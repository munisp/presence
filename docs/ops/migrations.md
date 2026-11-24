# Database migrations (INF-17)

Migrations are **forward-only, reviewed, and rehearsed** against a
production-sized snapshot before release. All three legs are enforced, none
is optional.

## Forward-only

A migration never destroys schema or bulk-deletes user data. The lint in
`scripts/rehearse_migrations.py` (`lint_forward_only`) rejects `DROP TABLE`,
`TRUNCATE`, `DROP COLUMN`, `DROP SCHEMA` and `DROP EXTENSION` in
`db/migrations/*.sql` and runs in CI on every change. Row-level retention
deletes inside governed functions (NFR-19/20/22 purge schedules) are the
only deletion the data plane performs, and they are behaviour, not schema
change.

## Reviewed

Every migration ships in its own pull request against `main`; review covers
at minimum:

- **Lock profile** — what locks does each statement take, on which tables,
  for how long at production size? Long rewrites go through a
  create-new/copy/swap sequence instead.
- **Index strategy** — new indexes on populated tables use
  `CREATE INDEX CONCURRENTLY` (outside the migration's transaction block).
- **Backfill plan** — new NOT NULL columns carry a DEFAULT or are added
  nullable and backfilled by a follow-up migration.
- **RLS and grants** — new tables get `ENABLE ROW LEVEL SECURITY`, explicit
  policies, and column-limited grants; nothing defaults open.
- **Reversibility of intent** — roll-forward only; the revert plan for a bad
  migration is another migration, never a manual hot-fix.

## Rehearsed

`scripts/rehearse_migrations.py` builds a fresh database at the previous
release, populates a synthetic snapshot at production scale (100 k users,
600 k messages, 1.75 M rows overall — `REHEARSAL_SCALE` resizes), applies
the pending migration under a stopwatch, and then asserts:

- no populated table lost rows;
- every foreign key still validates;
- every table the migrations put under RLS still has it enabled;
- the heaviest production join shape (messages → matches) still resolves.

The `migration-rehearsal` CI job runs this on a real Postgres 17 service on
every push to `main` and every pull request, with a 900 s total budget; any
migration that takes over 120 s on the snapshot is called out for a lock
review. Run it locally with a throwaway database:

```sh
DATABASE_URL=postgres://postgres:rehearse@localhost:5432/rehearse \
    python3 scripts/rehearse_migrations.py
```
