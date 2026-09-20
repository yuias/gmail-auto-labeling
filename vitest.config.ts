import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Dummy values for every secret the Worker reads; real values are uploaded via
// `wrangler secret bulk` and never touch this file.
const dummyBindings = {
  GOOGLE_CLIENT_ID: "dummy-client-id",
  GOOGLE_CLIENT_SECRET: "dummy-client-secret",
  GOOGLE_REFRESH_TOKEN: "dummy-refresh-token",
  TYPESAFE_API_KEY: "dummy-typesafe-key",
  ADMIN_TOKEN: "dummy-admin-token",
  GMAIL_TOPIC: "projects/dummy/topics/gmail-push",
  PUSH_AUDIENCE: "https://example.workers.dev/pubsub/push",
  PUSH_SERVICE_ACCOUNT: "gmail-push@dummy.iam.gserviceaccount.com",
  PUSH_JWKS_URL: "http://jwks.test/certs",
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: dummyBindings },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
        },
      },
    ],
  },
});
