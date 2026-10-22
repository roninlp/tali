import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"

/**
 * Apply the real `packages/sql` migrations to the local D1 binding before each
 * boundary test file. Isolated per-test storage starts empty, so every file
 * gets the same schema the deployed Worker has.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
