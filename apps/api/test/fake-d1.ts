import { DatabaseSync } from "node:sqlite"
import type { D1Database } from "@cloudflare/workers-types"

/**
 * A tiny D1Database over Node's built-in SQLite for the sync-engine tests.
 *
 * D1 is SQLite, and the production path's atomicity primitive is
 * `D1Client.batch()`. Implementing just `prepare`/`bind`/`all`/`raw`/`batch`
 * lets the tests run the real repository SQL (including `last_insert_rowid()`
 * and compare-and-set) against an in-process database, with a real transaction
 * behind the batch so a failed commit rolls back exactly like D1.
 */

interface D1Meta {
  readonly changes: number
  readonly last_row_id: number
}

interface D1ResultLike {
  readonly success: true
  readonly results: ReadonlyArray<unknown>
  readonly meta: D1Meta
}

class BoundStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: ReadonlyArray<unknown> = []
  ) {}

  bind(...params: ReadonlyArray<unknown>): BoundStatement {
    return new BoundStatement(this.db, this.sql, params)
  }

  async all(): Promise<D1ResultLike> {
    return this.execute()
  }

  async run(): Promise<D1ResultLike> {
    return this.execute()
  }

  async raw(): Promise<ReadonlyArray<ReadonlyArray<unknown>>> {
    return this.execute().results.map((row) => Object.values(row as Record<string, unknown>))
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.execute().results[0] as T | undefined) ?? null
  }

  execute(): D1ResultLike {
    const statement = this.db.prepare(this.sql)
    const results = statement.all(...(this.params as Array<string | number | null>))
    const meta = this.db
      .prepare("SELECT changes() AS changes, last_insert_rowid() AS lastRowId")
      .get() as { readonly changes: number; readonly lastRowId: number }
    return {
      success: true,
      results: results as ReadonlyArray<unknown>,
      meta: { changes: meta.changes, last_row_id: meta.lastRowId }
    }
  }
}

export class FakeD1 {
  /**
   * Test hook: runs immediately before a batch starts, so a test can simulate
   * another writer landing between the service's pre-read and its batch.
   */
  beforeBatch: (() => void) | undefined

  /** How many `batch()` calls ran — the sync commit must be exactly one. */
  batchCalls = 0

  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): BoundStatement {
    return new BoundStatement(this.db, sql)
  }

  async batch(
    statements: ReadonlyArray<BoundStatement>
  ): Promise<ReadonlyArray<D1ResultLike>> {
    this.batchCalls += 1
    this.beforeBatch?.()
    this.db.exec("BEGIN")
    try {
      const results = statements.map((statement) => statement.execute())
      this.db.exec("COMMIT")
      return results
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  async exec(sql: string): Promise<{ readonly count: number }> {
    this.db.exec(sql)
    return { count: 0 }
  }

  asD1Database(): D1Database {
    return this as unknown as D1Database
  }
}
