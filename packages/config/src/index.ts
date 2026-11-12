/**
 * Product-wide config shared by the Worker and the Alchemy deploy stack.
 *
 * One declaration per value means the API and the deploy stack cannot drift
 * apart on an endpoint, a model id, or a cron schedule.
 */

/**
 * Capture model defaults (ticket #101; ADR-0012 §7).
 *
 * The base URL is the **Go** gateway root, not the pay-as-you-go `/inference`
 * root. The key is a Workers Secret supplied out of band; these three are
 * ordinary values, so the Worker and the deploy stack cannot disagree about
 * the endpoint, model, or User-Agent.
 */
export const DEFAULT_CAPTURE_BASE_URL =
  'https://opencode.ai/inference/go/openai/v1'
export const DEFAULT_CAPTURE_MODEL = 'deepseek-v4.1-flash'
/** A non-generic UA; the gateway rejects the SDK default. */
export const DEFAULT_CAPTURE_USER_AGENT = 'tali-capture/0.1'

/**
 * The Worker's cron expressions, shared by the Alchemy stack and the Worker's
 * `scheduled()` dispatch. They must stay in the same file: `controller.cron`
 * is a string, so a second copy in `infra/alchemy.run.ts` would let a schedule
 * change silently run the reminder sweep instead of the maintenance job.
 */
export const CRON = {
  reminder: '* * * * *',
  purge: '17 3 * * *',
  backup: '47 3 * * *',
} as const

export const CRON_EXPRESSIONS = [
  CRON.reminder,
  CRON.purge,
  CRON.backup,
] as const
