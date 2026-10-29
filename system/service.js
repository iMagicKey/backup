// Installs or removes a systemd unit for this service (requires root).
//   npm run install-service            # uses .env (APP_ENV=live)
//   npm run install-service -- dev     # uses .env.dev
//   npm run uninstall-service
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT_PATH = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SERVICE_NAME = path.basename(ROOT_PATH).replace(/[^\w.@-]/g, '-')
const MARKER_PATH = path.join(ROOT_PATH, 'installed.service')
const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`
const LOG_DIR = path.join(ROOT_PATH, 'app/logs')

const action = process.argv[2]
const envFile = process.argv[3] === 'dev' ? '.env.dev' : '.env'

const systemctl = (...args) => execFileSync('systemctl', args, { stdio: 'inherit' })

function install() {
    if (fs.existsSync(UNIT_PATH)) {
        console.log(`Service already installed (${UNIT_PATH}).`)
        return
    }
    if (!fs.existsSync(path.join(ROOT_PATH, envFile))) {
        console.error(`${envFile} not found; create it from .env.example first.`)
        process.exit(1)
    }

    fs.mkdirSync(LOG_DIR, { recursive: true })
    const unit = `[Unit]
Description=Backup service (${SERVICE_NAME})
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT_PATH}
ExecStart=${process.execPath} --env-file=${path.join(ROOT_PATH, envFile)} ${path.join(ROOT_PATH, 'app/index.js')}
Restart=always
RestartSec=10
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
StandardOutput=append:${LOG_DIR}/service-output.log
StandardError=append:${LOG_DIR}/service-error.log
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
`
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

if (action === 'install') install()
else if (action === 'uninstall') uninstall()
else {
    console.error('Usage: node system/service.js install [dev] | uninstall')
    process.exit(1)
}
