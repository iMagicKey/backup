// Shared start-up for every entry point: private file permissions, file config, logger,
// environment config validation, secret redaction and Telegram reporting.
import path from 'node:path'
import { loadConfig } from 'imagic-config'
import Logger from './libs/logger.js'
import { registerSecret, registerUriSecrets } from './libs/redact.js'
import { buildConfig, secretsOf, ROOT_DIR } from './code/config.js'
import { configureReport } from './code/utils/report.js'

export default async function bootstrap({ requireAuth = true, exitOnError = true } = {}) {
    // Backups contain database dumps: everything this process creates is private to its user.
    process.umask(0o077)

    const config = buildConfig(process.env)
    const { values, uris } = secretsOf(config)
    values.forEach(registerSecret)
    uris.forEach(registerUriSecrets)

    const fileConfig = await loadConfig({
        dir: path.join(ROOT_DIR, 'app/config'),
        env: config.appEnv,
        defaults: { logger: { output: ['console'] }, scheduler: { interval: 15000 } },
    })

    Logger.setConfig({ prefix: 'BACKUP', logDir: path.join(ROOT_DIR, 'app/logs'), ...fileConfig.logger })
    configureReport(config)

    const errors = [...config.errors, ...(requireAuth ? config.authErrors : [])]
    config.warnings.forEach((warning) => Logger.pwarn('Config', warning))
    errors.forEach((error) => Logger.perror('Config', error))
    if (errors.length && exitOnError) {
        Logger.pcrit('Config', `Invalid configuration (${errors.length} error(s)); see README.md#configuration`)
        process.exit(1)
    }

    const tickInterval = Number(config.schedulerInterval) || Number(fileConfig.scheduler?.interval) || 15000

    return { config, fileConfig, tickInterval, errors }
}
