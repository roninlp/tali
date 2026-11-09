import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

/**
 * The one place the app answers "am I offline, and is anything waiting?".
 *
 * Ported from `apps/web/src/components/sync-status.tsx`. Deliberately quiet: a
 * dot plus a short label. It reads the local store's state, not the network,
 * so it stays truthful while a request is in flight.
 */

export type SyncStatusKind = 'idle' | 'opening' | 'ready' | 'failed'

export type SyncStatusConfig = Readonly<{
  kind: SyncStatusKind
  canSync: boolean
  isOnline: boolean
  isSyncing: boolean
  isHalted: boolean
  pending: number
  failed: number
  maybeError: Option.Option<string>
}>

const faNumber = new Intl.NumberFormat('fa-IR')

const toneOf = (config: SyncStatusConfig): 'success' | 'warning' | 'error' => {
  if (config.kind === 'failed') return 'error'

  // A rejected push is durable and needs the user, unlike a queue that is
  // merely waiting or a network that may come back on its own.
  if (config.isHalted || config.failed > 0) return 'error'

  if (!config.isOnline) return 'warning'

  if (config.pending > 0) return 'warning'

  return 'success'
}

const labelOf = (config: SyncStatusConfig): string => {
  if (config.kind === 'idle' || config.kind === 'opening') {
    return 'در حال آماده‌سازی…'
  }

  if (config.kind === 'failed') return 'حافظه‌ی محلی در دسترس نیست'

  if (config.isHalted) return 'نشست منقضی شد'

  if (config.failed > 0)
    return `${faNumber.format(config.failed)} تغییر ذخیره نشد`

  if (!config.isOnline) return 'آفلاین'

  if (config.pending > 0) {
    return `${faNumber.format(config.pending)} تغییر در انتظار ارسال`
  }

  return config.canSync ? 'همگام' : 'حافظه‌ی محلی فعال'
}

const dotClass = (config: SyncStatusConfig): string => {
  const tone = toneOf(config)

  if (tone === 'error') return 'bg-error'

  if (tone === 'warning') return 'bg-warning'

  return 'bg-success'
}

const hintOf = (config: SyncStatusConfig): Option.Option<string> => {
  if (Option.isSome(config.maybeError)) return config.maybeError

  if (config.failed > 0) {
    return Option.some(
      'این تغییرات روی سرور ذخیره نشدند؛ از داخل یادداشت دوباره تلاش کنید.',
    )
  }

  return Option.none()
}

export const syncStatusView = <Message>(
  config: SyncStatusConfig,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [
      h.Role('status'),
      h.AriaLive('polite'),
      h.Class(
        'badge badge-sm h-7 gap-1.5 border-base-300 bg-base-100 px-2.5 text-[0.72rem] whitespace-nowrap text-base-content/70',
      ),
      ...Option.match(hintOf(config), {
        onNone: () => [],
        onSome: hint => [h.Title(hint)],
      }),
      h.DataAttribute('sync-tone', toneOf(config)),
    ],
    [
      h.span([
        h.AriaHidden(true),
        h.Class(`size-1.5 rounded-full ${dotClass(config)}`),
      ]),
      labelOf(config),
      config.isSyncing
        ? h.span([h.AriaHidden(true), h.Class('leading-none')], ['…'])
        : h.empty,
    ],
  )
