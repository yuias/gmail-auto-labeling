// `@cloudflare/vitest-pool-workers/types` declares `cloudflare:test`'s `env`
// as `Cloudflare.Env`; this ties that ambient type to our actual bindings.
import type { Env as WorkerEnv } from "./env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
