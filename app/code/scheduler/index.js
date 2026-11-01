import Scheduler from 'imagic-scheduler'
import Logger from '../../libs/logger.js'
import { report } from '../utils/report.js'

export const TASK_INTERVAL = 60 * 1000

export default function startScheduler({ task, tickInterval, taskTimeout }) {
    const scheduler = new Scheduler({
        tickInterval,
        onError: (name, err) => {
            Logger.perror('Scheduler', `Task ${name} failed:`, err)
            if (!err?.reported) report(`❌ Task ${name} failed:`, err)
        },
        // imagic-scheduler only stops tracking the run; the task's own guard prevents overlapping backups.
        onTimeout: (name) => Logger.pwarn('Scheduler', `Task ${name} is still running after ${Math.round(taskTimeout / 60000)} min`),
    })

    // First check one minute after start, then every minute.
    scheduler.schedule('backup', task, { interval: TASK_INTERVAL, timeout: taskTimeout, runImmediately: false }).start()
    Logger.plog('Scheduler', `Started with tick interval ${tickInterval}ms`)

    return scheduler
}
