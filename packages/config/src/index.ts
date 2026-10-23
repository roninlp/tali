import { Config } from "effect"

/**
 * Typed environment config (Effect `Config`).
 *
 * On Cloudflare Workers these are resolved from bindings/vars at deploy time;
 * Alchemy binds `Config.Redacted(...)` as `secret_text`. Locally they fall back
 * to process env + defaults.
 */
export const AppConfig = Config.all({
  apiBaseUrl: Config.String("API_BASE_URL").pipe(
    Config.withDefault("http://localhost:8787")
  ),
  d1DatabaseName: Config.String("D1_DATABASE_NAME").pipe(
    Config.withDefault("tali-db")
  ),
  logLevel: Config.String("LOG_LEVEL").pipe(Config.withDefault("info"))
})

/**
 * The Worker's cron expressions, shared by the Alchemy stack and the Worker's
 * `scheduled()` dispatch. They must stay in the same file: `controller.cron`
 * is a string, so a second copy in `infra/alchemy.run.ts` would let a schedule
 * change silently run the reminder sweep instead of the maintenance job.
 */
export const CRON = {
  reminder: "* * * * *",
  purge: "17 3 * * *",
  backup: "47 3 * * *"
} as const

export const CRON_EXPRESSIONS = [CRON.reminder, CRON.purge, CRON.backup] as const
