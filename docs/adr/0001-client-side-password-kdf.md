# ADR-0001: Derive passwords into login keys in the browser

- **Status:** Accepted (2026-10-19)
- **Deciders:** Tali owner + developer (wayfinder #21)
- **Supersedes:** interim PBKDF2 in `apps/api` (ticket #15)

## Context

Tali authenticates two known users on Cloudflare Workers (Free plan, 10 ms CPU
per invocation). The map originally settled on argon2 for password storage, but
Workers expose no argon2 primitive and native crypto counts toward CPU.

We measured both alternatives on a probe Worker on the account:

| Probe | CPU | Result |
| --- | --- | --- |
| baseline | 0–1 ms | ok |
| `crypto.subtle` PBKDF2, 100,000 (workerd max) | 22–23 ms | over budget, cannot be strengthened |
| `@noble/hashes` PBKDF2, 600,000 | 359–1,917 ms | mostly `exceededCpu` |
| argon2id, m=19 MiB, t=2 | 318–808 ms | over budget |
| argon2id, m=1 MiB, t=1 | 20–41 ms | still over budget |

Server-side argon2 is 30–80× over the Free-plan budget, and workerd hard-caps
PBKDF2 at 100,000 iterations. PBKDF2 at the allowed maximum is itself over
budget (~22 ms). OpenAuth was evaluated and hits the same wall (scrypt via
`node:crypto`, or PBKDF2 at 600k). Moving the auth library does not move the
KDF off the CPU-limited runtime.

## Decision

Run the password KDF **in the browser** and send a derived credential instead.

- **Password** — a human secret that never leaves the browser. Minimum 12
  characters, no composition rules, enforced client-side (the API never sees a
  password and cannot enforce its length).
- **KDF Salt** — deterministic:
  `SHA-256("tali:kdf:v1:" + normalizeEmail(email))`. A deterministic salt
  means login needs no pre-flight endpoint, so there is no email-enumeration
  surface before the login request itself.
- **Login Key** — `argon2id(password, kdfSalt, { m: 19456 KiB, t: 2, p: 1,
  dkLen: 32 })`, encoded unpadded base64url (43 characters). This replaces the
  password on the wire.
- **Credential Verifier** — `SHA-256(credentialSalt || loginKey)` where
  `credentialSalt` is 16 random bytes (hex) generated once per user. Stored with
  the salt and `kdfVersion = 1`; compared in constant time.
- **Registration** — one request: the client sends the login key, the server
  generates the credential salt and stores the verifier.
- **Login** — unknown emails run a dummy verifier comparison, so timing and the
  `InvalidCredentials` envelope are the same as a wrong key.
- **Rate limiting** — D1 fixed-window table: 5 failures per email+IP per 15
  minutes, then `429 RateLimited` (with `retry-after`). This replaces the
  throttle that a server-side KDF used to provide.
- **Change password** — the browser derives both the current and the new login
  key; the API verifies the current one, mints a fresh credential salt, and
  replaces the verifier.

No migration path: nothing was deployed, so `0003_credentials.sql` replaces the
interim PBKDF2 columns and drops local test accounts.

## Consequences

- Login costs the Worker one SHA-256 plus a constant-time string compare
  (≪1 ms), comfortably inside the Free-plan budget.
- A D1 dump contains no credential that can be replayed: login requires the
  browser-derived key, and the verifier is salted SHA-256 over it.
- The login key is **password-equivalent in transit**. Auth bodies must only
  travel over TLS and must never be logged. Client-side hashing does not change
  the trust boundary of a compromised bundle — it can still capture the
  password at input time.
- KDF parameters are global (deterministic salt, no params endpoint), so a cost
  increase re-enrols both accounts. Acceptable for a two-user household.
- Users on a slow device pay the argon2id cost in the browser (hundreds of
  milliseconds at these parameters); the forms stay in a busy state meanwhile.
