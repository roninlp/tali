import { Option } from 'effect'

import * as Auth from './auth'
import type { AuthFailure } from './lib/auth-api'
import { Model } from './main'
import * as Household from './page/household'
import * as Login from './page/login'
import * as Register from './page/register'
import { AppRoute } from './route'
import { Session } from './session'
import * as Sync from './sync'
import * as Theme from './theme'

const USER_ID = '0192f0a0-0000-7000-8000-000000000001'
const HOUSEHOLD_ID = '0192f0a0-0000-7000-8000-000000000002'

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
    tasks: [],
    draft: '',
    isCreatingTask: false,
    maybeTaskError: Option.none(),
  })

export const modelAt = (
  route: AppRoute,
  status: Auth.SessionStatus = signedIn(),
  theme: Theme.Theme = 'Tali',
): Model =>
  Model.make({
    route,
    theme: Theme.Model.make({ theme }),
    auth: authModel(status),
    login: Login.initialModel(),
    register: Register.initialModel(),
    household: Household.initialModel(),
    sync: syncModel(),
  })
