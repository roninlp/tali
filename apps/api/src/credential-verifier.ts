import { Context, Effect, Layer } from "effect"
import { KDF_VERSION, type LoginKey } from "@tali/domain"
import { constantTimeEqual, randomToken, sha256Hex } from "./bytes.js"

/**
 * Credential verification (ADR-0001).
 *
 * The API never receives a password, and it deliberately does **not** run a
 * password KDF: the browser derives a 32-byte login key with argon2id (19 MiB,
 * t=2), so the server's only job is a cheap, constant-time comparison.
 *
 * Stored per user:
 *  - `credentialSalt`     — 16 random bytes, hex.
 *  - `credentialVerifier` — `SHA-256(credentialSalt || loginKey)` as hex.
 *  - `kdfVersion`         — which browser KDF produced the key (currently 1).
 *
 * A stolen D1 dump therefore yields nothing that can be replayed as a login,
 * and an unknown email still performs one dummy comparison so its response is
 * indistinguishable from a wrong key.
 */

const CREDENTIAL_SALT_BYTES = 16

/** The columns `verify` needs; `User` satisfies this structurally. */
export interface StoredCredential {
  readonly credentialVerifier: string
  readonly credentialSalt: string
  readonly kdfVersion: number
}

export interface EnrolledCredential {
  readonly credentialVerifier: string
  readonly credentialSalt: string
  readonly kdfVersion: number
}

/**
 * Fixed inputs for the unknown-email path — same work as a real compare.
 *
 * The verifier is a zero-filled placeholder, not a digest: `verifyDummy`
 * intentionally discards the result, and only the SHA-256 + constant-time
 * compare cost matters. Keeping it a low-entropy constant also stops secret
 * scanners flagging the module (an empty-string SHA-256 was flagged).
 */
const DUMMY_CREDENTIAL: StoredCredential = {
  credentialVerifier: "0".repeat(64),
  credentialSalt: "0".repeat(32),
  kdfVersion: KDF_VERSION
}

export class CredentialVerifier extends Context.Service<CredentialVerifier>()(
  "CredentialVerifier",
  {
    make: Effect.sync(() => {
      const digest = (salt: string, loginKey: string): Effect.Effect<string> =>
        sha256Hex(`${salt}${loginKey}`)

      /** Registration: mint a fresh per-user salt and store only the verifier. */
      const enroll = (loginKey: LoginKey): Effect.Effect<EnrolledCredential> =>
        Effect.gen(function*() {
          const credentialSalt = randomToken(CREDENTIAL_SALT_BYTES)
          const credentialVerifier = yield* digest(credentialSalt, loginKey)
          return { credentialVerifier, credentialSalt, kdfVersion: KDF_VERSION }
        })

      const verify = (loginKey: LoginKey, stored: StoredCredential): Effect.Effect<boolean> =>
        Effect.gen(function*() {
          const candidate = yield* digest(stored.credentialSalt, loginKey)
          return constantTimeEqual(candidate, stored.credentialVerifier)
        })

      /** Burn the same SHA-256 + constant-time compare when the email is unknown. */
      const verifyDummy = (loginKey: LoginKey): Effect.Effect<boolean> => verify(loginKey, DUMMY_CREDENTIAL)

      return { enroll, verify, verifyDummy } as const
    })
  }
) {}

export const CredentialVerifierLive = Layer.effect(CredentialVerifier, CredentialVerifier.make)
