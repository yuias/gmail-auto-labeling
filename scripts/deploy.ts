import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLocalEnv } from "./lib/cli";
import { parseEnvFile } from "./lib/env-file";

// Written by `pnpm setup:gcp`, which needs the Worker URL and therefore only
// runs after a first deploy; that first deploy must succeed while these are
// still empty.
const SETUP_GCP_KEYS = new Set(["GMAIL_TOPIC", "PUSH_AUDIENCE", "PUSH_SERVICE_ACCOUNT"]);

// Optional inputs, not secrets the Worker requires to run.
const OPTIONAL_KEYS = new Set(["CONTACT_EMAIL", "SITE_VERIFICATION"]);

// Fails fast on any key from .secrets.env.example that is required but empty
// in .secrets.env, so a broken deploy surfaces before wrangler runs at all.
function checkSecrets(root: string, secrets: Record<string, string>): void {
  const secretsPath = join(root, ".secrets.env");
  if (!existsSync(secretsPath)) {
    console.error(
      "deploy: .secrets.env is missing. Copy .secrets.env.example to .secrets.env and fill it in.",
    );
    process.exit(1);
  }

  const exampleKeys = Object.keys(
    parseEnvFile(readFileSync(join(root, ".secrets.env.example"), "utf8")),
  );
  let missingRequired = false;
  for (const key of exampleKeys) {
    if (OPTIONAL_KEYS.has(key) || secrets[key]) continue;
    if (SETUP_GCP_KEYS.has(key)) {
      console.warn(
        `deploy: ${key} is empty; that's expected before \`pnpm setup:gcp\` has run. ` +
          "After this deploy, set WORKER_URL in .env, run `pnpm setup:gcp`, then `pnpm deploy` again.",
      );
      continue;
    }
    console.error(`deploy: ${key} is empty in .secrets.env.`);
    missingRequired = true;
  }
  if (missingRequired) process.exit(1);
}

function main(): void {
  const { root, local, secrets } = loadLocalEnv();
  checkSecrets(root, secrets);

  console.log("Running wrangler deploy...");
  execFileSync("wrangler", ["deploy"], { cwd: root, stdio: "inherit" });
  if (!local.WORKER_URL) {
    console.log(
      "Next: copy the *.workers.dev URL printed above into WORKER_URL in .env, then run `pnpm setup:gcp`.",
    );
  }

  // `wrangler secret bulk <file>` uploads a .env file's values verbatim,
  // including empty strings for keys setup:gcp hasn't written yet; building
  // the payload here and dropping empty values avoids creating empty secrets.
  const payload = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== ""));
  console.log("Uploading secrets...");
  execFileSync("wrangler", ["secret", "bulk"], {
    cwd: root,
    input: JSON.stringify(payload),
    stdio: ["pipe", "inherit", "inherit"],
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
