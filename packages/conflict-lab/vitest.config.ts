import { fileURLToPath, URL } from "node:url"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

/**
 * The conflict lab (ticket #83).
 *
 * A private, throwaway package: nothing in production depends on it, and it
 * exists only to prove convergence. Tests run the **real** client engine
 * (`apps/web`'s `LocalStore` + `createSyncEngine`) in workerd next to the
 * **real** api Worker, so pushes, pulls, CAS, dedupe and tombstones are the
 * production code on both sides of the wire — not a fake transport.
 *
 * Two suites: a bounded deterministic + property run for PR CI, and a longer
 * randomised nightly run (`CONFLICT_LAB_NIGHTLY=1`, see package.json).
 */
const apiDir = fileURLToPath(new URL("../../apps/api/", import.meta.url))
const migrationsDir = fileURLToPath(
  new URL("../sql/migrations/", import.meta.url)
)

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsDir)
  // Resolved here, in Node: workerd does not receive the host `process.env`.
  // `define` carries it into the test module; the binding lets the harness
  // prove the two agree (harness.test.ts pins this against `resolveLabMode`).
  const nightly = process.env.CONFLICT_LAB_NIGHTLY === "1"
  const mode = {
    nightly,
    numRuns: nightly ? 100 : 20,
    maxSteps: nightly ? 70 : 40
  }

  return {
    define: {
      __CONFLICT_LAB_MODE__: JSON.stringify(mode)
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: `${apiDir}wrangler.test.jsonc` },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            CONFLICT_LAB_NIGHTLY: process.env.CONFLICT_LAB_NIGHTLY ?? ""
          }
        }
      })
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
      // Shrinking a failing two-device trace reruns real IndexedDB + D1 work;
      // give the property suite room without letting a hang pin CI.
      testTimeout: mode.nightly ? 1_200_000 : 300_000,
      hookTimeout: 60_000
    }
  }
})
