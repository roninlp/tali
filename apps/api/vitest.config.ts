import { fileURLToPath } from "node:url"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

/**
 * Two test layers, one command (ticket #82 / the #81 verification strategy).
 *
 * - `service`: the existing service + SQL suites on Node's SQLite through the
 *   `fake-d1` harness. They stay there — they are the integration backbone.
 * - `boundary`: the real Worker module in workerd, with a local D1 binding and
 *   the same migrations, exercised through real `fetch` requests. This is the
 *   only layer that can see routing, request-URL parsing (#44), CORS with
 *   credentials, cookie minting and middleware.
 */
const migrationsDir = fileURLToPath(
  new URL("../../packages/sql/migrations/", import.meta.url)
)

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsDir)

  return {
    test: {
      projects: [
        {
          test: {
            name: "service",
            include: ["test/**/*.test.ts"],
            exclude: ["test/boundary/**"]
          }
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.test.jsonc" },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } }
            })
          ],
          test: {
            name: "boundary",
            include: ["test/boundary/**/*.test.ts"],
            setupFiles: ["./test/boundary/setup.ts"]
          }
        }
      ]
    }
  }
})
