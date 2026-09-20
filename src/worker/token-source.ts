import type { TokenSource } from "../gmail/types";

interface StoredToken {
  token: string;
  expiresAt: number;
}

const STORAGE_KEY = "accessToken";
// Refresh a bit before the real expiry so a token handed to a caller does not
// expire mid-request.
const REFRESH_MARGIN_MS = 60_000;

// Caches the Gmail access token in Durable Object storage so it survives
// eviction between requests, refreshing through the injected callback only
// when missing, close to expiry, or explicitly forced.
export class StoredTokenSource implements TokenSource {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly refresh: () => Promise<{ accessToken: string; expiresAt: number }>,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    const cached = await this.storage.get<StoredToken>(STORAGE_KEY);
    if (!opts?.forceRefresh && cached && cached.expiresAt - REFRESH_MARGIN_MS > this.now()) {
      return cached.token;
    }
    const refreshed = await this.refresh();
    const stored: StoredToken = { token: refreshed.accessToken, expiresAt: refreshed.expiresAt };
    await this.storage.put(STORAGE_KEY, stored);
    return stored.token;
  }
}
