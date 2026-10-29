// Truncates log files: `npm run clear-logs` (all) or `npm run clear-logs -- error warn`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LOG_DIR = path.resolve(fileURLToPath(new URL('../app/logs', import.meta.url)))
const requested = process.argv.slice(2)

if (fs.existsSync(LOG_DIR)) {
    for (const file of fs.readdirSync(LOG_DIR).filter((name) => name.endsWith('.log'))) {
        if (!requested.length || requested.includes(path.basename(file, '.log'))) fs.writeFileSync(path.join(LOG_DIR, file), '')
    }
}
