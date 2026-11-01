import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from '../helpers/setup.js'
import { hashFile, formatBytes, ensurePrivateDir, processStartTime } from '../../app/code/utils/fs.js'

test('hashFile computes sha256 (default) and md5', async (t) => {
    const file = path.join(tempDir(t), 'f')
    fs.writeFileSync(file, 'hello\n')
    assert.equal(await hashFile(file), '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03')
    assert.equal(await hashFile(file, 'md5'), 'b1946ac92492d2347c6235b4d2611184')
})

test('hashFile rejects for a missing file', async (t) => {
    await assert.rejects(hashFile(path.join(tempDir(t), 'missing')), /ENOENT/)
})

test('formatBytes', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(1023), '1023 B')
    assert.equal(formatBytes(1024), '1.0 KiB')
    assert.equal(formatBytes(1536), '1.5 KiB')
    assert.equal(formatBytes(2219638514), '2.1 GiB')
    assert.equal(formatBytes(5 * 1024 ** 5), '5120.0 TiB')
})

test('ensurePrivateDir creates nested private directories and is idempotent', (t) => {
    const dir = path.join(tempDir(t), 'a', 'b')
    ensurePrivateDir(dir)
    ensurePrivateDir(dir)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
})

test('processStartTime identifies running processes', () => {
    const own = processStartTime(process.pid)
    assert.match(own, /^\d+$/)
    assert.equal(processStartTime(process.pid), own)
    assert.equal(processStartTime(999999999), null)
})
