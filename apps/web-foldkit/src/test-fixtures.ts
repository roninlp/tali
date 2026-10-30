import { Option } from 'effect'

import * as Auth from './auth'
import type { AuthFailure } from './lib/auth-api'
import { Model } from './main'
import { emptyMirrorSnapshot } from './mirror'
import * as Household from './page/household'
import * as Lists from './page/lists'
import * as Login from './page/login'
import * as Register from './page/register'
import * as Tasks from './page/tasks'
import * as Today from './page/today'
import * as Preferences from './preferences'
import * as Push from './push'
import { AppRoute } from './route'
import { Session } from './session'
import * as Sync from './sync'
import * as Theme from './theme'

export const USER_ID = '0192f0a0-0000-7000-8000-000000000001'
export const HOUSEHOLD_ID = '0192f0a0-0000-7000-8000-000000000002'
export const TODAY_NOW = Date.parse('2026-10-30T09:30:00.000Z')

const user: Session['user'] = {
  id: USER_ID,
  email: 'owner@example.com',
  displayName: 'مالک',
  timeZone: 'Asia/Tehran',
  weekStart: 'saturday',
  digits: 'persian',
}

export const sessionWithHousehold: Session = Session.make({
  user,
  householdId: HOUSEHOLD_ID,
})

export const sessionWithoutHousehold: Session = Session.make({
  user,
  householdId: null,
})

export const signedIn = (
  session: Session = sessionWithHousehold,
): Auth.SessionStatus =>
  Auth.SessionStatus.SignedIn({
    session,
    maybeBootFailure: Option.none(),
  })

export const signedOut = (): Auth.SessionStatus =>
  Auth.SessionStatus.SignedOut()

export const restoring = (): Auth.SessionStatus =>
  Auth.SessionStatus.Restoring()

export const failed = (failure: AuthFailure): Auth.SessionStatus =>
  Auth.SessionStatus.Failed({ failure })

export const authModel = (status: Auth.SessionStatus): Auth.Model =>
  Auth.Model.make({
    status,
    restoreAttempt: 1,
    isSigningOut: false,
    maybeSignOutFailure: Option.none(),
  })

export const syncModel = (
  status: Sync.StoreStatus = Sync.StoreStatus.Ready(),
): Sync.Model =>
  Sync.Model.make({
    maybeUserId: Option.some(USER_ID),
    hasHousehold: true,
    status,
    isOnline: true,
    isVisible: true,
    pending: 0,
    failed: 0,
    failedRefreshedAt: 0,
    isSyncing: false,
    wakePending: false,
    failures: 0,
    lastActivity: 0,
    isHalted: false,
    hasSyncedOnce: true,
    tick: 0,
    maybeError: Option.none(),
    mirror: emptyMirrorSnapshot(),
    pendingKeys: [],
  })

const DEFAULT_DISPLAY_FIELDS: Preferences.Model['defaults'] = {
  timeZone: 'Asia/Tehran',
  weekStart: 'saturday',
  digits: 'persian',
}

export const preferencesModel = (
  overrides: Partial<Preferences.Model> = {},
): Preferences.Model =>
  Preferences.Model.make({
    maybeUserId: Option.some(USER_ID),
    maybePreferences: Option.none(),
    defaults: DEFAULT_DISPLAY_FIELDS,
    draft: DEFAULT_DISPLAY_FIELDS,
    source: 'Default',
    isSaving: false,
    hasSaved: false,
    maybeError: Option.none(),
    ...overrides,
  })

export const pushModel = (overrides: Partial<Push.Model> = {}): Push.Model =>
  Push.Model.make({
    ...Push.initialModel({
      isSupported: true,
      isSecure: true,
      isInstalled: false,
      permission: 'default',
    }),
    maybeUserId: Option.some(USER_ID),
    ...overrides,
  })

export const modelAt = (
  route: AppRoute,
  status: Auth.SessionStatus = signedIn(),
  theme: Theme.ThemeChoice = 'tali',
  mode: Theme.ThemeMode = 'light',
  isSystemDark = false,
): Model =>
  Model.make({
    route,
    theme: Theme.Model.make({
      theme,
      mode,
      isSystemDark,
    }),
    auth: authModel(status),
    login: Login.initialModel(),
    register: Register.initialModel(),
    household: Household.initialModel(),
    preferences: preferencesModel(),
    push: pushModel(),
    sync: syncModel(),
    today: Today.initialModel(TODAY_NOW),
    lists:
      route._tag === 'List'
        ? Lists.mirrorSettled(
            Lists.enteredDetail(Lists.initialModel(), {
              listId: route.listId,
            }).model,
          ).model
        : Lists.initialModel(),
    tasks: Tasks.initialModel({
      now: TODAY_NOW,
      maybeUserId: Option.some(USER_ID),
      maybeSettings: Option.none(),
    }),
  })
