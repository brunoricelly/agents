// THE REPLAY: an unsaved block's rules evaluated over the answers the agent's own ticks already
// recorded (docs/decisions.md, "Trying a block"). No provider call and no write: a tick's line carries
// every answer in full (`answersForLog`), and `evaluateRules` is pure over them, so "how often would
// this rule have acted" costs nothing. Only answers to the SAME questions are used: a question that
// is new or worded differently has no recorded answer, and asking it is the paid try's job.

import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  assertDecisionActionArgsUsable,
  getAgent,
} from "@/modules/agents/service";
import {
  type DecisionQuestion,
  type DecisionRule,
  type DecisionsConfig,
  decisionsBlockFingerprint,
  decisionsQuestionsFingerprint,
  readDecisionsConfig,
  ruleStateKey,
  triggerOf,
} from "./config";
import type { DecisionAnswer } from "./providers";
import { evaluateRules } from "./rules";

// How many of the agent's newest decided ticks a replay reads. Enough to show a rule's rate on a
// busy inbox, small enough to read and evaluate inside one request.
export const REPLAY_WINDOW = 200;

export interface ReplayCount {
  // Conversation ids (the console's /conversations/:id), newest activity first.
  conversations: string[];
  ticks: number;
}

export interface ReplayRule {
  rule: number;
  tool: string;
  args: Record<string, unknown>;
  // What the draft's rule would have done over the comparable ticks.
  would: ReplayCount;
}

// A rule of the STORED block and what it did, by the outcomes the ticks that ran that block recorded
// (an action that ran, its merged rules included). Keyed by the stored index, since the draft's list
// may be reordered or edited; ticks that ran another block are not counted, their indices point into
// another list.
export interface StoredRuleActivity {
  rule: number;
  tool: string;
  args: Record<string, unknown>;
  acted: ReplayCount;
}

export interface ReplayReport {
  window: number;
  // Decided ticks of the window whose questions are the draft's: the rules ran over these.
  ticksUsed: number;
  // Decided ticks of the window answered with other questions.
  ticksNotComparable: number;
  // Decided ticks that answered these questions but whose line does not hold an answer that can be
  // read back (the log hides a value whose question is named like a secret): neither replayed nor
  // read as a "no".
  ticksUnreadable: number;
  // Ticks of the window that ran the stored block, which is what `acted` counts.
  ticksStoredBlock: number;
  // The mark of the stored block `stored` is indexed by (`decisionsBlockFingerprint`), null when it
  // cannot run: a caller matching its own rules to `stored` checks it first, since another save may
  // have reordered the stored rules since it read them.
  storedBlock: string | null;
  // The draft's questions differ from the stored ones: a new or edited question has no recorded
  // answer, and only a try that asks the classifier can show what it would answer.
  questionsChanged: boolean;
  rules: ReplayRule[];
  stored: StoredRuleActivity[];
}

export interface ReplayDraft {
  questions: unknown;
  rules: unknown;
}

interface DecidedLine {
  conversationId: bigint;
  block: unknown;
  questions: unknown;
  answers: Record<string, DecisionAnswer>;
  actions: unknown[];
}

const bag = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

// The draft is asked the stored block's own rules, with a stand-in classifier: what a replay runs is
// the questions and the rules, and a draft whose classifier is still unset can be tried.
function readDraft(draft: ReplayDraft): DecisionsConfig {
  const read = readDecisionsConfig({
    decisions: {
      provider: "openai",
      credentialRef: "replay",
      questions: draft.questions,
      rules: draft.rules,
    },
  });
  if (!read.ok) {
    throw new AppError(
      "The questions and rules have a problem to fix before they can be tried.",
      400,
      "errors.decisionsDraftInvalid",
    );
  }
  return read.config;
}

export async function replayDecisions(
  ctx: TenantContext,
  agentId: bigint,
  draft: ReplayDraft,
  base: PrismaClient = basePrisma,
): Promise<ReplayReport> {
  const config = readDraft(draft);
  const agent = await getAgent(ctx, agentId, base);
  // A custom tool's arguments, asked as a save asks them: a block the save would refuse is not one
  // whose effect is worth reporting.
  await assertDecisionActionArgsUsable(
    ctx,
    { monitoring: { decisions: { rules: draft.rules } } },
    agent.settings,
    base,
  );
  const storedBlock = bag(bag(agent.settings)?.monitoring)?.decisions;
  const storedMark = decisionsBlockFingerprint(storedBlock);
  const stored = readDecisionsConfig({ decisions: storedBlock });
  const draftQuestions = decisionsQuestionsFingerprint(config);
  const storedQuestions = stored.ok
    ? decisionsQuestionsFingerprint(stored.config)
    : null;

  const rows = await runScopedOn(base, ctx, (db) =>
    db.executionLog.findMany({
      where: {
        agentId,
        source: "inbox",
        stage: "observe",
        status: "ok",
        conversationId: { not: null },
        detail: { path: ["engine"], equals: "decisions" },
      },
      orderBy: { id: "desc" },
      take: REPLAY_WINDOW,
      select: { conversationId: true, detail: true },
    }),
  );
  const lines: DecidedLine[] = [];
  for (const r of rows) {
    const d = bag(r.detail);
    const answers = bag(d?.answers);
    if (!d || !answers || r.conversationId === null) continue;
    lines.push({
      conversationId: r.conversationId,
      block: d.block,
      questions: d.questions,
      answers: answers as Record<string, DecisionAnswer>,
      actions: Array.isArray(d.actions) ? d.actions : [],
    });
  }

  // A line answered the draft's questions when it says so, or, written before lines carried the
  // questions' own mark, when it ran the stored block and the draft kept the stored questions.
  const comparable = (l: DecidedLine): boolean =>
    typeof l.questions === "string"
      ? l.questions === draftQuestions
      : storedMark !== null &&
        l.block === storedMark &&
        storedQuestions === draftQuestions;

  const would = config.rules.map(() => ({
    conversations: new Set<bigint>(),
    ticks: 0,
  }));
  const storedRules = stored.ok ? stored.config.rules : [];
  const acted = storedRules.map(() => ({
    conversations: new Set<bigint>(),
    ticks: 0,
  }));
  // Newest activity first, for the lists the report returns.
  const order: bigint[] = [];
  const byConversation = new Map<bigint, DecidedLine[]>();
  for (const l of lines) {
    const list = byConversation.get(l.conversationId);
    if (list) list.push(l);
    else {
      byConversation.set(l.conversationId, [l]);
      order.push(l.conversationId);
    }
  }

  // A line whose answers to these questions all read back as answers. One the log rewrote (a value
  // under a secret-looking name) would replay as a miss, which is a "no" the classifier never said.
  const readable = (l: DecidedLine): boolean =>
    config.questions.every(
      (q) => l.answers[q.name] === undefined || isAnswer(q, l.answers[q.name]),
    );
  let ticksUsed = 0;
  let ticksUnreadable = 0;
  let ticksStoredBlock = 0;
  for (const [conversationId, newestFirst] of byConversation) {
    replayConversation(
      config.rules,
      [...newestFirst].reverse().filter((l) => comparable(l) && readable(l)),
      (rule) => {
        const w = would[rule];
        if (!w) return;
        w.ticks += 1;
        w.conversations.add(conversationId);
      },
    );
    for (const l of newestFirst) {
      if (comparable(l)) {
        if (readable(l)) ticksUsed += 1;
        else ticksUnreadable += 1;
      }
      if (storedMark === null || l.block !== storedMark) continue;
      ticksStoredBlock += 1;
      for (const rule of ranRules(l.actions)) {
        const a = acted[rule];
        if (!a) continue;
        a.ticks += 1;
        a.conversations.add(conversationId);
      }
    }
  }

  const listed = (set: Set<bigint>) =>
    order.filter((id) => set.has(id)).map(String);
  return {
    window: REPLAY_WINDOW,
    ticksUsed,
    ticksNotComparable: lines.length - ticksUsed - ticksUnreadable,
    ticksUnreadable,
    ticksStoredBlock,
    storedBlock: storedMark,
    questionsChanged: storedQuestions !== draftQuestions,
    rules: config.rules.map((r, i) => ({
      rule: i,
      tool: r.action.tool,
      args: r.action.args,
      would: {
        conversations: listed(would[i]?.conversations ?? new Set()),
        ticks: would[i]?.ticks ?? 0,
      },
    })),
    stored: storedRules.map((r, i) => ({
      rule: i,
      tool: r.action.tool,
      args: r.action.args,
      acted: {
        conversations: listed(acted[i]?.conversations ?? new Set()),
        ticks: acted[i]?.ticks ?? 0,
      },
    })),
  };
}

// One conversation's ticks, oldest first, with the trigger state simulated from an empty start: a
// rule that acted latches unless it acts each time, an `on_start` rule whose conditions stop holding
// is released, and a `once` rule stays latched. Every fired action is taken to have run, since the
// replay asks what the rules would do, not whether a tool would accept it.
export function replayConversation(
  rules: DecisionRule[],
  ticks: readonly { answers: Record<string, DecisionAnswer> }[],
  onActed: (rule: number) => void,
): void {
  const keys = rules.map(ruleStateKey);
  const triggers = rules.map(triggerOf);
  const latched = new Set<string>();
  for (const tick of ticks) {
    const { fired, missed } = evaluateRules(
      rules,
      tick.answers,
      (rule) =>
        triggers[rule] === "each_time" || !latched.has(keys[rule] ?? ""),
    );
    for (const f of fired) {
      for (const rule of [f.rule, ...f.merged]) {
        onActed(rule);
        const key = keys[rule];
        if (key && triggers[rule] !== "each_time") latched.add(key);
      }
    }
    for (const { rule } of missed) {
      const key = keys[rule];
      if (key && triggers[rule] === "on_start") latched.delete(key);
    }
  }
}

const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

// An answer to this question as `answersForLog` writes it, with the fields `evaluateRules` reads. A
// choice must still be one of the question's options: the log cuts a long value and scrubs one that
// looks like a secret, and either would replay as "another option".
function isAnswer(q: DecisionQuestion, v: unknown): boolean {
  const a = bag(v);
  if (!a) return false;
  if (a.type === "refusal") return true;
  if (a.type !== q.type) return false;
  switch (q.type) {
    case "yes_no":
      return isNumber(a.probability);
    case "choice":
      return q.options.some((o) => o.value === a.choice);
    case "score":
      return isNumber(a.score);
  }
}

// The rules a line's actions ran: the action's own rule and the later ones merged into it.
function ranRules(actions: readonly unknown[]): number[] {
  const out: number[] = [];
  for (const raw of actions) {
    const a = bag(raw);
    if (a?.outcome !== "ran" || typeof a.rule !== "number") continue;
    out.push(a.rule);
    for (const m of Array.isArray(a.merged) ? a.merged : []) {
      if (typeof m === "number") out.push(m);
    }
  }
  return out;
}
