import { Predicate } from "effect"

/**
 * Span attribute redaction shared by the api Worker and the Foldkit app.
 *
 * Both runtimes attach attributes the application did not author: Foldkit puts
 * every Command's `args` on the Command span, and Effect's HTTP and SQL
 * instrumentation adds request and query details. Capture args carry the raw
 * user text and the reviewed drafts, so a denylist alone is not enough: a new
 * Command arg name would leak until someone remembered to add it.
 *
 * Export is therefore allow-by-prefix. Only the namespaces this codebase
 * instruments (`capture.*`, `http.*`, `url.*`, `db.*`, …) are forwarded, and a
 * sensitive token anywhere in the key vetoes it even inside an allowed
 * namespace (`http.request.header.authorization`, `db.query.text`). Values
 * must be scalars, and URL attributes lose their query string and fragment.
 */

export type SpanAttributeValue = string | number | boolean

const SENSITIVE_TOKENS: ReadonlySet<string> = new Set([
  "arg",
  "args",
  "argument",
  "arguments",
  "authorization",
  "body",
  "content",
  "contents",
  "cookie",
  "cookies",
  "description",
  "descriptions",
  "draft",
  "drafts",
  "email",
  "input",
  "inputs",
  "message",
  "messages",
  "note",
  "notes",
  "output",
  "outputs",
  "parameter",
  "parameters",
  "params",
  "password",
  "payload",
  "payloads",
  "phone",
  "prompt",
  "prompts",
  "query",
  "question",
  "questions",
  "quote",
  "quotes",
  "raw",
  "search",
  "secret",
  "sql",
  "statement",
  "summary",
  "text",
  "texts",
  "title",
  "titles",
  "token",
  "tokens",
  "transcript"
])

const EXPORTABLE_KEY_PREFIXES: ReadonlyArray<string> = [
  "capture.",
  "client.",
  "db.",
  "http.",
  "network.",
  "server.",
  "url."
]

const EXPORTABLE_KEYS: ReadonlySet<string> = new Set([
  "effect.exit",
  "error.type",
  "exception.type"
])

const URL_KEYS: ReadonlySet<string> = new Set(["http.url", "url.full"])

const tokensOf = (key: string): ReadonlyArray<string> =>
  key
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "")

/** Whether an attribute key is in an exported namespace and names nothing sensitive. */
export const isExportableSpanAttributeKey = (key: string): boolean => {
  if (EXPORTABLE_KEYS.has(key)) return true
  if (!EXPORTABLE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return false
  return tokensOf(key).every((token) => !SENSITIVE_TOKENS.has(token))
}

const exportableUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return undefined
  }
}

/**
 * The value to export for one attribute, or `undefined` when the key is not
 * allowed or the value cannot be represented safely as a scalar.
 */
export const exportableSpanAttribute = (
  key: string,
  value: unknown
): SpanAttributeValue | undefined => {
  if (!isExportableSpanAttributeKey(key)) return undefined
  if (Predicate.isBoolean(value) || Predicate.isNumber(value)) return value
  if (!Predicate.isString(value)) return undefined
  return URL_KEYS.has(key) ? exportableUrl(value) : value
}

/** Filter an attribute record, dropping every unsafe entry. */
export const exportableSpanAttributes = (
  attributes: Record<string, unknown> | undefined
): Record<string, SpanAttributeValue> | undefined => {
  if (attributes === undefined) return undefined
  const exported: Record<string, SpanAttributeValue> = {}
  for (const [key, value] of Object.entries(attributes)) {
    const safe = exportableSpanAttribute(key, value)
    if (safe !== undefined) {
      exported[key] = safe
    }
  }
  return exported
}
