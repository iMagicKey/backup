import Logger from '../../../libs/logger.js'
import { getTimeLabels } from '../../utils/date.js'

export function getDuePeriods(labels, state, periods) {
    return periods.filter((period) => state[period] !== labels[period])
}

/**
 * Creates the scheduler task. It runs every minute, but only starts a backup when the label of a
 * configured period changed since the last successful backup of that period. Failed periods are
 * retried after `retryMs`. A running backup is never started twice, even if the scheduler times out.
 */
export function createBackupTask({ config, store, runBackup, now = () => new Date() }) {
    const state = store.load()
    let running = false
    let retryAt = 0

    return async function backupTask() {
        if (running || Date.now() < retryAt) return

        const labels = getTimeLabels(now())
        const due = getDuePeriods(labels, state, config.backup.periods)
        if (!due.length) return

        running = true
        try {
            const { succeeded } = await runBackup(due)
            succeeded.forEach((period) => {
                state[period] = labels[period]
            })
            if (succeeded.length) store.save(state)

            const failed = due.filter((period) => !succeeded.includes(period))
            if (failed.length) {
                retryAt = Date.now() + config.backup.retryMs
                Logger.pwarn('Scheduler', `Will retry ${failed.join(', ')} in ${Math.round(config.backup.retryMs / 60000)} min`)
            }
        } catch (err) {
            retryAt = Date.now() + config.backup.retryMs
            throw err
        } finally {
            running = false
        }
    }
}
