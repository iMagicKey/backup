// Thin wrapper around imagic-logger that redacts registered secrets from every log line.
import util from 'node:util'
import { Logger as BaseLogger } from 'imagic-logger'
import { redact } from './redact.js'

const LEVELS = ['log', 'debug', 'error', 'warn', 'info', 'crit']

const toSafeString = (value) => redact(typeof value === 'string' ? value : util.inspect(value, { depth: 4 }))

const Logger = {
    setConfig: (config) => BaseLogger.setConfig(config),
    getConfig: () => BaseLogger.getConfig(),
}

LEVELS.forEach((level) => {
    Logger[level] = (...args) => BaseLogger[level](...args.map(toSafeString))
    Logger[`p${level}`] = (prefix, ...args) => BaseLogger[`p${level}`](prefix, ...args.map(toSafeString))
})

export default Logger
