import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MessageState, SystemOneCaller, SystemOneRequest } from "../../src/core/types";
import { homepageHtml, privacyHtml } from "../../src/worker/pages";
import { makeMessage } from "../helpers/gmail-fixtures";
import { FakeGmailApi } from "./helpers/fake-gmail";

const PUSH_JWKS_URL = "http://jwks.test/certs";
const AUDIENCE = "https://example.workers.dev/pubsub/push";
const SERVICE_ACCOUNT = "gmail-push@dummy.iam.gserviceaccount.com";

// A stub classifier that answers "other" (no labels) for every message, so
// tests can drive Mailbox.sync() through the Worker's routes without a real
// Jev/TypeSafe call. Every question asked is recorded by subject.
class NullJev implements SystemOneCaller {
  readonly calls: string[] = [];

  async systemOne(request: SystemOneRequest): Promise<unknown> {
    this.calls.push((request.state as MessageState).subject);
    return {
      model: "jev-1.0.0",
      answers: {
        category: { choice: "other", confidence: 0.9, probabilities: {} },
        action: { noul: 0.1 },
        human: { noul: 0.1 },
      },
    };
  }
}

let sign: (claims?: Record<string, unknown>) => Promise<string>;
let restoreFetch: () => void;

// The Worker's `fetch()` route handlers and the test file run in the same
// workerd isolate (per cloudflare:test's SELF), so stubbing the global fetch
// here also intercepts jose's request for the JWKS the Worker verifies push
// tokens against.
beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";

  sign = (claims = {}) =>
    new SignJWT({
      iss: "https://accounts.google.com",
      aud: AUDIENCE,
      email: SERVICE_ACCOUNT,
      email_verified: true,
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  const originalFetch = globalThis.fetch;
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === PUSH_JWKS_URL) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };
  vi.stubGlobal("fetch", stub);
  restoreFetch = () => vi.stubGlobal("fetch", originalFetch);
});

afterAll(() => {
  restoreFetch();
});

// The Worker always talks to the single "mailbox" instance (see runCron /
// handlePush in index.ts), so every test that goes through SELF.fetch must
// seed that same instance rather than a per-test one. Sets fake deps and
// (optionally) the cursor before the route handler reaches it. Relies on the
// DO instance surviving between this call and the subsequent SELF.fetch,
// which is normal but not guaranteed (see the note in the spec's
// Worker-handlers task); it has held in local runs.
async function seedMailbox(gmail: FakeGmailApi, cursor?: string) {
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName("mailbox"));
  await runInDurableObject(stub, async (instance, state) => {
    if (cursor !== undefined) await state.storage.put("cursor", cursor);
    instance.deps = { gmail, jev: new NullJev(), now: Date.now };
  });
  return stub;
}

describe("worker routing", () => {
  it("GET /healthz returns 200", async () => {
    const response = await SELF.fetch("http://x/healthz");
    expect(response.status).toBe(200);
  });

  it("unknown routes return 404", async () => {
    const response = await SELF.fetch("http://x/nope");
    expect(response.status).toBe(404);
  });
});

describe("GET / and GET /privacy", () => {
  it("both return 200 html without auth", async () => {
    const home = await SELF.fetch("http://x/");
    const privacy = await SELF.fetch("http://x/privacy");
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(privacy.status).toBe(200);
    expect(privacy.headers.get("content-type")).toContain("text/html");
  });

  it("the homepage links to /privacy", async () => {
    const response = await SELF.fetch("http://x/");
    const body = await response.text();
    expect(body).toContain('href="/privacy"');
  });

  it("includes the verification meta tag only when SITE_VERIFICATION is set", () => {
    expect(homepageHtml({ SITE_VERIFICATION: "abc123" })).toContain(
      '<meta name="google-site-verification" content="abc123">',
    );
    expect(homepageHtml({})).not.toContain("google-site-verification");
  });

  it("shows the contact address only when CONTACT_EMAIL is set", () => {
    expect(homepageHtml({ CONTACT_EMAIL: "owner@example.com" })).toContain("owner@example.com");
    expect(homepageHtml({})).not.toContain("Contact:");
    expect(privacyHtml({ CONTACT_EMAIL: "owner@example.com" })).toContain("owner@example.com");
    expect(privacyHtml({})).not.toContain("Contact:");
  });
});

describe("POST /pubsub/push", () => {
  it("without a token returns 401", async () => {
    const response = await SELF.fetch("http://x/pubsub/push", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("with an invalid token returns 401", async () => {
    const response = await SELF.fetch("http://x/pubsub/push", {
      method: "POST",
      headers: { Authorization: "Bearer not-a-jwt" },
    });
    expect(response.status).toBe(401);
  });

  it("with a valid token runs the DO's sync and returns 204", async () => {
    const gmail = new FakeGmailApi();
    await seedMailbox(gmail, "1");
    const token = await sign();
    const response = await SELF.fetch("http://x/pubsub/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: { data: btoa(JSON.stringify({ emailAddress: "me@example.com", historyId: "1" })) },
      }),
    });
    expect(response.status).toBe(204);
    expect(gmail.calls.map((c) => c.method)).toContain("listHistory");
  });

  it("a malformed body with a valid token still returns 204 and syncs from the stored cursor", async () => {
    const gmail = new FakeGmailApi();
    await seedMailbox(gmail, "1");
    const token = await sign();
    const response = await SELF.fetch("http://x/pubsub/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "not json",
    });
    expect(response.status).toBe(204);
    expect(gmail.calls.map((c) => c.method)).toContain("listHistory");
  });
});

describe("truncated sync drains through the alarm", () => {
  it("keeps rescheduling itself until the backlog is empty, then stops", async () => {
    const gmail = new FakeGmailApi();
    const jev = new NullJev();
    const messagesAdded: Array<{ id: string; threadId: string; labelIds: string[] }> = [];
    for (let i = 0; i < 45; i++) {
      const id = `msg-${i}`;
      const subject = `sub-${i}`;
      gmail.messages.set(
        id,
        makeMessage({ id, headers: [{ name: "Subject", value: subject }], text: "x" }),
      );
      messagesAdded.push({ id, threadId: id, labelIds: ["INBOX"] });
    }
    gmail.history = { historyId: "10", messagesAdded };

    const stub = env.MAILBOX.get(env.MAILBOX.idFromName("mailbox"));
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("cursor", "1");
      instance.deps = { gmail, jev, now: Date.now };
    });

    const token = await sign();
    const response = await SELF.fetch("http://x/pubsub/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: {
          data: btoa(JSON.stringify({ emailAddress: "me@example.com", historyId: "10" })),
        },
      }),
    });
    expect(response.status).toBe(204);

    // Round 1 (20 of 45) ran inside the push above and left an alarm behind.
    expect(await runDurableObjectAlarm(stub)).toBe(true); // round 2: 20 more, still truncated
    expect(await runDurableObjectAlarm(stub)).toBe(true); // round 3: last 5, not truncated
    expect(await runDurableObjectAlarm(stub)).toBe(false); // nothing left scheduled

    expect(jev.calls).toHaveLength(45);
    expect(new Set(jev.calls).size).toBe(45);
  });
});

describe("POST /admin/cron", () => {
  it("without a token returns 401", async () => {
    const response = await SELF.fetch("http://x/admin/cron", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("with the wrong token returns 401", async () => {
    const response = await SELF.fetch("http://x/admin/cron", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
  });

  it("with the right token runs watch and sync and returns 200 JSON", async () => {
    const gmail = new FakeGmailApi();
    await seedMailbox(gmail, "1");
    const response = await SELF.fetch("http://x/admin/cron", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { watch: unknown; sync: unknown };
    expect(body.watch).toBeDefined();
    expect(body.sync).toBeDefined();
    expect(gmail.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining(["watch", "listHistory"]),
    );
  });
});
