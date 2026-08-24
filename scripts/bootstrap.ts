// Initialize one empty, verified Neon branch from the reviewed full schema.
// This is intentionally separate from additive release migrations.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import {
  describeDatabaseUrl,
  requiredIdentifier,
  type DatabaseIdentity,
} from './database-target.ts'
import {
  MIGRATION_LOCK_TIMEOUT,
  MIGRATION_STATEMENT_TIMEOUT,
  prepareMigrationStatements,
  prepareProductionMigration,
  verifyPreviewDatabaseTarget,
} from './migrate.ts'

export type BootstrapTarget = 'preview' | 'production'

export type BootstrapRun = Readonly<{
  target: BootstrapTarget
  databaseUrl: string
  identity: DatabaseIdentity
  projectId: string
  branchId: string
  productionBranchId: string
  sourceCommit: string
  snapshotName?: string
}>

type Environment = Readonly<Record<string, string | undefined>>
type Queryable = Readonly<{ query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }>

export const PREVIEW_BOOTSTRAP_ACKNOWLEDGEMENT =
  'INITIALIZE_EMPTY_GOBLIN_CITY_PREVIEW_DATABASE'
export const PRODUCTION_BOOTSTRAP_ACKNOWLEDGEMENT =
  'INITIALIZE_EMPTY_GOBLIN_CITY_PRODUCTION_DATABASE'

const SCHEMA_FILE = 'db/schema.sql'
const NEON_HOST_SUFFIX = '.neon.tech'
const CORE_TABLES = ['residents', 'places', 'events', 'notes']
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/

function requiredAcknowledgement(target: BootstrapTarget, environment: Environment): void {
  const variable = target === 'preview'
    ? 'CONFIRM_PREVIEW_BOOTSTRAP'
    : 'CONFIRM_PRODUCTION_BOOTSTRAP'
  const expected = target === 'preview'
    ? PREVIEW_BOOTSTRAP_ACKNOWLEDGEMENT
    : PRODUCTION_BOOTSTRAP_ACKNOWLEDGEMENT
  if (environment[variable] !== expected) {
    throw new Error(`${target} bootstrap requires ${variable}=${expected}`)
  }
}

function requiredNeonIdentity(value: string | undefined, variable: string): DatabaseIdentity {
  const identity = describeDatabaseUrl(value ?? '', variable)
  if (!identity.hostname.endsWith(NEON_HOST_SUFFIX)) {
    throw new Error(`${variable} must use a direct Neon endpoint`)
  }
  return identity
}

function sourceCommitFromGit(): string {
  const value = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error('could not determine the reviewed source commit')
  return value
}

function reviewedSchemaFromGit(sourceCommit: string): string {
  try {
    const schema = execFileSync('git', ['show', `${sourceCommit}:${SCHEMA_FILE}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (!schema.trim()) throw new Error('empty schema')
    return schema
  } catch {
    throw new Error(`could not read ${SCHEMA_FILE} from reviewed source commit ${sourceCommit}`)
  }
}

export function resolveBootstrapRun(
  target: BootstrapTarget,
  environment: Environment,
  sourceCommit = sourceCommitFromGit(),
): BootstrapRun {
  requiredAcknowledgement(target, environment)
  if (!environment.NEON_API_KEY?.trim()) throw new Error(`${target} bootstrap requires NEON_API_KEY`)

  const projectId = requiredIdentifier(environment.NEON_PROJECT_ID, 'NEON_PROJECT_ID')
  const productionBranchId = requiredIdentifier(
    environment.NEON_PRODUCTION_BRANCH_ID,
    'NEON_PRODUCTION_BRANCH_ID',
  )
  const branchVariable = target === 'preview' ? 'NEON_PREVIEW_BRANCH_ID' : 'NEON_PRODUCTION_BRANCH_ID'
  const branchId = requiredIdentifier(environment[branchVariable], branchVariable)
  if (target === 'preview' && branchId === productionBranchId) {
    throw new Error('preview bootstrap branch must not be the production branch')
  }

  const urlVariable = target === 'preview'
    ? 'PREVIEW_DATABASE_URL_UNPOOLED'
    : 'PRODUCTION_DATABASE_URL_UNPOOLED'
  const identity = requiredNeonIdentity(environment[urlVariable], urlVariable)
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
    throw new Error('source commit must be a full Git SHA')
  }

  if (target === 'production') {
    const snapshotName = environment.PRODUCTION_SNAPSHOT_NAME?.trim() ?? ''
    if (!SNAPSHOT_NAME.test(snapshotName)) {
      throw new Error('production bootstrap requires a safe PRODUCTION_SNAPSHOT_NAME')
    }
    return Object.freeze({
      target, databaseUrl: identity.databaseUrl, identity, projectId, branchId,
      productionBranchId, sourceCommit, snapshotName,
    })
  }
  return Object.freeze({
    target, databaseUrl: identity.databaseUrl, identity, projectId, branchId,
    productionBranchId, sourceCommit,
  })
}

export function safeBootstrapError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[redacted database URL]')
    .replace(/(?:NEON_API_KEY|authorization|password)\s*[=:]\s*[^\s]+/gi, 'credential=[redacted]')
}

async function scalarCount(database: Queryable, text: string): Promise<number> {
  const result = await database.query(text)
  const value = (result.rows[0] as { count?: unknown } | undefined)?.count
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('database emptiness check returned invalid evidence')
  return count
}

function systemSchema(namespace: string): string {
  return `(
    ${namespace}.nspname IN ('pg_catalog', 'information_schema', 'pg_toast')
    OR pg_is_other_temp_schema(${namespace}.oid)
    OR ${namespace}.oid = pg_my_temp_schema()
  )`
}

const NON_SYSTEM_SCHEMA = systemSchema('namespace')

/**
 * Refuse persistent user state in every schema, while allowing only PostgreSQL's
 * documented catalog, information, TOAST, and temporary namespaces. `public` is
 * allowed as a fresh namespace but any object within it is evidence of prior use.
 */
export async function assertEmptyDatabase(database: Queryable): Promise<void> {
  const checks: readonly (readonly [string, string])[] = [
    ['non-system schemas', `SELECT count(*)::integer AS count FROM pg_namespace AS namespace WHERE namespace.nspname <> 'public' AND NOT ${NON_SYSTEM_SCHEMA}`],
    ['relations', `SELECT count(*)::integer AS count FROM pg_class AS object JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace WHERE NOT ${NON_SYSTEM_SCHEMA}`],
    ['routines', `SELECT count(*)::integer AS count FROM pg_proc AS object JOIN pg_namespace AS namespace ON namespace.oid = object.pronamespace WHERE NOT ${NON_SYSTEM_SCHEMA}`],
    ['user-defined types', `SELECT count(*)::integer AS count FROM pg_type AS object JOIN pg_namespace AS namespace ON namespace.oid = object.typnamespace WHERE object.typtype <> 'p' AND NOT ${NON_SYSTEM_SCHEMA}`],
    ['extensions', `SELECT count(*)::integer AS count FROM pg_extension AS extension JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace WHERE NOT (extension.extname = 'plpgsql' AND namespace.nspname = 'pg_catalog')`],
    ['schema-scoped objects', `SELECT count(*)::integer AS count FROM (
      SELECT object.oid FROM pg_collation AS object JOIN pg_namespace AS namespace ON namespace.oid = object.collnamespace WHERE NOT ${NON_SYSTEM_SCHEMA}
      UNION ALL SELECT object.oid FROM pg_conversion AS object JOIN pg_namespace AS namespace ON namespace.oid = object.connamespace WHERE NOT ${NON_SYSTEM_SCHEMA}
      UNION ALL SELECT object.oid FROM pg_operator AS object JOIN pg_namespace AS namespace ON namespace.oid = object.oprnamespace WHERE NOT ${NON_SYSTEM_SCHEMA}
      UNION ALL SELECT object.oid FROM pg_opclass AS object JOIN pg_namespace AS namespace ON namespace.oid = object.opcnamespace WHERE NOT ${NON_SYSTEM_SCHEMA}
      UNION ALL SELECT object.oid FROM pg_opfamily AS object JOIN pg_namespace AS namespace ON namespace.oid = object.opfnamespace WHERE NOT ${NON_SYSTEM_SCHEMA}
      UNION ALL SELECT object.oid FROM pg_ts_config AS object JOIN pg_namespace AS namespace ON namespace.oid = object.cfgnamespace WHERE NOT ${NON_SYSTEM_SCHEMA}
      UNION ALL SELECT object.oid FROM pg_ts_dict AS object JOIN pg_namespace AS namespace ON namespace.oid = object.dictnamespace WHERE NOT ${NON_SYSTEM_SCHEMA}
      UNION ALL SELECT object.oid FROM pg_ts_parser AS object JOIN pg_namespace AS namespace ON namespace.oid = object.prsnamespace WHERE NOT ${NON_SYSTEM_SCHEMA}
      UNION ALL SELECT object.oid FROM pg_ts_template AS object JOIN pg_namespace AS namespace ON namespace.oid = object.tmplnamespace WHERE NOT ${NON_SYSTEM_SCHEMA}
    ) AS object`],
    ['database-scoped state', `SELECT count(*)::integer AS count FROM (
      SELECT object.oid FROM pg_default_acl AS object
      UNION ALL SELECT object.oid FROM pg_db_role_setting AS object WHERE object.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      UNION ALL SELECT object.oid FROM pg_publication AS object
      UNION ALL SELECT object.oid FROM pg_subscription AS object
      UNION ALL SELECT object.oid FROM pg_event_trigger AS object
    ) AS object`],
  ]
  const results = await Promise.all(checks.map(async ([label, query]) => [label, await scalarCount(database, query)] as const))
  const evidence = results.filter(([, count]) => count !== 0).map(([label]) => label)
  if (evidence.length) {
    throw new Error(`bootstrap requires a pristine database; found existing ${evidence.join(', ')}`)
  }
}

export async function verifyFreshInstall(database: Queryable): Promise<void> {
  const tables = await database.query(
    `SELECT name, to_regclass('public.' || name)::text AS relation FROM unnest($1::text[]) AS required(name)`,
    [CORE_TABLES],
  )
  const missing = (tables.rows as { name?: unknown; relation?: unknown }[])
    .filter(row => typeof row.name !== 'string' || row.relation !== `public.${row.name}`)
    .map(row => String(row.name))
  if (missing.length) throw new Error(`bootstrap is missing required core tables: ${missing.join(', ')}`)

  const extension = await database.query(
    `SELECT extension.extname FROM pg_extension AS extension JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace WHERE extension.extname = 'pg_trgm' AND namespace.nspname = 'public'`,
  )
  if (extension.rows.length !== 1) throw new Error('bootstrap did not install pg_trgm in the public schema')

  const residents = await scalarCount(database, 'SELECT count(*)::integer AS count FROM public.residents')
  if (residents !== 0) throw new Error('bootstrap unexpectedly created resident fixtures')
}

/**
 * An empty check and schema write must share a transaction; applyMigration cannot expose
 * its Neon transaction callback, so this uses the repository's pg dependency and the
 * exact statement preparation/timeouts from scripts/migrate.ts.
 */
export async function applyFreshSchema(
  databaseUrl: string,
  schema: string,
  createClient: (url: string) => Client = url => new Client({ connectionString: url }),
): Promise<number> {
  const statements = prepareMigrationStatements(schema)
  const client = createClient(databaseUrl)
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`)
    await client.query(`SET LOCAL statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`)
    await client.query("SELECT pg_advisory_xact_lock(hashtext('goblin-city-neon-bootstrap-v1'))")
    await assertEmptyDatabase(client)
    for (const statement of statements.slice(2)) await client.query(statement)
    await client.query('COMMIT')
    return statements.length - 2
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

async function withClient<T>(databaseUrl: string, action: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await action(client)
  } finally {
    await client.end()
  }
}

export async function bootstrap(
  run: BootstrapRun,
  environment: Environment,
  options: Readonly<{
    verifyPreview?: typeof verifyPreviewDatabaseTarget
    prepareProduction?: typeof prepareProductionMigration
    apply?: typeof applyFreshSchema
    verify?: typeof verifyFreshInstall
    postVerify?: (databaseUrl: string, verify: typeof verifyFreshInstall) => Promise<void>
    schema?: string
    logger?: (message: string) => void
  }> = {},
): Promise<void> {
  const logger = options.logger ?? console.log
  const safeTarget = `project=${run.projectId} branch=${run.branchId} endpoint=${run.identity.endpointFingerprint}`
  logger(`bootstrap target requested for ${run.target}: ${safeTarget}`)
  logger(`bootstrap source commit=${run.sourceCommit} schema=${SCHEMA_FILE}`)
  if (run.target === 'preview') {
    await (options.verifyPreview ?? verifyPreviewDatabaseTarget)(
      { projectId: run.projectId, branchId: run.branchId, productionBranchId: run.productionBranchId },
      run.databaseUrl,
      environment.NEON_API_KEY!,
    )
    logger(`bootstrap target verified for ${run.target}: ${safeTarget}`)
  } else {
    const snapshotId = await (options.prepareProduction ?? prepareProductionMigration)(
      { projectId: run.projectId, branchId: run.branchId, name: run.snapshotName! },
      run.databaseUrl,
      environment.NEON_API_KEY!,
    )
    logger(`bootstrap target verified for ${run.target}: ${safeTarget}`)
    logger(`bootstrap production snapshot verified: ${snapshotId}`)
  }

  const schema = options.schema ?? reviewedSchemaFromGit(run.sourceCommit)
  const count = await (options.apply ?? applyFreshSchema)(run.databaseUrl, schema)
  if (options.postVerify) {
    await options.postVerify(run.databaseUrl, options.verify ?? verifyFreshInstall)
  } else {
    await withClient(run.databaseUrl, options.verify ?? verifyFreshInstall)
  }
  logger(`bootstrap completed: ${count} reviewed schema statements applied to ${run.target}`)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command !== 'preview' && command !== 'production') {
    throw new Error('bootstrap requires preview or production')
  }
  const run = resolveBootstrapRun(command, process.env)
  await bootstrap(run, process.env)
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(error => {
    console.error(safeBootstrapError(error))
    process.exitCode = 1
  })
}
