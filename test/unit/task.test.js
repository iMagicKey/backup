import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { configFrom, tempDir } from '../helpers/setup.js'
import { createBackupTask, getDuePeriods } from '../../app/code/scheduler/tasks/backup.js'
import { createStore } from '../../app/code/store.js'

function memoryStore(initial = {}) {
    let saved = { ...initial }
    return {
        load: () => ({ ...saved }),
        save: (state) => {
            saved = { ...state }
        },
        get saved() {
            return saved
        },
    }
}

test('getDuePeriods', () => {
    const labels = { daily: '2026-10-30', weekly: '2026-W44' }
    assert.deepEqual(getDuePeriods(labels, { daily: '2026-10-29', weekly: '2026-W44' }, ['daily', 'weekly']), ['daily'])
    assert.deepEqual(getDuePeriods(labels, {}, ['daily']), ['daily'])
})

test('runs due periods once and records success', async () => {
    const config = configFrom({ BACKUP_PERIODS: 'daily,weekly' })
    const store = memoryStore({ weekly: '2026-W44' })
    const calls = []
    const task = createBackupTask({
        config,
        store,
        now: () => new Date('2026-10-30T10:00:00Z'),
        runBackup: async (periods) => {
            calls.push(periods)
            return { succeeded: periods }
        },
    })

    await task()
    await task()
    assert.deepEqual(calls, [['daily']])
    assert.deepEqual(store.saved, { weekly: '2026-W44', daily: '2026-10-30' })
})

test('failed periods are retried only after the retry delay', async (t) => {
    const config = configFrom({ BACKUP_PERIODS: 'daily', BACKUP_RETRY_MINUTES: '1' })
    let attempts = 0
    const task = createBackupTask({
        config,
        store: memoryStore(),
        runBackup: async () => {
            attempts += 1
            throw new Error('drive down')
        },
    })

    await assert.rejects(task(), /drive down/)
    await task() // within the retry delay: skipped
    assert.equal(attempts, 1)

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61 * 1000 })
    await assert.rejects(task(), /drive down/)
    assert.equal(attempts, 2)
})

test('never runs two backups at the same time', async () => {
    const config = configFrom({ BACKUP_PERIODS: 'daily' })
    let release
    let calls = 0
    const task = createBackupTask({
        config,
        store: memoryStore(),
        runBackup: () => {
            calls += 1
            return new Promise((resolve) => {
                release = () => resolve({ succeeded: ['daily'] })
            })
        },
    })

    const first = task()
    await task()
    release()
    await first
    assert.equal(calls, 1)
})

test('file store persists atomically and tolerates corruption', (t) => {
    const file = path.join(tempDir(t), 'data', 'state.json')
    const store = createStore(file)
    assert.deepEqual(store.load(), {})
    store.save({ daily: '2026-10-30' })
    assert.deepEqual(store.load(), { daily: '2026-10-30' })
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)

    fs.writeFileSync(file, '{broken')
    assert.deepEqual(store.load(), {})
})

test('state recorded elsewhere (e.g. by backup:once) is picked up before each run', async () => {
    const config = configFrom({ BACKUP_PERIODS: 'daily' })
    const store = memoryStore()
    const calls = []
    const task = createBackupTask({
        config,
        store,
        now: () => new Date('2026-10-30T10:00:00Z'),
        runBackup: async (periods) => {
            calls.push(periods)
            return { succeeded: periods }
        },
    })

    store.save({ daily: '2026-10-30' }) // written after the task was created
    await task()
    assert.deepEqual(calls, [])
})

test('a partial success records the successful periods and retries only the others', async (t) => {
    const config = configFrom({ BACKUP_PERIODS: 'daily,weekly', BACKUP_RETRY_MINUTES: '1' })
    const store = memoryStore()
    const calls = []
    const task = createBackupTask({
        config,
        store,
        now: () => new Date('2026-10-30T10:00:00Z'),
        runBackup: async (periods) => {
            calls.push(periods)
            return { succeeded: periods.filter((p) => p === 'daily' || calls.length > 1) }
        },
    })

    await task()
    assert.deepEqual(store.saved, { daily: '2026-10-30' })
    await task() // inside the retry delay
    assert.equal(calls.length, 1)

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61 * 1000 })
    await task()
    assert.deepEqual(calls, [['daily', 'weekly'], ['weekly']])
    assert.deepEqual(store.saved, { daily: '2026-10-30', weekly: '2026-W44' })
})
