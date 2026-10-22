import { createHash } from "node:crypto";
import type {
  StructuredToolInterface,
  ToolRunnableConfig,
} from "@langchain/core/tools";
import { z } from "zod";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { fetchBoundedBytes } from "@/lib/outbound";
import { clipText } from "@/lib/text";
import {
  CHATWOOT_ERP_CATALOG_TYPE,
  type ChatwootErpConfig,
  chatwootErpConfigSchema,
} from "@/modules/integrations/erp-config";
import {
  type IntegrationSelection,
  registerToolpack,
  type Toolpack,
  ToolpackCalledOffError,
  type ToolpackCtx,
  type ToolSpec,
} from "./types";

const REQUEST_TIMEOUT_MS = 5_000;
const RESPONSE_MAX_BYTES = 128 * 1024;
const MAX_ATTEMPTS = 2;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const emptyInputSchema = z.object({}).strict();
const ordersInputSchema = z
  .object({
    page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Results page, from 1 to 100."),
    perPage: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Orders per page, from 1 to 50."),
    from: z.iso.date().optional().describe("Start date in YYYY-MM-DD format."),
    to: z.iso.date().optional().describe("End date in YYYY-MM-DD format."),
  })
  .strict()
  .superRefine((value, issue) => {
    if (!value.from || !value.to) return;
    const from = Date.parse(`${value.from}T00:00:00Z`);
    const to = Date.parse(`${value.to}T00:00:00Z`);
    if (from > to || to - from > 365 * 24 * 60 * 60 * 1000) {
      issue.addIssue({
        code: "custom",
        message: "from/to must be ordered and cover no more than 365 days",
      });
    }
  });
const inventoryInputSchema = z
  .object({
    query: z
      .string()
      .max(100)
      .optional()
      .describe("SKU or product-name search text."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe("Maximum inventory matches, from 1 to 25."),
  })
  .strict();
const syncStatusInputSchema = z
  .object({
    syncRunId: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .describe("Sync run id returned by erp_sync_request."),
  })
  .strict();

const correlationSchema = z
  .object({
    turn_id: z.string().regex(SAFE_ID).optional(),
    tool_call_id: z.string().regex(SAFE_ID).optional(),
    request_id: z.string().regex(SAFE_ID).optional(),
  })
  .strict();
const freshnessSchema = z
  .object({
    last_synced_at: z.iso.datetime({ offset: true }).nullable(),
    stale: z.boolean(),
    stale_after_seconds: z.number().int().nonnegative().max(31_536_000),
  })
  .strict();
const baseResponseSchema = z.object({
  connection_id: z.string().min(1).max(128),
  source: z.literal("local_snapshot"),
  correlation: correlationSchema,
});
const capabilitiesResponseSchema = baseResponseSchema
  .extend({
    status: z.string().min(1).max(64),
    freshness: freshnessSchema,
    capabilities: z
      .array(
        z
          .object({
            name: z.enum([
              "connection_status",
              "customer_context",
              "recent_orders",
              "inventory_lookup",
              "sync_status",
              "request_sync",
            ]),
          })
          .strict(),
      )
      .max(6),
  })
  .strict();
const customerResponseSchema = baseResponseSchema
  .extend({
    freshness: freshnessSchema,
    customer: z
      .object({
        contact_id: z.number().int().positive(),
        external_code: z.string().max(128).nullable(),
        name: z.string().max(300).nullable(),
        email_masked: z.string().max(320).nullable(),
        phone_last4: z.string().max(4).nullable(),
        document_last4: z.string().max(4).nullable(),
        segment: z.string().max(160).nullable(),
        seller_name: z.string().max(200).nullable(),
        total_orders: z.number().int().nonnegative(),
        profile_status: z.string().min(1).max(64),
        last_synced_at: z.iso.datetime({ offset: true }).nullable(),
      })
      .strict(),
  })
  .strict();
const orderSchema = z
  .object({
    id: z.string().min(1).max(160),
    occurred_at: z.iso.datetime({ offset: true }),
    amount: z.string().regex(/^-?[0-9]{1,18}(?:\.[0-9]{1,8})?$/),
    currency: z.string().min(1).max(8),
    seller_name: z.string().max(200).nullable(),
  })
  .strict();
const ordersResponseSchema = baseResponseSchema
  .extend({
    freshness: freshnessSchema,
    orders: z.array(orderSchema).max(50),
    pagination: z
      .object({
        page: z.number().int().min(1).max(100),
        per_page: z.number().int().min(1).max(50),
        has_more: z.boolean(),
      })
      .strict(),
  })
  .strict();
const inventoryResponseSchema = baseResponseSchema
  .extend({
    freshness: freshnessSchema,
    inventory: z
      .object({
        supported: z.boolean(),
        status: z.string().min(1).max(64),
        reason: z.string().max(160).nullable().optional(),
        items: z
          .array(
            z
              .object({
                sku: z.string().min(1).max(160),
                name: z.string().max(300).nullable(),
                available: z.number().finite().nullable(),
                unit: z.string().max(40).nullable(),
              })
              .strict(),
          )
          .max(25),
      })
      .strict(),
  })
  .strict();
const syncResponseSchema = baseResponseSchema
  .extend({
    sync_run_id: z.union([
      z.number().int().positive().safe(),
      z.string().regex(/^[1-9][0-9]{0,18}$/),
    ]),
    status: z.string().min(1).max(64),
    created_at: z.iso.datetime({ offset: true }),
    started_at: z.iso.datetime({ offset: true }).nullable(),
    finished_at: z.iso.datetime({ offset: true }).nullable(),
    enqueued: z.boolean().optional(),
  })
  .strict();
const errorResultSchema = z
  .object({
    ok: z.literal(false),
    code: z.enum([
      "cancelled",
      "contract_or_precondition",
      "denied_or_unavailable",
      "throttled",
      "upstream_unavailable",
    ]),
    retryable: z.boolean(),
  })
  .strict();

interface Correlation {
  turnId: string;
  toolCallId: string;
  requestId: string;
}

type SuccessSchema =
  | typeof capabilitiesResponseSchema
  | typeof customerResponseSchema
  | typeof ordersResponseSchema
  | typeof inventoryResponseSchema
  | typeof syncResponseSchema;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeId(value: string | undefined, fallback: string): string {
  if (value && SAFE_ID.test(value)) return value;
  return fallback;
}

function correlationFor(
  toolName: string,
  config: ToolRunnableConfig | undefined,
  selection: IntegrationSelection,
  erp: ChatwootErpConfig,
  ctx: ToolpackCtx,
): Correlation {
  const seed = [
    String(ctx.tenantId),
    ctx.threadId,
    ctx.turnId ?? "",
    String(config?.toolCall?.id ?? ""),
    String(selection.instanceId),
    erp.erpConnectionId,
    toolName,
  ].join("|");
  const hash = digest(seed);
  return {
    turnId: safeId(ctx.turnId, `turn-${clipText(hash, 48)}`),
    toolCallId: safeId(
      config?.toolCall?.id ? String(config.toolCall.id) : undefined,
      `tool-${clipText(hash, 48)}`,
    ),
    requestId: `erp-${clipText(hash, 64)}`,
  };
}

function safeError(
  code: z.infer<typeof errorResultSchema>["code"],
  retryable: boolean,
) {
  const result: z.infer<typeof errorResultSchema> = {
    ok: false,
    code,
    retryable,
  };
  return toolFailure(JSON.stringify(result));
}

function responseResult(
  schema: SuccessSchema,
  value: unknown,
  erp: ChatwootErpConfig,
) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return safeError("upstream_unavailable", true);
  if (parsed.data.connection_id !== erp.erpConnectionId) {
    return safeError("denied_or_unavailable", false);
  }
  return JSON.stringify(parsed.data);
}

function statusError(status: number) {
  if ([401, 403, 404].includes(status)) {
    return safeError("denied_or_unavailable", false);
  }
  if ([409, 422].includes(status)) {
    return safeError("contract_or_precondition", false);
  }
  if (status === 429) return safeError("throttled", true);
  if (status >= 500) return safeError("upstream_unavailable", true);
  return safeError("contract_or_precondition", false);
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function queryString(
  values: Record<string, string | number | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function idempotencyKey(
  correlation: Correlation,
  selection: IntegrationSelection,
  erp: ChatwootErpConfig,
  ctx: ToolpackCtx,
): string {
  return `erp-sync:${digest(
    [
      String(ctx.tenantId),
      ctx.threadId,
      correlation.turnId,
      correlation.toolCallId,
      String(selection.instanceId),
      erp.erpConnectionId,
    ].join("|"),
  )}`;
}

async function request(
  args: {
    toolName: string;
    method: "GET" | "POST";
    path: string;
    query?: string;
    schema: SuccessSchema;
    idempotencyKey?: string;
  },
  config: ToolRunnableConfig | undefined,
  selection: IntegrationSelection,
  erp: ChatwootErpConfig,
  ctx: ToolpackCtx,
) {
  if (
    ctx.chatwootInstanceId === undefined ||
    String(ctx.chatwootInstanceId) !== erp.chatwootInstanceId ||
    !ctx.resolveChatwootBinding
  ) {
    return safeError("denied_or_unavailable", false);
  }
  const binding = await ctx.resolveChatwootBinding().catch(() => null);
  if (!binding || binding.disconnected) {
    return safeError("denied_or_unavailable", false);
  }
  const token = selection.credentialRef
    ? await ctx.resolveCredential(selection.credentialRef)
    : null;
  if (!token) return safeError("denied_or_unavailable", false);

  const correlation = correlationFor(
    args.toolName,
    config,
    selection,
    erp,
    ctx,
  );
  const base = binding.baseUrl.replace(/\/+$/, "");
  const url = `${base}/api/v1/integrations/agents/erp_connections/${encodeURIComponent(
    erp.erpConnectionId,
  )}/${args.path}${args.query ?? ""}`;
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "X-Agents-Account-Id": String(binding.accountId),
    "X-Agents-Tenant-Id": String(ctx.tenantId),
    "X-Turn-Id": correlation.turnId,
    "X-Tool-Call-Id": correlation.toolCallId,
    "X-Request-Id": correlation.requestId,
  });
  if (args.idempotencyKey) {
    headers.set("Idempotency-Key", args.idempotencyKey);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { res, body } = await fetchBoundedBytes(
        url,
        { method: args.method, headers, redirect: "error" },
        {
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxBytes: RESPONSE_MAX_BYTES,
          fetchImpl: ctx.fetchImpl,
          readWhen: (response) =>
            response.status >= 200 && response.status < 300,
        },
      );
      if (res.status < 200 || res.status >= 300) {
        if (attempt < MAX_ATTEMPTS && retryableStatus(res.status)) continue;
        return statusError(res.status);
      }
      if (!body || body.tooLarge) {
        return safeError("upstream_unavailable", true);
      }
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(body.bytes));
      } catch {
        return safeError("upstream_unavailable", true);
      }
      return responseResult(args.schema, json, erp);
    } catch (err) {
      if (err instanceof ToolpackCalledOffError) {
        return safeError("cancelled", false);
      }
      if (attempt < MAX_ATTEMPTS) continue;
      return safeError("upstream_unavailable", true);
    }
  }
  return safeError("upstream_unavailable", true);
}

function correlated(
  tool: StructuredToolInterface,
  selection: IntegrationSelection,
  erp: ChatwootErpConfig,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const wrapped = Object.create(tool) as StructuredToolInterface;
  wrapped.invoke = ((input: unknown, config?: ToolRunnableConfig) => {
    const correlation = correlationFor(tool.name, config, selection, erp, ctx);
    return tool.invoke(input, {
      ...(config ?? {}),
      metadata: {
        ...(config?.metadata ?? {}),
        erp_tool: tool.name,
        erp_connection_id: erp.erpConnectionId,
        turn_id: correlation.turnId,
        tool_call_id: correlation.toolCallId,
        request_id: correlation.requestId,
      },
    });
  }) as typeof tool.invoke;
  return wrapped;
}

function buildTools(
  selection: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface[] {
  const parsed = chatwootErpConfigSchema.safeParse(selection.config);
  if (!parsed.success) return [];
  const erp = parsed.data;
  const builders: Record<string, () => StructuredToolInterface> = {
    erp_connection_status: () =>
      failableTool(
        async (_input: Record<string, never>, config) =>
          request(
            {
              toolName: "erp_connection_status",
              method: "GET",
              path: "capabilities",
              schema: capabilitiesResponseSchema,
            },
            config,
            selection,
            erp,
            ctx,
          ),
        {
          name: "erp_connection_status",
          description:
            "Read the configured ERP connection status, freshness and granted capabilities from Chatwoot's local snapshot.",
          schema: emptyInputSchema,
        },
      ),
    erp_customer_context: () =>
      failableTool(
        async (_input: Record<string, never>, config) => {
          if (!ctx.chatwootContactId) {
            return safeError("denied_or_unavailable", false);
          }
          return request(
            {
              toolName: "erp_customer_context",
              method: "GET",
              path: `customers/${ctx.chatwootContactId}/context`,
              schema: customerResponseSchema,
            },
            config,
            selection,
            erp,
            ctx,
          );
        },
        {
          name: "erp_customer_context",
          description:
            "Read the current customer's redacted ERP profile from Chatwoot's local materialized snapshot.",
          schema: emptyInputSchema,
        },
      ),
    erp_orders_lookup: () =>
      failableTool(
        async (
          input: {
            page?: number;
            perPage?: number;
            from?: string;
            to?: string;
          },
          config,
        ) => {
          if (!ctx.chatwootContactId) {
            return safeError("denied_or_unavailable", false);
          }
          return request(
            {
              toolName: "erp_orders_lookup",
              method: "GET",
              path: `customers/${ctx.chatwootContactId}/orders`,
              query: queryString({
                page: input.page,
                per_page: input.perPage,
                from: input.from,
                to: input.to,
              }),
              schema: ordersResponseSchema,
            },
            config,
            selection,
            erp,
            ctx,
          );
        },
        {
          name: "erp_orders_lookup",
          description:
            "List the current customer's recent ERP orders from the local snapshot, with bounded pagination and an optional date range of at most 365 days.",
          schema: ordersInputSchema,
        },
      ),
    erp_inventory_lookup: () =>
      failableTool(
        async (input: { query?: string; limit?: number }, config) =>
          request(
            {
              toolName: "erp_inventory_lookup",
              method: "GET",
              path: "inventory",
              query: queryString({ query: input.query, limit: input.limit }),
              schema: inventoryResponseSchema,
            },
            config,
            selection,
            erp,
            ctx,
          ),
        {
          name: "erp_inventory_lookup",
          description:
            "Look up bounded local ERP inventory. If no local inventory snapshot exists, returns an explicit unsupported result; never infer stock.",
          schema: inventoryInputSchema,
        },
      ),
    erp_sync_request: () =>
      failableTool(
        async (_input: Record<string, never>, config) => {
          const correlation = correlationFor(
            "erp_sync_request",
            config,
            selection,
            erp,
            ctx,
          );
          return request(
            {
              toolName: "erp_sync_request",
              method: "POST",
              path: "syncs",
              schema: syncResponseSchema,
              idempotencyKey: idempotencyKey(correlation, selection, erp, ctx),
            },
            config,
            selection,
            erp,
            ctx,
          );
        },
        {
          name: "erp_sync_request",
          description:
            "Request one idempotent incremental ERP sync for this configured connection. The sync runs asynchronously; use erp_sync_status with the returned id.",
          schema: emptyInputSchema,
        },
      ),
    erp_sync_status: () =>
      failableTool(
        async (input: { syncRunId: string }, config) =>
          request(
            {
              toolName: "erp_sync_status",
              method: "GET",
              path: `syncs/${input.syncRunId}`,
              schema: syncResponseSchema,
            },
            config,
            selection,
            erp,
            ctx,
          ),
        {
          name: "erp_sync_status",
          description:
            "Read the status of a sync run returned by erp_sync_request for this configured ERP connection.",
          schema: syncStatusInputSchema,
        },
      ),
  };
  return selection.enabledTools.flatMap((name) => {
    const build = builders[name];
    return build ? [correlated(build(), selection, erp, ctx)] : [];
  });
}

export const CHATWOOT_ERP_TOOL_SPECS: ToolSpec[] = [
  { name: "erp_connection_status", schema: emptyInputSchema },
  { name: "erp_customer_context", schema: emptyInputSchema },
  { name: "erp_orders_lookup", schema: ordersInputSchema },
  { name: "erp_inventory_lookup", schema: inventoryInputSchema },
  { name: "erp_sync_request", schema: emptyInputSchema },
  { name: "erp_sync_status", schema: syncStatusInputSchema },
];

export const chatwootErpToolpack: Toolpack = {
  catalogType: CHATWOOT_ERP_CATALOG_TYPE,
  toolSpecs: CHATWOOT_ERP_TOOL_SPECS,
  build: buildTools,
};

registerToolpack(chatwootErpToolpack);
