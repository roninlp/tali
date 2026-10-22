import type { D1Migration } from "@cloudflare/vitest-plugin"

/**
 * The bindings this test-only Worker config declares. Production bindings live
 * in `infra/alchemy.run.ts`; keeping these local means the suite does not need
 * generated `wrangler types` output.
 */
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    WEB_ORIGIN?: string
    TEST_MIGRATIONS: D1Migration[]
  }
}
