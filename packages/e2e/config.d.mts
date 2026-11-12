/**
 * Types for `config.mjs` (plain ESM, so `stack.mjs` and the smoke scripts can
 * import it without a build step). The gate flows import the same values.
 */
export const WEB_PORT: number
export const API_PORT: number
export const WEB_URL: string
export const API_URL: string
export const STAGE: string
export const ALCHEMY_STATE_DIR: string
export const SEED_STATE_DIR: string
