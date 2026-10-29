// Service entry point: validates the configuration and starts the backup scheduler.
import path from 'node:path'
import util from 'node:util'
import bootstrap from './bootstrap.js'
import run from './code/index.js'
import Logger from './libs/logger.js'
import { report } from './code/utils/report.js'
import { killActiveProcesses } from './code/utils/exec.js'

const { config, tickInterval } = await bootstrap({ requireAuth: true })

process.on('unhandledRejection', (err) => {
    Logger.crit('unhandledRejection', err)
    report('🚨 UNHANDLED REJECTION:', err instanceof Error ? err : util.inspect(err))
})

process.on('uncaughtException', (err) => {
    Logger.crit('uncaughtException', err)
    // The process state is unknown after an uncaught exception: report, then exit and let systemd restart us.
    Promise.race([report('🚨 UNCAUGHT EXCEPTION:', err), new Promise((resolve) => setTimeout(resolve, 5000))]).finally(() => process.exit(1))
})

const scheduler = run({ config, tickInterval, statePath: path.join(config.backup.dataDir, 'state.json') })

let stopping = false
const shutdown = (signal) => {
    if (stopping) return
    stopping = true
    Logger.plog('Service', `${signal} received, shutting down`)
    scheduler.stop()
    killActiveProcesses()
    setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

Logger.plog('Service', `Started; periods: ${config.backup.periods.join(', ')}`)
report('🚀 Started')
