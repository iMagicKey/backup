// Diagnoses the configuration and environment without creating a backup:
//   npm run check                # config, tools, containers, storage, Google Drive access
//   npm run check -- --telegram  # additionally send a test Telegram message
import fs from 'node:fs'
import bootstrap from './bootstrap.js'
import { run } from './code/utils/exec.js'
import { assertContainerRunning, wrapInContainer } from './code/utils/docker.js'
import { getCompression } from './code/utils/tar.js'
import { createDriveClient, escapeQuery, FOLDER_MIME } from './code/utils/drive.js'
import { formatBytes, ensurePrivateDir } from './code/utils/fs.js'
import { report } from './code/utils/report.js'

const { config, errors } = await bootstrap({ requireAuth: true, exitOnError: false })
const results = []

async function check(name, fn) {
    try {
        const detail = await fn()
        results.push({ ok: true, name, detail })
    } catch (err) {
        results.push({ ok: false, name, detail: err.message.split('\n')[0] })
    }
}

const commandExists = (command, container) =>
    run({
        ...(container
            ? wrapInContainer({ command: 'sh', args: ['-c', `command -v ${command}`] }, { container, dockerCommand: config.docker.command })
            : { command: 'sh', args: ['-c', `command -v ${command}`] }),
        captureStdout: true,
        timeoutMs: 30000,
        label: `lookup of ${command}`,
    }).then(({ stdout }) => stdout.trim())

await check('configuration', () => {
    if (errors.length) throw new Error(errors.join('; '))
    return `periods: ${config.backup.periods.join(', ')}; compression: ${config.backup.compression}`
})

await check('tar', () => commandExists('tar'))
await check(config.backup.compression, () => commandExists(getCompression(config.backup).stream.command))

await check('storage directory', () => {
    ensurePrivateDir(config.backup.storageDir)
    fs.accessSync(config.backup.storageDir, fs.constants.W_OK)
    const { bavail, bsize } = fs.statfsSync(config.backup.storageDir)
    return `${config.backup.storageDir} (${formatBytes(bavail * bsize)} free)`
})

if (config.backup.paths.length) {
    await check('backup paths', () => {
        const missing = config.backup.paths.filter((p) => !fs.existsSync(p))
        if (missing.length === config.backup.paths.length) throw new Error(`none exist: ${missing.join(', ')}`)
        return missing.length ? `missing (will be skipped): ${missing.join(', ')}` : config.backup.paths.join(', ')
    })
}

const databases = [
    { name: 'MariaDB', cfg: config.mariadb, tool: config.mariadb.dumpCommand || 'mariadb-dump || command -v mysqldump' },
    { name: 'PostgreSQL', cfg: config.postgres, tool: config.postgres.all ? 'pg_dumpall' : 'pg_dump' },
    { name: 'MongoDB', cfg: config.mongodb, tool: 'mongodump' },
]
for (const { name, cfg, tool } of databases.filter((db) => db.cfg.enabled)) {
    if (cfg.container) {
        await check(`${name} container "${cfg.container}"`, () => assertContainerRunning(cfg.container, config.docker.command).then(() => 'running'))
    }

    await check(`${name} dump tool${cfg.container ? ' (in container)' : ''}`, () => commandExists(tool, cfg.container))
}

await check('Google Drive access', async () => {
    if (config.authErrors.length) throw new Error(config.authErrors.join('; '))
    const client = createDriveClient(config)
    const res = await client.files.list({
        q: `name = '${escapeQuery(config.backup.serverName)}' and mimeType = '${FOLDER_MIME}' and '${escapeQuery(config.google.folderId)}' in parents and trashed = false`,
        fields: 'files(id)',
        pageSize: 1,
    })
    return res.data.files?.length ? `folder "${config.backup.serverName}" found` : `authorized (folder "${config.backup.serverName}" will be created)`
})

if (process.argv.includes('--telegram')) {
    await check('Telegram', async () => {
        if (!(await report('🧪 Test message from `npm run check`'))) throw new Error('not configured or sending failed (see log above)')
        return 'test message sent'
    })
}

for (const { ok, name, detail } of results) {
    console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
}
process.exit(results.every((r) => r.ok) ? 0 : 1)
