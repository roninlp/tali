import { describe, expect, it } from 'vite-plus/test'
import { Schema } from 'effect'
import { uuidV7 } from './ids.js'
import { ListItemId } from './list-item.js'
import type { ListItemId as AggregateListItemId } from './planning/common.js'

/**
 * The legacy `list_items` scaffold is the shape sync still speaks (#34), but
 * every row it sees now comes from the core-planning `ListItem` aggregate, so
 * its id check must match that aggregate: UUID v7 only.
 */

/** A valid UUID v4 — accepted by a bare `isUUID()` check, rejected by v7. */
const V4 = '9f1c1c4e-3b4a-4f2e-9b3a-6d1a2c3b4d5e'

describe('the scaffold ListItemId', () => {
  it('accepts a UUID v7', () => {
    const id = Schema.decodeSync(ListItemId)(uuidV7(1_700_000_000_000))
    // Same branded type as the aggregate id, so sync hands a row across with
    // no cast.
    const aggregate: AggregateListItemId = id
    expect(aggregate).toBe(id)
  })

  it('rejects a valid UUID that is not v7', () => {
    expect(() => Schema.decodeSync(ListItemId)(V4)).toThrow()
  })
})
