// Installs or removes a systemd unit for this service (requires root).
//   npm run install-service            # uses .env (APP_ENV=live)
//   npm run install-service -- dev     # uses .env.dev
//   npm run uninstall-service
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT_PATH = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

export function serviceNameFor(rootPath) {
    return path.basename(rootPath).replace(/[^\w.@-]/g, '-')
}

export function buildUnit({ rootPath, envFile = '.env', nodePath = process.execPath }) {
    const serviceName = serviceNameFor(rootPath)
    const logDir = path.join(rootPath, 'app/logs')
    return `[Unit]
Description=Backup service (${serviceName})
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${rootPath}
ExecStart=${nodePath} --env-file=${path.join(rootPath, envFile)} ${path.join(rootPath, 'app/index.js')}
Restart=always
RestartSec=10
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
StandardOutput=append:${logDir}/service-output.log
StandardError=append:${logDir}/service-error.log
SyslogIdentifier=${serviceName}

[Install]
WantedBy=multi-user.target
`
}

const SERVICE_NAME = serviceNameFor(ROOT_PATH)
const MARKER_PATH = path.join(ROOT_PATH, 'installed.service')
const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`
const LOG_DIR = path.join(ROOT_PATH, 'app/logs')

const systemctl = (...args) => execFileSync('systemctl', args, { stdio: 'inherit' })

function install(envFile) {
    if (fs.existsSync(UNIT_PATH)) {
        console.log(`Service already installed (${UNIT_PATH}).`)
        return
    }
    if (!fs.existsSync(path.join(ROOT_PATH, envFile))) {
        console.error(`${envFile} not found; create it from .env.example first.`)
        process.exit(1)
    }

    fs.mkdirSync(LOG_DIR, { recursive: true })
    const unit = buildUnit({ rootPath: ROOT_PATH, envFile })
    fs.writeFileSync(UNIT_PATH, unit, { mode: 0o644 })
    fs.writeFileSync(MARKER_PATH, unit)
    systemctl('daemon-reload')
    systemctl('enable', '--now', SERVICE_NAME)
    console.log(`Service "${SERVICE_NAME}" installed and started. Logs: journalctl -u ${SERVICE_NAME} or ${LOG_DIR}`)
}

function uninstall() {
    if (!fs.existsSync(UNIT_PATH) && !fs.existsSync(MARKER_PATH)) {
        console.log('Service not installed.')
        return
    }
    try {
        systemctl('disable', '--now', SERVICE_NAME)
    } catch {
        // already stopped or unknown to systemd
    }
    fs.rmSync(UNIT_PATH, { force: true })
    fs.rmSync(MARKER_PATH, { force: true })
    systemctl('daemon-reload')
    console.log(`Service "${SERVICE_NAME}" uninstalled.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [action, environment] = process.argv.slice(2)
    if (action === 'install') install(environment === 'dev' ? '.env.dev' : '.env')
    else if (action === 'uninstall') uninstall()
    else {
        console.error('Usage: node system/service.js install [dev] | uninstall')
        process.exit(1)
    }
}
