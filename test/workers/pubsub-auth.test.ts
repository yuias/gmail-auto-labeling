import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { extractBearer, PushAuthError, verifyPushToken } from "../../src/worker/pubsub-auth";

const AUDIENCE = "https://example.workers.dev/pubsub/push";
const SERVICE_ACCOUNT = "gmail-push@dummy.iam.gserviceaccount.com";

let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

async function sign(claims: Record<string, unknown>, expiresIn = "5m"): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

function validClaims(): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    email: SERVICE_ACCOUNT,
    email_verified: true,
  };
}

beforeAll(async () => {
  const { privateKey: priv, publicKey } = await generateKeyPair("RS256", { extractable: true });
  privateKey = priv;
  const jwk = await exportJWK(publicKey);
  getKey = createLocalJWKSet({ keys: [jwk] });
});

describe("verifyPushToken", () => {
  it("accepts a valid token", async () => {
    const token = await sign(validClaims());
    await expect(
      verifyPushToken(token, { audience: AUDIENCE, serviceAccount: SERVICE_ACCOUNT, getKey }),
    ).resolves.toBeUndefined();
  });

  it("accepts the accounts.google.com issuer without scheme", async () => {
    const token = await sign({ ...validClaims(), iss: "accounts.google.com" });
    await expect(
      verifyPushToken(token, { audience: AUDIENCE, serviceAccount: SERVICE_ACCOUNT, getKey }),
    ).resolves.toBeUndefined();
  });

  it("rejects the wrong audience", async () => {
    const token = await sign({ ...validClaims(), aud: "https://other.example/push" });
    await expect(
      verifyPushToken(token, { audience: AUDIENCE, serviceAccount: SERVICE_ACCOUNT, getKey }),
    ).rejects.toThrow(PushAuthError);
  });

  it("rejects the wrong issuer", async () => {
    const token = await sign({ ...validClaims(), iss: "https://evil.example" });
    await expect(
      verifyPushToken(token, { audience: AUDIENCE, serviceAccount: SERVICE_ACCOUNT, getKey }),
    ).rejects.toThrow(PushAuthError);
  });

  it("rejects the wrong email", async () => {
    const token = await sign({
      ...validClaims(),
      email: "someone-else@dummy.iam.gserviceaccount.com",
    });
    await expect(
      verifyPushToken(token, { audience: AUDIENCE, serviceAccount: SERVICE_ACCOUNT, getKey }),
    ).rejects.toThrow(PushAuthError);
  });

  it("rejects email_verified: false", async () => {
    const token = await sign({ ...validClaims(), email_verified: false });
    await expect(
      verifyPushToken(token, { audience: AUDIENCE, serviceAccount: SERVICE_ACCOUNT, getKey }),
    ).rejects.toThrow(PushAuthError);
  });

  it("rejects an expired token", async () => {
    const token = await sign(validClaims(), "-1s");
    await expect(
      verifyPushToken(token, { audience: AUDIENCE, serviceAccount: SERVICE_ACCOUNT, getKey }),
    ).rejects.toThrow(PushAuthError);
  });

  it("rejects a garbage string", async () => {
    await expect(
      verifyPushToken("not-a-jwt", { audience: AUDIENCE, serviceAccount: SERVICE_ACCOUNT, getKey }),
    ).rejects.toThrow(PushAuthError);
  });
});

describe("extractBearer", () => {
  it("returns null when the Authorization header is missing", () => {
    expect(extractBearer(new Request("http://x/"))).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    const request = new Request("http://x/", { headers: { Authorization: "Basic abc123" } });
    expect(extractBearer(request)).toBeNull();
  });

  it("returns the token for a Bearer header", () => {
    const request = new Request("http://x/", { headers: { Authorization: "Bearer abc.def.ghi" } });
    expect(extractBearer(request)).toBe("abc.def.ghi");
  });
});
