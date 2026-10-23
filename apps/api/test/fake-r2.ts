/**
 * A tiny in-memory `R2Bucket` for the backup tests (#85).
 *
 * Only the operations the nightly job uses are implemented: `put`, `get`,
 * `list` and `delete`. Listing is unpaginated on purpose; a test can still
 * exercise the runner's cursor loop by feeding a custom bucket.
 */

interface StoredObject {
  readonly bytes: Uint8Array
  readonly contentType: string | undefined
  readonly customMetadata: Record<string, string> | undefined
}

const bytesOf = async (value: unknown): Promise<Uint8Array> => {
  if (typeof value === "string") return new TextEncoder().encode(value)
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer())
  }
  return new Uint8Array(await new Response(value as BodyInit).arrayBuffer())
}

const asR2Object = (key: string, stored: StoredObject, body: boolean) => ({
  key,
  version: "1",
  size: stored.bytes.byteLength,
  etag: `etag-${key}`,
  httpEtag: `"etag-${key}"`,
  uploaded: new Date(),
  httpMetadata: { contentType: stored.contentType },
  customMetadata: stored.customMetadata ?? {},
  range: undefined,
  checksums: {},
  storageClass: "Standard",
  ...(body
    ? {
      body: new Response(stored.bytes).body,
      bodyUsed: false,
      arrayBuffer: async () => stored.bytes.slice().buffer,
      bytes: async () => stored.bytes.slice(),
      text: async () => new TextDecoder().decode(stored.bytes),
      json: async () => JSON.parse(new TextDecoder().decode(stored.bytes)),
      blob: async () => new Blob([stored.bytes])
    }
    : {})
})

export class FakeR2 {
  readonly objects = new Map<string, StoredObject>()
  /** Test hook: force pagination even for small object counts. */
  pageSize = 1000

  async put(
    key: string,
    value: unknown,
    options?: { readonly httpMetadata?: { readonly contentType?: string }; readonly customMetadata?: Record<string, string> }
  ): Promise<unknown> {
    const stored: StoredObject = {
      bytes: await bytesOf(value),
      contentType: options?.httpMetadata?.contentType,
      customMetadata: options?.customMetadata
    }
    this.objects.set(key, stored)
    return asR2Object(key, stored, false)
  }

  async get(key: string): Promise<unknown | null> {
    const stored = this.objects.get(key)
    return stored === undefined ? null : asR2Object(key, stored, true)
  }

  async head(key: string): Promise<unknown | null> {
    const stored = this.objects.get(key)
    return stored === undefined ? null : asR2Object(key, stored, false)
  }

  async list(options: {
    readonly prefix?: string
    readonly cursor?: string
    readonly limit?: number
  } = {}): Promise<unknown> {
    const prefix = options.prefix ?? ""
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
    const start = options.cursor === undefined
      ? 0
      : Math.max(0, keys.indexOf(options.cursor) + 1)
    const limit = Math.min(options.limit ?? this.pageSize, this.pageSize)
    const page = keys.slice(start, start + limit)
    const truncated = start + page.length < keys.length
    return {
      objects: page.map((key) => asR2Object(key, this.objects.get(key)!, false)),
      truncated,
      cursor: truncated ? page[page.length - 1] : undefined,
      delimitedPrefixes: []
    }
  }

  async delete(keys: string | ReadonlyArray<string>): Promise<void> {
    for (const key of typeof keys === "string" ? [keys] : keys) {
      this.objects.delete(key)
    }
  }

  asR2Bucket(): R2Bucket {
    return this as unknown as R2Bucket
  }
}
