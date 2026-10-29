// Telegram notifications. Messages are redacted, HTML-escaped (imagic-telegram sends with
// parse_mode=HTML, so a raw "<" in a stack trace would make Telegram reject the message) and
// truncated to Telegram's 4096 character limit.
import os from 'node:os'
import util from 'node:util'
import Telegram from 'imagic-telegram'
import Logger from '../../libs/logger.js'
import { redact } from '../../libs/redact.js'

const MAX_LENGTH = 4000

let bot = null
let header = ''

export function configureReport({ telegram, backup, appEnv }) {
    bot = telegram.enabled && telegram.token && telegram.chatId ? new Telegram(telegram.token, telegram.chatId) : null
    header = `[${backup.serverName || os.hostname()}] [BACKUP] (${appEnv.toUpperCase()})`
}

export function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function formatReport(parts) {
    const message = parts
        .map((item) => {
            if (typeof item === 'string') return item
            if (item instanceof Error) return item.stack || `${item.name}: ${item.message}`
            return util.inspect(item, { depth: 4 })
        })
        .join(' ')

    const text = escapeHtml(redact(`${header} ${message}`))
    if (text.length <= MAX_LENGTH) return text
    // Cut after escaping (escaping makes text longer) and never inside an &…; entity.
    return `${text.slice(0, MAX_LENGTH).replace(/&[a-z]*$/, '')}\n… (truncated)`
}

export async function report(...parts) {
    if (!bot) return false
    try {
        await bot.sendMessage({ text: formatReport(parts) })
        return true
    } catch (err) {
        Logger.perror('Telegram', `Failed to send report: ${err.message}`)
        return false
    }
}
