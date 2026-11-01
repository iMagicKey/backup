import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../helpers/setup.js'

const ONCE = fileURLToPath(new URL('../../app/once.js', import.meta.url))

function once(t, extraEnv) {
    const dir = tempDir(t)
    const src = path.join(dir, 'src')
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')
    const env = {
        PATH: process.env.PATH,
        TMPDIR: dir,
        APP_ENV: 'test',
        BACKUP_PATHS: src,
        BACKUP_STORAGE_DIR: path.join(dir, 'storage'),
        BACKUP_DATA_DIR: path.join(dir, 'data'),
        ...extraEnv,
    }
    return spawnSync(process.execPath, [ONCE, '--no-upload'], { env, encoding: 'utf8' })
}

test('backup:once exits 0 when everything was backed up', (t) => {
    const { status, stdout } = once(t, {})
    assert.equal(status, 0, stdout)
})

test('backup:once exits 1 when a component failed, even though the bundle was created', (t) => {
    // `false` exits with code 1: a dump tool that always fails.
    const { status, stdout } = once(t, { MARIADB_ENABLED: 'true', MARIADB_ALL: 'true', MARIADB_DUMP_COMMAND: 'false' })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /MariaDB backup failed/)
    assert.match(stdout, /Local bundle:/)
})
