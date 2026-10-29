import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { redact, registerSecret, registerUriSecrets, clearSecrets } from '../../app/libs/redact.js'
import { escapeHtml, formatReport, configureReport } from '../../app/code/utils/report.js'
import { buildConfig } from '../../app/code/config.js'

beforeEach(() => clearSecrets())

test('removes registered secrets including URL-encoded forms', () => {
    registerSecret('p@ss!word#1')
    assert.equal(redact('pw=p@ss!word#1 enc=p%40ss!word%231'), 'pw=*** enc=***')
})

test('ignores very short values', () => {
    registerSecret('ab')
    assert.equal(redact('ab cd'), 'ab cd')
})

test('masks credentials in connection strings even when unregistered', () => {
    assert.equal(
        redact('failed to connect to mongodb://admin:s3cr%21t@127.0.0.1:27017/?authSource=admin'),
        'failed to connect to mongodb://admin:***@127.0.0.1:27017/?authSource=admin'
    )
    assert.equal(redact('postgresql://u:p@h/db'), 'postgresql://u:***@h/db')
})

test('registers the password of a URI', () => {
    registerUriSecrets('mongodb://admin:s3cr%21t@db:27017')
    assert.equal(redact('password was s3cr!t'), 'password was ***')
})

test('masks telegram tokens and bearer tokens', () => {
    assert.equal(redact('https://api.telegram.org/bot123456:ABC-def_ghi/sendMessage'), 'https://api.telegram.org/bot***/sendMessage')
    assert.equal(redact('Authorization: Bearer ya29.a0AfB_byC-xyz'), 'Authorization: Bearer ***')
})

test('telegram reports are redacted, escaped and truncated', () => {
    configureReport(buildConfig({ BACKUP_PATHS: '/x', BACKUP_SERVER_NAME: 'HOST', APP_ENV: 'live' }))
    registerSecret('topsecret')
    const text = formatReport(['<b>topsecret</b> & more', new Error('boom')])
    assert.match(text, /^\[HOST\] \[BACKUP\] \(LIVE\) &lt;b&gt;\*\*\*&lt;\/b&gt; &amp; more Error: boom/)
    assert.ok(formatReport(['x'.repeat(10000)]).length < 4096)
    const escaped = formatReport(['<'.repeat(5000)])
    assert.ok(escaped.length < 4096)
    assert.match(escaped, /(&lt;)+\n… \(truncated\)$/)
    assert.equal(escapeHtml('a<b>&c'), 'a&lt;b&gt;&amp;c')
})
