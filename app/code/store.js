// Persists the time label of the last successful backup per period (app/data/state.json),
// so a restart neither skips a due backup nor repeats one that already ran.
import fs from 'node:fs'
import path from 'node:path'
import Logger from '../libs/logger.js'

export function createStore(filePath) {
    return {
        load() {
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
                return data && typeof data.periods === 'object' ? data.periods : {}
            } catch (err) {
                if (err.code !== 'ENOENT') Logger.pwarn('Store', `Ignoring unreadable state file ${filePath}: ${err.message}`)
                return {}
            }
        },

        save(periods) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
            const tmp = `${filePath}.tmp`
            fs.writeFileSync(tmp, `${JSON.stringify({ periods, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
            fs.renameSync(tmp, filePath)
        },
    }
}
