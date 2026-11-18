/**
 * The keyed overlay every server-snapshot screen folds its mirror into.
 *
 * A local write is visible in the IndexedDB mirror at once but reaches the
 * server's read model only after the outbox drains, so a screen holding a
 * fresh server snapshot still has to reconcile the two. The rule is one
 * sentence, applied per lane: a pending mirror row beats the server row for
 * its id, server rows for non-pending ids win, and tombstoned ids drop out.
 * `overlayRowsById` owns that sentence once; a lane only names its rows and
 * how a mirror row folds into the base row it lands on.
 */

import { Array } from 'effect'

interface OverlayRowsInput<Base, Mirror> {
  /** The server snapshot's rows, keyed by their id. */
  readonly base: ReadonlyArray<Base & { readonly id: string }>
  /** The mirror's rows for the same lane. */
  readonly mirror: ReadonlyArray<Mirror & { readonly id: string }>
  /** The ids a pending or dirty local write makes authoritative. */
  readonly overlayIds: ReadonlySet<string>
  /** Tombstoned ids; the base row for each drops out. */
  readonly deletedIds?: ReadonlySet<string> | undefined
  /**
   * Fold one mirror row into the base row it lands on. The base row is
   * `undefined` when the server has never seen the id, so the same callback
   * both merges over a server row and projects a mirror-only row.
   */
  readonly merge: (maybeBase: Base | undefined, row: Mirror) => Base
}

/** Overlay the mirror's pending rows over the server snapshot's rows. */
export const overlayRowsById = <Base, Mirror>(
  input: OverlayRowsInput<Base, Mirror>,
): ReadonlyArray<Base> => {
  const byId = new Map<string, Base>(input.base.map(row => [row.id, row]))
  const mirrorById = new Map(input.mirror.map(row => [row.id, row]))

  Array.reduce([...input.overlayIds], byId, (rows, id) => {
    if (input.deletedIds?.has(id) === true) {
      rows.delete(id)

      return rows
    }

    const row = mirrorById.get(id)

    if (row !== undefined) {
      rows.set(id, input.merge(rows.get(id), row))
    }

    return rows
  })

  return [...byId.values()]
}
