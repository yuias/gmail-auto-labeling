import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageState, SystemOneCaller, SystemOneRequest } from "../../src/core/types";
import { GmailApiError } from "../../src/gmail/client";
import type { Mailbox, MailboxDeps } from "../../src/worker/mailbox";
import { makeMessage } from "../helpers/gmail-fixtures";
import { FakeGmailApi } from "./helpers/fake-gmail";

// Each test gets its own Durable Object instance so storage does not leak
// across cases; `runInDurableObject` requires a stub pointing at one.
function freshStub(name: string) {
  const id = env.MAILBOX.idFromName(name);
  return env.MAILBOX.get(id);
}

const NOW = Date.parse("2026-01-15T00:00:00Z");

// Dispatches a canned Jev response by the message subject (the fixtures below
// give every message a distinct one) and records every call it saw.
class StubJev implements SystemOneCaller {
  calls: string[] = [];
  constructor(private readonly responses: Record<string, unknown>) {}

  async systemOne(request: SystemOneRequest): Promise<unknown> {
    const subject = (request.state as MessageState).subject;
    this.calls.push(subject);
    const response = this.responses[subject];
    if (!response) throw new Error(`stub jev: no response for subject "${subject}"`);
    return response;
  }
}

function rawResponse(opts: {
  choice: string;
  probabilities: Record<string, number>;
  flags?: Record<string, number>;
  model?: string;
}) {
  return {
    model: opts.model ?? "jev-1.0.0",
    answers: {
      category: { choice: opts.choice, confidence: 0.9, probabilities: opts.probabilities },
      action: { noul: opts.flags?.action ?? 0.1 },
      human: { noul: opts.flags?.human ?? 0.1 },
    },
  };
}

function fakeDeps(overrides: Partial<MailboxDeps> = {}): MailboxDeps {
  return {
    gmail: new FakeGmailApi(),
    jev: new StubJev({}),
    now: () => NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Mailbox sync: uninitialized", () => {
  it("initializes the cursor from the profile and calls nothing else", async () => {
    const stub = freshStub("sync-uninitialized");
    const gmail = new FakeGmailApi();
    gmail.profile = { emailAddress: "me@example.com", historyId: "42" };
    const result = await runInDurableObject(stub, async (instance: Mailbox) => {
      instance.deps = fakeDeps({ gmail });
      return instance.sync();
    });
    expect(result).toEqual({
      status: "uninitialized",
      cursor: "42",
      processed: 0,
      skipped: 0,
      labeled: 0,
    });
    expect(gmail.calls.map((c) => c.method)).toEqual(["getProfile"]);
  });
});

describe("Mailbox sync: labeling", () => {
  it("fetches, classifies, and modifies two new messages, then advances the cursor", async () => {
    const stub = freshStub("sync-two-messages");
    const gmail = new FakeGmailApi();
    gmail.messages.set(
      "msg-1",
      makeMessage({
        id: "msg-1",
        headers: [{ name: "Subject", value: "receipt-subject" }],
        text: "thanks",
      }),
    );
    gmail.messages.set(
      "msg-2",
      makeMessage({
        id: "msg-2",
        headers: [{ name: "Subject", value: "shipped-subject" }],
        text: "on its way",
      }),
    );
    gmail.history = {
      historyId: "10",
      messagesAdded: [
        { id: "msg-1", threadId: "msg-1", labelIds: ["INBOX"] },
        { id: "msg-2", threadId: "msg-2", labelIds: ["INBOX"] },
      ],
    };
    const jev = new StubJev({
      "receipt-subject": rawResponse({ choice: "receipt", probabilities: { receipt: 0.9 } }),
      "shipped-subject": rawResponse({ choice: "shipped", probabilities: { shipped: 0.9 } }),
    });

    const result = await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      instance.deps = fakeDeps({ gmail, jev });
      return instance.sync();
    });

    expect(result).toEqual({ status: "ok", cursor: "10", processed: 2, skipped: 0, labeled: 2 });
    expect(jev.calls).toEqual(["receipt-subject", "shipped-subject"]);
    expect(gmail.modifiedLabels.get("msg-1")).toEqual(["label_Receipt"]);
    expect(gmail.modifiedLabels.get("msg-2")).toEqual(["label_Shipped"]);

    const cursor = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.get("cursor"),
    );
    expect(cursor).toBe("10");
  });

  it("skips SENT messages and already-processed ids without calling Jev", async () => {
    const stub = freshStub("sync-skip");
    const gmail = new FakeGmailApi();
    gmail.messages.set(
      "msg-new",
      makeMessage({
        id: "msg-new",
        headers: [{ name: "Subject", value: "receipt-subject" }],
        text: "x",
      }),
    );
    gmail.history = {
      historyId: "10",
      messagesAdded: [
        { id: "msg-sent", threadId: "msg-sent", labelIds: ["SENT"] },
        { id: "msg-done", threadId: "msg-done", labelIds: ["INBOX"] },
        { id: "msg-new", threadId: "msg-new", labelIds: ["INBOX"] },
      ],
    };
    const jev = new StubJev({
      "receipt-subject": rawResponse({ choice: "receipt", probabilities: { receipt: 0.9 } }),
    });

    const result = await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      instance.markProcessed("msg-done");
      instance.deps = fakeDeps({ gmail, jev });
      return instance.sync();
    });

    expect(result).toEqual({ status: "ok", cursor: "10", processed: 1, skipped: 2, labeled: 1 });
    expect(jev.calls).toEqual(["receipt-subject"]);
    expect(gmail.calls.some((c) => c.method === "getMessage" && c.args[0] === "msg-sent")).toBe(
      false,
    );
    expect(gmail.calls.some((c) => c.method === "getMessage" && c.args[0] === "msg-done")).toBe(
      false,
    );
  });

  it("records a message with an empty label selection without calling modifyMessage", async () => {
    const stub = freshStub("sync-empty-selection");
    const gmail = new FakeGmailApi();
    gmail.messages.set(
      "msg-1",
      makeMessage({
        id: "msg-1",
        headers: [{ name: "Subject", value: "other-subject" }],
        text: "hi",
      }),
    );
    gmail.history = {
      historyId: "10",
      messagesAdded: [{ id: "msg-1", threadId: "msg-1", labelIds: ["INBOX"] }],
    };
    const jev = new StubJev({
      "other-subject": rawResponse({ choice: "other", probabilities: {} }),
    });

    const [result, processed] = await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      instance.deps = fakeDeps({ gmail, jev });
      const r = await instance.sync();
      return [r, instance.isProcessed("msg-1")];
    });

    expect(result).toEqual({ status: "ok", cursor: "10", processed: 1, skipped: 0, labeled: 0 });
    expect(processed).toBe(true);
    expect(gmail.calls.some((c) => c.method === "modifyMessage")).toBe(false);
  });

  it("records a gone (404) message and skips it without modifying", async () => {
    const stub = freshStub("sync-message-gone");
    const gmail = new FakeGmailApi();
    // No entry in gmail.messages: getMessage() throws its built-in 404.
    gmail.history = {
      historyId: "10",
      messagesAdded: [{ id: "msg-gone", threadId: "msg-gone", labelIds: ["INBOX"] }],
    };
    const jev = new StubJev({});

    const [result, processed] = await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      instance.deps = fakeDeps({ gmail, jev });
      const r = await instance.sync();
      return [r, instance.isProcessed("msg-gone")];
    });

    expect(result).toEqual({ status: "ok", cursor: "10", processed: 1, skipped: 0, labeled: 0 });
    expect(processed).toBe(true);
    expect(jev.calls).toEqual([]);
    expect(gmail.calls.some((c) => c.method === "modifyMessage")).toBe(false);
  });
});

describe("Mailbox sync: failure handling", () => {
  it("leaves a failed modifyMessage unrecorded, rejects sync, and keeps the earlier message recorded", async () => {
    const stub = freshStub("sync-modify-500");
    const gmail = new FakeGmailApi();
    gmail.messages.set(
      "msg-1",
      makeMessage({
        id: "msg-1",
        headers: [{ name: "Subject", value: "receipt-subject" }],
        text: "a",
      }),
    );
    gmail.messages.set(
      "msg-2",
      makeMessage({
        id: "msg-2",
        headers: [{ name: "Subject", value: "shipped-subject" }],
        text: "b",
      }),
    );
    gmail.history = {
      historyId: "10",
      messagesAdded: [
        { id: "msg-1", threadId: "msg-1", labelIds: ["INBOX"] },
        { id: "msg-2", threadId: "msg-2", labelIds: ["INBOX"] },
      ],
    };
    gmail.failNext(
      "modifyMessage",
      new GmailApiError(500, "server error", "/messages/msg-2/modify"),
      "msg-2",
    );
    const jev = new StubJev({
      "receipt-subject": rawResponse({ choice: "receipt", probabilities: { receipt: 0.9 } }),
      "shipped-subject": rawResponse({ choice: "shipped", probabilities: { shipped: 0.9 } }),
    });

    const [processed1, processed2, cursor] = await runInDurableObject(
      stub,
      async (instance: Mailbox, state) => {
        await state.storage.put("cursor", "1");
        instance.deps = fakeDeps({ gmail, jev });
        await expect(instance.sync()).rejects.toThrow(/500/);
        return [
          instance.isProcessed("msg-1"),
          instance.isProcessed("msg-2"),
          state.storage.get("cursor"),
        ];
      },
    );

    expect(processed1).toBe(true);
    expect(processed2).toBe(false);
    expect(await cursor).toBe("1");
  });

  it("resets the cursor from the profile when listHistory 404s", async () => {
    const stub = freshStub("sync-history-reset");
    const gmail = new FakeGmailApi();
    gmail.profile = { emailAddress: "me@example.com", historyId: "999" };
    gmail.failNext("listHistory", new GmailApiError(404, "history gone", "/history"));

    const result = await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      instance.deps = fakeDeps({ gmail });
      return instance.sync();
    });

    expect(result).toEqual({
      status: "reset",
      cursor: "999",
      processed: 0,
      skipped: 0,
      labeled: 0,
    });
    const cursor = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.get("cursor"),
    );
    expect(cursor).toBe("999");
  });

  it("rebuilds the label map and retries once on a modifyMessage 400 (a deleted label)", async () => {
    const stub = freshStub("sync-modify-400-rebuild");
    const gmail = new FakeGmailApi();
    // Gmail's current labels (as if Receipt was deleted and recreated under a
    // new id since the DO's cache was built).
    gmail.labels = [
      { id: "label_Receipt_new", name: "Receipt" },
      { id: "label_Shipped", name: "Shipped" },
      { id: "label_Booking", name: "Booking" },
      { id: "label_ads", name: "ads" },
      { id: "label_Respond", name: "Respond" },
      { id: "label_Human", name: "Human" },
    ];
    gmail.messages.set(
      "msg-1",
      makeMessage({
        id: "msg-1",
        headers: [{ name: "Subject", value: "receipt-subject" }],
        text: "a",
      }),
    );
    gmail.history = {
      historyId: "10",
      messagesAdded: [{ id: "msg-1", threadId: "msg-1", labelIds: ["INBOX"] }],
    };
    gmail.failNext(
      "modifyMessage",
      new GmailApiError(400, "unknown label id", "/messages/msg-1/modify"),
      "msg-1",
    );
    const jev = new StubJev({
      "receipt-subject": rawResponse({ choice: "receipt", probabilities: { receipt: 0.9 } }),
    });

    const result = await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      // The DO's stale cache, since every configured name is present
      // ensureLabelIds() returns it as-is without listing labels first.
      await state.storage.put("labelIds", {
        Receipt: "label_Receipt_stale",
        Shipped: "label_Shipped",
        Booking: "label_Booking",
        ads: "label_ads",
        Respond: "label_Respond",
        Human: "label_Human",
      });
      instance.deps = fakeDeps({ gmail, jev });
      return instance.sync();
    });

    expect(result).toEqual({ status: "ok", cursor: "10", processed: 1, skipped: 0, labeled: 1 });
    const modifyCalls = gmail.calls.filter((c) => c.method === "modifyMessage");
    expect(modifyCalls).toHaveLength(2);
    expect(modifyCalls[0]?.args).toEqual(["msg-1", ["label_Receipt_stale"]]);
    expect(modifyCalls[1]?.args).toEqual(["msg-1", ["label_Receipt_new"]]);
    // listLabels ran between the two attempts, as part of the rebuild.
    const modifyIndexes = gmail.calls
      .map((c, i) => (c.method === "modifyMessage" ? i : -1))
      .filter((i) => i >= 0);
    const listLabelsIndex = gmail.calls.findIndex((c) => c.method === "listLabels");
    expect(listLabelsIndex).toBeGreaterThan(modifyIndexes[0] ?? -1);
    expect(listLabelsIndex).toBeLessThan(modifyIndexes[1] ?? Number.POSITIVE_INFINITY);
  });

  it("shares one rebuilt label map across the rest of the batch instead of rebuilding per message", async () => {
    const stub = freshStub("sync-shared-rebuild");
    const gmail = new FakeGmailApi();
    gmail.labels = [
      { id: "label_Receipt_new", name: "Receipt" },
      { id: "label_Shipped", name: "Shipped" },
      { id: "label_Booking", name: "Booking" },
      { id: "label_ads", name: "ads" },
      { id: "label_Respond", name: "Respond" },
      { id: "label_Human", name: "Human" },
    ];
    // A deleted label id, still cached, fails modifyMessage no matter which
    // message sends it.
    gmail.staleLabelIds.add("label_Receipt_stale");
    gmail.messages.set(
      "msg-1",
      makeMessage({
        id: "msg-1",
        headers: [{ name: "Subject", value: "receipt-subject-1" }],
        text: "a",
      }),
    );
    gmail.messages.set(
      "msg-2",
      makeMessage({
        id: "msg-2",
        headers: [{ name: "Subject", value: "receipt-subject-2" }],
        text: "b",
      }),
    );
    gmail.history = {
      historyId: "10",
      messagesAdded: [
        { id: "msg-1", threadId: "msg-1", labelIds: ["INBOX"] },
        { id: "msg-2", threadId: "msg-2", labelIds: ["INBOX"] },
      ],
    };
    const jev = new StubJev({
      "receipt-subject-1": rawResponse({ choice: "receipt", probabilities: { receipt: 0.9 } }),
      "receipt-subject-2": rawResponse({ choice: "receipt", probabilities: { receipt: 0.9 } }),
    });

    const result = await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      await state.storage.put("labelIds", {
        Receipt: "label_Receipt_stale",
        Shipped: "label_Shipped",
        Booking: "label_Booking",
        ads: "label_ads",
        Respond: "label_Respond",
        Human: "label_Human",
      });
      instance.deps = fakeDeps({ gmail, jev });
      return instance.sync();
    });

    expect(result).toEqual({ status: "ok", cursor: "10", processed: 2, skipped: 0, labeled: 2 });
    expect(gmail.modifiedLabels.get("msg-1")).toEqual(["label_Receipt_new"]);
    expect(gmail.modifiedLabels.get("msg-2")).toEqual(["label_Receipt_new"]);
    // msg-1 pays for the rebuild; msg-2 reuses the already-fresh map and
    // succeeds on its first attempt, so only one rebuild happens for the
    // whole batch.
    expect(gmail.calls.filter((c) => c.method === "listLabels")).toHaveLength(1);
    const modifyCalls = gmail.calls.filter((c) => c.method === "modifyMessage");
    expect(modifyCalls).toHaveLength(3);
  });
});

describe("Mailbox sync: repeated failures", () => {
  it("quarantines a message after three failed attempts and advances past it", async () => {
    const stub = freshStub("sync-quarantine");
    const gmail = new FakeGmailApi();
    gmail.messages.set(
      "msg-early",
      makeMessage({
        id: "msg-early",
        headers: [{ name: "Subject", value: "receipt-subject" }],
        text: "a",
      }),
    );
    gmail.messages.set(
      "msg-bad",
      makeMessage({
        id: "msg-bad",
        headers: [{ name: "Subject", value: "shipped-subject" }],
        text: "b",
      }),
    );
    gmail.messages.set(
      "msg-late",
      makeMessage({
        id: "msg-late",
        headers: [{ name: "Subject", value: "scheduled-subject" }],
        text: "c",
      }),
    );
    gmail.history = {
      historyId: "10",
      messagesAdded: [
        { id: "msg-early", threadId: "msg-early", labelIds: ["INBOX"] },
        { id: "msg-bad", threadId: "msg-bad", labelIds: ["INBOX"] },
        { id: "msg-late", threadId: "msg-late", labelIds: ["INBOX"] },
      ],
    };
    const jev = new StubJev({
      "receipt-subject": rawResponse({ choice: "receipt", probabilities: { receipt: 0.9 } }),
      "shipped-subject": rawResponse({ choice: "shipped", probabilities: { shipped: 0.9 } }),
      "scheduled-subject": rawResponse({ choice: "scheduled", probabilities: { scheduled: 0.9 } }),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      instance.deps = fakeDeps({ gmail, jev });

      gmail.failNext(
        "modifyMessage",
        new GmailApiError(500, "server error", "/messages/msg-bad/modify"),
        "msg-bad",
      );
      await expect(instance.sync()).rejects.toThrow(/500/);
      expect(instance.isProcessed("msg-early")).toBe(true);
      expect(instance.isProcessed("msg-bad")).toBe(false);

      gmail.failNext(
        "modifyMessage",
        new GmailApiError(500, "server error", "/messages/msg-bad/modify"),
        "msg-bad",
      );
      await expect(instance.sync()).rejects.toThrow(/500/);
      expect(instance.isProcessed("msg-bad")).toBe(false);

      gmail.failNext(
        "modifyMessage",
        new GmailApiError(500, "server error", "/messages/msg-bad/modify"),
        "msg-bad",
      );
      const result = await instance.sync();

      expect(result).toEqual({ status: "ok", cursor: "10", processed: 2, skipped: 1, labeled: 1 });
      expect(instance.isProcessed("msg-bad")).toBe(true);
      expect(instance.isProcessed("msg-late")).toBe(true);
    });

    const quarantineLines = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .filter((line) => line.event === "quarantined");
    expect(quarantineLines).toHaveLength(1);
    expect(quarantineLines[0]).toMatchObject({ id: "msg-bad", attempts: 3 });
    expect(quarantineLines[0].error).toMatch(/500/);

    const modifyCallsForBad = gmail.calls.filter(
      (c) => c.method === "modifyMessage" && c.args[0] === "msg-bad",
    );
    expect(modifyCallsForBad).toHaveLength(3);
  });

  it("clears the failure record once a message fails once but then succeeds", async () => {
    const stub = freshStub("sync-fail-then-succeed");
    const gmail = new FakeGmailApi();
    gmail.messages.set(
      "msg-1",
      makeMessage({
        id: "msg-1",
        headers: [{ name: "Subject", value: "receipt-subject" }],
        text: "a",
      }),
    );
    gmail.history = {
      historyId: "10",
      messagesAdded: [{ id: "msg-1", threadId: "msg-1", labelIds: ["INBOX"] }],
    };
    const jev = new StubJev({
      "receipt-subject": rawResponse({ choice: "receipt", probabilities: { receipt: 0.9 } }),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      instance.deps = fakeDeps({ gmail, jev });

      gmail.failNext(
        "modifyMessage",
        new GmailApiError(500, "server error", "/messages/msg-1/modify"),
        "msg-1",
      );
      await expect(instance.sync()).rejects.toThrow(/500/);
      expect(instance.isProcessed("msg-1")).toBe(false);

      const result = await instance.sync();
      expect(result).toEqual({ status: "ok", cursor: "10", processed: 1, skipped: 0, labeled: 1 });
      expect(instance.isProcessed("msg-1")).toBe(true);

      const remaining = state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM failures")
        .one();
      expect(remaining.n).toBe(0);
    });

    const quarantineLines = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .filter((line) => line.event === "quarantined");
    expect(quarantineLines).toHaveLength(0);
  });
});

describe("Mailbox sync: batch size cap", () => {
  it("processes at most 20 messages per run, continuing from the same cursor next run", async () => {
    const stub = freshStub("sync-batch-cap");
    const gmail = new FakeGmailApi();
    const responses: Record<string, unknown> = {};
    const messagesAdded: Array<{ id: string; threadId: string; labelIds: string[] }> = [];
    for (let i = 0; i < 25; i++) {
      const id = `msg-${i}`;
      const subject = `sub-${i}`;
      gmail.messages.set(
        id,
        makeMessage({ id, headers: [{ name: "Subject", value: subject }], text: "x" }),
      );
      messagesAdded.push({ id, threadId: id, labelIds: ["INBOX"] });
      responses[subject] = rawResponse({ choice: "other", probabilities: {} });
    }
    gmail.history = { historyId: "10", messagesAdded };
    const jev = new StubJev(responses);

    const [first, second] = await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      instance.deps = fakeDeps({ gmail, jev });
      const r1 = await instance.sync();
      const r2 = await instance.sync();
      return [r1, r2];
    });

    expect(first).toEqual({
      status: "ok",
      cursor: "1",
      processed: 20,
      skipped: 0,
      labeled: 0,
      truncated: true,
    });
    expect(second).toEqual({ status: "ok", cursor: "10", processed: 5, skipped: 20, labeled: 0 });
    expect(jev.calls).toHaveLength(25);
    expect(new Set(jev.calls).size).toBe(25);
  });
});

describe("Mailbox sync: concurrency and logging", () => {
  it("serializes two concurrent sync() calls; the second sees the first's processed ids", async () => {
    const stub = freshStub("sync-concurrent");
    const gmail = new FakeGmailApi();
    gmail.messages.set(
      "msg-1",
      makeMessage({
        id: "msg-1",
        headers: [{ name: "Subject", value: "receipt-subject" }],
        text: "a",
      }),
    );
    gmail.history = {
      historyId: "10",
      messagesAdded: [{ id: "msg-1", threadId: "msg-1", labelIds: ["INBOX"] }],
    };
    const jev = new StubJev({
      "receipt-subject": rawResponse({ choice: "receipt", probabilities: { receipt: 0.9 } }),
    });

    const [first, second] = await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      instance.deps = fakeDeps({ gmail, jev });
      // Call the instance directly (bypassing the stub's input gate) so both
      // calls genuinely overlap and exercise the explicit mutex.
      return Promise.all([instance.sync(), instance.sync()]);
    });

    expect(first).toEqual({ status: "ok", cursor: "10", processed: 1, skipped: 0, labeled: 1 });
    expect(second).toEqual({ status: "ok", cursor: "10", processed: 0, skipped: 1, labeled: 0 });
    expect(jev.calls).toEqual(["receipt-subject"]);
  });

  it("logs the model for each labeled message", async () => {
    const stub = freshStub("sync-log-model");
    const gmail = new FakeGmailApi();
    gmail.messages.set(
      "msg-1",
      makeMessage({
        id: "msg-1",
        headers: [{ name: "Subject", value: "receipt-subject" }],
        text: "a",
      }),
    );
    gmail.history = {
      historyId: "10",
      messagesAdded: [{ id: "msg-1", threadId: "msg-1", labelIds: ["INBOX"] }],
    };
    const jev = new StubJev({
      "receipt-subject": rawResponse({
        choice: "receipt",
        probabilities: { receipt: 0.9 },
        model: "jev-9.9.9",
      }),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "1");
      instance.deps = fakeDeps({ gmail, jev });
      await instance.sync();
    });

    const labeledLines = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .filter((line) => line.event === "labeled");
    expect(labeledLines).toHaveLength(1);
    expect(labeledLines[0]).toMatchObject({ id: "msg-1", model: "jev-9.9.9", labels: ["Receipt"] });
  });
});
