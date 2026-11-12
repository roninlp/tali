/**
 * Types for `scripts/lib/vapid.mjs` (plain ESM, no build step), so the deploy
 * stack in `infra/alchemy.run.ts` can share the derivation.
 */
export const publicKeyOf: (privateKey: string) => string
