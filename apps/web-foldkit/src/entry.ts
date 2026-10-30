import { Effect, Option } from 'effect'
import { Runtime } from 'foldkit'

import { readCachedPreferences } from './lib/preferences-cache'
import { detectPushEnvironment } from './lib/push/service-worker'
import { readCachedSession } from './lib/session-cache'
import {
  Flags,
  Message,
  Model,
  init,
  managedResources,
  subscriptions,
  update,
  view,
} from './main'
import { readStoredMode, readStoredTheme } from './theme'

const prefersDark = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

const flags: Effect.Effect<Flags> = Effect.sync(() => {
  const maybeCachedSession = readCachedSession()

  return Flags.make({
    maybeCachedSession,
    maybeCachedPreferences: Option.flatMap(maybeCachedSession, session =>
      readCachedPreferences(session.user.id),
    ),
    maybeSavedTheme: readStoredTheme(),
    maybeSavedMode: readStoredMode(),
    isSystemDark: prefersDark(),
    pushEnvironment: detectPushEnvironment(),
    isOnline: navigator.onLine,
    isVisible: document.visibilityState !== 'hidden',
    now: Date.now(),
  })
})

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  managedResources,
  container: document.getElementById('root'),
  routing: {
    onUrlRequest: request => Message.ClickedLink({ request }),
    onUrlChange: url => Message.ChangedUrl({ url }),
  },
  devTools: {
    Message,
  },
})

Runtime.run(application, { flags })
