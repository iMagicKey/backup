import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { configFrom, tempDir } from '../helpers/setup.js'
import { createBackup, cleanStorage, runBackup, uploadBackup, COMPONENTS } from '../../app/code/backup/index.js'
import { createFakeDrive } from '../helpers/fake-drive.js'
import { acquireLock, processStartTime } from '../../app/code/utils/fs.js'
import Telegram from 'imagic-telegram'
import { configureReport } from '../../app/code/utils/report.js'

const NOW = new Date('2026-10-30T00:00:00Z')

function component(name, fn) {
    return { name, run: fn }
}

const writes =
    (file, content) =>
    async (_config, { runDir }) => {
        fs.writeFileSync(path.join(runDir, file), content)
        return [{ component: file, file }]
    }

test('bundles successful components with manifest and checksums; records failures', async (t) => {
    const dir = tempDir(t)
    const config = configFrom({ BACKUP_STORAGE_DIR: dir })
    const result = await createBackup(config, {
        now: NOW,
        components: [component('a', writes('a.sql.gz', 'AAA')), component('b', async () => Promise.reject(new Error('db down')))],
    })

    assert.equal(path.basename(result.bundlePath), 'backup-2026-10-30_00-00.tar')
    assert.equal(result.failures[0].component, 'b')

    const out = path.join(dir, 'extract')
    fs.mkdirSync(out)
    execFileSync('tar', ['-xf', result.bundlePath, '-C', out])
    assert.deepEqual(fs.readdirSync(out).sort(), ['SHA256SUMS', 'a.sql.gz', 'manifest.json'])
    execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: out })

    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.failures, [{ component: 'b', error: 'db down' }])
    assert.equal(manifest.artifacts[0].size, 3)

    // The temporary run directory is removed.
    assert.deepEqual(
        fs.readdirSync(dir).filter((n) => n.startsWith('run-')),
        []
    )
})

test('throws when nothing could be backed up', async (t) => {
    const config = configFrom({ BACKUP_STORAGE_DIR: tempDir(t) })
    await assert.rejects(
        createBackup(config, { now: NOW, components: [component('x', async () => Promise.reject(new Error('nope')))] }),
        /No backup artifacts were created \(x\)/
    )
})

test('cleanStorage only removes files created by this service', (t) => {
    const dir = tempDir(t)
    const keep = ['notes.txt', 'backup-important.tar', 'other-2026-10-30_00-00.tar', 'dump-2026.10.26-21:00.sql', 'backup-2026-10-29_00-00.tar.bak']
    const remove = [
        'backup-2026-10-29_00-00.tar',
        'backup-2026.10.26-21:00.tar.zst',
        'files-2026.10.26-21:00.tar.zst',
        'mariadb-2026.10.26-21:00.sql',
        'mongodb-2026.10.26-21:00.archive',
        'backup-postgres-2026.10.26-21:00.pgsql',
    ]
    ;[...keep, ...remove].forEach((name) => fs.writeFileSync(path.join(dir, name), ''))
    fs.mkdirSync(path.join(dir, 'run-2026-10-29_00-00'))
    fs.mkdirSync(path.join(dir, 'run-scripts'))
    fs.mkdirSync(path.join(dir, 'photos'))

    cleanStorage({ storageDir: dir, prefix: 'backup-' })
    assert.deepEqual(fs.readdirSync(dir).sort(), [...keep, 'photos', 'run-scripts'].sort())
})

test('components can report partial failures', async (t) => {
    const config = configFrom({ BACKUP_STORAGE_DIR: tempDir(t) })
    const partial = async (_config, ctx) => {
        fs.writeFileSync(path.join(ctx.runDir, 'one.dump'), '1')
        ctx.failures.push({ component: 'X (two)', error: new Error('two failed') })
        return [{ component: 'x', file: 'one.dump' }]
    }
    const result = await createBackup(config, { now: NOW, components: [component('X', partial)] })
    assert.deepEqual(
        result.artifacts.map((a) => a.file),
        ['one.dump']
    )
    assert.equal(result.failures[0].component, 'X (two)')
})

test('lock prevents concurrent runs and recovers stale locks', (t) => {
    const lock = path.join(tempDir(t), '.lock')
    const release = acquireLock(lock)
    assert.throws(() => acquireLock(lock), /Another backup is already running/) // held by this live process

    fs.writeFileSync(lock, `${process.ppid} ${processStartTime(process.ppid)}`) // a live foreign process
    assert.throws(() => acquireLock(lock), /Another backup is already running/)

    fs.writeFileSync(lock, `${process.ppid} 1`) // pid reused by another process (start time differs)
    acquireLock(lock)()
    fs.writeFileSync(lock, '999999999 1') // dead pid
    acquireLock(lock)()
    release()
    assert.equal(fs.existsSync(lock), false)
    assert.deepEqual(
        fs.readdirSync(path.dirname(lock)).filter((n) => n.endsWith('.tmp')),
        []
    )
})

test('runBackup end to end with files and a fake Drive', async (t) => {
    const dir = tempDir(t)
    const src = path.join(dir, 'src')
    fs.mkdirSync(path.join(src, 'skip'), { recursive: true })
    fs.writeFileSync(path.join(src, 'keep.txt'), 'keep')
    fs.writeFileSync(path.join(src, 'skip', 'x.txt'), 'x')

    const config = configFrom({
        BACKUP_PATHS: src,
        BACKUP_EXCLUDES: 'skip',
        BACKUP_STORAGE_DIR: path.join(dir, 'storage'),
        BACKUP_KEEP_LOCAL: 'false',
    })
    const { client, files } = createFakeDrive()
    const result = await runBackup(config, { client, periods: ['daily', 'weekly'], now: NOW })

    assert.deepEqual(result.succeeded, ['daily', 'weekly'])
    assert.equal(fs.existsSync(result.bundle.bundlePath), false) // BACKUP_KEEP_LOCAL=false

    const uploaded = [...files.values()].find((f) => f.name === 'daily-2026-10-30_00-00.tar')
    const out = path.join(dir, 'restore')
    fs.mkdirSync(out)
    fs.writeFileSync(path.join(dir, 'dl.tar'), uploaded.content)
    execFileSync('tar', ['-xf', path.join(dir, 'dl.tar'), '-C', out])
    const listing = execFileSync('tar', ['-tzf', path.join(out, 'files.tar.gz')]).toString()
    assert.match(listing, /keep\.txt/)
    assert.doesNotMatch(listing, /skip/)
})

test('a failed upload keeps the local bundle even with BACKUP_KEEP_LOCAL=false; total failures are marked as reported', async (t) => {
    const dir = tempDir(t)
    const src = path.join(dir, 'src')
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')
    const config = configFrom({ BACKUP_PATHS: src, BACKUP_STORAGE_DIR: path.join(dir, 'storage'), BACKUP_KEEP_LOCAL: 'false' })

    const { client } = createFakeDrive()
    client.files.create = async () => {
        throw new Error('quota exceeded')
    }
    const result = await runBackup(config, { client, periods: ['daily'], now: NOW })
    assert.deepEqual(result.succeeded, [])
    assert.equal(fs.existsSync(result.bundle.bundlePath), true)

    const empty = configFrom({ BACKUP_PATHS: path.join(dir, 'missing'), BACKUP_STORAGE_DIR: path.join(dir, 'storage') })
    await assert.rejects(runBackup(empty, { client, periods: ['daily'], now: NOW }), (err) => err.reported === true)
})

test('a retention failure is a warning, not an upload failure', async (t) => {
    const dir = tempDir(t)
    const bundlePath = path.join(dir, 'b.tar')
    fs.writeFileSync(bundlePath, 'x')
    const { client } = createFakeDrive()
    const list = client.files.list
    client.files.list = async (params) => {
        if (params.q.includes('mimeType !=')) throw new Error('rate limited')
        return list(params)
    }
    const result = await uploadBackup(configFrom({}), client, { bundlePath, stamp: 's', size: 1 }, ['daily'])
    assert.deepEqual(result.succeeded, ['daily'])
    assert.deepEqual(result.failed, [])
    assert.match(result.warnings[0], /retention \[daily\]: rate limited/)
})

test('the files backup never includes the service working directories', async (t) => {
    const dir = tempDir(t)
    const storage = path.join(dir, 'storage')
    fs.mkdirSync(storage)
    fs.writeFileSync(path.join(storage, 'old.bin'), 'x')
    fs.writeFileSync(path.join(dir, 'data.txt'), 'd')
    const config = configFrom({ BACKUP_PATHS: dir, BACKUP_STORAGE_DIR: storage })
    const result = await createBackup(config, { now: NOW, components: COMPONENTS.filter((c) => c.name === 'files') })

    const out = path.join(dir, '..', `${path.basename(dir)}-out`)
    fs.mkdirSync(out)
    t.after(() => fs.rmSync(out, { recursive: true, force: true }))
    execFileSync('tar', ['-xf', result.bundlePath, '-C', out])
    const listing = execFileSync('tar', ['-tzf', path.join(out, 'files.tar.gz')]).toString()
    assert.match(listing, /data\.txt/)
    assert.doesNotMatch(listing, /storage/)
})

test('the lock is released when preparing the run fails', async (t) => {
    const dir = tempDir(t)
    const config = configFrom({ BACKUP_STORAGE_DIR: dir })
    // A plain file where the run directory should go makes mkdir fail after the lock was taken.
    fs.writeFileSync(path.join(dir, 'run-2026-10-30_00-00'), '')
    await assert.rejects(createBackup(config, { now: NOW, components: [component('a', writes('a.gz', 'A'))] }), /EEXIST|ENOTDIR/)
    assert.equal(fs.existsSync(path.join(dir, '.backup.lock')), false)

    assert.equal(fs.existsSync(path.join(dir, 'run-2026-10-30_00-00')), false) // cleaned up by the failed run
    await createBackup(config, { now: NOW, components: [component('a', writes('a.gz', 'A'))] })
})

test('runBackup reports a summary to Telegram: errors always, success only when enabled', async (t) => {
    const sent = []
    t.mock.method(Telegram.prototype, 'sendMessage', async ({ text }) => sent.push(text))
    const dir = tempDir(t)
    const src = path.join(dir, 'src')
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')
    const env = {
        BACKUP_PATHS: src,
        BACKUP_STORAGE_DIR: path.join(dir, 'storage'),
        TELEGRAM_REPORT_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: '1:t',
        TELEGRAM_CHANNEL_ID: '-1',
    }
    t.after(() => configureReport(configFrom({})))

    // Success without TELEGRAM_REPORT_SUCCESS: silent.
    const quiet = configFrom(env)
    configureReport(quiet)
    await runBackup(quiet, { client: createFakeDrive().client, periods: ['daily'], now: NOW })
    assert.equal(sent.length, 0)

    // Success with TELEGRAM_REPORT_SUCCESS: one summary.
    const loud = configFrom({ ...env, TELEGRAM_REPORT_SUCCESS: 'true' })
    configureReport(loud)
    await runBackup(loud, { client: createFakeDrive().client, periods: ['daily', 'weekly'], now: NOW })
    assert.match(sent[0], /✅ Backup 2026-10-30_00-00 uploaded to daily, weekly \(\d+(\.\d)? KiB, \d+s\)/)

    // A failing component: a warning listing the problem, even without TELEGRAM_REPORT_SUCCESS.
    const partial = configFrom({ ...env, MARIADB_ENABLED: 'true', MARIADB_ALL: 'true', MARIADB_DUMP_COMMAND: 'false' })
    configureReport(partial)
    await runBackup(partial, { client: createFakeDrive().client, periods: ['daily'], now: NOW })
    assert.match(sent[1], /⚠️ Backup 2026-10-30_00-00 finished with errors .*\n• MariaDB: mariadb-dump exited with code 1/)

    // Nothing at all could be backed up: an error report, and the error is marked as reported.
    const broken = configFrom({ ...env, BACKUP_PATHS: path.join(dir, 'missing') })
    configureReport(broken)
    await assert.rejects(runBackup(broken, { client: createFakeDrive().client, periods: ['daily'], now: NOW }), (err) => err.reported)
    assert.match(sent[2], /❌ Backup failed for daily: No backup artifacts were created \(files\)/)
})
