import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Format: `KEY=VALUE`, `#` line and trailing comments, optional surrounding
// quotes. Blank lines and comment-only lines are ignored.
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const key = lineKey(rawLine);
    if (key === undefined) continue;
    const eqIndex = rawLine.indexOf("=");
    result[key] = parseValue(rawLine.slice(eqIndex + 1));
  }
  return result;
}

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnvFile(readFileSync(path, "utf8"));
}

// Replaces the line for each existing key in place, appends keys that are
// not yet present, and leaves comments/blank lines/other keys untouched.
export function upsertEnvFile(path: string, values: Record<string, string>): void {
  const existingText = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existingText.length > 0 ? existingText.split(/\r?\n/) : [];
  const remaining = new Set(Object.keys(values));

  const updatedLines = lines.map((rawLine) => {
    const key = lineKey(rawLine);
    if (key !== undefined && remaining.has(key)) {
      remaining.delete(key);
      return `${key}=${values[key]}`;
    }
    return rawLine;
  });

  // Drop one trailing blank line (from the file's final newline) so appended
  // keys don't accumulate a growing gap on repeated upserts.
  if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] === "") {
    updatedLines.pop();
  }

  for (const key of remaining) {
    updatedLines.push(`${key}=${values[key]}`);
  }

  writeFileSync(path, `${updatedLines.join("\n")}\n`, "utf8");
}

// Returns the assignment's key if the line is `KEY=...` (not a comment or
// blank line), otherwise undefined.
function lineKey(rawLine: string): string | undefined {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return undefined;
  const eqIndex = line.indexOf("=");
  if (eqIndex === -1) return undefined;
  const key = line.slice(0, eqIndex).trim();
  return key || undefined;
}

// Strips a leading run of spaces/tabs, then an optional surrounding-quote pair
// or trailing `# comment`, from the raw `KEY=<rest>` remainder.
function parseValue(rawValue: string): string {
  const leftTrimmed = rawValue.replace(/^[ \t]+/, "");
  if (leftTrimmed.startsWith("#")) return "";
  if (leftTrimmed.startsWith('"') || leftTrimmed.startsWith("'")) {
    const quote = leftTrimmed[0];
    const end = leftTrimmed.indexOf(quote, 1);
    if (end !== -1) return leftTrimmed.slice(1, end);
    return leftTrimmed.slice(1).trimEnd();
  }
  const commentMatch = leftTrimmed.match(/\s#/);
  const cut = commentMatch ? leftTrimmed.slice(0, commentMatch.index) : leftTrimmed;
  return cut.trim();
}
