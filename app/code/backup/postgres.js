import path from 'node:path'
import crypto from 'node:crypto'
import { runToFile } from '../utils/exec.js'
import { getCompression } from '../utils/tar.js'
import { inContainerIfConfigured, assertContainerRunning } from '../utils/docker.js'

function connectionArgs({ host, port, user }) {
    const args = ['--no-password'] // never prompt; fail fast if credentials are wrong
    if (host) args.push(`--host=${host}`)
    if (port) args.push(`--port=${port}`)
    if (user) args.push(`--username=${user}`)
    return args
}

function wrap(spec, { postgres, docker }) {
    return inContainerIfConfigured({ ...spec, env: postgres.password ? { PGPASSWORD: postgres.password } : {} }, postgres.container, docker.command)
}

// Plain SQL of every database plus roles and tablespaces (restore with psql).
export function buildPgDumpAllCommand(config) {
    const { postgres } = config
    return wrap({ command: 'pg_dumpall', args: [...connectionArgs(postgres), ...postgres.extraArgs], label: 'pg_dumpall' }, config)
}

// Custom-format archive of one database (already compressed; restore with pg_restore).
export function buildPgDumpCommand(config, database) {
    const { postgres } = config
    return wrap(
        {
            command: 'pg_dump',
            args: [...connectionArgs(postgres), '--format=custom', ...postgres.extraArgs, `--dbname=${database}`],
            label: `pg_dump ${database}`,
        },
        config
    )
}

// File-name-safe database name; a short hash keeps names unique when characters had to be replaced.
export function safeName(name) {
    const safe = name.replace(/[^\w.-]/g, '_')
    return safe === name ? name : `${safe}-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 8)}`
}

export default async function backupPostgres(config, { runDir, timeoutMs, failures }) {
    const { postgres, docker } = config
    if (!postgres.enabled) return []

    if (postgres.container) await assertContainerRunning(postgres.container, docker.command)

    if (postgres.all) {
        const compression = getCompression(config.backup)
        const file = `postgres-all.sql${compression.extension}`
        await runToFile({ ...buildPgDumpAllCommand(config), timeoutMs }, path.join(runDir, file), { compressor: compression.stream })
        return [{ component: 'postgres', file }]
    }

    // One failing database must not discard the dumps of the others.
    const artifacts = []
    const errors = []
    for (const database of postgres.databases) {
        const file = `postgres-${safeName(database)}.dump`
        try {
            await runToFile({ ...buildPgDumpCommand(config, database), timeoutMs }, path.join(runDir, file))
            artifacts.push({ component: 'postgres', database, file })
        } catch (err) {
            errors.push({ component: `PostgreSQL (${database})`, error: err })
        }
    }
    if (!artifacts.length && errors.length === 1) throw errors[0].error
    failures.push(...errors)
    return artifacts
}
