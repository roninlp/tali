import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { buttonView } from './button'

/**
 * What the app shows before it knows who the user is: a splash while the
 * session restores, and a retry when that restore failed for a transient
 * reason. The standalone layout and theme toggle come from `shell.ts`.
 */

export type BootConfig<Message> = Readonly<{
  message: string
  maybeRetry: Option.Option<Message>
}>

export const bootView = <Message>(
  config: BootConfig<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.AriaBusy(true),
      h.Class(
        'grid justify-items-center gap-4 text-center text-base-content/60',
      ),
    ],
    [
      h.span([h.Class('spinner spinner-lg text-primary')]),
      h.p([h.Class('m-0 text-sm')], [config.message]),
      Option.match(config.maybeRetry, {
        onNone: () => h.empty,
        onSome: message =>
          buttonView(
            {
              variant: 'primary',
              size: 'sm',
              children: ['تلاش دوباره'],
              onClick: message,
            },
            h,
          ),
      }),
    ],
  )
