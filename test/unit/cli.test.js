// Entry points run as real child processes with an isolated environment (never the repository's .env).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { tempDir, stubCommand, withEnv, FAKE_DOCKER, ROOT } from '../helpers/setup.js'
import bootstrap from '../../app/bootstrap.js'
import Logger from '../../app/libs/logger.js'
import { redact, clearSecrets } from '../../app/libs/redact.js'

const GOOGLE = { GOOGLE_APP: '{"clientId":"id","clientSecret":"secret-123"}', GOOGLE_AUTH: '{"refresh_token":"refresh-456"}' }

function baseEnv(t, extra = {}) {
    const dir = tempDir(t)
    const src = path.join(dir, 'src')
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')
    return {
        PATH: process.env.PATH,
        NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE, // keeps coverage reports of child processes
        TMPDIR: dir,
        APP_ENV: 'test', // no app/config/test: console logging only
        BACKUP_PATHS: src,
        BACKUP_STORAGE_DIR: path.join(dir, 'storage'),
        BACKUP_DATA_DIR: path.join(dir, 'data'),
        ...extra,
    }
}

const node = (script, args, env, options = {}) =>
    spawnSync(process.execPath, [path.join(ROOT, script), ...args], { env, encoding: 'utf8', timeout: 30000, ...options })

// --- bootstrap ---------------------------------------------------------------

test('bootstrap validates the environment, registers secrets and picks the scheduler tick', async (t) => {
    const previous = Logger.getConfig()
    t.after(() => {
        Logger.setConfig(previous)
        clearSecrets()
    })
    withEnv(t, { APP_ENV: 'test', BACKUP_PATHS: '/etc/hostname', MARIADB_PASSWORD: 'maria-secret', SCHEDULER_INTERVAL: undefined, ...GOOGLE })

    const { config, tickInterval, errors } = await bootstrap({ requireAuth: true, exitOnError: false })
    assert.deepEqual(errors, [])
    assert.equal(config.backup.paths[0], '/etc/hostname')
    assert.equal(tickInterval, 15000)
    assert.equal(process.umask(), 0o077)
    assert.equal(redact('pw maria-secret, token refresh-456'), 'pw ***, token ***')

    withEnv(t, { SCHEDULER_INTERVAL: '2500' })
    assert.equal((await bootstrap({ exitOnError: false })).tickInterval, 2500)
})

test('bootstrap reports auth errors only when they are required', async (t) => {
    withEnv(t, { APP_ENV: 'test', BACKUP_PATHS: '/etc/hostname', GOOGLE_APP: undefined, GOOGLE_AUTH: undefined })
    assert.equal((await bootstrap({ requireAuth: false, exitOnError: false })).errors.length, 0)
    assert.equal((await bootstrap({ requireAuth: true, exitOnError: false })).errors.length, 2)
})

test('bootstrap loads app/config/<APP_ENV> with imagic-config', async (t) => {
    const previous = Logger.getConfig()
    t.after(() => Logger.setConfig(previous))
    withEnv(t, { APP_ENV: 'live', BACKUP_PATHS: '/etc/hostname' })
    const { fileConfig } = await bootstrap({ requireAuth: false, exitOnError: false })
    assert.deepEqual(fileConfig.logger, { output: ['console', 'file'] })
    assert.deepEqual(fileConfig.scheduler, { interval: 15000 })
})

// --- app/index.js (service) ----------------------------------------------------

test('service: exits 1 on invalid configuration', (t) => {
    const { status, stdout } = node('app/index.js', [], baseEnv(t, { BACKUP_COMPRESSION: 'rar' }))
    assert.equal(status, 1)
    assert.match(stdout, /BACKUP_COMPRESSION must be one of gzip, zstd/)
    assert.match(stdout, /Invalid configuration/)
})

test('service: starts the scheduler and shuts down cleanly on SIGTERM', async (t) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'app/index.js')], { env: baseEnv(t, { ...GOOGLE, SCHEDULER_INTERVAL: '1000' }) })
    let stdout = ''
    let signalled = false
    child.stdout.on('data', (chunk) => {
        stdout += chunk
        if (!signalled && stdout.includes('Started; periods: daily')) {
            signalled = true // exactly one signal: a second one during exit would kill the process
            child.kill('SIGTERM')
        }
    })
    const [code] = await new Promise((resolve) => child.on('close', (...args) => resolve(args)))
    assert.equal(code, 0, stdout)
    assert.match(stdout, /\(Scheduler\) \[LOG\] Started with tick interval 1000ms/)
    assert.match(stdout, /SIGTERM received, shutting down/)
    assert.doesNotMatch(stdout, /secret-123|refresh-456/)
})

// --- app/once.js ---------------------------------------------------------------

test('backup:once rejects unknown periods and invalid configuration', (t) => {
    const unknown = node('app/once.js', ['--no-upload', 'fortnightly'], baseEnv(t))
    assert.equal(unknown.status, 1)
    assert.match(unknown.stdout, /Unknown period\(s\): fortnightly/)

    const invalid = node('app/once.js', ['--no-upload'], baseEnv(t, { BACKUP_PERIODS: 'often' }))
    assert.equal(invalid.status, 1)
    assert.match(invalid.stdout, /Invalid configuration/)

    const noAuth = node('app/once.js', [], baseEnv(t))
    assert.equal(noAuth.status, 1)
    assert.match(noAuth.stdout, /GOOGLE_AUTH must contain a "refresh_token"/)
})

test('backup:once --no-upload accepts explicit periods', (t) => {
    const { status, stdout } = node('app/once.js', ['--no-upload', 'weekly', 'monthly'], baseEnv(t))
    assert.equal(status, 0, stdout)
    assert.match(stdout, /Backup started for: weekly, monthly/)
})

// --- app/check.js --------------------------------------------------------------

test('check: reports each item and exits 1 when something is wrong', (t) => {
    const { status, stdout } = node('app/check.js', ['--telegram'], baseEnv(t, { BACKUP_PATHS: `${path.join(ROOT, 'app')},/missing` }))
    assert.equal(status, 1)
    assert.match(stdout, /^✖ configuration — GOOGLE_APP must be JSON/m)
    assert.match(stdout, /^✔ tar — \/\S+tar$/m)
    assert.match(stdout, /^✔ gzip — /m)
    assert.match(stdout, /^✔ storage directory — .* free\)$/m)
    assert.match(stdout, /^✔ backup paths — missing \(will be skipped\): \/missing$/m)
    assert.match(stdout, /^✖ Google Drive access — /m)
    assert.match(stdout, /^✖ Telegram — not configured or sending failed/m)
})

test('check: verifies database containers and the dump tool inside them', (t) => {
    const bin = path.join(tempDir(t), 'bin')
    stubCommand(t, bin, 'mariadb-dump', 'exit 0')
    const env = baseEnv(t, {
        PATH: `${bin}:${process.env.PATH}`,
        DOCKER_COMMAND: FAKE_DOCKER,
        FAKE_DOCKER_CONTAINERS: 'db',
        MARIADB_ENABLED: 'true',
        MARIADB_ALL: 'true',
        MARIADB_DOCKER_CONTAINER: 'db',
        POSTGRES_ENABLED: 'true',
        POSTGRES_ALL: 'true',
        POSTGRES_DOCKER_CONTAINER: 'gone',
    })
    const { stdout } = node('app/check.js', [], env)
    assert.match(stdout, /^✔ MariaDB container "db" — running$/m)
    assert.match(stdout, new RegExp(`^✔ MariaDB dump tool \\(in container\\) — ${bin}/mariadb-dump$`, 'm'))
    assert.match(stdout, /^✖ PostgreSQL container "gone" — Docker container "gone" does not exist$/m)
})

// --- app/code/create.js ----------------------------------------------------------

test('create-auth explains a missing GOOGLE_APP', (t) => {
    const { status, stderr } = node('app/code/create.js', [], baseEnv(t))
    assert.equal(status, 1)
    assert.match(stderr, /GOOGLE_APP must be set to/)
})

test('create-auth prints the consent URL and waits for the code', (t) => {
    const { stdout } = node('app/code/create.js', [], baseEnv(t, GOOGLE), { input: '', timeout: 10000 })
    assert.match(stdout, /Open this URL in a browser/)
    assert.match(stdout, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?\S*scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fdrive\.file/)
    assert.match(stdout, /Paste it here:/)
})
