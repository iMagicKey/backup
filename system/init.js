// Prepares a fresh checkout: runtime directories and .env files created from .env.example.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_PATH = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

for (const dir of ['app/logs', 'app/storage', 'app/data']) {
    fs.mkdirSync(path.join(ROOT_PATH, dir), { recursive: true, mode: 0o700 })
}

const example = fs.readFileSync(path.join(ROOT_PATH, '.env.example'), 'utf8')
const envFiles = { '.env': 'live', '.env.dev': 'dev' }

for (const [fileName, appEnv] of Object.entries(envFiles)) {
    const filePath = path.join(ROOT_PATH, fileName)
    if (fs.existsSync(filePath)) {
        console.log(`${fileName} already exists, left unchanged`)
    } else {
        fs.writeFileSync(filePath, example.replace(/^APP_ENV=.*$/m, `APP_ENV=${appEnv}`), { mode: 0o600 })
        console.log(`Created ${fileName} from .env.example; edit it before starting the service`)
    }
}
