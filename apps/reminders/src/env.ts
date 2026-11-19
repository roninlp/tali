/** The reminders Worker's environment: D1, the internal token, VAPID. */
export interface RemindersEnv {
  readonly DB: D1Database
  /** The api's shared internal secret; no request without it is served. */
  readonly INTERNAL_TOKEN?: string
  readonly VAPID_PRIVATE_KEY?: string
  readonly VAPID_PUBLIC_KEY?: string
  readonly VAPID_SUBJECT?: string
}

/** The one typed boundary: alchemy hands over an untyped env record. */
export const remindersEnvOf = (env: unknown): RemindersEnv =>
  env as RemindersEnv
