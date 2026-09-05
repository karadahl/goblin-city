# Fresh Neon bootstrap

`db/schema.sql` at the reviewed current Git commit is the canonical full schema for a
new Goblin City database. Historical files in `db/migrations/` are additive upgrades
for initialized databases; never replay them as a bootstrap sequence. Upstream's
`migrate:local` command remains loopback-only, so it is not a substitute for this
explicit remote-pristine bootstrap path.

This branch provides two explicit commands:

```sh
npm run bootstrap:preview
npm run bootstrap:production
```

They are for a pristine Neon database only. They refuse pooled URLs, non-Neon hosts,
non-default direct-endpoint ports, unproven project/branch endpoints, and persistent
state in any schema. The check rejects non-system schemas, relations, routines,
user-defined types, extensions, schema-scoped objects, and database-scoped state before
DDL. It permits only PostgreSQL's `pg_catalog`, `information_schema`, `pg_toast`, and
temporary namespaces, plus the empty default `public` schema and built-in `plpgsql` in
`pg_catalog`. It also permits only Neon-managed `public` default ACL records with the
exact documented-provider ownership and grants observed on a fresh Neon database:
`cloud_admin` grants `neon_superuser` default privileges for tables and sequences. Any
other default ACL remains blocking, and the command requires exactly that pair - this is
a narrowly evidenced Neon provider-state exception, not a universal fresh-database
assumption. A `public.show_db_tree()` routine is never allowed:
Neon's MCP `describe_branch` is known to leave it behind, so remove that artifact from
the disposable target and re-check rather than broadening the bootstrap allowlist. It
never resets, drops, truncates, or overwrites an existing database.

The schema is read with `git show <full-current-HEAD>:db/schema.sql`, not from the
working tree. The command logs only target IDs, an endpoint fingerprint, the schema
commit, and the Production snapshot ID. URLs and credentials are redacted from failures.

## Required protected environment values

Both commands require `NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_PRODUCTION_BRANCH_ID`,
and a direct non-pooled Neon URL on port 5432 for the selected target.

Preview additionally requires `NEON_PREVIEW_BRANCH_ID`, `PREVIEW_DATABASE_URL_UNPOOLED`,
and this exact acknowledgement:

```text
CONFIRM_PREVIEW_BOOTSTRAP=INITIALIZE_EMPTY_GOBLIN_CITY_PREVIEW_DATABASE
```

Production requires `PRODUCTION_DATABASE_URL_UNPOOLED`, a safe
`PRODUCTION_SNAPSHOT_NAME`, and this exact acknowledgement:

```text
CONFIRM_PRODUCTION_BOOTSTRAP=INITIALIZE_EMPTY_GOBLIN_CITY_PRODUCTION_DATABASE
```

All values stay in a protected operator environment. Never place a URL, API key, or
password in a command line, committed file, deployment log, or chat.

## Procedure

1. Create an isolated Neon Preview branch and an empty Production branch. Their IDs must
   be distinct.
2. Configure protected Preview values and run `npm run bootstrap:preview`.
3. Verify the target identity, source Git SHA, core tables, `pg_trgm`, and zero residents.
4. Deploy and exercise Preview before considering Production.
5. Configure protected Production values and run `npm run bootstrap:production`. The
   command proves the Production endpoint and creates/verifies a Neon snapshot first.
6. Record only safe evidence: project/branch IDs, endpoint fingerprint, source commit,
   snapshot ID, and successful post-bootstrap checks.

The schema creates no resident fixtures. Founder resident `#1` is created only by the
ordinary application registration flow after deployment.

## Forward-port status - 2026-09-03

Completed: this fork's bootstrap guard was reconciled against upstream commit
`d195c5b2492a81f98919ee65deb8eb75760f7659`. It reuses the current shared Neon
project-and-branch endpoint proof, direct-URL parsing, transaction limits, and Production
snapshot preparation. No Neon, Vercel, or application deployment action was performed.

Proposed next step: provide the protected Preview-only values, confirm a distinct empty
branch, and run `npm run bootstrap:preview` from the reviewed commit. Record only the
safe evidence listed above. Do not run the Production command as a Preview rehearsal.
