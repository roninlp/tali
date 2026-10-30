import { Effect } from 'effect'
import { Runtime } from 'foldkit'

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

const flags: Effect.Effect<Flags> = Effect.sync(() =>
  Flags.make({
    maybeCachedSession: readCachedSession(),
    isOnline: navigator.onLine,
    isVisible: document.visibilityState !== 'hidden',
  }),
)

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
