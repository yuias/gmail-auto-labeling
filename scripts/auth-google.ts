import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { buildAuthUrl, exchangeCode, type OAuthClient } from "../src/gmail/oauth";
import { loadLocalEnv, requireKey } from "./lib/cli";
import { upsertEnvFile } from "./lib/env-file";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

// Best-effort browser launch; the printed URL is the fallback if neither
// command exists or the launch otherwise fails.
function tryOpen(url: string): void {
  const commands = ["xdg-open", "open"];
  const attempt = (index: number): void => {
    if (index >= commands.length) return;
    const child = spawn(commands[index], [url], { stdio: "ignore" });
    child.unref(); // don't let the launched browser process keep this script alive
    child.once("error", () => attempt(index + 1));
  };
  attempt(0);
}

// Runs the loopback flow: starts a local HTTP server on an ephemeral port,
// prints the auth URL, and resolves with the authorization code once Google
// redirects back to it with a matching `state`.
async function runLoopbackFlow(
  client: OAuthClient,
): Promise<{ code: string; redirectUri: string }> {
  const state = randomBytes(16).toString("hex");
  let redirectUri = "";

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (result: { code: string } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections(); // drop the callback's keep-alive socket so the process can exit promptly
      if ("error" in result) reject(result.error);
      else resolve(result.code);
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Authorization failed.");
        finish({ error: new Error(`auth-google: Google returned an error: ${error}`) });
        return;
      }

      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      if (returnedState !== state || !returnedCode) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid request.");
        finish({ error: new Error("auth-google: state parameter mismatch or missing code") });
        return;
      }

      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<html><body>Authentication complete. You can close this tab.</body></html>");
      finish({ code: returnedCode });
    });

    const timer = setTimeout(() => {
      finish({ error: new Error("auth-google: timed out waiting for the OAuth callback") });
    }, CALLBACK_TIMEOUT_MS);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        finish({ error: new Error("auth-google: failed to determine the loopback server port") });
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/callback`;
      const authUrl = buildAuthUrl(client, redirectUri, state);
      console.log("Open this URL to authorize Gmail access:");
      console.log(authUrl);
      tryOpen(authUrl);
    });
  });

  return { code, redirectUri };
}

async function main(): Promise<void> {
  const { secrets, root } = loadLocalEnv();
  const hint =
    "Set it in .secrets.env (see .secrets.env.example), then run `pnpm auth:google` again.";
  const clientId = requireKey(secrets, "GOOGLE_CLIENT_ID", hint);
  const clientSecret = requireKey(secrets, "GOOGLE_CLIENT_SECRET", hint);
  const client: OAuthClient = { clientId, clientSecret };

  const { code, redirectUri } = await runLoopbackFlow(client);
  const { refreshToken } = await exchangeCode(client, code, redirectUri);
  upsertEnvFile(join(root, ".secrets.env"), { GOOGLE_REFRESH_TOKEN: refreshToken });
  console.log("Saved GOOGLE_REFRESH_TOKEN to .secrets.env.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
