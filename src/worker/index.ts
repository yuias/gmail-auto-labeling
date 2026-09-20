import { log } from "../core/log";
import type { Env } from "./env";

export { Mailbox } from "./mailbox";

import { homepageHtml, privacyHtml } from "./pages";
import { extractBearer, PushAuthError, verifyPushToken } from "./pubsub-auth";

function mailboxStub(env: Env) {
  return env.MAILBOX.get(env.MAILBOX.idFromName("mailbox"));
}

// Constant-time token comparison; a length mismatch fails immediately rather
// than being padded, since the lengths of two secrets are not sensitive.
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

async function handlePush(request: Request, env: Env): Promise<Response> {
  const token = extractBearer(request);
  if (!token) {
    log("push_rejected", { reason: "missing bearer token" });
    return new Response(null, { status: 401 });
  }
  try {
    await verifyPushToken(token, {
      audience: env.PUSH_AUDIENCE,
      serviceAccount: env.PUSH_SERVICE_ACCOUNT,
      jwksUrl: env.PUSH_JWKS_URL,
    });
  } catch (error) {
    const reason = error instanceof PushAuthError ? error.message : String(error);
    log("push_rejected", { reason });
    return new Response(null, { status: 401 });
  }

  // The push body only wakes the Worker up; the cursor in Durable Object
  // storage is what drives sync(). A malformed body must not make Pub/Sub
  // redeliver forever, so it is logged and sync() still runs.
  try {
    const body = (await request.json()) as { message?: { data?: string } };
    const data = body.message?.data;
    if (data) {
      const decoded = JSON.parse(atob(data)) as { emailAddress?: string; historyId?: string };
      log("push_received", decoded);
    } else {
      log("push_malformed", {});
    }
  } catch {
    log("push_malformed", {});
  }

  try {
    // A truncated result still means the request succeeded: the Durable
    // Object has already scheduled its own alarm to drain the rest of the
    // backlog, so the push handler does not stay open for it and does not
    // answer non-2xx (which would just make Pub/Sub redeliver).
    await mailboxStub(env).sync();
  } catch (error) {
    log("push_sync_failed", { error: error instanceof Error ? error.message : String(error) });
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 204 });
}

export async function runCron(env: Env): Promise<{ watch: unknown; sync: unknown }> {
  const stub = mailboxStub(env);
  const watch = await stub.renewWatch();
  const sync = await stub.sync();
  return { watch, sync };
}

async function handleAdminCron(request: Request, env: Env): Promise<Response> {
  const token = extractBearer(request);
  if (!token || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return new Response(null, { status: 401 });
  }
  const result = await runCron(env);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    return new Response(homepageHtml(env), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (request.method === "GET" && url.pathname === "/privacy") {
    return new Response(privacyHtml(env), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (request.method === "GET" && url.pathname === "/healthz") {
    return new Response("ok", { status: 200 });
  }
  if (request.method === "POST" && url.pathname === "/pubsub/push") {
    return handlePush(request, env);
  }
  if (request.method === "POST" && url.pathname === "/admin/cron") {
    return handleAdminCron(request, env);
  }
  return new Response(null, { status: 404 });
}

export default {
  fetch,
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;
