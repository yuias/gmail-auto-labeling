import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Mailbox, MailboxDeps } from "../../src/worker/mailbox";
import { StoredTokenSource } from "../../src/worker/token-source";
import { FakeGmailApi } from "./helpers/fake-gmail";

// Each test gets its own Durable Object instance so storage does not leak
// across cases; `runInDurableObject` requires a stub pointing at one.
function freshStub(name: string) {
  const id = env.MAILBOX.idFromName(name);
  return env.MAILBOX.get(id);
}

function fakeDeps(overrides: Partial<MailboxDeps> = {}): MailboxDeps {
  return {
    gmail: new FakeGmailApi(),
    jev: { systemOne: async () => ({}) },
    now: () => Date.parse("2026-01-15T00:00:00Z"),
    ...overrides,
  };
}

describe("StoredTokenSource", () => {
  it("returns the cached token when it is not close to expiry", async () => {
    const stub = freshStub("token-cached");
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.parse("2026-01-15T00:00:00Z");
      await state.storage.put("accessToken", { token: "cached", expiresAt: now + 120_000 });
      let refreshCalls = 0;
      const source = new StoredTokenSource(
        state.storage,
        async () => {
          refreshCalls++;
          return { accessToken: "fresh", expiresAt: now + 3_600_000 };
        },
        () => now,
      );
      const token = await source.getAccessToken();
      expect(token).toBe("cached");
      expect(refreshCalls).toBe(0);
    });
  });

  it("refreshes when within 60 seconds of expiry", async () => {
    const stub = freshStub("token-near-expiry");
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.parse("2026-01-15T00:00:00Z");
      await state.storage.put("accessToken", { token: "stale", expiresAt: now + 30_000 });
      let refreshCalls = 0;
      const source = new StoredTokenSource(
        state.storage,
        async () => {
          refreshCalls++;
          return { accessToken: "fresh", expiresAt: now + 3_600_000 };
        },
        () => now,
      );
      const token = await source.getAccessToken();
      expect(token).toBe("fresh");
      expect(refreshCalls).toBe(1);
      const stored = await state.storage.get("accessToken");
      expect(stored).toEqual({ token: "fresh", expiresAt: now + 3_600_000 });
    });
  });

  it("refreshes when forced even if the cached token is still valid", async () => {
    const stub = freshStub("token-forced");
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.parse("2026-01-15T00:00:00Z");
      await state.storage.put("accessToken", { token: "cached", expiresAt: now + 3_600_000 });
      let refreshCalls = 0;
      const source = new StoredTokenSource(
        state.storage,
        async () => {
          refreshCalls++;
          return { accessToken: "forced", expiresAt: now + 3_600_000 };
        },
        () => now,
      );
      const token = await source.getAccessToken({ forceRefresh: true });
      expect(token).toBe("forced");
      expect(refreshCalls).toBe(1);
    });
  });
});

describe("Mailbox label ids", () => {
  it("ensureLabelIds creates only the missing labels and caches the map", async () => {
    const stub = freshStub("labels-missing");
    const gmail = new FakeGmailApi();
    gmail.labels = [{ id: "existing_receipt", name: "Receipt" }];
    await runInDurableObject(stub, async (instance: Mailbox) => {
      instance.deps = fakeDeps({ gmail });
      const map = await instance.ensureLabelIds();
      expect(map).toEqual({
        Receipt: "existing_receipt",
        Shipped: "label_Shipped",
        Booking: "label_Booking",
        ads: "label_ads",
        Respond: "label_Respond",
        Human: "label_Human",
      });
      const createCalls = gmail.calls.filter((c) => c.method === "createLabel");
      expect(createCalls.map((c) => c.args[0])).toEqual([
        "Shipped",
        "Booking",
        "ads",
        "Respond",
        "Human",
      ]);
      const callsAfterFirst = gmail.calls.length;

      // Cached map already has every configured name: no Gmail calls at all.
      await instance.ensureLabelIds();
      expect(gmail.calls.length).toBe(callsAfterFirst);
    });
  });

  it("treats a non-string cached label id as a cache miss and rebuilds", async () => {
    const stub = freshStub("labels-bad-cache-value");
    const gmail = new FakeGmailApi();
    gmail.labels = [
      { id: "id_receipt", name: "Receipt" },
      { id: "id_shipped", name: "Shipped" },
      { id: "id_scheduled", name: "Booking" },
      { id: "id_ads", name: "ads" },
      { id: "id_action", name: "Respond" },
      { id: "id_human", name: "Human" },
    ];
    await runInDurableObject(stub, async (instance: Mailbox, state) => {
      instance.deps = fakeDeps({ gmail });
      // A corrupt cache entry (e.g. from a schema change) should not reach
      // modifyMessage as a label id.
      await state.storage.put("labelIds", {
        Receipt: 123,
        Shipped: "id_shipped",
        Booking: "id_scheduled",
        ads: "id_ads",
        Respond: "id_action",
        Human: "id_human",
      } as unknown as Record<string, string>);

      const map = await instance.ensureLabelIds();
      expect(map.Receipt).toBe("id_receipt");
      expect(gmail.calls.filter((c) => c.method === "listLabels")).toHaveLength(1);
    });
  });

  it("rebuildLabelIds re-lists even when a cached map is present", async () => {
    const stub = freshStub("labels-rebuild");
    const gmail = new FakeGmailApi();
    gmail.labels = [
      { id: "id_receipt", name: "Receipt" },
      { id: "id_shipped", name: "Shipped" },
      { id: "id_scheduled", name: "Booking" },
      { id: "id_ads", name: "ads" },
      { id: "id_action", name: "Respond" },
      { id: "id_human", name: "Human" },
    ];
    await runInDurableObject(stub, async (instance: Mailbox) => {
      instance.deps = fakeDeps({ gmail });
      await instance.ensureLabelIds();
      expect(gmail.calls.filter((c) => c.method === "listLabels")).toHaveLength(1);

      await instance.rebuildLabelIds();
      expect(gmail.calls.filter((c) => c.method === "listLabels")).toHaveLength(2);
    });
  });
});

describe("Mailbox processed set", () => {
  it("markProcessed + isProcessed round-trip, and pruneProcessed drops entries older than 7 days", async () => {
    const stub = freshStub("processed-ttl");
    const dayMs = 24 * 60 * 60 * 1000;
    let now = Date.parse("2026-01-15T00:00:00Z");
    await runInDurableObject(stub, async (instance: Mailbox) => {
      instance.deps = fakeDeps({ now: () => now });

      expect(instance.isProcessed("old-message")).toBe(false);
      instance.markProcessed("old-message");
      expect(instance.isProcessed("old-message")).toBe(true);

      now += 8 * dayMs;
      instance.markProcessed("recent-message");
      expect(instance.isProcessed("recent-message")).toBe(true);

      instance.pruneProcessed();
      expect(instance.isProcessed("old-message")).toBe(false);
      expect(instance.isProcessed("recent-message")).toBe(true);
    });
  });
});

describe("Mailbox renewWatch", () => {
  it("calls watch with the configured topic and INBOX/INCLUDE, and sets the cursor only when absent", async () => {
    const stub = freshStub("watch-init-cursor");
    const gmail = new FakeGmailApi();
    gmail.watchResult = { historyId: "999", expiration: "1234567890" };
    const result = await runInDurableObject(stub, async (instance: Mailbox, state) => {
      instance.deps = fakeDeps({ gmail });
      const watch = await instance.renewWatch();
      const watchCall = gmail.calls.find((c) => c.method === "watch");
      expect(watchCall?.args[0]).toEqual({
        topicName: env.GMAIL_TOPIC,
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      });
      const cursor = await state.storage.get("cursor");
      const watchExpiration = await state.storage.get("watchExpiration");
      return { watch, cursor, watchExpiration };
    });
    expect(result.watch).toEqual({ historyId: "999", expiration: "1234567890" });
    expect(result.cursor).toBe("999");
    expect(result.watchExpiration).toBe("1234567890");
  });

  it("does not overwrite an existing cursor", async () => {
    const stub = freshStub("watch-existing-cursor");
    const gmail = new FakeGmailApi();
    gmail.watchResult = { historyId: "999", expiration: "1234567890" };
    const cursor = await runInDurableObject(stub, async (instance: Mailbox, state) => {
      await state.storage.put("cursor", "555");
      instance.deps = fakeDeps({ gmail });
      await instance.renewWatch();
      return state.storage.get("cursor");
    });
    expect(cursor).toBe("555");
  });
});
