import { beforeEach, describe, expect, test } from "bun:test";
import {
  isRepeatedMessageUpdate,
  noteMirrored,
  REPEATED_UPDATE_MESSAGES_MAX,
  recordOnSuccess,
  repeatedUpdateRecordCount,
  resetRepeatedUpdateRecords,
} from "@/modules/chatwoot/repeated-update";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";

// The record behind the receipt drop: one digest per message and route, in memory, bounded, gone on a
// restart (where a miss processes the update as before).

const event = (
  name: string,
  msg: number,
  over: Partial<NormalizedChatwootEvent> = {},
): NormalizedChatwootEvent => ({
  event: name,
  conversationId: 1,
  contactInboxId: 77,
  inboxId: 7,
  inboxName: "WhatsApp",
  status: "pending",
  conversationUpdatedAt: 1_791_000_100.5,
  lastActivityAt: 1_791_000_000,
  contact: { id: 501, name: "Cliente", phone: "+5511999990000" },
  labels: [],
  message: {
    id: msg,
    content: "resposta",
    messageType: "outgoing",
    private: false,
    externalError: null,
  },
  ...over,
});

const processed = (
  n: NormalizedChatwootEvent,
  where: { tenant?: bigint; instance?: bigint; bot?: number } = {},
) => {
  noteMirrored(where.tenant ?? 1n, where.instance ?? 1n, n);
  recordOnSuccess(
    where.tenant ?? 1n,
    where.instance ?? 1n,
    where.bot ?? 9,
    n,
  )();
};

const dropped = (
  n: NormalizedChatwootEvent,
  where: { tenant?: bigint; instance?: bigint; bot?: number } = {},
) =>
  isRepeatedMessageUpdate(
    where.tenant ?? 1n,
    where.instance ?? 1n,
    where.bot ?? 9,
    n,
  );

describe("repeated-update records", () => {
  beforeEach(() => resetRepeatedUpdateRecords());

  test("a restart forgets: the first receipt after it is processed", () => {
    processed(event("message_created", 1));
    expect(dropped(event("message_updated", 1))).toBe(true);
    resetRepeatedUpdateRecords();
    expect(dropped(event("message_updated", 1))).toBe(false);
  });

  test("the record is taken on arrival and kept only when the returned function runs", () => {
    noteMirrored(1n, 1n, event("message_created", 1));
    const record = recordOnSuccess(1n, 1n, 9, event("message_created", 1));
    expect(dropped(event("message_updated", 1))).toBe(false);
    record();
    expect(dropped(event("message_updated", 1))).toBe(true);
  });

  test("the record is bounded and evicts the least recently processed message first", () => {
    const own = (i: number, name = "message_created") =>
      event(name, i, { conversationId: i });
    const record = (i: number) => recordOnSuccess(1n, 1n, 9, own(i))();
    for (let i = 0; i <= REPEATED_UPDATE_MESSAGES_MAX; i++) {
      record(i);
      // The first message is processed again after the second, so the second is the oldest.
      if (i === 1) record(0);
    }
    expect(repeatedUpdateRecordCount()).toBe(REPEATED_UPDATE_MESSAGES_MAX);
    // Each conversation's last mirror is its own message, so only the message record decides.
    for (const i of [0, 1, REPEATED_UPDATE_MESSAGES_MAX])
      noteMirrored(1n, 1n, own(i));
    expect(dropped(own(1, "message_updated"))).toBe(false);
    expect(dropped(own(0, "message_updated"))).toBe(true);
    expect(dropped(own(REPEATED_UPDATE_MESSAGES_MAX, "message_updated"))).toBe(
      true,
    );
  });

  test("the conversations' last mirror is bounded too, oldest out first", () => {
    const own = (i: number, name = "message_created") =>
      event(name, i, { conversationId: i });
    processed(own(0));
    for (let i = 1; i <= REPEATED_UPDATE_MESSAGES_MAX; i++) {
      noteMirrored(1n, 1n, own(i));
    }
    expect(dropped(own(0, "message_updated"))).toBe(false);
  });

  test("the record is kept per tenant, instance and bot route", () => {
    processed(event("message_created", 1));
    expect(dropped(event("message_updated", 1), { tenant: 2n })).toBe(false);
    expect(dropped(event("message_updated", 1), { instance: 2n })).toBe(false);
    expect(dropped(event("message_updated", 1), { bot: 10 })).toBe(false);
  });

  test("a customer message is never recorded, and a route-less delivery records nothing", () => {
    const incoming = event("message_created", 1);
    (incoming.message as { messageType: string }).messageType = "incoming";
    processed(incoming);
    recordOnSuccess(1n, 1n, null, event("message_created", 2))();
    expect(repeatedUpdateRecordCount()).toBe(0);
  });

  // Left out of the comparison: the event's name, changed attributes, and the recovery-only markers.
  test("the event name, changed attributes and recovery markers are left out of the comparison", () => {
    processed(
      event("message_created", 1, {
        factsOnCreateOnly: true,
        createActivityAt: 1_791_000_000,
      }),
    );
    expect(
      dropped(
        event("message_updated", 1, {
          changedAttributes: [{ status: { previous_value: "sent" } }],
        }),
      ),
    ).toBe(true);
  });

  // The positions the mirror orders by are compared: a repeat at a newer position is not exact.
  test("a newer version or activity keeps the update from being dropped", () => {
    processed(event("message_created", 1));
    expect(
      dropped(
        event("message_updated", 1, {
          conversationUpdatedAt: 1_791_000_900.25,
        }),
      ),
    ).toBe(false);
    expect(
      dropped(event("message_updated", 1, { lastActivityAt: 1_791_000_800 })),
    ).toBe(false);
  });

  // Everything else is compared, including fields that only ride on other events.
  const meaningful: [string, Partial<NormalizedChatwootEvent>][] = [
    [
      "the contact identifier",
      {
        contact: {
          id: 501,
          name: "Cliente",
          phone: "+5511999990000",
          identifier: "x-1",
        },
      },
    ],
    [
      "the contact's custom attributes",
      {
        contact: {
          id: 501,
          name: "Cliente",
          phone: "+5511999990000",
          customAttributes: { plano: "pro" },
        },
      },
    ],
    ["the conversation's group type", { conversationType: "group" }],
    ["the redirect pairing", { redirectOriginDisplayId: 42 }],
    [
      "the first reply time",
      { firstReplyCreatedAt: new Date("2026-10-10T12:00:01Z") },
    ],
    [
      "the assignee's name",
      { assigneeType: "User", assigneeId: 3, assigneeName: "Pessoa" },
    ],
    ["the inbox name", { inboxName: "Vendas" }],
    ["the kanban card", { kanbanAttributes: { etapa: "proposta" } }],
    ["the labels", { labels: ["vendas"] }],
    [
      "the conversation's custom attributes",
      { customAttributes: { pedido: "1" } },
    ],
    ["the status", { status: "open" }],
  ];
  for (const [label, change] of meaningful) {
    test(`a change in ${label} keeps the update from being dropped`, () => {
      processed(event("message_created", 1));
      expect(dropped(event("message_updated", 1, change))).toBe(false);
    });
  }

  test("an attachment's metadata is compared with the message", () => {
    processed(event("message_created", 1));
    const withAudio = event("message_updated", 1);
    (withAudio.message as { attachments: unknown }).attachments = [
      {
        id: 1,
        fileType: "audio",
        dataUrl: "https://x/a.ogg",
        transcribedText: "oi",
      },
    ];
    expect(dropped(withAudio)).toBe(false);
  });

  // A payload of another message mirrored in between can have written a shared row (the inbox name,
  // the contact, the card) at the same positions: the repeat is no longer the last word.
  test("a repeat is not dropped once another payload of its conversation was mirrored after it", () => {
    processed(event("message_created", 1));
    noteMirrored(1n, 1n, event("message_updated", 2, { inboxName: "Vendas" }));
    expect(dropped(event("message_updated", 1))).toBe(false);
  });

  test("the same payload mirrored again (another route, a redelivery) keeps the repeat droppable", () => {
    processed(event("message_created", 1));
    noteMirrored(1n, 1n, event("message_created", 1));
    expect(dropped(event("message_updated", 1))).toBe(true);
  });

  test("a conversation never mirrored here drops nothing, even with a message record", () => {
    recordOnSuccess(1n, 1n, 9, event("message_created", 1))();
    expect(dropped(event("message_updated", 1))).toBe(false);
  });
});
