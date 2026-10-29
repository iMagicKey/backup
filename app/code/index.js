import startSheduler from './sheduler/index.js'
import { createBackupTask } from './sheduler/tasks/backup.js'
import { createStore } from './store.js'
import { createDriveClient } from './utils/drive.js'
import { runBackup } from './backup/index.js'

export default function run({ config, tickInterval, statePath }) {
    const client = createDriveClient(config)
    const task = createBackupTask({
        config,
        store: createStore(statePath),
        runBackup: (periods) => runBackup(config, { client, periods }),
    })

    return startSheduler({ task, tickInterval, taskTimeout: config.backup.timeoutMs })
}
