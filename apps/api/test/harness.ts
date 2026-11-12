import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { URL, fileURLToPath } from 'node:url'
import { Effect, Layer, String as Str, type Context } from 'effect'
import { D1Client } from '@effect/sql-d1'
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

/** A `Context.Service` seen only through the shape it resolves to. */
interface ServiceTag<Shape> {
  readonly Service: Shape
}

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
  readonly run: <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>
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
  const layer = build({ db, fake, d1: d1Layer(fake) })

  const run = <A, E>(effect: Effect.Effect<A, E, Services>): Promise<A> =>
    Effect.runPromise(
      // `RpcHandlers` (and the route layers) advertise the services they use as
      // *requirements* even though the same `mergeAll` also provides them; the
      // original per-file harnesses relied on that, so the closed-layer view is
      // restored here in one place instead of at every call site.
      Effect.provide(
        effect,
        layer as Layer.Layer<Services, LayerError, never>,
      ) as Effect.Effect<A, E>,
    )

  return {
    db,
    fake,
    layer: layer as Layer.Layer<Services, unknown, never>,
    run,
  }
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

const accessorOf =
  <Services>(harness: Harness<Services>) =>
  <S>(tag: ServiceTag<S>) =>
  <A, E>(f: (service: S) => Effect.Effect<A, E, never>): Promise<A> =>
    harness.run(
      (tag as unknown as Context.Service<never, S>).use(f) as Effect.Effect<
        A,
        E,
        Services
      >,
    )

/**
 * An extra accessor from the same layer, for suites that expose more than one
 * service (the occasion suite also answers reminders).
 */
export const serviceAccessor = <Services, Tag extends ServiceTag<unknown>>(
  harness: Harness<Services>,
  tag: Tag,
) => accessorOf(harness)(tag as unknown as ServiceTag<ShapeOf<Tag>>)

/**
 * The same harness plus the two accessors almost every suite wants: `svc`
 * (the suite's own service) and `sync` (the sync service it layers alongside).
 */
export const makeServiceHarness = <
  Services,
  Shape,
  LayerError = never,
  LayerServices = never,
>(
  build: (env: HarnessEnv) => Layer.Layer<Services, LayerError, LayerServices>,
  serviceTag: ServiceTag<Shape>,
): ServiceHarness<Services, Shape> => {
  const harness = buildHarness(build)
  const accessor = accessorOf(harness)

  return {
    ...harness,
    svc: accessor(serviceTag),
    sync: <A, E>(
      f: (service: ShapeOf<typeof SyncService>) => Effect.Effect<A, E, never>,
    ): Promise<A> =>
      harness.run(SyncService.use(f) as Effect.Effect<A, E, Services>),
  }
}
