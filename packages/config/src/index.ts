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
