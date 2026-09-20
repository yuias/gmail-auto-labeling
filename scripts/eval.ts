import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/core/config";
import { buildQuestions, normalizeResponse } from "../src/core/jev";
import { createJevCaller } from "../src/core/jev-sdk";
import { selectLabels } from "../src/core/select";
import { buildState } from "../src/core/state";
import type { ClassificationResult, LabelConfig } from "../src/core/types";
import { GmailClient } from "../src/gmail/client";
import { MemoryTokenSource } from "../src/gmail/oauth";
import type { GmailMessage } from "../src/gmail/types";
import { loadLocalEnv, parseArgs, requireKey } from "./lib/cli";
import { toCsvLine } from "./lib/csv";

const DEFAULT_COUNT = 30;
const PAGE_SIZE = 100;

interface Row {
  id: string;
  date: string;
  fromAddress: string;
  subject: string;
  result: ClassificationResult;
  labels: string[];
  inputTokens: number | undefined;
}

// The SDK's raw response is typed `unknown` at the `SystemOneCaller`
// boundary (see src/core/types.ts); this narrows just enough to read the
// optional usage field classify() itself does not expose.
function inputTokensOf(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null || !("usage" in raw)) return undefined;
  const usage = (raw as { usage: unknown }).usage;
  if (typeof usage !== "object" || usage === null || !("input_tokens" in usage)) return undefined;
  const tokens = (usage as { input_tokens: unknown }).input_tokens;
  return typeof tokens === "number" ? tokens : undefined;
}

function parseCount(flags: Record<string, string | true>): number {
  const raw = flags.count;
  if (raw === undefined) return DEFAULT_COUNT;
  const count = Number(raw);
  if (!Number.isInteger(count) || count <= 0) {
    console.error(`eval: --count must be a positive integer, got ${String(raw)}`);
    process.exit(1);
  }
  return count;
}

function truncateSubject(subject: string): string {
  return subject.length > 60 ? `${subject.slice(0, 60)}...` : subject;
}

function formatProbabilities(result: ClassificationResult): string {
  return Object.entries(result.category.probabilities)
    .map(([key, p]) => `${key}=${p.toFixed(2)}`)
    .join(" ");
}

function formatFlags(result: ClassificationResult): string {
  return Object.entries(result.flags)
    .map(([id, value]) => `${id}=${value.toFixed(2)}`)
    .join(" ");
}

function printRow(row: Row): void {
  const parts = [
    row.id,
    row.date,
    row.fromAddress,
    truncateSubject(row.subject),
    row.result.category.choice,
    formatProbabilities(row.result),
    `conf=${row.result.category.confidence.toFixed(2)}`,
    formatFlags(row.result),
    row.labels.length > 0 ? row.labels.join(",") : "(none)",
    row.inputTokens !== undefined ? `tokens=${row.inputTokens}` : "tokens=?",
  ];
  console.log(parts.join(" | "));
}

// Category labels first (config order, dropping the null "other" option),
// then flag labels, matching the order selectLabels() emits them in.
function labelOrder(config: LabelConfig): string[] {
  const categoryLabels = Object.values(config.category.options)
    .map((option) => option.label)
    .filter((label): label is string => label !== null);
  const flagLabels = Object.values(config.flags).map((flag) => flag.label);
  return [...categoryLabels, ...flagLabels];
}

function printSummary(rows: Row[], failed: number, config: LabelConfig): void {
  console.log("--- summary ---");
  for (const label of labelOrder(config)) {
    const count = rows.filter((row) => row.labels.includes(label)).length;
    console.log(`${label}: ${count}`);
  }
  const noLabels = rows.filter((row) => row.labels.length === 0).length;
  console.log(`(no labels): ${noLabels}`);
  console.log(`errors: ${failed}`);
  console.log(`model: ${config.model}`);
  const totalTokens = rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  console.log(`total input tokens: ${totalTokens}`);
}

function writeCsv(path: string, rows: Row[], config: LabelConfig): void {
  const optionKeys = Object.keys(config.category.options);
  const flagKeys = Object.keys(config.flags);
  const header = [
    "id",
    "date",
    "from",
    "subject",
    "choice",
    ...optionKeys.map((key) => `p_${key}`),
    "confidence",
    ...flagKeys,
    "labels",
    "model",
  ];
  const lines = [toCsvLine(header)];
  for (const row of rows) {
    lines.push(
      toCsvLine([
        row.id,
        row.date,
        row.fromAddress,
        row.subject,
        row.result.category.choice,
        ...optionKeys.map((key) => row.result.category.probabilities[key] ?? 0),
        row.result.category.confidence,
        ...flagKeys.map((key) => row.result.flags[key] ?? 0),
        row.labels.join(";"),
        row.result.model,
      ]),
    );
  }
  writeFileSync(path, `${lines.join("\r\n")}\r\n`, "utf8");
}

async function collectMessageIds(
  gmail: GmailClient,
  count: number,
  query: string | undefined,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < count) {
    const page = await gmail.listMessages({
      ...(query ? { q: query } : { labelIds: ["INBOX"] }),
      maxResults: Math.min(count - ids.length, PAGE_SIZE),
      pageToken,
    });
    for (const message of page.messages) ids.push(message.id);
    pageToken = page.nextPageToken;
    if (!pageToken || page.messages.length === 0) break;
  }
  return ids.slice(0, count);
}

function messageDate(message: GmailMessage): string {
  return message.internalDate ? new Date(Number(message.internalDate)).toISOString() : "";
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const count = parseCount(flags);
  const query = typeof flags.query === "string" ? flags.query : undefined;
  const csvPath = typeof flags.csv === "string" ? flags.csv : undefined;
  const showState = Boolean(flags["show-state"]);

  const { secrets } = loadLocalEnv();
  const hint = "Set it in .secrets.env (see .secrets.env.example).";
  const clientId = requireKey(secrets, "GOOGLE_CLIENT_ID", hint);
  const clientSecret = requireKey(secrets, "GOOGLE_CLIENT_SECRET", hint);
  const refreshToken = requireKey(secrets, "GOOGLE_REFRESH_TOKEN", hint);
  const apiKey = requireKey(secrets, "TYPESAFE_API_KEY", hint);

  const tokens = new MemoryTokenSource({ clientId, clientSecret }, refreshToken);
  const gmail = new GmailClient(tokens);
  const caller = createJevCaller(apiKey);
  const config = loadConfig();
  const questions = buildQuestions(config);

  const profile = await gmail.getProfile();
  const selfAddress = profile.emailAddress;

  const ids = await collectMessageIds(gmail, count, query);

  const rows: Row[] = [];
  let failed = 0;
  for (const id of ids) {
    try {
      const message = await gmail.getMessage(id);
      const state = buildState(message, { selfAddress, maxChars: config.body.maxChars });
      if (showState) {
        console.log(JSON.stringify(state, null, 2));
      }
      // Called directly (bypassing classify()) so the raw response's token
      // usage is available; classify() only returns the normalized result
      // and would also print a "jev" log line that clutters this output.
      const raw = await caller.systemOne({ model: config.model, state, questions });
      const result = normalizeResponse(raw, config);
      const labels = selectLabels(result, config);
      rows.push({
        id,
        date: messageDate(message),
        fromAddress: state.from.address ?? "",
        subject: state.subject,
        result,
        labels,
        inputTokens: inputTokensOf(raw),
      });
      printRow(rows[rows.length - 1]);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${id}: ${message}`);
    }
  }

  printSummary(rows, failed, config);

  if (csvPath) {
    writeCsv(csvPath, rows, config);
    console.log(`wrote ${rows.length} rows to ${csvPath}`);
  }

  if (ids.length > 0 && failed === ids.length) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
