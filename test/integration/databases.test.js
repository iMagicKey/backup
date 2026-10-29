// Real backup → restore round trips against running database servers.
// Each engine runs only when its IT_* variables are set (see "Testing" in README.md):
//   IT_MARIADB_HOST/PORT/USER/PASSWORD   [IT_MARIADB_CONTAINER]   [IT_MARIADB_CLIENT=mariadb]
//   IT_POSTGRES_HOST/PORT/USER/PASSWORD  [IT_POSTGRES_CONTAINER]
//   IT_MONGODB_URI                       [IT_MONGODB_CONTAINER]
//   IT_DOCKER_COMMAND (docker, or test/helpers/fake-docker.js), IT_COMPRESSION (gzip|zstd, default zstd)
// With *_CONTAINER set, both the backup and the restore run via `docker exec`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { configFrom, tempDir } from '../helpers/setup.js'
import { createBackup, COMPONENTS } from '../../app/code/backup/index.js'
import { run } from '../../app/code/utils/exec.js'
import { inContainerIfConfigured } from '../../app/code/utils/docker.js'

const env = process.env
const DOCKER = env.IT_DOCKER_COMMAND || 'docker'
const COMPRESSION = env.IT_COMPRESSION || 'zstd'
const ROWS = [
    [1, "it's a quote"],
    [2, 'ünïcödé ✓'],
    [3, 'back\\slash "double"'],
]

const exec = (spec, container) => run({ ...inContainerIfConfigured(spec, container, DOCKER), captureStdout: true, timeoutMs: 120000 })

function decompress(file) {
    if (file.endsWith('.zst')) return execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 })
    if (file.endsWith('.gz')) return execFileSync('gzip', ['-dc', file], { maxBuffer: 1 << 30 })
    return fs.readFileSync(file)
}

async function backupAndExtract(t, extraEnv, componentName) {
    const dir = tempDir(t, 'backup-it-')
    const config = configFrom({
        BACKUP_PATHS: '',
        BACKUP_STORAGE_DIR: dir,
        BACKUP_COMPRESSION: COMPRESSION,
        BACKUP_ZSTD_LEVEL: '3',
        DOCKER_COMMAND: DOCKER,
        ...extraEnv,
    })
    const result = await createBackup(config, { components: COMPONENTS.filter((c) => c.name === componentName) })
    assert.deepEqual(result.failures, [])

    const out = path.join(dir, 'extracted')
    fs.mkdirSync(out)
    execFileSync('tar', ['-xf', result.bundlePath, '-C', out])
    execFileSync('sha256sum', ['-c', '--quiet', 'SHA256SUMS'], { cwd: out })
    return { out, result }
}

// --- MariaDB -----------------------------------------------------------------
const maria = {
    host: env.IT_MARIADB_HOST,
    port: env.IT_MARIADB_PORT,
    user: env.IT_MARIADB_USER || 'root',
    password: env.IT_MARIADB_PASSWORD,
    container: env.IT_MARIADB_CONTAINER,
    client: env.IT_MARIADB_CLIENT || 'mariadb',
}
const mariaSql = (input) =>
    exec(
        {
            command: maria.client,
            args: [
                ...(maria.host ? [`--host=${maria.host}`] : []),
                ...(maria.port ? [`--port=${maria.port}`] : []),
                `--user=${maria.user}`,
                '--batch',
                '--skip-column-names',
            ],
            env: maria.password ? { MYSQL_PWD: maria.password } : {},
            input,
        },
        maria.container
    )

test('MariaDB: backup and restore', { skip: !maria.host && !maria.container && 'IT_MARIADB_* not set' }, async (t) => {
    const values = ROWS.map(([id, txt]) => `(${id}, '${txt.replace(/\\/g, '\\\\').replace(/'/g, "''")}')`).join(',')
    await mariaSql(`DROP DATABASE IF EXISTS bk_it; CREATE DATABASE bk_it CHARACTER SET utf8mb4; USE bk_it;
        CREATE TABLE t (id INT PRIMARY KEY, txt VARCHAR(100)) CHARACTER SET utf8mb4; INSERT INTO t VALUES ${values};
        CREATE PROCEDURE p() SELECT 42;`)

    const { out } = await backupAndExtract(
        t,
        {
            MARIADB_ENABLED: 'true',
            MARIADB_DATABASE: 'bk_it',
            MARIADB_HOST: maria.host || '',
            MARIADB_PORT: maria.port || '',
            MARIADB_USER: maria.user,
            MARIADB_PASSWORD: maria.password || '',
            MARIADB_DOCKER_CONTAINER: maria.container || '',
        },
        'MariaDB'
    )

    const dump = decompress(
        path.join(
            out,
            fs.readdirSync(out).find((f) => f.startsWith('mariadb.sql'))
        )
    )
    await mariaSql('DROP DATABASE bk_it;')
    await mariaSql(dump)

    const { stdout } = await mariaSql(
        "SELECT id, txt FROM bk_it.t ORDER BY id; SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = 'bk_it';"
    )
    assert.equal(stdout, `${ROWS.map(([id, txt]) => `${id}\t${txt.replace(/\\/g, '\\\\')}`).join('\n')}\n1\n`)
    await mariaSql('DROP DATABASE bk_it;')
})

// --- PostgreSQL --------------------------------------------------------------
const pg = {
    host: env.IT_POSTGRES_HOST,
    port: env.IT_POSTGRES_PORT,
    user: env.IT_POSTGRES_USER || 'postgres',
    password: env.IT_POSTGRES_PASSWORD,
    container: env.IT_POSTGRES_CONTAINER,
}
const pgConn = [...(pg.host ? [`--host=${pg.host}`] : []), ...(pg.port ? [`--port=${pg.port}`] : []), `--username=${pg.user}`, '--no-password']
const pgEnv = pg.password ? { PGPASSWORD: pg.password } : {}
const psql = (database, input) =>
    exec({ command: 'psql', args: [...pgConn, '--quiet', '--tuples-only', '--no-align', `--dbname=${database}`], env: pgEnv, input }, pg.container)
const pgEnvFor = (all) => ({
    POSTGRES_ENABLED: 'true',
    POSTGRES_ALL: all ? 'true' : 'false',
    POSTGRES_DATABASE: all ? '' : 'bk_it',
    POSTGRES_HOST: pg.host || '',
    POSTGRES_PORT: pg.port || '',
    POSTGRES_USER: pg.user,
    POSTGRES_PASSWORD: pg.password || '',
    POSTGRES_DOCKER_CONTAINER: pg.container || '',
})

async function seedPostgres() {
    await psql('postgres', 'DROP DATABASE IF EXISTS bk_it;\nCREATE DATABASE bk_it;\n')
    const values = ROWS.map(([id, txt]) => `(${id}, '${txt.replace(/'/g, "''")}')`).join(',')
    await psql('bk_it', `CREATE TABLE t (id int PRIMARY KEY, txt text); INSERT INTO t VALUES ${values};`)
}

async function assertPostgresRows() {
    const { stdout } = await psql('bk_it', 'SELECT id, txt FROM t ORDER BY id;')
    assert.equal(stdout, `${ROWS.map(([id, txt]) => `${id}|${txt}`).join('\n')}\n`)
}

const pgSkip = !pg.host && !pg.container && 'IT_POSTGRES_* not set'

test('PostgreSQL (single database, custom format): backup and restore', { skip: pgSkip }, async (t) => {
    await seedPostgres()
    const { out } = await backupAndExtract(t, pgEnvFor(false), 'PostgreSQL')
    assert.ok(fs.existsSync(path.join(out, 'postgres-bk_it.dump')))

    await psql('postgres', 'DROP DATABASE bk_it;\nCREATE DATABASE bk_it;\n')
    await exec(
        { command: 'pg_restore', args: [...pgConn, '--dbname=bk_it'], env: pgEnv, input: fs.readFileSync(path.join(out, 'postgres-bk_it.dump')) },
        pg.container
    )
    await assertPostgresRows()
})

test('PostgreSQL (pg_dumpall): backup and restore', { skip: pgSkip }, async (t) => {
    await seedPostgres()
    const { out } = await backupAndExtract(t, pgEnvFor(true), 'PostgreSQL')
    const dump = decompress(
        path.join(
            out,
            fs.readdirSync(out).find((f) => f.startsWith('postgres-all.sql'))
        )
    )
    assert.match(dump.toString(), /CREATE ROLE/)

    await psql('postgres', 'DROP DATABASE bk_it;\n')
    await psql('postgres', dump)
    await assertPostgresRows()
    await psql('postgres', 'DROP DATABASE bk_it;\n')
})

// --- MongoDB -----------------------------------------------------------------
const mongo = { uri: env.IT_MONGODB_URI, container: env.IT_MONGODB_CONTAINER }
const mongosh = (script) =>
    exec({ command: 'mongosh', args: ['--quiet', mongo.uri || 'mongodb://localhost:27017', '--eval', script] }, mongo.container)

test('MongoDB: backup and restore', { skip: !mongo.uri && !mongo.container && 'IT_MONGODB_* not set' }, async (t) => {
    const docs = JSON.stringify(ROWS.map(([id, txt]) => ({ _id: id, txt })))
    await mongosh(`db.getSiblingDB('bk_it').dropDatabase(); db.getSiblingDB('bk_it').t.insertMany(${docs})`)

    const { out } = await backupAndExtract(
        t,
        { MONGODB_ENABLED: 'true', MONGODB_URI: mongo.uri || '', MONGODB_DOCKER_CONTAINER: mongo.container || '' },
        'MongoDB'
    )
    const archive = decompress(
        path.join(
            out,
            fs.readdirSync(out).find((f) => f.startsWith('mongodb.archive'))
        )
    )

    await mongosh(`db.getSiblingDB('bk_it').dropDatabase()`)
    const restoreArgs = ['--archive', '--drop', '--nsInclude=bk_it.*']
    await exec(
        mongo.uri
            ? { command: 'mongorestore', args: [`--uri=${mongo.uri}`, ...restoreArgs], input: archive }
            : { command: 'mongorestore', args: restoreArgs, input: archive },
        mongo.container
    )

    const { stdout } = await mongosh(`JSON.stringify(db.getSiblingDB('bk_it').t.find().sort({_id: 1}).toArray())`)
    assert.deepEqual(JSON.parse(stdout), JSON.parse(docs))
    await mongosh(`db.getSiblingDB('bk_it').dropDatabase()`)
})
