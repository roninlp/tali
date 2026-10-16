# Migrations

Plain SQL migrations for D1, applied out-of-band (D1 has no interactive
transactions, so Effect's `Migrator` cannot run here — see
`docs/research/effect-drizzle-d1.md`).

Apply locally (from `apps/api`, which owns the `DB` binding):

```sh
wrangler d1 migrations apply DB --local
```

Apply to remote:

```sh
wrangler d1 migrations apply DB --remote
```

Or apply a single file directly:

```sh
wrangler d1 execute tali-db --local --file 0001_list_items.sql
```

Alchemy (see `infra/stack.ts`) also applies `packages/sql/migrations` on deploy.
