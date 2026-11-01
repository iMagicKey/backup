// Backup components run against stub dump tools (shell scripts placed first in PATH),
// so command lines, environment, compression and error handling are tested without real databases.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { configFrom, tempDir, stubCommand, withEnv, FAKE_DOCKER } from '../helpers/setup.js'
import backupFiles from '../../app/code/backup/files.js'
import backupMariaDB from '../../app/code/backup/mariadb.js'
import backupPostgres from '../../app/code/backup/postgres.js'
import backupMongoDB from '../../app/code/backup/mongodb.js'

function context(t) {
    const runDir = tempDir(t)
    return { runDir, timeoutMs: 60000, warnings: [], failures: [] }
}

const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(file)).toString()

// A PATH containing only the given stubs plus sh and gzip, so real client tools on the machine cannot interfere.
function isolatedPath(t) {
    const bin = path.join(tempDir(t), 'bin')
    fs.mkdirSync(bin)
    for (const tool of ['sh', 'gzip', 'cat', 'mktemp', 'rm', 'stat']) {
        fs.symlinkSync(
            execFileSync('sh', ['-c', `command -v ${tool}`])
                .toString()
                .trim(),
            path.join(bin, tool)
        )
    }
    withEnv(t, { PATH: bin })
    return bin
}

// --- files -------------------------------------------------------------------

test('files: disabled when BACKUP_PATHS is empty', async (t) => {
    assert.deepEqual(await backupFiles(configFrom({ BACKUP_PATHS: '' }, { allowErrors: true }), context(t)), [])
})

test('files: skips missing paths with a warning and archives the rest', async (t) => {
    const src = tempDir(t)
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')
    const ctx = context(t)
    const result = await backupFiles(configFrom({ BACKUP_PATHS: `${src},/does/not/exist` }), ctx)
    assert.deepEqual(result, [{ component: 'files', file: 'files.tar.gz' }])
    assert.match(ctx.warnings[0], /does not exist and was skipped: \/does\/not\/exist/)
    assert.match(execFileSync('tar', ['-tzf', path.join(ctx.runDir, 'files.tar.gz')]).toString(), /a\.txt/)
})

test('files: fails when no path exists', async (t) => {
    await assert.rejects(backupFiles(configFrom({ BACKUP_PATHS: '/does/not/exist' }), context(t)), /None of the BACKUP_PATHS exist/)
})

test('files: tar exit code 1 is a warning with the relevant stderr lines', async (t) => {
    const src = tempDir(t)
    stubCommand(
        t,
        path.join(tempDir(t), 'bin'),
        'tar',
        `prev=; for a; do [ "$prev" = --file ] && : > "$a"; prev=$a; done
echo "tar: Removing leading / from member names" >&2
echo "tar: ${src}/log: file changed as we read it" >&2
exit 1`
    )
    const ctx = context(t)
    const result = await backupFiles(configFrom({ BACKUP_PATHS: src }), ctx)
    assert.equal(result.length, 1)
    assert.match(ctx.warnings[0], /some files changed while being archived/)
    assert.match(ctx.warnings[0], /file changed as we read it/)
    assert.doesNotMatch(ctx.warnings[0], /Removing leading/)
})

test('files: tar exit code 2 is a failure', async (t) => {
    stubCommand(t, path.join(tempDir(t), 'bin'), 'tar', 'echo "tar: fatal" >&2; exit 2')
    await assert.rejects(backupFiles(configFrom({ BACKUP_PATHS: tempDir(t) }), context(t)), /tar exited with code 2:\ntar: fatal/)
})

// --- MariaDB -----------------------------------------------------------------

test('MariaDB: disabled', async (t) => {
    assert.deepEqual(await backupMariaDB(configFrom({}), context(t)), [])
})

test('MariaDB: streams mariadb-dump through the compressor, password via MYSQL_PWD', async (t) => {
    const bin = isolatedPath(t)
    stubCommand(t, bin, 'mariadb-dump', 'echo "mariadb-dump $*"; echo "pwd=$MYSQL_PWD"')
    const ctx = context(t)
    const result = await backupMariaDB(configFrom({ MARIADB_ENABLED: 'true', MARIADB_DATABASE: 'app', MARIADB_PASSWORD: 's3cret' }), ctx)
    assert.deepEqual(result, [{ component: 'mariadb', file: 'mariadb.sql.gz' }])
    const dump = gunzip(path.join(ctx.runDir, 'mariadb.sql.gz'))
    assert.match(dump, /^mariadb-dump --single-transaction .* --databases app$/m)
    assert.match(dump, /^pwd=s3cret$/m)
})

test('MariaDB: falls back to mysqldump when mariadb-dump is missing', async (t) => {
    const bin = isolatedPath(t)
    stubCommand(t, bin, 'mysqldump', 'echo "mysqldump $*"')
    const ctx = context(t)
    await backupMariaDB(configFrom({ MARIADB_ENABLED: 'true', MARIADB_ALL: 'true' }), ctx)
    assert.match(gunzip(path.join(ctx.runDir, 'mariadb.sql.gz')), /^mysqldump .*--all-databases --events$/m)
})

test('MariaDB: a failing dump rejects and leaves no partial file', async (t) => {
    const bin = isolatedPath(t)
    stubCommand(t, bin, 'mariadb-dump', 'echo partial; echo "Access denied for user" >&2; exit 2')
    const ctx = context(t)
    await assert.rejects(
        backupMariaDB(configFrom({ MARIADB_ENABLED: 'true', MARIADB_ALL: 'true' }), ctx),
        /mariadb-dump exited with code 2:\nAccess denied/
    )
    assert.deepEqual(fs.readdirSync(ctx.runDir), [])
})

test('MariaDB in a container: checks the container, then dumps through docker exec', async (t) => {
    const bin = isolatedPath(t)
    fs.symlinkSync(process.execPath, path.join(bin, 'node'))
    stubCommand(t, bin, 'mariadb-dump', 'echo "in container: pwd=$MYSQL_PWD"')
    withEnv(t, { FAKE_DOCKER_CONTAINERS: 'db', FAKE_DOCKER_STOPPED: 'old' })
    const env = { MARIADB_ENABLED: 'true', MARIADB_ALL: 'true', MARIADB_PASSWORD: 'pw123', DOCKER_COMMAND: FAKE_DOCKER, BACKUP_COMPRESSION: 'gzip' }

    const ctx = context(t)
    await backupMariaDB(configFrom({ ...env, MARIADB_DOCKER_CONTAINER: 'db' }), ctx)
    assert.match(gunzip(path.join(ctx.runDir, 'mariadb.sql.gz')), /in container: pwd=pw123/)

    await assert.rejects(
        backupMariaDB(configFrom({ ...env, MARIADB_DOCKER_CONTAINER: 'old' }), context(t)),
        /container "old" is not running \(status: exited\)/
    )
})

// --- PostgreSQL --------------------------------------------------------------

test('PostgreSQL: disabled', async (t) => {
    assert.deepEqual(await backupPostgres(configFrom({}), context(t)), [])
})

test('PostgreSQL: one custom-format file per database, password via PGPASSWORD', async (t) => {
    const bin = isolatedPath(t)
    stubCommand(t, bin, 'pg_dump', 'echo "pg_dump $* pw=$PGPASSWORD"')
    const ctx = context(t)
    const result = await backupPostgres(configFrom({ POSTGRES_ENABLED: 'true', POSTGRES_DATABASE: 'app,my db', POSTGRES_PASSWORD: 'pgpw' }), ctx)
    assert.equal(result.length, 2)
    assert.equal(result[0].file, 'postgres-app.dump')
    assert.match(result[1].file, /^postgres-my_db-[0-9a-f]{8}\.dump$/)
    // Custom format is compressed by pg_dump itself: no extra compressor.
    assert.equal(
        fs.readFileSync(path.join(ctx.runDir, 'postgres-app.dump'), 'utf8'),
        'pg_dump --no-password --username=postgres --format=custom --dbname=app pw=pgpw\n'
    )
})

test('PostgreSQL: pg_dumpall output is compressed', async (t) => {
    const bin = isolatedPath(t)
    stubCommand(t, bin, 'pg_dumpall', 'echo "pg_dumpall $*"')
    const ctx = context(t)
    const result = await backupPostgres(
        configFrom({ POSTGRES_ENABLED: 'true', POSTGRES_ALL: 'true', POSTGRES_HOST: 'h', POSTGRES_PORT: '5433' }),
        ctx
    )
    assert.deepEqual(result, [{ component: 'postgres', file: 'postgres-all.sql.gz' }])
    assert.equal(gunzip(path.join(ctx.runDir, 'postgres-all.sql.gz')), 'pg_dumpall --no-password --host=h --port=5433 --username=postgres\n')
})

test('PostgreSQL: a single failing database rejects with its own error', async (t) => {
    const bin = isolatedPath(t)
    stubCommand(t, bin, 'pg_dump', 'echo "database does not exist" >&2; exit 1')
    const ctx = context(t)
    await assert.rejects(backupPostgres(configFrom({ POSTGRES_ENABLED: 'true', POSTGRES_DATABASE: 'gone' }), ctx), /pg_dump gone exited with code 1/)
    assert.deepEqual(ctx.failures, [])
})

test('PostgreSQL: all databases failing are all reported', async (t) => {
    const bin = isolatedPath(t)
    stubCommand(t, bin, 'pg_dump', 'exit 1')
    const ctx = context(t)
    assert.deepEqual(await backupPostgres(configFrom({ POSTGRES_ENABLED: 'true', POSTGRES_DATABASE: 'a,b' }), ctx), [])
    assert.deepEqual(
        ctx.failures.map((f) => f.component),
        ['PostgreSQL (a)', 'PostgreSQL (b)']
    )
})

// --- MongoDB -----------------------------------------------------------------

// The stub prints the config file it received and records its path and permissions for later checks.
const MONGODUMP_STUB = `for a; do case "$a" in --config=*) f="\${a#--config=}";; esac; done
echo "args: $*"
[ -n "$f" ] && { cat "$f"; echo "$f" > "$MARKER"; stat -c %a "$f" >> "$MARKER"; }
exit 0`

test('MongoDB: disabled', async (t) => {
    assert.deepEqual(await backupMongoDB(configFrom({}), context(t)), [])
})

test('MongoDB: the URI is passed in a private temporary config file that is removed afterwards', async (t) => {
    const bin = isolatedPath(t)
    const marker = path.join(tempDir(t), 'marker')
    stubCommand(t, bin, 'mongodump', MONGODUMP_STUB)
    withEnv(t, { MARKER: marker })

    const uri = 'mongodb://admin:p%40ss@db:27017/?authSource=admin'
    const ctx = context(t)
    const result = await backupMongoDB(configFrom({ MONGODB_ENABLED: 'true', MONGODB_URI: uri, MONGODB_EXTRA_ARGS: '--db=app' }), ctx)
    assert.deepEqual(result, [{ component: 'mongodb', file: 'mongodb.archive.gz' }])

    const output = gunzip(path.join(ctx.runDir, 'mongodb.archive.gz'))
    assert.match(output, /^args: --config=\S+ --archive --db=app$/m)
    assert.ok(!output.split('\n')[0].includes('p%40ss'), 'URI must not be in argv')
    assert.match(output, new RegExp(`^uri: "${uri.replace(/[?.]/g, '\\$&')}"$`, 'm'))

    const [configPath, mode] = fs.readFileSync(marker, 'utf8').trim().split('\n')
    assert.equal(mode, '600')
    assert.equal(fs.existsSync(configPath), false)
})

test('MongoDB: the temporary config file is removed when the dump fails', async (t) => {
    const bin = isolatedPath(t)
    const marker = path.join(tempDir(t), 'marker')
    stubCommand(t, bin, 'mongodump', MONGODUMP_STUB.replace('exit 0', 'exit 1'))
    withEnv(t, { MARKER: marker })
    await assert.rejects(
        backupMongoDB(configFrom({ MONGODB_ENABLED: 'true', MONGODB_URI: 'mongodb://h' }), context(t)),
        /mongodump exited with code 1/
    )
    assert.equal(fs.existsSync(fs.readFileSync(marker, 'utf8').split('\n')[0]), false)
})

test('MongoDB in a container: the URI goes over stdin into a temporary file inside the container', async (t) => {
    const bin = isolatedPath(t)
    fs.symlinkSync(process.execPath, path.join(bin, 'node'))
    const marker = path.join(tempDir(t), 'marker')
    stubCommand(t, bin, 'mongodump', MONGODUMP_STUB)
    withEnv(t, { MARKER: marker, FAKE_DOCKER_CONTAINERS: 'mongo' })

    const ctx = context(t)
    const env = { MONGODB_ENABLED: 'true', MONGODB_DOCKER_CONTAINER: 'mongo', DOCKER_COMMAND: FAKE_DOCKER }
    await backupMongoDB(configFrom({ ...env, MONGODB_URI: 'mongodb://root:pw@localhost' }), ctx)
    const output = gunzip(path.join(ctx.runDir, 'mongodb.archive.gz'))
    assert.match(output, /^uri: "mongodb:\/\/root:pw@localhost"$/m)
    const [configPath, mode] = fs.readFileSync(marker, 'utf8').trim().split('\n')
    assert.equal(mode, '600')
    assert.equal(fs.existsSync(configPath), false)

    // Without a URI mongodump connects to the default localhost inside the container.
    const plain = context(t)
    await backupMongoDB(configFrom(env), plain)
    assert.equal(gunzip(path.join(plain.runDir, 'mongodb.archive.gz')), 'args: --archive\n')
})
