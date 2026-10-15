import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { DecisionToolUnknownError } from "@/modules/agents/service";
import {
  type DecisionRule,
  decisionsFingerprint,
  decisionsQuestionsFingerprint,
} from "@/modules/decisions/config";
import type { DecisionAnswer } from "@/modules/decisions/providers";
import {
  REPLAY_WINDOW,
  replayConversation,
  replayDecisions,
} from "@/modules/decisions/replay";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentDecisionsReplay } from "@/modules/mcp/read";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogCount } from "../utils/flowlog";

// An unsaved block's rules replayed over the answers the agent's ticks recorded: what each rule
// would do beside what it did, using only ticks that answered the same questions, and writing nothing.

const yes = (probability: number): DecisionAnswer => ({
  type: "yes_no",
  probability,
});
const rule = (
  minProbability: number,
  tool: string,
  trigger?: DecisionRule["trigger"],
): DecisionRule => ({
  when: [{ question: "refund", minProbability }],
  action: { tool, args: tool === "set_labels" ? { add: ["refund"] } : {} },
  ...(trigger ? { trigger } : {}),
});

test("moving a question on screen keeps its answers comparable; rewording one does not", () => {
  const a = { name: "a", type: "yes_no" as const, instructions: "A?" };
  const b = { name: "b", type: "yes_no" as const, instructions: "B?" };
  expect(decisionsQuestionsFingerprint({ questions: [a, b] })).toBe(
    decisionsQuestionsFingerprint({ questions: [b, a] }),
  );
  expect(decisionsQuestionsFingerprint({ questions: [a, b] })).not.toBe(
    decisionsQuestionsFingerprint({
      questions: [{ ...a, instructions: "A, really?" }, b],
    }),
  );
});

describe("a conversation's ticks replayed with the trigger simulated", () => {
  const acted = (rules: DecisionRule[], ps: number[]) => {
    const out: number[] = [];
    replayConversation(
      rules,
      ps.map((p) => ({ answers: { refund: yes(p) } })),
      (r) => out.push(r),
    );
    return out;
  };

  test("on_start acts again only after its conditions stopped holding; once acts once; each_time every tick", () => {
    const ps = [0.9, 0.9, 0.1, 0.9];
    expect(acted([rule(0.7, "handoff_to_human", "on_start")], ps)).toEqual([
      0, 0,
    ]);
    expect(acted([rule(0.7, "handoff_to_human", "once")], ps)).toEqual([0]);
    expect(acted([rule(0.7, "set_labels", "each_time")], ps)).toEqual([
      0, 0, 0,
    ]);
  });

  test("a rule merged into an earlier identical action counts as acting, and latches by its own trigger", () => {
    const rules = [
      rule(0.7, "set_labels", "each_time"),
      rule(0.5, "set_labels", "once"),
    ];
    expect(acted(rules, [0.9, 0.9])).toEqual([0, 1, 0]);
  });
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const QUESTIONS = [
  { name: "refund", type: "yes_no", instructions: "Asks for a refund?" },
];
const RULES = [
  {
    when: [{ question: "refund", minProbability: 0.7 }],
    action: { tool: "set_labels", args: { add: ["refund"] } },
  },
];
const BLOCK = {
  provider: "typesafe",
  model: "jev-latest",
  credentialRef: "vault:1",
  questions: QUESTIONS,
  rules: RULES,
};
const asConfig = (b: unknown) =>
  b as Parameters<typeof decisionsFingerprint>[0];
const MARK = decisionsFingerprint(asConfig(BLOCK));
const QMARK = decisionsQuestionsFingerprint(asConfig(BLOCK));

let tenantId = 0n;
let otherTenantId = 0n;
let agentId = 0n;
let otherAgentId = 0n;
let foreignAgentId = 0n;
const convs: bigint[] = [];
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const draft = (minProbability = 0.7, questions: unknown[] = QUESTIONS) => ({
  questions,
  rules: [
    {
      when: [{ question: "refund", minProbability }],
      action: { tool: "set_labels", args: { add: ["refund"] } },
    },
  ],
});

let clock = Date.parse("2026-10-15T10:00:00Z");
const row = (
  conv: bigint,
  p: number,
  detail: Prisma.InputJsonObject = {},
  data: Partial<Prisma.ExecutionLogCreateManyInput> = {},
): Prisma.ExecutionLogCreateManyInput => {
  clock += 1000;
  return {
    tenantId,
    conversationId: conv,
    agentId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    stage: "observe",
    level: "info",
    status: "ok",
    createdAt: new Date(clock),
    detail: {
      engine: "decisions",
      block: MARK,
      questions: QMARK,
      answers: { refund: { type: "yes_no", probability: p } },
      actions:
        p >= 0.7 ? [{ rule: 0, tool: "set_labels", outcome: "ran" }] : [],
      ...detail,
    },
    ...data,
  };
};
const seed = (rows: Prisma.ExecutionLogCreateManyInput[]) =>
  suDb.executionLog.createMany({ data: rows });

describe.skipIf(!dbUp)("replaying a draft over the recorded answers", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "replay1498", slug: `replay1498-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      adminToken: "enc",
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootInboxId: 10,
        name: "Support",
      },
    });
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: inst.id,
        tenantId,
        chatwootContactId: 5,
        name: "Alice",
      },
    });
    for (const n of [100, 101, 102]) {
      const c = await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: inst.id,
          chatwootConversationId: n,
          inboxId: inbox.id,
          contactId: contact.id,
          status: "pending",
          assigneeType: "AgentBot",
          threadId: `${tenantId}:${inst.id}:${n}`,
          lastEventAt: new Date("2026-10-15T10:00:00Z"),
        },
      });
      convs.push(c.id);
    }
    const agent = (name: string, tenant: bigint) =>
      suDb.agent.create({
        data: {
          tenantId: tenant,
          name,
          systemPrompt: "",
          mode: "monitoring",
          settings: { monitoring: { engine: "decisions", decisions: BLOCK } },
        },
      });
    agentId = (await agent("watcher", tenantId)).id;
    otherAgentId = (await agent("other", tenantId)).id;
    otherTenantId = (
      await suDb.tenant.create({
        data: { name: "replay1498b", slug: `replay1498b-${process.pid}` },
      })
    ).id;
    foreignAgentId = (await agent("foreign", otherTenantId)).id;
  });

  beforeEach(async () => {
    await clearFlowLog(suDb, { tenantId });
  });

  afterAll(async () => {
    for (const t of [tenantId, otherTenantId]) {
      if (!t) continue;
      await clearFlowLog(suDb, { tenantId: t });
      await suDb.$executeRaw`DELETE FROM agents WHERE tenant_id = ${t}`;
      await suDb.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${t}`;
      await suDb.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${t}`;
      await suDb.$executeRaw`DELETE FROM inboxes WHERE tenant_id = ${t}`;
      await suDb.$executeRaw`DELETE FROM chatwoot_instances WHERE tenant_id = ${t}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${t}`;
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a lower threshold counts what it would do beside what the stored rule did, from this agent's decided ticks only", async () => {
    const [c1, c2] = convs as [bigint, bigint];
    await seed([
      row(c1, 0.9),
      row(c1, 0.65),
      row(c2, 0.6),
      // Another agent, a skipped tick and a failed one: none of them is a decision of this agent.
      row(c2, 0.99, {}, { agentId: otherAgentId }),
      row(c2, 0.99, {}, { status: "skipped" }),
      row(c2, 0.99, {}, { status: "error" }),
    ]);
    const r = await replayDecisions(ctx(), agentId, draft(0.6), appDb);
    expect(r.ticksUsed).toBe(3);
    expect(r.ticksNotComparable).toBe(0);
    expect(r.questionsChanged).toBe(false);
    expect(r.rules[0]).toMatchObject({
      tool: "set_labels",
      args: { add: ["refund"] },
      would: { ticks: 3, conversations: [String(c2), String(c1)] },
    });
    expect(r.stored[0]).toMatchObject({
      tool: "set_labels",
      acted: { ticks: 1, conversations: [String(c1)] },
    });
  });

  test("ticks answered with other questions are counted apart and never replayed", async () => {
    const [c1, c2] = convs as [bigint, bigint];
    await seed([
      row(c1, 0.9),
      row(c2, 0.9, { questions: "other", block: "x" }),
    ]);
    const r = await replayDecisions(ctx(), agentId, draft(), appDb);
    expect(r.ticksUsed).toBe(1);
    expect(r.ticksNotComparable).toBe(1);
    expect(r.rules[0]?.would.conversations).toEqual([String(c1)]);
  });

  test("a line written before ticks marked their questions is used when it ran the stored block and the draft kept its questions", async () => {
    const [c1] = convs as [bigint];
    await seed([row(c1, 0.9, { questions: null })]);
    const kept = await replayDecisions(ctx(), agentId, draft(0.8), appDb);
    expect(kept.ticksUsed).toBe(1);
    expect(kept.rules[0]?.would.ticks).toBe(1);
    const edited = await replayDecisions(
      ctx(),
      agentId,
      draft(0.8, [{ ...QUESTIONS[0], instructions: "Angry?" }]),
      appDb,
    );
    expect(edited.questionsChanged).toBe(true);
    expect(edited.ticksUsed).toBe(0);
    expect(edited.ticksNotComparable).toBe(1);
  });

  test("ticks that ran older rules over the same questions feed what the draft would do, not what the stored block did", async () => {
    const [c1] = convs as [bigint];
    await seed([row(c1, 0.9, { block: "older-rules" })]);
    const r = await replayDecisions(ctx(), agentId, draft(), appDb);
    expect(r.ticksUsed).toBe(1);
    expect(r.ticksStoredBlock).toBe(0);
    expect(r.rules[0]?.would.ticks).toBe(1);
    expect(r.stored[0]?.acted.ticks).toBe(0);
  });

  test("only the newest ticks of the window are replayed", async () => {
    const [c1, c2] = convs as [bigint, bigint];
    await seed([
      row(c1, 0.95),
      ...Array.from({ length: REPLAY_WINDOW }, () => row(c2, 0.1)),
    ]);
    const r = await replayDecisions(ctx(), agentId, draft(), appDb);
    expect(r.ticksUsed + r.ticksNotComparable).toBe(REPLAY_WINDOW);
    expect(r.rules[0]?.would.ticks).toBe(0);
  });

  test("an invalid draft is refused, and another tenant's agent is not found, on REST's core and over MCP", async () => {
    await expect(
      replayDecisions(
        ctx(),
        agentId,
        {
          questions: QUESTIONS,
          rules: [
            {
              when: [{ question: "nope", minProbability: 0.5 }],
              action: { tool: "set_labels", args: {} },
            },
          ],
        },
        appDb,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      translationKey: "errors.decisionsDraftInvalid",
    });
    await expect(
      replayDecisions(ctx(), foreignAgentId, draft(), appDb),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("an answer the log hid is left out as unreadable, never replayed as a no", async () => {
    const [c1] = convs as [bigint];
    await seed([
      row(c1, 0.9, { answers: { refund: "‹redacted›" } }),
      row(c1, 0.9),
    ]);
    const r = await replayDecisions(ctx(), agentId, draft(), appDb);
    expect(r.ticksUsed).toBe(1);
    expect(r.ticksUnreadable).toBe(1);
    expect(r.ticksNotComparable).toBe(0);
    expect(r.rules[0]?.would.ticks).toBe(1);
  });

  test("a rule naming a custom tool the tenant does not have is refused, as a save refuses it", async () => {
    await expect(
      replayDecisions(
        ctx(),
        agentId,
        {
          questions: QUESTIONS,
          rules: [
            {
              when: [{ question: "refund", minProbability: 0.5 }],
              action: { tool: "no_such_tool", args: {} },
            },
          ],
        },
        appDb,
      ),
    ).rejects.toBeInstanceOf(DecisionToolUnknownError);
  });

  test("MCP returns the same report and nothing is written", async () => {
    const [c1] = convs as [bigint];
    await seed([row(c1, 0.9), row(c1, 0.5)]);
    // flowlog-scope: tenant-wide. "Nothing written" is about the whole tenant, not one turn.
    const before = await flowLogCount(suDb, { where: { tenantId } });
    const token: VerifiedToken = {
      userId: null as unknown as bigint,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      clientId: "c1498",
      jti: "j1498",
    };
    const viaMcp = await agentDecisionsReplay(
      token,
      { agent_id: String(agentId), ...draft(0.4) },
      { base: appDb },
    );
    const viaCore = await replayDecisions(ctx(), agentId, draft(0.4), appDb);
    expect(viaMcp.ok && viaMcp.data.replay).toEqual(viaCore);
    // flowlog-scope: tenant-wide
    const after = await flowLogCount(suDb, { where: { tenantId } });
    expect(after).toBe(before);
    const foreign = await agentDecisionsReplay(
      token,
      { agent_id: String(foreignAgentId), ...draft() },
      { base: appDb },
    );
    expect(foreign.ok).toBe(false);
  });
});
