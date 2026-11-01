import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from '../helpers/setup.js'
import Logger from '../../app/libs/logger.js'
import { registerSecret, clearSecrets } from '../../app/libs/redact.js'

function fileLogger(t) {
    const logDir = tempDir(t)
    const previous = Logger.getConfig()
    Logger.setConfig({ output: ['file'], logDir, levels: ['log', 'debug', 'error', 'warn', 'info', 'crit'], prefix: 'TEST' })
    t.after(() => {
        Logger.setConfig(previous)
        clearSecrets()
    })
    return (level) => fs.readFileSync(path.join(logDir, `${level}.log`), 'utf8')
}

test('every level and its prefixed variant is available', () => {
    for (const level of ['log', 'debug', 'error', 'warn', 'info', 'crit']) {
        assert.equal(typeof Logger[level], 'function')
        assert.equal(typeof Logger[`p${level}`], 'function')
    }
})

test('writes one file per level with the global or per-call prefix', (t) => {
    const read = fileLogger(t)
    Logger.log('hello', 42)
    Logger.perror('Drive', 'upload failed')
    assert.match(read('log'), /^\[\d{4}-\d{2}-\d{2} [\d:.]+\] \(TEST\) \[LOG\] hello 42\n$/)
    assert.match(read('error'), /\(Drive\) \[ERROR\] upload failed\n$/)
})

test('redacts registered secrets and URL credentials, also inside objects and errors', (t) => {
    const read = fileLogger(t)
    registerSecret('hunter22')
    Logger.warn('password is hunter22', { nested: { uri: 'mongodb://u:pw123@h' } }, new Error('failed with hunter22'))
    const line = read('warn')
    assert.doesNotMatch(line, /hunter22|pw123/)
    assert.match(line, /password is \*\*\*/)
    assert.match(line, /mongodb:\/\/u:\*\*\*@h/)
})

test('getConfig returns the merged configuration', (t) => {
    fileLogger(t)
    assert.equal(Logger.getConfig().prefix, 'TEST')
    assert.deepEqual(Logger.getConfig().output, ['file'])
})
