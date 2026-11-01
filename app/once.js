// Runs one backup cycle immediately and exits.
//   npm run backup:once                     # all BACKUP_PERIODS, upload to Google Drive
//   npm run backup:once -- daily weekly     # only the given periods
//   npm run backup:once -- --no-upload      # create the local bundle only (no Google credentials needed)
import path from 'node:path'
import bootstrap from './bootstrap.js'
import Logger from './libs/logger.js'
import { PERIODS } from './code/config.js'
import { runBackup } from './code/backup/index.js'
import { createDriveClient } from './code/utils/drive.js'
import { createStore } from './code/store.js'
import { getTimeLabels } from './code/utils/date.js'

const argv = process.argv.slice(2)
const upload = !argv.includes('--no-upload')
const requested = argv.filter((arg) => !arg.startsWith('--'))

const { config } = await bootstrap({ requireAuth: upload })

const unknown = requested.filter((period) => !PERIODS.includes(period))
if (unknown.length) {
    Logger.perror('Once', `Unknown period(s): ${unknown.join(', ')}. Allowed: ${PERIODS.join(', ')}`)
    process.exit(1)
}

const periods = requested.length ? requested : config.backup.periods
const now = new Date()

try {
    const result = await runBackup(config, { client: upload ? createDriveClient(config) : null, periods, upload, now })

    if (upload && result.succeeded.length) {
        // Record the run so the service does not immediately repeat it.
        const store = createStore(path.join(config.backup.dataDir, 'state.json'))
        const state = store.load()
        const labels = getTimeLabels(now)
        result.succeeded.forEach((period) => {
            state[period] = labels[period]
        })
        store.save(state)
    }

    if (!upload) Logger.plog('Once', `Local bundle: ${result.bundle.bundlePath}`)
    // Non-zero when anything is missing, so cron jobs and monitors notice partial backups.
    const incomplete = result.bundle.failures.length > 0 || (upload && result.failed.length > 0)
    process.exit(incomplete ? 1 : 0)
} catch (err) {
    Logger.perror('Once', err)
    process.exit(1)
}
