import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configFrom } from '../helpers/setup.js'
import { buildMariaDbCommand } from '../../app/code/backup/mariadb.js'
import { buildPgDumpCommand, buildPgDumpAllCommand, safeName } from '../../app/code/backup/postgres.js'
import { buildMongoDumpCommand, mongoConfigYaml } from '../../app/code/backup/mongodb.js'
import { buildFilesCommand } from '../../app/code/backup/files.js'
import { getCompression } from '../../app/code/utils/tar.js'
import { ROOT_DIR } from '../../app/code/config.js'
import { wrapInContainer } from '../../app/code/utils/docker.js'

const PASSWORD = 'pa ss$(rm -rf /)'
const argvText = (spec) => [spec.command, ...spec.args].join(' ')

test('MariaDB: password via MYSQL_PWD, binary fallback, selected databases', () => {
    const spec = buildMariaDbCommand(
        configFrom({
            MARIADB_ENABLED: 'true',
            MARIADB_HOST: 'db',
            MARIADB_PORT: '3307',
            MARIADB_USER: 'u',
            MARIADB_PASSWORD: PASSWORD,
            MARIADB_DATABASE: 'a,b',
        })
    )
    assert.equal(spec.command, 'sh')
    assert.match(spec.args[1], /mariadb-dump.*mysqldump/)
    assert.deepEqual(spec.env, { MYSQL_PWD: PASSWORD })
    assert.ok(!argvText(spec).includes(PASSWORD))
    assert.deepEqual(spec.args.slice(3), [
        '--single-transaction',
        '--quick',
        '--routines',
        '--triggers',
        '--host=db',
        '--port=3307',
        '--user=u',
        '--databases',
        'a',
        'b',
    ])
})

test('MariaDB: all databases include events; custom binary; extra args last', () => {
    const spec = buildMariaDbCommand(
        configFrom({ MARIADB_ENABLED: 'true', MARIADB_ALL: 'true', MARIADB_DUMP_COMMAND: 'mysqldump', MARIADB_EXTRA_ARGS: '--skip-routines' })
    )
    assert.equal(spec.command, 'mysqldump')
    assert.deepEqual(spec.args.slice(-3), ['--all-databases', '--events', '--skip-routines'])
    assert.deepEqual(spec.env, {})
})

test('MariaDB in Docker: docker exec with -e NAME only', () => {
    const spec = buildMariaDbCommand(
        configFrom({
            MARIADB_ENABLED: 'true',
            MARIADB_ALL: 'true',
            MARIADB_PASSWORD: PASSWORD,
            MARIADB_DOCKER_CONTAINER: 'maria',
            DOCKER_COMMAND: 'podman',
        })
    )
    assert.equal(spec.command, 'podman')
    assert.deepEqual(spec.args.slice(0, 5), ['exec', '-e', 'MYSQL_PWD', 'maria', 'sh'])
    assert.equal(spec.env.MYSQL_PWD, PASSWORD)
    assert.ok(!argvText(spec).includes(PASSWORD))
    assert.ok(!spec.args.some((a) => a.startsWith('--host')))
})

test('PostgreSQL: pg_dump custom format and pg_dumpall', () => {
    const config = configFrom({ POSTGRES_ENABLED: 'true', POSTGRES_HOST: 'h', POSTGRES_PASSWORD: PASSWORD, POSTGRES_DATABASE: 'app' })
    const dump = buildPgDumpCommand(config, 'app')
    assert.equal(dump.command, 'pg_dump')
    assert.deepEqual(dump.args, ['--no-password', '--host=h', '--username=postgres', '--format=custom', '--dbname=app'])
    assert.deepEqual(dump.env, { PGPASSWORD: PASSWORD })

    const all = buildPgDumpAllCommand(config)
    assert.equal(all.command, 'pg_dumpall')
    assert.ok(!argvText(all).includes(PASSWORD))
    assert.equal(safeName('app_1.prod-db'), 'app_1.prod-db')
    assert.match(safeName('my db/x'), /^my_db_x-[0-9a-f]{8}$/)
    assert.notEqual(safeName('база'), safeName('дата'))
})

test('PostgreSQL in Docker', () => {
    const spec = buildPgDumpCommand(
        configFrom({ POSTGRES_ENABLED: 'true', POSTGRES_ALL: 'true', POSTGRES_PASSWORD: 'x1234', POSTGRES_DOCKER_CONTAINER: 'pg' }),
        'db'
    )
    assert.deepEqual(spec.args.slice(0, 5), ['exec', '-e', 'PGPASSWORD', 'pg', 'pg_dump'])
})

test('MongoDB: URI only in a private config file, never in argv', () => {
    const uri = 'mongodb://admin:secret@db:27017/?authSource=admin'
    const config = configFrom({ MONGODB_ENABLED: 'true', MONGODB_URI: uri })
    const spec = buildMongoDumpCommand(config, { configFile: '/tmp/x/mongodump.yaml' })
    assert.deepEqual(spec.args, ['--config=/tmp/x/mongodump.yaml', '--archive'])
    assert.ok(!argvText(spec).includes('secret'))
    assert.equal(mongoConfigYaml('mongodb://a:"b"@c'), 'uri: "mongodb://a:\\"b\\"@c"\n')
})

test('MongoDB in Docker: URI streamed over stdin', () => {
    const uri = 'mongodb://admin:secret@localhost:27017'
    const spec = buildMongoDumpCommand(configFrom({ MONGODB_ENABLED: 'true', MONGODB_URI: uri, MONGODB_DOCKER_CONTAINER: 'mongo' }))
    assert.deepEqual(spec.args.slice(0, 5), ['exec', '-i', 'mongo', 'sh', '-c'])
    assert.equal(spec.input, mongoConfigYaml(uri))
    assert.ok(!argvText(spec).includes('secret'))

    const noUri = buildMongoDumpCommand(configFrom({ MONGODB_ENABLED: 'true', MONGODB_DOCKER_CONTAINER: 'mongo' }))
    assert.deepEqual(noUri.args, ['exec', 'mongo', 'mongodump', '--archive'])
    assert.equal(noUri.input, undefined)
})

test('files: no shell quoting needed, excludes before paths, exit code 1 tolerated', () => {
    const config = configFrom({
        BACKUP_PATHS: "/srv/it's here",
        BACKUP_EXCLUDES: '*.log,node_modules',
        BACKUP_COMPRESSION: 'zstd',
        BACKUP_ZSTD_LEVEL: '3',
    })
    const spec = buildFilesCommand(config, '/out/files.tar.zst', ["/srv/it's here"])
    assert.deepEqual(spec.args, [
        '--create',
        '-I',
        'zstd -T0 -3',
        '--file',
        '/out/files.tar.zst',
        '--warning=no-file-ignored',
        `--exclude=${config.backup.storageDir}`,
        `--exclude=${config.backup.dataDir}`,
        `--exclude=${ROOT_DIR}/app/logs`,
        '--exclude=*.log',
        '--exclude=node_modules',
        '--',
        "/srv/it's here",
    ])
    assert.deepEqual(spec.okCodes, [0, 1])
})

test('compression settings', () => {
    assert.deepEqual(getCompression({ compression: 'gzip' }).tarFlags, ['-z'])
    assert.deepEqual(getCompression({ compression: 'zstd', zstdLevel: 22 }).stream.args, ['-q', '-T0', '--ultra', '-22', '-c'])
    assert.equal(getCompression({ compression: 'zstd', zstdLevel: 19 }).extension, '.zst')
})

test('wrapInContainer adds -i only when stdin is used', () => {
    const spec = wrapInContainer({ command: 'cat', args: ['-'], input: 'x', env: { A: '1' } }, { container: 'c' })
    assert.deepEqual(spec.args, ['exec', '-i', '-e', 'A', 'c', 'cat', '-'])
})
