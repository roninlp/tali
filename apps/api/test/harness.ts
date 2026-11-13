import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { URL, fileURLToPath } from 'node:url'
import { Effect, Layer, String as Str, type Context } from 'effect'
import { D1Client } from '@effect/sql-d1'
import type { SyncPushResponse, SyncPushResult } from '@tali/domain'
import { SyncService } from '../src/sync-service.js'
import { FakeD1 } from './fake-d1.js'

/**
 * The bootstrap every service/sync suite shares: the real migration chain
 * applied to Node's SQLite, a D1-shaped batch over it, and the layer wiring
 * that turns a service into a promise-returning call.
 *
 * Each suite keeps only what is genuinely its own: which services it merges
 * into the layer, its seed rows, and its table probes.
 */

/** The real migration chain; also used by the order/completeness assertions. */
export const MIGRATIONS_DIR = new URL(
  '../../../packages/sql/migrations/',
  import.meta.url,
)

/** Every migration, in the order D1 and Alchemy apply them. */
export const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter(file => file.endsWith('.sql'))
    .sort()

/** A fresh in-memory SQLite with `files` (all migrations by default) applied. */
export const openMigratedDatabase = (
  files: ReadonlyArray<string> = migrationFiles(),
): DatabaseSync => {
  const db = new DatabaseSync(':memory:')
  for (const file of files) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), 'utf8'))
  }
  return db
}

/** The D1 client the services see in production, over the fake in-memory db. */
export const d1Layer = (fake: FakeD1) =>
  D1Client.layer({
    db: fake.asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel,
  })

type ShapeOf<Tag> = Tag extends { readonly Service: infer Shape }
  ? Shape
  : never

export interface HarnessEnv {
  readonly db: DatabaseSync
  readonly fake: FakeD1
  readonly d1: ReturnType<typeof d1Layer>
}

export interface Harness<Services = never> {
  readonly db: DatabaseSync
  readonly fake: FakeD1
  readonly layer: Layer.Layer<Services, unknown, never>
  readonly run: <A, E, R extends Services>(
    effect: Effect.Effect<A, E, R>,
  ) => Promise<A>
}
export interface ServiceHarness<
  Services = never,
  Shape = never,
> extends Harness<Services> {
  readonly svc: <A, E>(
    f: (service: Shape) => Effect.Effect<A, E, never>,
  ) => Promise<A>
  readonly sync: <A, E>(
    f: (service: ShapeOf<typeof SyncService>) => Effect.Effect<A, E, never>,
  ) => Promise<A>
}

const buildHarness = <Services, LayerError, LayerServices>(
  build: (env: HarnessEnv) => Layer.Layer<Services, LayerError, LayerServices>,
): Harness<Services> => {
  const db = openMigratedDatabase()
  const fake = new FakeD1(db)
  const built = build({ db, fake, d1: d1Layer(fake) })

  // The RPC handler map and the route layers advertise *every* service their
  // handlers may reach for as a requirement, even though `mergeAll` also
  // provides some of them and the suites never provide the rest (the handler
  // captures the build context and only touches what each call needs). That
  // makes their `RIn` unprovable, so the requirement-free view is asserted
  // here, in one place, instead of at every call site. It says nothing about
  // the *success* services: those stay fully inferred, which is what `run`'s
  // `R extends Services` check below is built on.
  const layer = built as Layer.Layer<Services, LayerError, never>

  const run = <A, E, R extends Services>(
    effect: Effect.Effect<A, E, R>,
  ): Promise<A> => {
    // `Layer` is contravariant in the services it provides, so the layer that
    // produces all of `Services` also produces this effect's narrower
    // requirement `R`; `Exclude<R, R>` then leaves the provided effect closed.
    const closed: Layer.Layer<R, LayerError, never> = layer

    return Effect.runPromise(Effect.provide(effect, closed))
  }

  return { db, fake, layer, run }
}

/**
 * A harness over a closed layer. The callback receives the migrated db and the
 * D1 layer so seeding and extra provides stay inside it.
 */
export const makeHarnessCore = <
  Services,
  LayerError = never,
  LayerServices = never,
>(
  build: (env: HarnessEnv) => Layer.Layer<Services, LayerError, LayerServices>,
): Harness<Services> => buildHarness(build)

/** An accessor for one `Context.Service` key provided by `Services`. */
const accessorOf =
  <Services>(harness: Harness<Services>) =>
  <Self extends Services, Shape>(tag: Context.Service<Self, Shape>) =>
  <A, E>(f: (service: Shape) => Effect.Effect<A, E, never>): Promise<A> =>
    harness.run(tag.use(f))

/**
 * An extra accessor from the same layer, for suites that expose more than one
 * service (the occasion suite also answers reminders).
 */
export const serviceAccessor = <Services, Self extends Services, Shape>(
  harness: Harness<Services>,
  tag: Context.Service<Self, Shape>,
) => accessorOf(harness)(tag)

/**
 * The same harness plus the two accessors almost every suite wants: `svc`
 * (the suite's own service) and `sync` (the sync service it layers alongside).
 */
export const makeServiceHarness = <
  Services,
  Self extends Services,
  Shape,
  LayerError = never,
  LayerServices = never,
>(
  build: (env: HarnessEnv) => Layer.Layer<Services, LayerError, LayerServices>,
  serviceTag: Context.Service<Self, Shape>,
): ServiceHarness<Services, Shape> => {
  const harness = buildHarness(build)
  const accessor = accessorOf(harness)

  return {
    ...harness,
    svc: accessor(serviceTag),
    // `sync` is part of the shared accessor shape even for the three suites
    // whose layer stops at a repo or a single service (capture, capture
    // persistence, reminders) and so has no `SyncService`; none of them calls
    // it. A generic `Services` cannot prove that membership without requiring
    // `SyncService` of every suite's layer, so this one assertion stays: a
    // `sync` call without the provider is still a runtime "Service not found",
    // unlike `svc` and `serviceAccessor`, which are now checked.
    sync: <A, E>(
      f: (service: ShapeOf<typeof SyncService>) => Effect.Effect<A, E, never>,
    ): Promise<A> =>
      harness.run(SyncService.use(f) as Effect.Effect<A, E, Services>),
  }
}

/**
 * One push result with `rejected` ruled out.
 *
 * A suite still asserts the tag it wants next (`expect(result._tag).toBe(
 * 'conflict')`), but `expect` cannot narrow a union and `rejected` is the only
 * outcome without `seq`/`item`. Ruling it out here keeps that assertion
 * readable and the field reads typed; a rejected entry throws its code.
 */
export const nonRejected = (
  response: SyncPushResponse,
  index = 0,
): Exclude<SyncPushResult, { readonly _tag: 'rejected' }> => {
  const result = response.results[index]
  assert(result !== undefined, `no push result at ${index}`)
  if (result._tag === 'rejected') {
    throw new Error(
      `push result ${index} was rejected (${result.code}): ${result.message}`,
    )
  }
  return result
}
