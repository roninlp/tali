import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"

/**
 * Every test file starts from the same schema the deployed Worker has: the
 * real `packages/sql` migrations applied to this file's isolated local D1.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
