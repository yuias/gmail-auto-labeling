import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/lib/cli";
import { parseEnvFile, readEnvFile, upsertEnvFile } from "../../scripts/lib/env-file";

describe("parseEnvFile", () => {
  it("ignores comments and blank lines, and strips quotes and trailing comments", () => {
    const text = [
      "# top-level comment",
      "",
      "FOO=bar",
      "  # indented comment",
      'BAR="baz qux"   # trailing comment',
      "BAZ='single'",
      "EMPTY=",
      "WITH_COMMENT=        # written later",
    ].join("\n");

    expect(parseEnvFile(text)).toEqual({
      FOO: "bar",
      BAR: "baz qux",
      BAZ: "single",
      EMPTY: "",
      WITH_COMMENT: "",
    });
  });
});

describe("readEnvFile / upsertEnvFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "env-file-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readEnvFile returns {} for a missing file", () => {
    expect(readEnvFile(join(dir, "missing.env"))).toEqual({});
  });

  it("upsertEnvFile creates a missing file", () => {
    const path = join(dir, "new.env");
    upsertEnvFile(path, { GOOGLE_REFRESH_TOKEN: "rt-1" });
    expect(readEnvFile(path)).toEqual({ GOOGLE_REFRESH_TOKEN: "rt-1" });
  });

  it("replaces an existing key in place and preserves comments, blank lines, and other keys", () => {
    const path = join(dir, "existing.env");
    const original = [
      "# secrets",
      "GOOGLE_CLIENT_ID=abc",
      "",
      "GOOGLE_REFRESH_TOKEN=        # written by pnpm auth:google",
      "TYPESAFE_API_KEY=key-1",
      "",
    ].join("\n");
    writeFileSync(path, original, "utf8");

    upsertEnvFile(path, { GOOGLE_REFRESH_TOKEN: "rt-1" });

    expect(readFileSync(path, "utf8")).toBe(
      "# secrets\nGOOGLE_CLIENT_ID=abc\n\nGOOGLE_REFRESH_TOKEN=rt-1\nTYPESAFE_API_KEY=key-1\n",
    );
    expect(readEnvFile(path)).toEqual({
      GOOGLE_CLIENT_ID: "abc",
      GOOGLE_REFRESH_TOKEN: "rt-1",
      TYPESAFE_API_KEY: "key-1",
    });
  });

  it("appends a new key without touching existing lines", () => {
    const path = join(dir, "append.env");
    writeFileSync(path, "GOOGLE_CLIENT_ID=abc\n", "utf8");

    upsertEnvFile(path, { GOOGLE_REFRESH_TOKEN: "rt-1" });

    expect(readEnvFile(path)).toEqual({
      GOOGLE_CLIENT_ID: "abc",
      GOOGLE_REFRESH_TOKEN: "rt-1",
    });
  });

  it("replaces the key again on a second run without duplicating it", () => {
    const path = join(dir, "twice.env");
    upsertEnvFile(path, { GOOGLE_REFRESH_TOKEN: "rt-1" });
    upsertEnvFile(path, { GOOGLE_REFRESH_TOKEN: "rt-2" });

    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("GOOGLE_REFRESH_TOKEN"));
    expect(lines).toEqual(["GOOGLE_REFRESH_TOKEN=rt-2"]);
    expect(readEnvFile(path)).toEqual({ GOOGLE_REFRESH_TOKEN: "rt-2" });
  });
});

describe("parseArgs", () => {
  it("parses --k v, --k=v, and positionals in any order", () => {
    const result = parseArgs(["pos1", "--count", "30", "--query=in:inbox", "pos2"]);
    expect(result).toEqual({
      flags: { count: "30", query: "in:inbox" },
      positional: ["pos1", "pos2"],
    });
  });

  it("a bare --k consumes the following non-flag token as its value", () => {
    const result = parseArgs(["--show-state", "pos1"]);
    expect(result).toEqual({
      flags: { "show-state": "pos1" },
      positional: [],
    });
  });

  it("treats a flag immediately followed by another flag as boolean", () => {
    const result = parseArgs(["--show-state", "--count=5"]);
    expect(result).toEqual({
      flags: { "show-state": true, count: "5" },
      positional: [],
    });
  });

  it("treats a flag as boolean when it is the last argument", () => {
    const result = parseArgs(["--flag"]);
    expect(result).toEqual({ flags: { flag: true }, positional: [] });
  });
});
