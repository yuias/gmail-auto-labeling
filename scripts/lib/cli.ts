import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "./env-file";

// Parses `--flag=value` and, for `--flag` without `=`, consumes the next
// token as its value unless that token is absent or itself starts with `--`
// (in which case the flag is boolean `true`). Everything else is positional.
export function parseArgs(argv: string[]): {
  flags: Record<string, string | true>;
  positional: string[];
} {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eqIndex = body.indexOf("=");
    if (eqIndex !== -1) {
      flags[body.slice(0, eqIndex)] = body.slice(eqIndex + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }

  return { flags, positional };
}

// Walks up from this file's directory to the directory containing
// package.json, so scripts work regardless of the caller's cwd.
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`cli: could not find package.json walking up from ${startDir}`);
    }
    dir = parent;
  }
  return dir;
}

export function loadLocalEnv(): {
  secrets: Record<string, string>;
  local: Record<string, string>;
  root: string;
} {
  const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  return {
    secrets: readEnvFile(join(root, ".secrets.env")),
    local: readEnvFile(join(root, ".env")),
    root,
  };
}

export function requireKey(obj: Record<string, string>, key: string, hint: string): string {
  const value = obj[key];
  if (!value) {
    console.error(`cli: missing ${key}. ${hint}`);
    process.exit(1);
  }
  return value;
}
