import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  PREVIEW_BOOTSTRAP_ACKNOWLEDGEMENT,
  PRODUCTION_BOOTSTRAP_ACKNOWLEDGEMENT,
  assertEmptyDatabase,
  bootstrap,
  resolveBootstrapRun,
  safeBootstrapError,
  verifyFreshInstall,
} from '../scripts/bootstrap.ts'
import { prepareMigrationStatements, verifyPreviewDatabaseTarget } from '../scripts/migrate.ts'

const directPreview = 'postgres://role:password@ep-preview-one.us-east-2.aws.neon.tech:5432/city'
const directProduction = 'postgres://role:password@ep-production-one.us-east-2.aws.neon.tech:5432/city'
const fullSchema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    NEON_API_KEY: 'secret-neon-key',
    NEON_PROJECT_ID: 'project-one',
    NEON_PREVIEW_BRANCH_ID: 'branch-preview',
    NEON_PRODUCTION_BRANCH_ID: 'branch-production',
    PREVIEW_DATABASE_URL_UNPOOLED: directPreview,
    PRODUCTION_DATABASE_URL_UNPOOLED: directProduction,
    CONFIRM_PREVIEW_BOOTSTRAP: PREVIEW_BOOTSTRAP_ACKNOWLEDGEMENT,
    CONFIRM_PRODUCTION_BOOTSTRAP: PRODUCTION_BOOTSTRAP_ACKNOWLEDGEMENT,
    PRODUCTION_SNAPSHOT_NAME: 'goblin-city-bootstrap-001',
    ...overrides,
  }
}

test('bootstrap rejects missing acknowledgement, poolers, non-Neon endpoints, wrong ports, and preview=production', () => {
  assert.throws(() => resolveBootstrapRun('preview', environment({ CONFIRM_PREVIEW_BOOTSTRAP: undefined }), 'a'.repeat(40)), /CONFIRM_PREVIEW_BOOTSTRAP/)
  assert.throws(() => resolveBootstrapRun('preview', environment({ PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@ep-pooler.neon.tech:5432/city' }), 'a'.repeat(40)), /non-pooled/i)
  assert.throws(() => resolveBootstrapRun('preview', environment({ PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@db.example.test:5432/city' }), 'a'.repeat(40)), /direct Neon endpoint/)
  assert.throws(() => resolveBootstrapRun('preview', environment({ PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@ep-preview-one.neon.tech:5433/city' }), 'a'.repeat(40)), /port 5432/)
  assert.throws(() => resolveBootstrapRun('preview', environment({ NEON_PREVIEW_BRANCH_ID: 'branch-production' }), 'a'.repeat(40)), /must not be the production branch/)
})

test('production requires the stronger acknowledgement and a snapshot name', () => {
  assert.throws(() => resolveBootstrapRun('production', environment({ CONFIRM_PRODUCTION_BOOTSTRAP: undefined }), 'a'.repeat(40)), /CONFIRM_PRODUCTION_BOOTSTRAP/)
  assert.throws(() => resolveBootstrapRun('production', environment({ PRODUCTION_SNAPSHOT_NAME: 'bad name' }), 'a'.repeat(40)), /PRODUCTION_SNAPSHOT_NAME/)
})

test('reused Neon endpoint verification rejects a wrong project or branch', async () => {
  const target = { projectId: 'project-one', branchId: 'branch-preview', productionBranchId: 'branch-production' }
  const endpoint = (projectId: string, branchId: string) => async () => new Response(JSON.stringify({
    endpoints: [{
      id: 'ep-preview-one', host: 'ep-preview-one.us-east-2.aws.neon.tech',
      project_id: projectId, branch_id: branchId, type: 'read_write',
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  await assert.rejects(verifyPreviewDatabaseTarget(target, directPreview, 'secret-neon-key', endpoint('wrong-project', 'branch-preview') as typeof fetch), /Could not prove the preview database target/)
  await assert.rejects(verifyPreviewDatabaseTarget(target, directPreview, 'secret-neon-key', endpoint('project-one', 'wrong-branch') as typeof fetch), /Could not prove the preview database target/)
})

test('empty-database check ignores only PostgreSQL system and temporary schemas', async () => {
  const queries: string[] = []
  await assertEmptyDatabase({ query: async text => { queries.push(text); return { rows: [{ count: '0' }] } } })
  assert.ok(queries.some(query => query.includes("'pg_catalog', 'information_schema', 'pg_toast'")))
  assert.ok(queries.some(query => query.includes('pg_is_other_temp_schema')))
  assert.ok(queries.some(query => query.includes('pg_my_temp_schema()')))
  const databaseScoped = queries.find(query => query.includes('FROM pg_db_role_setting AS object'))
  assert.ok(databaseScoped)
  assert.doesNotMatch(databaseScoped, /pg_db_role_setting AS object WHERE object\.oid/u)
})

test('empty-database check permits only Neon\'s exact managed public default ACLs', async () => {
  const queries: string[] = []
  await assertEmptyDatabase({ query: async text => { queries.push(text); return { rows: [{ count: '0' }] } } })
  const defaultAcl = queries.find(query => query.includes('FROM pg_default_acl AS object'))
  assert.ok(defaultAcl)
  assert.match(defaultAcl, /role\.rolname = 'cloud_admin'/u)
  assert.match(defaultAcl, /namespace\.nspname = 'public'/u)
  assert.match(defaultAcl, /object\.defaclobjtype = 'S'/u)
  assert.match(defaultAcl, /object\.defaclobjtype = 'r'/u)
  assert.match(defaultAcl, /neon_superuser=r\*w\*U\*\/cloud_admin/u)
  assert.match(defaultAcl, /neon_superuser=a\*r\*w\*d\*D\*x\*t\*m\*\/cloud_admin/u)
  const exactPair = queries.find(query => query.includes("CASE WHEN count(*) = 2 THEN 0 ELSE 1"))
  assert.ok(exactPair)
  await assert.rejects(
    assertEmptyDatabase({ query: async text => ({ rows: [{ count: text.includes('FROM pg_default_acl AS object') ? '1' : '0' }] }) }),
    /pristine database/u,
  )
  await assert.rejects(
    assertEmptyDatabase({ query: async text => ({ rows: [{ count: text.includes("CASE WHEN count(*) = 2 THEN 0 ELSE 1") ? '1' : '0' }] }) }),
    /the exact Neon managed default ACL pair/u,
  )
})

test('empty-database check refuses persistent state in every user schema', async () => {
  const cases = [
    ['a user-created schema', 'FROM pg_namespace AS namespace WHERE'],
    ['a public relation', 'FROM pg_class AS object'],
    ['a public routine such as show_db_tree', 'FROM pg_proc AS object'],
    ['a user-defined type outside public', 'FROM pg_type AS object'],
    ['an extension outside public', 'FROM pg_extension AS extension'],
    ['database-scoped state', 'FROM pg_default_acl AS object'],
  ] as const
  for (const [label, marker] of cases) {
    await assert.rejects(assertEmptyDatabase({ query: async text => ({ rows: [{ count: text.includes(marker) ? '1' : '0' }] }) }), /pristine database/, label)
  }
})

test('fresh-install verification requires core tables, pg_trgm, and zero residents', async () => {
  let call = 0
  await verifyFreshInstall({
    query: async () => {
      call += 1
      if (call === 1) return { rows: ['residents', 'places', 'events', 'notes'].map(name => ({ name, present: true })) }
      if (call === 2) return { rows: [{ extname: 'pg_trgm' }] }
      return { rows: [{ count: '0' }] }
    },
  })
  await assert.rejects(verifyFreshInstall({ query: async () => ({ rows: [{ name: 'residents', relation: null }] }) }), /missing required core tables/)
})

test('the current reviewed full schema remains transaction-safe and creates no resident fixture', () => {
  const statements = prepareMigrationStatements(fullSchema)
  assert.ok(statements.length > 100)
  assert.match(statements[2] ?? '', /CREATE EXTENSION IF NOT EXISTS pg_trgm/i)
  assert.doesNotMatch(fullSchema, /\bINSERT\s+INTO\s+(?:public\.)?residents\b/i)
})

test('production bootstrap fails closed when snapshot setup fails and never applies schema', async () => {
  const run = resolveBootstrapRun('production', environment(), 'a'.repeat(40))
  let applied = false
  await assert.rejects(bootstrap(run, environment(), {
    prepareProduction: async () => { throw new Error('snapshot unavailable') },
    apply: async () => { applied = true; return 1 },
    logger: () => undefined,
  }), /snapshot unavailable/)
  assert.equal(applied, false)
})

test('preview bootstrap verifies target before applying and logging redacts credentials', async () => {
  const run = resolveBootstrapRun('preview', environment(), 'a'.repeat(40))
  const calls: string[] = []
  await bootstrap(run, environment(), {
    verifyPreview: async () => { calls.push('verify') },
    apply: async () => { calls.push('apply'); return 42 },
    verify: async () => { calls.push('postcheck') },
    postVerify: async () => { calls.push('postcheck') },
    schema: 'mock reviewed schema',
    logger: message => calls.push(message),
  })
  assert.deepEqual(calls.filter(value => ['verify', 'apply', 'postcheck'].includes(value)), ['verify', 'apply', 'postcheck'])
  assert.ok(calls.every(value => !value.includes('password') && !value.includes('secret-neon-key')))
  assert.equal(safeBootstrapError(new Error(`failed ${directPreview}`)), 'failed [redacted database URL]')
})
