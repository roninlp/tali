/**
 * Shared HTTP plumbing for the aggregated read models (`GET /today`,
 * `GET /week`, `GET /month`; tickets #42/#43).
 *
 * These routes are plain HTTP rather than RPC because their caching semantics
 * are part of the contract: the body is deterministic for the requested
 * window + data set, so it is hashed into a strong `ETag` and a matching
 * `If-None-Match` answers `304` with no body. The session is the cookie, so
 * every response is `private, no-cache` — a shared cache must never reuse one
 * household's picture for another.
 *
 * The helpers themselves live in `http-envelope.ts` (one envelope for every
 * plain-HTTP route); this module re-exports the subset the read models use so
 * their imports stay put.
 */

export {
  cacheHeaders,
  conditionalJson,
  etagOf,
  fail,
  json,
  matchesIfNoneMatch,
  requestUrl,
  type ErrorCode,
  type ReadFailureCode,
} from './http-envelope.js'
