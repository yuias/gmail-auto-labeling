import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export class PushAuthError extends Error {}

export interface PushAuthOptions {
  audience: string;
  serviceAccount: string;
  jwksUrl?: string; // default GOOGLE_JWKS_URL; Worker passes env.PUSH_JWKS_URL
  getKey?: JWTVerifyGetKey; // default: memoized createRemoteJWKSet(new URL(jwksUrl))
}

// Memoized per jwksUrl so repeated requests reuse the same cached key set
// instead of refetching Google's JWKS on every push.
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function resolveGetKey(opts: PushAuthOptions): JWTVerifyGetKey {
  if (opts.getKey) return opts.getKey;
  const jwksUrl = opts.jwksUrl ?? GOOGLE_JWKS_URL;
  let getKey = remoteKeySets.get(jwksUrl);
  if (!getKey) {
    getKey = createRemoteJWKSet(new URL(jwksUrl));
    remoteKeySets.set(jwksUrl, getKey);
  }
  return getKey;
}

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ", 2);
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

export async function verifyPushToken(token: string, opts: PushAuthOptions): Promise<void> {
  const getKey = resolveGetKey(opts);
  const result = await jwtVerify(token, getKey, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: opts.audience,
  }).catch((err: unknown) => {
    throw new PushAuthError(err instanceof Error ? err.message : String(err));
  });
  if (result.payload.email !== opts.serviceAccount || result.payload.email_verified !== true) {
    throw new PushAuthError("token email does not match the expected push service account");
  }
}
