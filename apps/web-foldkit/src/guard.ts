import { Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import type { Model as AuthModel } from './auth'
import { SessionStatus } from './auth'
import { AppRoute, householdRouter, loginRouter, todayRouter } from './route'
import type { Session } from './session'

/**
 * Route access rules, ported from `apps/web/src/components/guard.tsx` and the
 * `/` redirect in `apps/web/src/routes/index.tsx`.
 *
 * `guest` screens are signed-out only, `session` screens need any account
 * (household onboarding and settings), and `household` screens need a
 * household. The boot restore is a state of its own: until it settles the
 * guard waits instead of bouncing a cached user through login.
 */

export const GuardDecision = defineTaggedUnion({
  Allow: {},
  Wait: {},
  Redirect: { route: AppRoute, path: Schema.String },
})

export type GuardDecision = typeof GuardDecision.Type

export type GuardContext = Readonly<{
  /** The invite panel keeps the onboarding screen after creating a household. */
  isHouseholdInviteVisible: boolean
}>

export const hasHousehold = (session: Session): boolean =>
  Option.isSome(Option.fromNullishOr(session.householdId))

export const landingRoute = (session: Session): AppRoute =>
  hasHousehold(session) ? AppRoute.Today() : AppRoute.Household()

export const landingPath = (session: Session): string =>
  hasHousehold(session) ? todayRouter() : householdRouter()

const isGuestRoute = AppRoute.isAnyOf(['Login', 'Register'])
const isNotFoundRoute = AppRoute.isAnyOf(['NotFound'])
const isHomeRoute = AppRoute.isAnyOf(['Home'])
const isHouseholdOnboardingRoute = AppRoute.isAnyOf(['Household'])

const isHouseholdRoute = AppRoute.isAnyOf([
  'Today',
  'Tasks',
  'Lists',
  'List',
  'Notes',
  'Note',
  'NotesTrash',
  'Habits',
  'Calendar',
  'Reminders',
  'Capture',
  'PushHealth',
])

const redirectToLogin = (): GuardDecision =>
  GuardDecision.Redirect({
    route: AppRoute.Login(),
    path: loginRouter(),
  })

const redirectToLanding = (session: Session): GuardDecision =>
  GuardDecision.Redirect({
    route: landingRoute(session),
    path: landingPath(session),
  })

const redirectToHousehold = (): GuardDecision =>
  GuardDecision.Redirect({
    route: AppRoute.Household(),
    path: householdRouter(),
  })

export const guardRoute = (
  route: AppRoute,
  auth: AuthModel,
  context: GuardContext = { isHouseholdInviteVisible: false },
): GuardDecision =>
  SessionStatus.match(auth.status, {
    Restoring: () => GuardDecision.Wait(),

    Failed: () =>
      isNotFoundRoute(route) ? GuardDecision.Allow() : GuardDecision.Wait(),

    SignedOut: () =>
      isGuestRoute(route) || isNotFoundRoute(route)
        ? GuardDecision.Allow()
        : redirectToLogin(),

    SignedIn: ({ session }) => {
      if (isGuestRoute(route) || isHomeRoute(route)) {
        return redirectToLanding(session)
      }

      if (
        isHouseholdOnboardingRoute(route) &&
        hasHousehold(session) &&
        !context.isHouseholdInviteVisible
      ) {
        return redirectToLanding(session)
      }

      if (isHouseholdRoute(route) && !hasHousehold(session)) {
        return redirectToHousehold()
      }

      return GuardDecision.Allow()
    },
  })
