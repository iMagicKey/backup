import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Logger from '../../app/libs/logger.js'
import { buildConfig } from '../../app/code/config.js'

// Keep test output readable; set TEST_LOGS=1 to see application logs.
if (!process.env.TEST_LOGS) Logger.setConfig({ levels: [] })

export const FAKE_DOCKER = fileURLToPath(new URL('./fake-docker.js', import.meta.url))

export function tempDir(t, prefix = 'backup-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

// Builds a config from a minimal env; throws if the env is invalid so tests fail loudly.
export function configFrom(env, { allowErrors = false } = {}) {
    const config = buildConfig({ BACKUP_PATHS: '/nonexistent-placeholder', ...env })
    if (!allowErrors && config.errors.length) throw new Error(config.errors.join('\n'))
    return config
}

// Creates an executable stub `name` in `dir` (a shell script) and puts `dir` first in PATH for this test.
export function stubCommand(t, dir, name, script) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    if (!process.env.PATH.split(':').includes(dir)) withEnv(t, { PATH: `${dir}:${process.env.PATH}` })
}

// Sets environment variables for the duration of a test.
// Restores happen in reverse order (like a stack), so nested overrides of the same variable unwind correctly.
const envStacks = new WeakMap()

function setEnv(vars) {
    Object.entries(vars).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)))
}

export function withEnv(t, vars) {
    if (!envStacks.has(t)) {
        envStacks.set(t, [])
        t.after(() => envStacks.get(t).reverse().forEach(setEnv))
    }
    envStacks.get(t).push(Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]])))
    setEnv(vars)
}

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
