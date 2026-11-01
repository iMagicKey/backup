import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { configFrom, tempDir } from '../helpers/setup.js'
import startScheduler, { TASK_INTERVAL } from '../../app/code/scheduler/index.js'
import run from '../../app/code/index.js'

// imagic-scheduler starts tasks in a microtask: let it run after advancing the clock.
async function advance(t, ms) {
    t.mock.timers.tick(ms)
    await new Promise(setImmediate)
}

test('the backup task first runs one interval after start, then every interval', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
    let runs = 0
    const scheduler = startScheduler({ task: async () => (runs += 1), tickInterval: 1000, taskTimeout: 60 * 60 * 1000 })
    t.after(() => scheduler.stop())

    assert.equal(TASK_INTERVAL, 60 * 1000)
    assert.ok(scheduler.isRunning())
    await advance(t, TASK_INTERVAL - 1000)
    assert.equal(runs, 0)
    await advance(t, 1000)
    assert.equal(runs, 1)
    await advance(t, TASK_INTERVAL)
    assert.equal(runs, 2)
})

test('task errors are caught and the scheduler keeps running', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
    let runs = 0
    const scheduler = startScheduler({
        task: async () => {
            runs += 1
            const error = new Error('already reported elsewhere')
            error.reported = runs === 1
            throw error
        },
        tickInterval: 1000,
        taskTimeout: 60 * 60 * 1000,
    })
    t.after(() => scheduler.stop())

    for (let i = 0; i < 3; i += 1) await advance(t, TASK_INTERVAL)
    assert.equal(runs, 3)
    assert.ok(scheduler.isRunning())
    assert.equal(scheduler.getStatus().backup.inProcess, false)
})

test('run() wires the Drive client, state store and backup task into a running scheduler', (t) => {
    const config = configFrom({ GOOGLE_APP: '{"clientId":"id","clientSecret":"s"}', GOOGLE_AUTH: '{"refresh_token":"r"}' })
    const scheduler = run({ config, tickInterval: 60 * 60 * 1000, statePath: path.join(tempDir(t), 'state.json') })
    t.after(() => scheduler.stop())

    assert.ok(scheduler.isRunning())
    const { backup } = scheduler.getStatus()
    assert.equal(backup.interval, TASK_INTERVAL)
    assert.equal(backup.timeout, config.backup.timeoutMs)
    assert.ok(backup.nextExecuteTime > Date.now())
})
