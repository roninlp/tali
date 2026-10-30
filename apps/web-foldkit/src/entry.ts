import { Effect } from 'effect'
import { Runtime } from 'foldkit'

import { readCachedSession } from './lib/session-cache'
import { Flags, Message, Model, init, update, view } from './main'

const flags: Effect.Effect<Flags> = Effect.sync(() =>
  Flags.make({
    maybeCachedSession: readCachedSession(),
  }),
)

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
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
