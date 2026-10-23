import type { D1Migration } from "@cloudflare/vitest-plugin"

/**
 * The bindings this lab's Worker config declares (it reuses
 * `apps/api/wrangler.test.jsonc`). Mirrors the boundary suite's declaration so
 * `exports.default` and `env.DB` are typed without generated `wrangler types`.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      WEB_ORIGIN?: string
      TEST_MIGRATIONS: D1Migration[]
    }

    interface GlobalProps {
      // Structural on purpose: importing the Worker module's type would pull
      // the whole api + DOM libs into this package's typecheck.
      mainModule: {
        default: {
          fetch: (
            input: string | URL | Request,
            init?: RequestInit
          ) => Promise<Response>
        }
      }
    }
  }

  /**
   * The only Vite env the web modules read (`apps/web/src/lib/config.ts`).
   * Vitest still substitutes `import.meta.env` at transform time.
   */
  interface ImportMetaEnv {
    readonly VITE_API_URL?: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}
