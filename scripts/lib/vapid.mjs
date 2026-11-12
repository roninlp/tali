import { createECDH } from 'node:crypto'

/**
 * The base64url VAPID public key for a base64url private scalar (RFC 8292).
 *
 * Only the private half is ever supplied: it is a Workers Secret on a deploy
 * and a local env var in development, and the public half is derived from it
 * with Node's ECDH. Shared by `infra/alchemy.run.ts` (deploy time) and
 * `scripts/test-push.mjs` (the local push harness) so the two cannot disagree
 * about which key pair is in use.
 */
export const publicKeyOf = privateKey => {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'))
  return ecdh.getPublicKey().toString('base64url')
}
