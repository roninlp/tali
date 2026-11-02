import type { LocalStore } from '@tali/sync-client'

/**
 * Visibility writes shared by the shareable detail screens (ADR-0011).
 *
 * The policy — not the screen — owns the default and the allowed classes; this
 * helper only commits the user's choice to the mirror, so the outbox carries it
 * like any other patch. Fixed and inherited aggregates never call it.
 */

export const Visibility = {
  Private: 'private',
  Shared: 'shared',
} as const

export type Visibility = (typeof Visibility)[keyof typeof Visibility]

/** A shareable aggregate whose detail screen offers a Share / Unshare action. */
export type ShareableEntityType =
  | 'task'
  | 'list'
  | 'note'
  | 'event'
  | 'habit'
  | 'reminder'
  | 'occasion'

export const setVisibilityInMirror = async (
  store: LocalStore,
  entityType: ShareableEntityType,
  entityId: string,
  visibility: Visibility,
  now: string,
): Promise<void> => {
  await store.writeLocal({
    entityType,
    entityId,
    op: 'upsert',
    patch: { visibility },
    now,
  })
}

/** The label and next value for a Share / Unshare action. */
export const shareActionOf = (
  visibility: Visibility,
): Readonly<{ label: string; next: Visibility }> =>
  visibility === 'shared'
    ? { label: 'فقط خودم', next: 'private' }
    : { label: 'اشتراک با خانه', next: 'shared' }
