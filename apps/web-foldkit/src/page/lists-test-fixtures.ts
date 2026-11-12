import { Option } from 'effect'
import { modifyFields } from 'foldkit/struct'

import { ListId } from '@tali/domain'

import {
  type ListItemRow,
  ListItemRow as ListItemRowSchema,
  type ListRow,
} from '../lists-model'
import type { MirrorSnapshot } from '../mirror'
import { mirrorList, mirrorSnapshot } from '../mirror-fixtures'
import { DISPLAY, USER_ID } from '../test-fixtures'
import * as Lists from './lists'
import { initialModel } from './lists'
import type { Inputs, Model } from './lists'

/**
 * Deterministic Lists fixtures shared by the Story and Scene tests. The ids are
 * UUID v7 values so the detail route decodes them through the same brand the
 * router uses.
 */

export const LIST_ID = '0192f0a0-0000-7000-8000-000000000040'
export const SECOND_LIST_ID = '0192f0a0-0000-7000-8000-000000000041'
export const ITEM_ID = '0192f0a0-0000-7000-8000-000000000050'
export const CHECKED_ITEM_ID = '0192f0a0-0000-7000-8000-000000000051'
export const THIRD_ITEM_ID = '0192f0a0-0000-7000-8000-000000000052'

export const listRow = (overrides: Partial<ListRow> = {}): ListRow =>
  mirrorList({ id: LIST_ID, ...overrides })

export const checkedListRow = (overrides: Partial<ListRow> = {}): ListRow =>
  listRow({
    id: SECOND_LIST_ID,
    title: 'کارهای خانه',
    icon: '🏠',
    visibility: 'private',
    updatedAt: '2026-10-21T09:00:00.000Z',
    ...overrides,
  })

export const listItemRow = (
  overrides: Partial<ListItemRow> = {},
): ListItemRow =>
  ListItemRowSchema.make({
    id: ITEM_ID,
    listId: LIST_ID,
    name: 'نان',
    done: false,
    order: 1,
    checkedAt: null,
    color: null,
    tagIds: [],
    visibility: 'shared',
    lastWriterId: USER_ID,
    createdAt: '2026-10-20T09:00:00.000Z',
    updatedAt: '2026-10-20T09:00:00.000Z',
    version: 1,
    hasSyncError: false,
    ...overrides,
  })

export const checkedItemRow = (
  overrides: Partial<ListItemRow> = {},
): ListItemRow =>
  listItemRow({
    id: CHECKED_ITEM_ID,
    name: 'شیر',
    done: true,
    order: 2,
    checkedAt: '2026-10-20T09:30:00.000Z',
    ...overrides,
  })

export const thirdItemRow = (
  overrides: Partial<ListItemRow> = {},
): ListItemRow =>
  listItemRow({
    id: THIRD_ITEM_ID,
    name: 'پنیر',
    order: 3,
    ...overrides,
  })

export const mirrorWith = (
  lists: ReadonlyArray<ListRow> = [listRow()],
  listItems: ReadonlyArray<ListItemRow> = [listItemRow()],
): MirrorSnapshot => mirrorSnapshot({ lists, listItems })

export const listInputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  display: DISPLAY,
  checkedItemPlacement: 'bottom',
  isStoreReady: true,
  isOnline: true,
  pending: 0,
  mirror: mirrorWith(),
  pendingKeys: [],
  maybeUserId: Option.some(USER_ID),
  ...overrides,
})

export const detailModel = (): Model =>
  modifyFields(
    Lists.enteredDetail(initialModel(), {
      listId: ListId.make(LIST_ID),
    }).model,
    { isDetailLoading: () => false },
  )
