import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadLocalEnv, parseArgs, requireKey } from "./lib/cli";
import { upsertEnvFile } from "./lib/env-file";

const DEFAULT_TOPIC = "gmail-push";
const DEFAULT_PUSH_SA_NAME = "gmail-push";
const DEFAULT_SUBSCRIPTION = "gmail-push-worker";

// Google's fixed service account that publishes Gmail push notifications;
// documented by Gmail's watch() API, not project-specific.
const GMAIL_PUSH_SERVICE_ACCOUNT = "gmail-api-push@system.gserviceaccount.com";

const SUBSCRIPTION_RETRY_ATTEMPTS = 5;
const SUBSCRIPTION_RETRY_DELAY_MS = 15_000;

interface GcloudOptions {
  dryRun: boolean;
  // Stdout to return in --dry-run instead of actually invoking gcloud. When
  // omitted, --dry-run simulates a "not found" failure so idempotent
  // describe-then-create steps still print (and exercise) their create path.
  placeholder?: string;
}

function gcloud(args: string[], options: GcloudOptions): string {
  if (options.dryRun) {
    console.log(`gcloud ${args.join(" ")}`);
    if (options.placeholder === undefined) {
      throw new Error("dry-run: simulated not-found");
    }
    return options.placeholder;
  }
  return execFileSync("gcloud", args, { encoding: "utf8" }).trim();
}

// Runs describeArgs; if that fails (resource does not exist), runs
// createArgs. Safe to repeat: an existing resource is left untouched.
function ensureResource(
  describeArgs: string[],
  createArgs: string[],
  dryRun: boolean,
  label: string,
): void {
  try {
    gcloud(describeArgs, { dryRun });
    console.log(`${label} already exists.`);
  } catch {
    gcloud(createArgs, { dryRun, placeholder: "" });
    console.log(`Created ${label}.`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// IAM bindings made just before this call (topic publisher, token creator)
// take a while to propagate; gcloud surfaces that as a permission error
// naming the service account.
function isPropagationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /permission|service account/i.test(message);
}

async function withPropagationRetry(fn: () => string, label: string): Promise<string> {
  for (let attempt = 1; attempt <= SUBSCRIPTION_RETRY_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (error) {
      const isLastAttempt = attempt === SUBSCRIPTION_RETRY_ATTEMPTS;
      if (isLastAttempt || !isPropagationError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `setup-gcp: ${label} failed (attempt ${attempt}/${SUBSCRIPTION_RETRY_ATTEMPTS}), ` +
          `retrying in ${SUBSCRIPTION_RETRY_DELAY_MS / 1000}s: ${message}`,
      );
      await sleep(SUBSCRIPTION_RETRY_DELAY_MS);
    }
  }
  // Unreachable: the loop above always returns or throws.
  throw new Error(`setup-gcp: ${label} failed`);
}

interface SetupConfig {
  dryRun: boolean;
  projectId: string;
  workerUrl: string;
  topic: string;
  pushSaName: string;
  subscriptionName: string;
}

async function ensureSubscription(config: SetupConfig, saEmail: string): Promise<void> {
  const { dryRun, projectId, subscriptionName, topic, workerUrl } = config;
  const pushEndpoint = `${workerUrl}/pubsub/push`;

  let exists = true;
  try {
    gcloud(["pubsub", "subscriptions", "describe", subscriptionName, "--project", projectId], {
      dryRun,
    });
  } catch {
    exists = false;
  }

  const sharedFlags = [
    `--push-endpoint=${pushEndpoint}`,
    `--push-auth-service-account=${saEmail}`,
    `--push-auth-token-audience=${pushEndpoint}`,
    "--ack-deadline=60",
    "--min-retry-delay=10s",
    "--max-retry-delay=600s",
  ];
  const action = exists ? "update" : "create";
  const args = [
    "pubsub",
    "subscriptions",
    action,
    subscriptionName,
    ...sharedFlags,
    // A subscription's topic is immutable once created, so gcloud rejects
    // --topic on `update`; only `create` takes it and `--expiration-period`.
    ...(exists ? [] : [`--topic=${topic}`, "--expiration-period=never"]),
    "--project",
    projectId,
  ];

  await withPropagationRetry(
    () => gcloud(args, { dryRun, placeholder: "" }),
    `subscription ${action}`,
  );
  console.log(`${exists ? "Updated" : "Created"} subscription ${subscriptionName}.`);
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const dryRun = flags["dry-run"] === true;

  const { local, root } = loadLocalEnv();
  const hint = "Set it in .env (see .env.example), then run `pnpm setup:gcp` again.";
  const projectId = requireKey(local, "GCP_PROJECT_ID", hint);
  const workerUrl = requireKey(local, "WORKER_URL", hint).replace(/\/$/, "");
  const topic = local.PUBSUB_TOPIC || DEFAULT_TOPIC;
  const pushSaName = local.PUSH_SA_NAME || DEFAULT_PUSH_SA_NAME;
  const subscriptionName = local.PUBSUB_SUBSCRIPTION || DEFAULT_SUBSCRIPTION;
  const saEmail = `${pushSaName}@${projectId}.iam.gserviceaccount.com`;
  const pushEndpoint = `${workerUrl}/pubsub/push`;

  // 1. APIs this setup depends on.
  gcloud(
    ["services", "enable", "gmail.googleapis.com", "pubsub.googleapis.com", "--project", projectId],
    { dryRun, placeholder: "" },
  );

  // 2. Force creation of the Pub/Sub service agent; best-effort, since it may
  // already exist or the caller may lack permission to force it explicitly.
  try {
    gcloud(
      [
        "beta",
        "services",
        "identity",
        "create",
        "--service=pubsub.googleapis.com",
        "--project",
        projectId,
      ],
      { dryRun, placeholder: "" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `setup-gcp: could not force-create the Pub/Sub service agent, continuing: ${message}`,
    );
  }

  // 3. Topic.
  ensureResource(
    ["pubsub", "topics", "describe", topic, "--project", projectId],
    ["pubsub", "topics", "create", topic, "--project", projectId],
    dryRun,
    `topic ${topic}`,
  );

  // 4. Let Gmail publish push notifications to the topic.
  gcloud(
    [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      topic,
      `--member=serviceAccount:${GMAIL_PUSH_SERVICE_ACCOUNT}`,
      "--role=roles/pubsub.publisher",
      "--project",
      projectId,
    ],
    { dryRun, placeholder: "" },
  );

  // 5. Push service account that Pub/Sub authenticates as when it calls the Worker.
  ensureResource(
    ["iam", "service-accounts", "describe", saEmail, "--project", projectId],
    [
      "iam",
      "service-accounts",
      "create",
      pushSaName,
      "--display-name=Gmail push invoker",
      "--project",
      projectId,
    ],
    dryRun,
    `service account ${saEmail}`,
  );

  // 6. Project number, needed to address the Pub/Sub service agent's own identity below.
  const projectNumber = gcloud(
    ["projects", "describe", projectId, "--format=value(projectNumber)", "--project", projectId],
    { dryRun, placeholder: "123456789012" },
  );

  // 7. Let the Pub/Sub service agent mint tokens as the push service account;
  // Google does not grant this automatically.
  gcloud(
    [
      "iam",
      "service-accounts",
      "add-iam-policy-binding",
      saEmail,
      `--member=serviceAccount:service-${projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`,
      "--role=roles/iam.serviceAccountTokenCreator",
      "--project",
      projectId,
    ],
    { dryRun, placeholder: "" },
  );

  // 8. Push subscription, with retry backoff so delivery failures don't hammer the Worker.
  await ensureSubscription(
    { dryRun, projectId, workerUrl, topic, pushSaName, subscriptionName },
    saEmail,
  );

  // 9. Persist the values the Worker reads at deploy time.
  const values = {
    GMAIL_TOPIC: `projects/${projectId}/topics/${topic}`,
    PUSH_AUDIENCE: pushEndpoint,
    PUSH_SERVICE_ACCOUNT: saEmail,
  };
  if (dryRun) {
    console.log("Would write to .secrets.env:");
    for (const [key, value] of Object.entries(values)) console.log(`  ${key}=${value}`);
  } else {
    upsertEnvFile(join(root, ".secrets.env"), values);
    console.log("Saved GMAIL_TOPIC, PUSH_AUDIENCE, PUSH_SERVICE_ACCOUNT to .secrets.env.");
  }

  // 10.
  console.log("Next: pnpm deploy, then pnpm watch:start.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
