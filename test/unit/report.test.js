import { test } from 'node:test'
import assert from 'node:assert/strict'
import Telegram from 'imagic-telegram'
import '../helpers/setup.js'
import { configureReport, formatReport, report } from '../../app/code/utils/report.js'
import { registerSecret, clearSecrets } from '../../app/libs/redact.js'
import { buildConfig } from '../../app/code/config.js'

const TELEGRAM_ENV = {
    BACKUP_PATHS: '/x',
    BACKUP_SERVER_NAME: 'SRV',
    TELEGRAM_REPORT_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '1:tok',
    TELEGRAM_CHANNEL_ID: '-100',
}

// Replaces the network call of imagic-telegram for one test.
function captureTelegram(t, impl) {
    const sent = []
    t.mock.method(Telegram.prototype, 'sendMessage', async function sendMessage(message) {
        sent.push({ ...message, token: this.token, chatId: this.chatId })
        return impl ? impl(message) : { ok: true }
    })
    t.after(() => clearSecrets())
    return sent
}

test('report is a no-op without Telegram configuration', async (t) => {
    const sent = captureTelegram(t)
    configureReport(buildConfig({ BACKUP_PATHS: '/x' }))
    assert.equal(await report('hello'), false)

    configureReport(buildConfig({ BACKUP_PATHS: '/x', TELEGRAM_REPORT_ENABLED: 'true' })) // enabled but no token
    assert.equal(await report('hello'), false)
    assert.equal(sent.length, 0)
})

test('report sends a redacted, escaped message to the configured chat', async (t) => {
    const sent = captureTelegram(t)
    configureReport(buildConfig({ ...TELEGRAM_ENV, APP_ENV: 'dev' }))
    registerSecret('dbpassword')

    assert.equal(await report('⚠️ failed:', 'login with dbpassword <x>'), true)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].token, '1:tok')
    assert.equal(sent[0].chatId, '-100')
    assert.equal(sent[0].text, '[SRV] [BACKUP] (DEV) ⚠️ failed: login with *** &lt;x&gt;')
})

test('report never throws when Telegram fails', async (t) => {
    captureTelegram(t, () => {
        throw new Error('Bad Request: chat not found')
    })
    configureReport(buildConfig(TELEGRAM_ENV))
    assert.equal(await report('hello'), false)
})

test('formatReport renders strings, errors and objects', () => {
    configureReport(buildConfig({ BACKUP_PATHS: '/x', BACKUP_SERVER_NAME: 'SRV' }))
    const text = formatReport(['a', { periods: ['daily'] }, 3])
    assert.equal(text, "[SRV] [BACKUP] (LIVE) a { periods: [ 'daily' ] } 3")

    const error = new Error('boom')
    error.stack = undefined
    assert.match(formatReport([error]), /Error: boom$/)
})
