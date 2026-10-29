import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../helpers/setup.js'
import { buildConfig, DEFAULT_RETENTION, ROOT_DIR } from '../../app/code/config.js'

test('defaults', () => {
    const config = buildConfig({ BACKUP_PATHS: '/etc' })
    assert.deepEqual(config.errors, [])
    assert.deepEqual(config.backup.periods, ['daily'])
    assert.equal(config.backup.compression, 'gzip')
    assert.equal(config.backup.zstdLevel, 19)
    assert.equal(config.backup.prefix, 'backup-')
    assert.equal(config.backup.storageDir, `${ROOT_DIR}/app/storage`)
    assert.deepEqual(config.backup.retention, DEFAULT_RETENTION)
    assert.equal(config.google.folderId, 'root')
    assert.equal(config.postgres.user, 'postgres')
    assert.equal(config.appEnv, 'live')
})

test('lists accept comma-separated values and JSON arrays', () => {
    assert.deepEqual(buildConfig({ BACKUP_PATHS: ' /a , /b,,' }).backup.paths, ['/a', '/b'])
    assert.deepEqual(buildConfig({ BACKUP_PATHS: '["/a,b", "/c"]' }).backup.paths, ['/a,b', '/c'])
    assert.deepEqual(buildConfig({ BACKUP_PATHS: '/x', MARIADB_DATABASE: 'one, two' }).mariadb.databases, ['one', 'two'])
})

test('extra arguments split on whitespace or JSON', () => {
    assert.deepEqual(buildConfig({ BACKUP_PATHS: '/x', MARIADB_EXTRA_ARGS: '--skip-routines  --hex-blob' }).mariadb.extraArgs, [
        '--skip-routines',
        '--hex-blob',
    ])
    assert.deepEqual(buildConfig({ BACKUP_PATHS: '/x', MONGODB_EXTRA_ARGS: '["--query={\\"a\\": 1}"]' }).mongodb.extraArgs, ['--query={"a": 1}'])
})

test('reports invalid values instead of throwing', () => {
    const config = buildConfig({
        BACKUP_PERIODS: 'daily,fortnightly',
        BACKUP_COMPRESSION: 'xz',
        BACKUP_ZSTD_LEVEL: '30',
        BACKUP_RETENTION: '{"daily":0,"often":3}',
        GOOGLE_APP: '{not json',
        MARIADB_ENABLED: 'true',
        POSTGRES_ENABLED: 'true',
        MONGODB_ENABLED: 'true',
    })
    const text = config.errors.join('\n')
    assert.match(text, /fortnightly/)
    assert.match(text, /BACKUP_COMPRESSION/)
    assert.match(text, /BACKUP_ZSTD_LEVEL/)
    assert.match(text, /BACKUP_RETENTION.daily/)
    assert.match(text, /unknown period "often"/)
    assert.match(text, /GOOGLE_APP is not valid JSON/)
    assert.match(text, /MARIADB_DATABASE is required/)
    assert.match(text, /POSTGRES_DATABASE is required/)
    assert.match(text, /MONGODB_URI is required/)
})

test('nothing to back up is an error', () => {
    assert.match(buildConfig({}).errors.join(), /Nothing to back up/)
})

test('retention override merges with defaults', () => {
    const config = buildConfig({ BACKUP_PATHS: '/x', BACKUP_RETENTION: '{"daily":7}' })
    assert.equal(config.backup.retention.daily, 7)
    assert.equal(config.backup.retention.hourly, 24)
})

test('docker mode: MongoDB URI is optional', () => {
    const config = buildConfig({ MONGODB_ENABLED: 'true', MONGODB_DOCKER_CONTAINER: 'mongo' })
    assert.deepEqual(config.errors, [])
    assert.equal(config.mongodb.container, 'mongo')
})

test('auth errors are separate from config errors', () => {
    const config = buildConfig({ BACKUP_PATHS: '/x' })
    assert.deepEqual(config.errors, [])
    assert.equal(config.authErrors.length, 2)

    const ok = buildConfig({ BACKUP_PATHS: '/x', GOOGLE_APP: '{"clientId":"id","clientSecret":"s"}', GOOGLE_AUTH: '{"refresh_token":"r"}' })
    assert.deepEqual(ok.authErrors, [])
    assert.equal(ok.google.redirectURL, 'http://localhost')
})

test('rejects unsafe prefix, server name and storage dir', () => {
    const text = buildConfig({ BACKUP_PATHS: '/x', BACKUP_PREFIX: '../x', BACKUP_SERVER_NAME: 'a/b', BACKUP_STORAGE_DIR: '/' }).errors.join('\n')
    assert.match(text, /BACKUP_PREFIX/)
    assert.match(text, /BACKUP_SERVER_NAME/)
    assert.match(text, /BACKUP_STORAGE_DIR/)
})

test('telegram enabled without credentials is a warning', () => {
    const config = buildConfig({ BACKUP_PATHS: '/x', TELEGRAM_REPORT_ENABLED: 'true' })
    assert.equal(config.warnings.length, 1)
})
