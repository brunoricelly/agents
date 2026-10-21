import { afterEach, describe, expect, jest, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { getCatalogEntry } from "@/modules/integrations/catalog";
import { assertCatalogConfig } from "@/modules/integrations/service";
import {
  buildToolpackTools,
  getToolpackToolNames,
  type IntegrationSelection,
  type ToolpackCtx,
} from "@/modules/integrations/toolpacks";
import { chatwootErpToolpack } from "@/modules/integrations/toolpacks/chatwoot-erp";

const SECRET = "erp_secret_do_not_echo";

function selection(
  over: Partial<IntegrationSelection> = {},
): IntegrationSelection {
  return {
    instanceId: 31n,
    catalogType: "CHATWOOT_ERP",
    config: { chatwootInstanceId: "41", erpConnectionId: "erp-main" },
    credentialRef: "vault:91",
    enabledTools: [],
    ...over,
  };
}

function context(over: Partial<ToolpackCtx> = {}): ToolpackCtx {
  return {
    tenantId: 7n,
    base: undefined as unknown as PrismaClient,
    threadId: "7:41:contact-501",
    turnId: "turn-701",
    chatwootInstanceId: 41n,
    chatwootContactId: 501,
    resolveChatwootBinding: async () => ({
      baseUrl: "https://chatwoot.example.test/",
      accountId: 17,
      serverKey: "chatwoot.example.test",
      disconnected: false,
    }),
    resolveCredential: async () => SECRET,
    ...over,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function capabilityResponse(over: Record<string, unknown> = {}) {
  return {
    connection_id: "erp-main",
    source: "local_snapshot",
    correlation: {
      turn_id: "turn-701",
      tool_call_id: "call-1",
      request_id: "request-1",
    },
    status: "connected",
    freshness: {
      last_synced_at: "2026-10-21T10:00:00Z",
      stale: false,
      stale_after_seconds: 900,
    },
    capabilities: [{ name: "connection_status" }],
    ...over,
  };
}

function syncResponse() {
  return {
    connection_id: "erp-main",
    source: "local_snapshot",
    correlation: {
      turn_id: "turn-701",
      tool_call_id: "call-1",
      request_id: "request-1",
    },
    sync_run_id: "123",
    status: "queued",
    created_at: "2026-10-21T10:00:00Z",
    started_at: null,
    finished_at: null,
    enqueued: true,
  };
}

function tool(
  name: string,
  overSelection: Partial<IntegrationSelection> = {},
  overContext: Partial<ToolpackCtx> = {},
) {
  const built = chatwootErpToolpack.build(
    selection({ enabledTools: [name], ...overSelection }),
    context(overContext),
  );
  const found = built.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

function parsed(output: unknown): Record<string, unknown> {
  const value =
    output && typeof output === "object" && "content" in output
      ? (output as { content: unknown }).content
      : output;
  return JSON.parse(String(value)) as Record<string, unknown>;
}

function hangingFetch(onCall?: (init: RequestInit) => void): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    onCall?.(init ?? {});
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.useRealTimers();
});

describe("Chatwoot ERP integration wiring", () => {
  test("is registered as an outbound toolpack with a strict stored config", () => {
    expect(getCatalogEntry("CHATWOOT_ERP")).toMatchObject({
      kind: "TOOLPACK",
      supportsInbound: false,
    });
    expect(getToolpackToolNames("CHATWOOT_ERP")).toEqual([
      "erp_connection_status",
      "erp_customer_context",
      "erp_orders_lookup",
      "erp_inventory_lookup",
      "erp_sync_request",
      "erp_sync_status",
    ]);
    expect(() =>
      assertCatalogConfig("CHATWOOT_ERP", {
        chatwootInstanceId: "41",
        erpConnectionId: "erp-main",
      }),
    ).not.toThrow();
    expect(() =>
      assertCatalogConfig("CHATWOOT_ERP", {
        chatwootInstanceId: "41",
        erpConnectionId: "erp-main",
        tenantId: "7",
      }),
    ).toThrow("config.tenantId");
  });
});

describe("Chatwoot ERP grants and model input", () => {
  test("omitted, denied and unknown grants expose no callable tool", () => {
    expect(chatwootErpToolpack.build(selection(), context())).toEqual([]);
    expect(
      chatwootErpToolpack
        .build(selection({ enabledTools: ["erp_customer_context"] }), context())
        .map((candidate) => candidate.name),
    ).toEqual(["erp_customer_context"]);
    expect(
      chatwootErpToolpack.build(
        selection({ enabledTools: ["erp_not_granted"] }),
        context(),
      ),
    ).toEqual([]);
  });

  test("strict schemas reject tenant, contact and connection overrides before fetch", async () => {
    let calls = 0;
    const status = tool(
      "erp_connection_status",
      {},
      {
        fetchImpl: (async () => {
          calls += 1;
          return jsonResponse(capabilityResponse());
        }) as unknown as typeof fetch,
      },
    );
    await expect(
      status.invoke({ tenantId: "999", chatwootContactId: 999 }),
    ).rejects.toThrow();

    const inventory = tool(
      "erp_inventory_lookup",
      {},
      {
        fetchImpl: (async () => {
          calls += 1;
          return jsonResponse(capabilityResponse());
        }) as unknown as typeof fetch,
      },
    );
    await expect(
      inventory.invoke({ query: "sku", erpConnectionId: "other" }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

describe("Chatwoot ERP context binding and tenant fences", () => {
  test("derives origin, tenant, contact and connection only from trusted context/config", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const orders = tool(
      "erp_orders_lookup",
      {},
      {
        fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
          calls.push({ url: String(url), init: init ?? {} });
          return jsonResponse({
            connection_id: "erp-main",
            source: "local_snapshot",
            correlation: {},
            freshness: {
              last_synced_at: null,
              stale: true,
              stale_after_seconds: 900,
            },
            orders: [],
            pagination: { page: 2, per_page: 10, has_more: false },
          });
        }) as unknown as typeof fetch,
      },
    );
    const out = parsed(
      await orders.invoke({ page: 2, perPage: 10, from: "2026-10-01" }),
    );
    expect(out.connection_id).toBe("erp-main");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://chatwoot.example.test/api/v1/integrations/agents/erp_connections/erp-main/customers/501/orders?page=2&per_page=10&from=2026-10-01",
    );
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("X-Agents-Tenant-Id")).toBe("7");
    expect(headers.get("X-Agents-Account-Id")).toBe("17");
    expect(headers.get("Authorization")).toBe(`Bearer ${SECRET}`);
  });

  test("a configured Chatwoot instance mismatch fails closed before binding, secret or fetch", async () => {
    let bindingReads = 0;
    let secretReads = 0;
    let fetches = 0;
    const status = tool(
      "erp_connection_status",
      { config: { chatwootInstanceId: "999", erpConnectionId: "erp-main" } },
      {
        resolveChatwootBinding: async () => {
          bindingReads += 1;
          return null;
        },
        resolveCredential: async () => {
          secretReads += 1;
          return SECRET;
        },
        fetchImpl: (async () => {
          fetches += 1;
          return jsonResponse(capabilityResponse());
        }) as unknown as typeof fetch,
      },
    );
    expect(parsed(await status.invoke({}))).toEqual({
      ok: false,
      code: "denied_or_unavailable",
      retryable: false,
    });
    expect({ bindingReads, secretReads, fetches }).toEqual({
      bindingReads: 0,
      secretReads: 0,
      fetches: 0,
    });
  });

  test("missing contact context denies customer reads without network access", async () => {
    let fetches = 0;
    const customer = tool(
      "erp_customer_context",
      {},
      {
        chatwootContactId: null,
        fetchImpl: (async () => {
          fetches += 1;
          return jsonResponse({});
        }) as unknown as typeof fetch,
      },
    );
    expect(parsed(await customer.invoke({}))).toEqual({
      ok: false,
      code: "denied_or_unavailable",
      retryable: false,
    });
    expect(fetches).toBe(0);
  });
});

describe("Chatwoot ERP bounded and redacted failures", () => {
  test("provider denials never echo an upstream body, URL or bearer secret", async () => {
    const output = String(
      await tool(
        "erp_connection_status",
        {},
        {
          fetchImpl: (async () =>
            new Response(
              JSON.stringify({
                error: `invalid ${SECRET}`,
                debug_url: "https://internal.invalid/private",
              }),
              { status: 403 },
            )) as unknown as typeof fetch,
        },
      ).invoke({}),
    );
    expect(parsed(output)).toEqual({
      ok: false,
      code: "denied_or_unavailable",
      retryable: false,
    });
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("internal.invalid");
  });

  test("invalid successful payloads fail safely without reflecting secret-shaped fields", async () => {
    const output = String(
      await tool(
        "erp_connection_status",
        {},
        {
          fetchImpl: (async () =>
            jsonResponse(
              capabilityResponse({ access_token: SECRET }),
            )) as unknown as typeof fetch,
        },
      ).invoke({}),
    );
    expect(parsed(output)).toEqual({
      ok: false,
      code: "upstream_unavailable",
      retryable: true,
    });
    expect(output).not.toContain(SECRET);
  });

  test("a response for a different ERP connection is refused", async () => {
    const output = String(
      await tool(
        "erp_connection_status",
        {},
        {
          fetchImpl: (async () =>
            jsonResponse(
              capabilityResponse({ connection_id: "another-connection" }),
            )) as unknown as typeof fetch,
        },
      ).invoke({}),
    );
    expect(parsed(output)).toEqual({
      ok: false,
      code: "denied_or_unavailable",
      retryable: false,
    });
    expect(output).not.toContain("another-connection");
  });

  test("responses over 128 KiB are refused instead of truncated into model output", async () => {
    const huge = `${JSON.stringify(capabilityResponse()).slice(0, -1)},"pad":"${"x".repeat(140 * 1024)}"}`;
    const output = String(
      await tool(
        "erp_connection_status",
        {},
        {
          fetchImpl: (async () =>
            new Response(huge, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })) as unknown as typeof fetch,
        },
      ).invoke({}),
    );
    expect(parsed(output)).toEqual({
      ok: false,
      code: "upstream_unavailable",
      retryable: true,
    });
    expect(output.length).toBeLessThan(200);
  });

  test("a stalled response is timed out, retried once and returned as a safe error", async () => {
    jest.useFakeTimers();
    let calls = 0;
    let settled = false;
    const pending = tool(
      "erp_connection_status",
      {},
      {
        fetchImpl: hangingFetch(() => {
          calls += 1;
        }),
      },
    )
      .invoke({})
      .finally(() => {
        settled = true;
      });
    for (let step = 0; step < 20 && !settled; step += 1) {
      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(settled).toBe(true);
    expect(calls).toBe(2);
    expect(parsed(await pending)).toEqual({
      ok: false,
      code: "upstream_unavailable",
      retryable: true,
    });
  });
});

describe("Chatwoot ERP sync idempotency and takeover fences", () => {
  test("sync retries and repeated delivery reuse the same idempotency key", async () => {
    const keys: string[] = [];
    let calls = 0;
    const sync = tool(
      "erp_sync_request",
      {},
      {
        fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          calls += 1;
          keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
          return calls === 1
            ? jsonResponse({ error: "temporary" }, 503)
            : jsonResponse(syncResponse());
        }) as unknown as typeof fetch,
      },
    );
    const invokeConfig = { toolCall: { id: "call-sync-1" } } as never;
    expect(parsed(await sync.invoke({}, invokeConfig)).status).toBe("queued");
    expect(parsed(await sync.invoke({}, invokeConfig)).status).toBe("queued");
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^erp-sync:[a-f0-9]{64}$/);
  });

  test("a reset/takeover fence stops sync before any request leaves", async () => {
    let fetches = 0;
    const [sync] = buildToolpackTools(
      [selection({ enabledTools: ["erp_sync_request"] })],
      context({
        stillWanted: async () => false,
        fetchImpl: (async () => {
          fetches += 1;
          return jsonResponse(syncResponse());
        }) as unknown as typeof fetch,
      }),
    );
    if (!sync) throw new Error("missing erp_sync_request");
    expect(parsed(await sync.invoke({}))).toEqual({
      ok: false,
      code: "cancelled",
      retryable: false,
    });
    expect(fetches).toBe(0);
  });

  test("a takeover while the secret resolves is fenced before the POST", async () => {
    let wanted = true;
    let fetches = 0;
    const [sync] = buildToolpackTools(
      [selection({ enabledTools: ["erp_sync_request"] })],
      context({
        resolveCredential: async () => {
          wanted = false;
          return SECRET;
        },
        stillWanted: async () => wanted,
        fetchImpl: (async () => {
          fetches += 1;
          return jsonResponse(syncResponse());
        }) as unknown as typeof fetch,
      }),
    );
    if (!sync) throw new Error("missing erp_sync_request");
    expect(parsed(await sync.invoke({}))).toEqual({
      ok: false,
      code: "cancelled",
      retryable: false,
    });
    expect(fetches).toBe(0);
  });
});
