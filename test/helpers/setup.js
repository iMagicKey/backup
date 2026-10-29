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
