import { loadLocalEnv, requireKey } from "./lib/cli";

async function main(): Promise<void> {
  const { local, secrets } = loadLocalEnv();
  const workerUrl = requireKey(
    local,
    "WORKER_URL",
    "Set it in .env (known after the first `pnpm deploy`; see .env.example).",
  ).replace(/\/$/, "");
  const adminToken = requireKey(
    secrets,
    "ADMIN_TOKEN",
    "Set it in .secrets.env (see .secrets.env.example), then run `pnpm deploy` to upload it.",
  );

  const response = await fetch(`${workerUrl}/admin/cron`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const text = await response.text();
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
  if (!response.ok) {
    console.error(`watch-start: request failed with status ${response.status}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
