# Fresh Neon bootstrap

`db/schema.sql` is the canonical full schema for a new Goblin City database. Historical
files in `db/migrations/` are additive upgrades for already initialized databases; never
replay them as a bootstrap sequence.

This fork provides two explicit commands:

```sh
npm run bootstrap:preview
npm run bootstrap:production
```

They are for a pristine Neon database only. They refuse pooled URLs, non-Neon hosts,
unproven project/branch endpoints, and persistent user state in any schema. The check
rejects non-system schemas, relations, routines, user-defined types, extensions,
schema-scoped objects, and database-scoped state before DDL. It permits only PostgreSQL's
`pg_catalog`, `information_schema`, `pg_toast`, and temporary namespaces, plus the empty
default `public` schema. It also permits the built-in `plpgsql` extension in `pg_catalog`.
It never resets, drops, truncates, or overwrites an existing database.

Neon documents that new databases include `public`; PostgreSQL documents the catalog and
information schemas. This check deliberately fails rather than treating any additional
Neon-specific persistent object as safe. It has not been run against a real Neon database.

## Required protected environment values

Both commands require `NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_PRODUCTION_BRANCH_ID`,
and a direct non-pooled Neon URL for the selected target.

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
password in a command line, committed file, or deployment log.

## Procedure

1. Create an isolated Neon Preview branch and an empty Production branch.
2. Configure the protected Preview values and run `npm run bootstrap:preview`.
3. Verify the target identity, source Git SHA, core tables, `pg_trgm`, and zero residents.
4. Deploy and exercise Preview before any Production work.
5. Configure the protected Production values and run `npm run bootstrap:production`.
   The command first proves the Production endpoint and creates/verifies a Neon snapshot.
6. Record only safe evidence: project/branch IDs, endpoint fingerprint, source commit,
   snapshot ID, and successful post-bootstrap checks.

The schema creates no fixtures or residents. Founder resident `#1` is created only by
the ordinary application registration flow after the application is deployed.
