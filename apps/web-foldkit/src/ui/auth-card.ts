import type { Html, HtmlBuilder } from 'foldkit/html'

import { sparklesIcon } from './icons'

/**
 * The auth-screen card, ported from `apps/web/src/components/form.tsx`.
 *
 * The login, register, and household screens render their forms inside it.
 * The surrounding standalone layout and the theme toggle live in `shell.ts`.
 */

export type AuthCardConfig = Readonly<{
  title: string
  subtitle: string
  children: ReadonlyArray<Html>
}>

export type AuthFooterLinkConfig = Readonly<{
  href: string
  text: string
  linkText: string
}>

export const authFooterLinkView = <Message>(
  config: AuthFooterLinkConfig,
  h: HtmlBuilder<Message>,
): Html =>
  h.nav(
    [h.Class('text-center text-sm text-base-content/60')],
    [
      config.text,
      ' ',
      h.a(
        [h.Href(config.href), h.Class('link link-primary font-medium')],
        [config.linkText],
      ),
    ],
  )

export const authCardView = <Message>(
  config: AuthCardConfig,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.Class(
        'card relative w-full max-w-sm border border-base-300 bg-base-100 shadow-xl',
      ),
    ],
    [
      h.div(
        [h.Class('card-body gap-5 p-6 sm:p-8')],
        [
          h.header(
            [h.Class('grid gap-2')],
            [
              h.span(
                [h.Class('flex items-center gap-2 text-primary')],
                [
                  h.span(
                    [
                      h.Class(
                        'grid size-9 place-items-center rounded-xl bg-primary text-primary-content shadow-sm',
                      ),
                    ],
                    [sparklesIcon('size-5')],
                  ),
                  h.span(
                    [h.Class('text-sm font-bold tracking-tight')],
                    ['تالی'],
                  ),
                ],
              ),
              h.h1(
                [h.Class('text-2xl font-bold tracking-tight')],
                [config.title],
              ),
              h.p(
                [h.Class('text-sm leading-7 text-base-content/60')],
                [config.subtitle],
              ),
            ],
          ),
          ...config.children,
        ],
      ),
    ],
  )
