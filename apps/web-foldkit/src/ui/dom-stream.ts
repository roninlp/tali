import { Clock, Duration, Effect, Queue, Stream } from 'effect'

/**
 * DOM event subscriptions as Streams, the one adapter every Subscription entry
 * that listens to the browser goes through.
 *
 * A page declares its Subscription entries as `Stream<Message>`; the browser
 * speaks callbacks. `eventStream` bridges the two by running the subscribe
 * callback on acquire and its returned unsubscribe on release, so a route
 * change adds and removes listeners exactly once. The clock, connectivity, and
 * tab-visibility listeners are the same shape on every screen, so they get a
 * named helper here instead of a private copy per module.
 */

/** Wrap an `addEventListener`-style subscription as a Stream of its events. */
export const eventStream = <A>(
  subscribe: (emit: (value: A) => void) => () => void,
): Stream.Stream<A> =>
  Stream.callback<A>(queue =>
    Effect.acquireRelease(
      Effect.sync(() =>
        subscribe(value => {
          Queue.offerUnsafe(queue, value)
        }),
      ),
      unsubscribe => Effect.sync(unsubscribe),
    ).pipe(Effect.flatMap(() => Effect.never)),
  )

const DEFAULT_CLOCK_INTERVAL_MS = 60_000

/**
 * A clock that emits the current time every `intervalMs` (one minute by
 * default).
 *
 * `immediate` (the default) emits one tick as soon as the subscription starts,
 * so returning to a screen renders a fresh "now" instead of the value left
 * over from the previous visit. The interval ticks follow at `intervalMs` from
 * the start.
 */
export const clockEvents = <M>(
  toMessage: (now: number) => M,
  options?: Readonly<{
    intervalMs?: number
    immediate?: boolean
  }>,
): Stream.Stream<M> => {
  const intervalMs = options?.intervalMs ?? DEFAULT_CLOCK_INTERVAL_MS
  const immediate = options?.immediate ?? true

  const ticks = Stream.tick(Duration.millis(intervalMs))
  const stream = immediate ? ticks : Stream.drop(ticks, 1)

  return stream.pipe(
    Stream.mapEffect(() => Clock.currentTimeMillis),
    Stream.map(toMessage),
  )
}

/** The browser going online or offline, as the caller's two Messages. */
export const onlineEvents = <M>(
  config: Readonly<{
    onOnline: () => M
    onOffline: () => M
  }>,
): Stream.Stream<M> =>
  eventStream(emit => {
    const onOnline = () => emit(config.onOnline())
    const onOffline = () => emit(config.onOffline())

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  })

/** Every tab visibility change, reported as whether the page is visible. */
export const visibilityEvents = <M>(
  toMessage: (isVisible: boolean) => M,
): Stream.Stream<M> =>
  eventStream(emit => {
    const onVisibilityChange = () =>
      emit(toMessage(document.visibilityState !== 'hidden'))

    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  })
