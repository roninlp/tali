import {
  habitFrequencyHistoryAfter,
  localDateIn,
  sameHabitFrequency,
} from '@tali/domain'
import type { LocalStore } from '@tali/sync-client'

import type { HabitFrequency, HabitRow } from '../habits-model'

/**
 * Habit mirror writes, ported from `apps/web/src/lib/habits/model.ts`
 * (ticket #66; FR-HAB-01/02/03).
 *
 * Every helper commits the mirror row and its outbox entry in one
 * `writeLocal` transaction before resolving, so the habit is in the list —
 * and its streak recomputes — before the network is involved. A frequency
 * change appends the same era boundary the server computes, so the optimistic
 * streak never rewrites history at the new frequency.
 *
 * Ids and timestamps are supplied by the caller because a Foldkit Command
 * mints them in `execute`, never while preparing its arguments.
 */

export interface HabitCreateDraft {
  readonly title: string
  readonly description?: string | null
  readonly icon?: string | null
  readonly color?: string | null
  readonly frequency: HabitFrequency
  readonly reminderTime?: string | null
  readonly timeZone: string
}

/**
 * Create a habit locally. `startedOn` and era 0 are written now, in the
 * habit's zone, exactly as the service/sync defaults recompute them, so the
 * streak is correct offline from the first render.
 */
export const createHabitInMirror = async (
  store: LocalStore,
  draft: HabitCreateDraft,
  id: string,
  now: string,
): Promise<string> => {
  const title = draft.title.trim()

  if (title === '') {
    throw new Error('a habit needs a title')
  }

  const timeZone = draft.timeZone
  const startedOn = localDateIn(now, timeZone)

  await store.writeLocal({
    entityType: 'habit',
    entityId: id,
    op: 'upsert',
    patch: {
      id,
      type: 'habit',
      title,
      description: draft.description ?? null,
      icon: draft.icon ?? null,
      color: draft.color ?? null,
      frequency: draft.frequency,
      frequencyHistory: [
        { effectiveFrom: startedOn, frequency: draft.frequency },
      ],
      startedOn,
      reminderTime: draft.reminderTime ?? null,
      timeZone,
      visibility: 'shared',
      createdAt: now,
    },
    now,
  })

  return id
}

/** Only the editable fields; an omitted field keeps its stored value. */
export interface HabitEditPatch {
  readonly title?: string
  readonly description?: string | null
  readonly icon?: string | null
  readonly color?: string | null
  readonly frequency?: HabitFrequency
  readonly reminderTime?: string | null
}

/**
 * Apply an edit locally. A frequency change appends the server's era boundary
 * (`habitFrequencyHistoryAfter`, #63) so past periods stay judged by the rule
 * that opened them.
 */
export const updateHabitInMirror = async (
  store: LocalStore,
  habit: Pick<HabitRow, 'id' | 'timeZone' | 'frequency' | 'frequencyHistory'>,
  patch: HabitEditPatch,
  now: string,
): Promise<void> => {
  const local: Record<string, unknown> = {}

  if (patch.title !== undefined) {
    const title = patch.title.trim()

    if (title === '') {
      throw new Error('a habit needs a title')
    }

    local.title = title
  }

  if (patch.description !== undefined) {
    local.description = patch.description
  }

  if (patch.icon !== undefined) {
    local.icon = patch.icon
  }

  if (patch.color !== undefined) {
    local.color = patch.color
  }

  if (patch.reminderTime !== undefined) {
    local.reminderTime = patch.reminderTime
  }

  if (
    patch.frequency !== undefined &&
    !sameHabitFrequency(patch.frequency, habit.frequency)
  ) {
    local.frequency = patch.frequency
    local.frequencyHistory = habitFrequencyHistoryAfter({
      history: habit.frequencyHistory,
      frequency: patch.frequency,
      changeDate: localDateIn(now, habit.timeZone),
    })
  }

  await store.writeLocal({
    entityType: 'habit',
    entityId: habit.id,
    op: 'upsert',
    patch: local,
    now,
  })
}

/** Soft delete — the row and its entries stay, so undo returns the same habit. */
export const deleteHabitInMirror = async (
  store: LocalStore,
  id: string,
  now: string,
): Promise<void> => {
  await store.writeLocal({
    entityType: 'habit',
    entityId: id,
    op: 'delete',
    patch: {},
    now,
  })
}

/**
 * Undo a soft delete in place.
 *
 * The queued empty-patch upsert returns the habit before any network; the sync
 * engine repairs it through the explicit `RestoreHabit` mutation, exactly as
 * it repairs a queued habit tap.
 */
export const restoreHabitInMirror = async (
  store: LocalStore,
  id: string,
  now: string,
): Promise<void> => {
  await store.writeLocal({
    entityType: 'habit',
    entityId: id,
    op: 'upsert',
    patch: {},
    deletedAt: null,
    now,
  })
}
