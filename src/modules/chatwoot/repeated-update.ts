import { createHash } from "node:crypto";
import type { NormalizedChatwootEvent } from "./types";

// A `message_updated` of the business's own message whose payload repeats, field for field, the last
// payload of that same message this process processed on the same bot route: a delivery receipt
// (`source_id`, delivered, read). The wire names neither the status nor what changed, so the question
// asked is whether the update carries anything an already processed payload of the message did not.
// Nothing here reads the mirror: a payload that differs in anything meaningful is processed, and one
// that does not has nothing to write that was not written. docs/chatwoot.md, "Webhook receiver", 3a.

// How many messages, and separately conversations, are remembered: one key and one digest each
// (about 150 bytes), oldest out first.
export const REPEATED_UPDATE_MESSAGES_MAX = 20_000;

// Per message and route, the last payload processed; per conversation, the last payload mirrored.
interface Store {
  messages: Map<string, string>;
  conversations: Map<string, string>;
}

const KEY = Symbol.for("fazerai.chatwoot.repeatedUpdates.v2");

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  const held = g[KEY];
  if (
    !held ||
    !(held.messages instanceof Map) ||
    !(held.conversations instanceof Map)
  ) {
    g[KEY] = { messages: new Map(), conversations: new Map() };
  }
  return g[KEY] as Store;
}

// Re-inserted so the most recently written key is the last evicted.
function setBounded(map: Map<string, string>, key: string, value: string) {
  map.delete(key);
  map.set(key, value);
  while (map.size > REPEATED_UPDATE_MESSAGES_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

const conversationKey = (
  tenantId: bigint,
  instanceId: bigint,
  conversationId: number,
) => `${tenantId}:${instanceId}:${conversationId}`;

// Left out: only what carries nothing the mirror or the agent reads. The conversation's version and
// activity stay in: they are the positions the mirror orders by, so a dropped update is an exact repeat
// of a payload already applied, at the same positions. Delivery status and `source_id` are not normalized.
function payloadDigest(n: NormalizedChatwootEvent): string {
  const {
    event: _event, // names the dispatch (created or updated), not the state
    changedAttributes: _changed, // never sent with `message_updated`
    factsOnCreateOnly: _createOnly, // set only on a recovery's rebuilt body, never on the wire
    createActivityAt: _createAt, // same
    ...meaningful
  } = n;
  return createHash("sha256")
    .update(
      JSON.stringify(meaningful, (_k, v) =>
        typeof v === "bigint" ? `${v}n` : v,
      ),
    )
    .digest("base64");
}

function recordKey(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number,
  messageId: number,
): string {
  return `${tenantId}:${instanceId}:${agentBotId}:${messageId}`;
}

// The business's own message, the only kind a repeat is dropped for and so the only kind recorded.
function businessMessageId(n: NormalizedChatwootEvent): number | null {
  const m = n.message;
  if (m === undefined || m.id === null) return null;
  return m.messageType === "outgoing" || m.messageType === "template"
    ? m.id
    : null;
}

// Whether this delivery may be acked and dropped before the ledger row.
export function isRepeatedMessageUpdate(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number,
  n: NormalizedChatwootEvent,
): boolean {
  if (n.event !== "message_updated") return false;
  const id = businessMessageId(n);
  if (id === null || n.message?.externalError) return false;
  // A Chatwoot before 4.0.2 sends no version: equal payloads can be two transitions (open, resolved,
  // open again), and each is mirrored, as `mirrorOncePerEvent` does.
  if (n.conversationUpdatedAt == null || n.conversationId === null) {
    return false;
  }
  const s = store();
  const seen = s.messages.get(recordKey(tenantId, instanceId, agentBotId, id));
  if (seen === undefined) return false;
  const digest = payloadDigest(n);
  // The last payload mirrored for the conversation must be this same one: a payload of another
  // message in between can have written a shared row (inbox name, contact, card) at the same
  // positions, which this repeat would write back.
  return (
    seen === digest &&
    s.conversations.get(
      conversationKey(tenantId, instanceId, n.conversationId),
    ) === digest
  );
}

// Every mirror run of a conversation, whatever the event, route or path (live, drained, recovered).
export function noteMirrored(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
): void {
  if (n.conversationId === null) return;
  setBounded(
    store().conversations,
    conversationKey(tenantId, instanceId, n.conversationId),
    payloadDigest(n),
  );
}

// Taken when the delivery starts processing; the returned function records it, and is called only
// once the delivery was processed on this route with its mirror fully applied.
export function recordOnSuccess(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number | null,
  n: NormalizedChatwootEvent,
): () => void {
  const id = businessMessageId(n);
  if (agentBotId === null || id === null) return () => {};
  const key = recordKey(tenantId, instanceId, agentBotId, id);
  const digest = payloadDigest(n);
  return () => setBounded(store().messages, key, digest);
}

export function repeatedUpdateRecordCount(): number {
  return store().messages.size;
}

export function resetRepeatedUpdateRecords(): void {
  store().messages.clear();
  store().conversations.clear();
}
