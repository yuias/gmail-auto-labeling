import { DurableObject } from "cloudflare:workers";
import { loadConfig } from "../core/config";
import { classify } from "../core/jev";
import { createJevCaller } from "../core/jev-sdk";
import { log } from "../core/log";
import { selectLabels } from "../core/select";
import { buildState } from "../core/state";
import type { LabelConfig, SystemOneCaller } from "../core/types";
import { type GmailApi, GmailApiError, GmailClient } from "../gmail/client";
import { refreshAccessToken } from "../gmail/oauth";
import type { GmailMessage, HistoryResult } from "../gmail/types";
import type { Env } from "./env";
import { StoredTokenSource } from "./token-source";

// System label ids that mark a message as never belonging to the inbox
// stream we classify: outgoing, unfinished, or moved out.
const EXCLUDED_LABEL_IDS = new Set(["SENT", "DRAFT", "SPAM", "TRASH"]);

const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// A message that keeps failing is quarantined (marked processed without
// labeling) after this many failed attempts, so a permanently broken message
// costs at most this many Jev calls instead of blocking the mailbox forever.
const QUARANTINE_THRESHOLD = 3;

// Upper bound on messages handled per sync() run, so a large backlog cannot
// run past the Pub/Sub push ack deadline. A capped run does not advance the
// cursor; the next redelivery or cron tick picks up where it left off.
const MAX_MESSAGES_PER_SYNC = 20;

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
  // Present (and true) only when the run stopped early at
  // MAX_MESSAGES_PER_SYNC; absent otherwise so existing callers/tests that
  // compare the full result shape are unaffected.
  truncated?: boolean;
}

interface ProcessMessageResult {
  labeled: boolean;
  // The label map processMessage finished with (rebuilt or unchanged), so
  // the caller can reuse it for the rest of the batch instead of every
  // message discovering the same stale entry on its own.
  labels: Record<string, string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS failures (message_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, last_error_at INTEGER NOT NULL)",
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
    return this.run(() => this.syncLocked());
  }

  private async syncLocked(): Promise<SyncResult> {
    const cursor = await this.ctx.storage.get<string>("cursor");
    if (!cursor) {
      const profile = await this.deps.gmail.getProfile();
      await this.ctx.storage.put("cursor", profile.historyId);
      log("cursor_init", { historyId: profile.historyId });
      return {
        status: "uninitialized",
        cursor: profile.historyId,
        processed: 0,
        skipped: 0,
        labeled: 0,
      };
    }

    let history: HistoryResult;
    try {
      history = await this.deps.gmail.listHistory({
        startHistoryId: cursor,
        labelId: "INBOX",
        historyTypes: ["messageAdded"],
      });
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        const profile = await this.deps.gmail.getProfile();
        await this.ctx.storage.put("cursor", profile.historyId);
        log("cursor_reset", { old: cursor, new: profile.historyId });
        return { status: "reset", cursor: profile.historyId, processed: 0, skipped: 0, labeled: 0 };
      }
      throw error;
    }

    let labels = await this.ensureLabelIds();
    const self = await this.ensureSelfAddress();

    let processed = 0;
    let skipped = 0;
    let labeled = 0;
    let attempted = 0;
    let truncated = false;
    for (const message of history.messagesAdded) {
      if (message.labelIds.some((id) => EXCLUDED_LABEL_IDS.has(id))) {
        skipped++;
        continue;
      }
      if (this.isProcessed(message.id)) {
        skipped++;
        continue;
      }
      if (attempted >= MAX_MESSAGES_PER_SYNC) {
        truncated = true;
        break;
      }
      attempted++;

      try {
        const result = await this.processMessage(message.id, labels, self);
        labels = result.labels;
        if (result.labeled) labeled++;
        this.clearFailure(message.id);
      } catch (error) {
        const attempts = this.recordFailure(message.id);
        if (attempts < QUARANTINE_THRESHOLD) throw error;
        // Bounded at QUARANTINE_THRESHOLD Jev/Gmail calls: mark it processed
        // so it is never retried, and move on instead of blocking the
        // mailbox on one permanently broken message.
        log("quarantined", { id: message.id, attempts, error: errorMessage(error) });
        this.markProcessed(message.id);
        processed++;
        continue;
      }
      processed++;
    }

    if (truncated) {
      // Cursor stays put: the next redelivery or cron run re-lists from the
      // same startHistoryId and skips the ids already in `processed`.
      return { status: "ok", cursor, processed, skipped, labeled, truncated: true };
    }

    // Cursor and prune only run once every message in the batch has
    // succeeded (or been quarantined); a rethrow above leaves both untouched
    // for the next attempt.
    await this.ctx.storage.put("cursor", history.historyId);
    this.pruneProcessed();
    this.pruneFailures();

    return { status: "ok", cursor: history.historyId, processed, skipped, labeled };
  }

  // Not run through the mutex: called from inside syncLocked(), which
  // already holds it.
  private async processMessage(
    id: string,
    labels: Record<string, string>,
    self: string,
  ): Promise<ProcessMessageResult> {
    let message: GmailMessage;
    try {
      message = await this.deps.gmail.getMessage(id);
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        log("message_gone", { id });
        this.markProcessed(id);
        return { labeled: false, labels };
      }
      throw error;
    }

    const state = buildState(message, { selfAddress: self, maxChars: this.config.body.maxChars });
    const result = await classify(this.deps.jev, state, this.config);
    const names = selectLabels(result, this.config);

    let currentLabels = labels;
    if (names.length > 0) {
      const ids = names.map((name) => currentLabels[name]);
      try {
        await this.deps.gmail.modifyMessage(id, ids);
      } catch (error) {
        // A 400/404 here means a configured label was deleted out from
        // under us; rebuild the cache once and retry with fresh ids.
        if (error instanceof GmailApiError && (error.status === 400 || error.status === 404)) {
          currentLabels = await this.rebuildLabelIds();
          await this.deps.gmail.modifyMessage(
            id,
            names.map((name) => currentLabels[name]),
          );
        } else {
          throw error;
        }
      }
    }

    // Recorded only after modifyMessage succeeded (or no labels were
    // needed), so a failed modify leaves the message eligible for retry.
    this.markProcessed(id);
    log("labeled", {
      id,
      labels: names,
      model: result.model,
      choice: result.category.choice,
      confidence: result.category.confidence,
    });
    return { labeled: names.length > 0, labels: currentLabels };
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
    // A missing or non-string entry is treated as a cache miss so a corrupt
    // cache can never send a junk id to modifyMessage.
    if (cached && names.every((name) => typeof cached[name] === "string")) {
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

  // Increments (or creates) the attempt count for a failed message and
  // returns the new count.
  private recordFailure(id: string): number {
    this.ctx.storage.sql.exec(
      "INSERT INTO failures (message_id, attempts, last_error_at) VALUES (?, 1, ?) " +
        "ON CONFLICT(message_id) DO UPDATE SET attempts = attempts + 1, last_error_at = excluded.last_error_at",
      id,
      this.deps.now(),
    );
    const row = this.ctx.storage.sql
      .exec<{ attempts: number }>("SELECT attempts FROM failures WHERE message_id = ?", id)
      .one();
    return row.attempts;
  }

  private clearFailure(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM failures WHERE message_id = ?", id);
  }

  private pruneFailures(): void {
    const cutoff = this.deps.now() - PROCESSED_TTL_MS;
    this.ctx.storage.sql.exec("DELETE FROM failures WHERE last_error_at < ?", cutoff);
  }
}
