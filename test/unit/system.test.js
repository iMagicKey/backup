// Maintenance scripts. init.js and logs.js resolve paths relative to their own location, so they are
// tested from a copy in a temporary directory; service.js is tested through its pure unit-file builder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tempDir, ROOT } from '../helpers/setup.js'
import { buildUnit, serviceNameFor } from '../../system/service.js'

function copyProject(t, files) {
    const root = tempDir(t)
    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
        fs.copyFileSync(path.join(ROOT, file), path.join(root, file))
    }
    return root
}

const runScript = (root, script, args = []) => spawnSync(process.execPath, [path.join(root, script), ...args], { encoding: 'utf8', timeout: 30000 })

test('init creates private runtime directories and .env files from the example, once', (t) => {
    const root = copyProject(t, ['system/init.js', '.env.example'])
    const first = runScript(root, 'system/init.js')
    assert.equal(first.status, 0, first.stderr)

    for (const dir of ['app/logs', 'app/storage', 'app/data']) assert.equal(fs.statSync(path.join(root, dir)).mode & 0o777, 0o700)
    assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /^APP_ENV=live$/m)
    assert.match(fs.readFileSync(path.join(root, '.env.dev'), 'utf8'), /^APP_ENV=dev$/m)
    assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600)

    fs.writeFileSync(path.join(root, '.env'), 'APP_ENV=live\nCUSTOM=1\n')
    const second = runScript(root, 'system/init.js')
    assert.match(second.stdout, /\.env already exists, left unchanged/)
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'APP_ENV=live\nCUSTOM=1\n')
})

test('clear-logs truncates all or only the selected log files', (t) => {
    const root = copyProject(t, ['system/logs.js'])
    const logs = path.join(root, 'app/logs')
    fs.mkdirSync(logs, { recursive: true })
    for (const level of ['log', 'error', 'warn']) fs.writeFileSync(path.join(logs, `${level}.log`), 'line\n')
    fs.writeFileSync(path.join(logs, 'notes.txt'), 'keep')

    runScript(root, 'system/logs.js', ['error'])
    assert.equal(fs.readFileSync(path.join(logs, 'error.log'), 'utf8'), '')
    assert.equal(fs.readFileSync(path.join(logs, 'log.log'), 'utf8'), 'line\n')

    runScript(root, 'system/logs.js')
    assert.equal(fs.readFileSync(path.join(logs, 'warn.log'), 'utf8'), '')
    assert.equal(fs.readFileSync(path.join(logs, 'notes.txt'), 'utf8'), 'keep')
})

test('clear-logs does nothing without a log directory', (t) => {
    const root = copyProject(t, ['system/logs.js'])
    assert.equal(runScript(root, 'system/logs.js').status, 0)
})

test('service name is derived from the project directory', () => {
    assert.equal(serviceNameFor('/srv/apps/backup'), 'backup')
    assert.equal(serviceNameFor('/srv/apps/my backup (prod)'), 'my-backup--prod-')
})

test('systemd unit runs node directly with the env file and hardening options', () => {
    const unit = buildUnit({ rootPath: '/srv/backup', envFile: '.env.dev', nodePath: '/usr/bin/node' })
    assert.match(unit, /^ExecStart=\/usr\/bin\/node --env-file=\/srv\/backup\/\.env\.dev \/srv\/backup\/app\/index\.js$/m)
    assert.match(unit, /^WorkingDirectory=\/srv\/backup$/m)
    assert.match(unit, /^Restart=always$/m)
    for (const option of ['NoNewPrivileges=true', 'PrivateTmp=true', 'UMask=0077']) assert.match(unit, new RegExp(`^${option}$`, 'm'))
    assert.match(unit, /^StandardError=append:\/srv\/backup\/app\/logs\/service-error\.log$/m)
    assert.match(unit, /^SyslogIdentifier=backup$/m)
    assert.match(buildUnit({ rootPath: '/srv/backup' }), /--env-file=\/srv\/backup\/\.env /)
})

test('service script prints usage for unknown actions (and never touches systemd)', () => {
    const { status, stderr } = runScript(ROOT, 'system/service.js', ['bogus'])
    assert.equal(status, 1)
    assert.match(stderr, /Usage: node system\/service\.js install \[dev\] \| uninstall/)
})
