import { DurableObject } from "cloudflare:workers";
import { loadConfig } from "../core/config";
import { createJevCaller } from "../core/jev-sdk";
import { log } from "../core/log";
import type { LabelConfig, SystemOneCaller } from "../core/types";
import { type GmailApi, GmailClient } from "../gmail/client";
import { refreshAccessToken } from "../gmail/oauth";
import type { Env } from "./env";
import { StoredTokenSource } from "./token-source";

const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MailboxDeps {
  gmail: GmailApi;
  jev: SystemOneCaller;
  now: () => number;
}

export interface SyncResult {
  status: "ok" | "reset" | "uninitialized";
  cursor: string | null;
  processed: number;
  skipped: number;
  labeled: number;
}

// SQLite-backed Durable Object that owns one mailbox's Gmail history cursor,
// label id cache, and processed-message dedup set. `deps` is built from env
// in the constructor but left mutable so tests can substitute fakes via
// runInDurableObject.
export class Mailbox extends DurableObject<Env> {
  deps: MailboxDeps;
  private readonly config: LabelConfig;

  // Durable Object input gates do not serialize across awaited fetches to
  // external services, so sync() and renewWatch() share this explicit
  // promise-chain mutex instead.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS processed (message_id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL)",
    );
    const tokens = new StoredTokenSource(ctx.storage, () =>
      refreshAccessToken(
        { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
        env.GOOGLE_REFRESH_TOKEN,
      ),
    );
    this.deps = {
      gmail: new GmailClient(tokens),
      jev: createJevCaller(env.TYPESAFE_API_KEY),
      now: Date.now,
    };
    this.config = loadConfig();
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async sync(): Promise<SyncResult> {
    return this.run(() => {
      throw new Error("not implemented");
    });
  }

  async renewWatch(): Promise<{ historyId: string; expiration: string }> {
    return this.run(() => this.renewWatchLocked());
  }

  private async renewWatchLocked(): Promise<{ historyId: string; expiration: string }> {
    const result = await this.deps.gmail.watch({
      topicName: this.env.GMAIL_TOPIC,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    });
    const cursor = await this.ctx.storage.get<string>("cursor");
    if (!cursor) {
      await this.ctx.storage.put("cursor", result.historyId);
    }
    await this.ctx.storage.put("watchExpiration", result.expiration);
    log("watch_renewed", { historyId: result.historyId, expiration: result.expiration });
    return result;
  }

  // Every configured category label (excluding the null "other" option) plus
  // every flag label, deduplicated in case a name is reused.
  private configuredLabelNames(): string[] {
    const names = new Set<string>();
    for (const option of Object.values(this.config.category.options)) {
      if (option.label !== null) names.add(option.label);
    }
    for (const flag of Object.values(this.config.flags)) {
      names.add(flag.label);
    }
    return [...names];
  }

  // Not run through the mutex: sync() calls this from inside run(), and a
  // nested lock there would deadlock.
  async ensureLabelIds(): Promise<Record<string, string>> {
    const names = this.configuredLabelNames();
    const cached = await this.ctx.storage.get<Record<string, string>>("labelIds");
    if (cached && names.every((name) => name in cached)) {
      return cached;
    }
    return this.rebuildLabelIds();
  }

  async rebuildLabelIds(): Promise<Record<string, string>> {
    await this.ctx.storage.delete("labelIds");
    const names = this.configuredLabelNames();
    const existing = await this.deps.gmail.listLabels();
    const byName = new Map(existing.map((l) => [l.name, l.id]));
    const map: Record<string, string> = {};
    for (const name of names) {
      const id = byName.get(name) ?? (await this.deps.gmail.createLabel(name)).id;
      map[name] = id;
    }
    await this.ctx.storage.put("labelIds", map);
    return map;
  }

  async ensureSelfAddress(): Promise<string> {
    const cached = await this.ctx.storage.get<string>("selfAddress");
    if (cached) return cached;
    const profile = await this.deps.gmail.getProfile();
    await this.ctx.storage.put("selfAddress", profile.emailAddress);
    return profile.emailAddress;
  }

  isProcessed(id: string): boolean {
    const rows = this.ctx.storage.sql
      .exec("SELECT 1 FROM processed WHERE message_id = ?", id)
      .toArray();
    return rows.length > 0;
  }

  markProcessed(id: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO processed (message_id, processed_at) VALUES (?, ?) " +
        "ON CONFLICT(message_id) DO UPDATE SET processed_at = excluded.processed_at",
      id,
      this.deps.now(),
    );
  }

  pruneProcessed(): void {
    const cutoff = this.deps.now() - PROCESSED_TTL_MS;
    this.ctx.storage.sql.exec("DELETE FROM processed WHERE processed_at < ?", cutoff);
  }
}
