import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { sha256Hex } from "./bytes.js"

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
 */

export type ReadFailureCode =
  | "Unauthorized"
  | "Forbidden"
  | "BadRequest"
  | "InternalError"

/** An error envelope with `no-store`, so a failure is never cached. */
export const json = (
  status: number,
  body: unknown
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.json(body, { status }).pipe(
    Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
    Effect.orDie
  )

export const fail = (
  status: number,
  code: ReadFailureCode,
  message: string,
  retryable = false
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  json(status, { error: { code, message, retryable, details: {} } })

/** A strong hash of the encoded payload; the body alone determines the tag. */
export const etagOf = (body: unknown): Effect.Effect<string> =>
  sha256Hex(JSON.stringify(body)).pipe(Effect.map((hex) => `"${hex}"`))

/**
 * `If-None-Match` uses the weak comparison function even for strong tags, so
 * `W/"x"` matches `"x"`. A comma-separated list and `*` are both legal.
 */
export const matchesIfNoneMatch = (header: string, etag: string): boolean => {
  const opaque = (value: string): string => value.trim().replace(/^W\//, "")
  return header
    .split(",")
    .some((candidate) => candidate.trim() === "*" || opaque(candidate) === opaque(etag))
}

export const cacheHeaders = (etag: string): Record<string, string> => ({
  etag,
  "cache-control": "private, no-cache",
  // The body is per-session; make that explicit for any intermediary.
  vary: "cookie"
})

/**
 * Effect v4 keeps `HttpServerRequest.url` path-only (`/week?anchor=…`); the
 * absolute URL is derived from the `host`/`x-forwarded-proto` headers.
 * `new URL(request.url)` therefore throws on every request with a query.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): URL =>
  Option.getOrElse(
    HttpServerRequest.toURL(request),
    () => new URL(request.url, "http://localhost")
  )
