import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { configFrom, tempDir, FAKE_DOCKER } from '../helpers/setup.js'
import { createBackup, COMPONENTS } from '../../app/code/backup/index.js'
import { assertContainerRunning, inContainerIfConfigured } from '../../app/code/utils/docker.js'

function withFakeDocker(t, containers) {
    const dir = tempDir(t)
    const log = path.join(dir, 'docker.log')
    const previous = { FAKE_DOCKER_CONTAINERS: process.env.FAKE_DOCKER_CONTAINERS, FAKE_DOCKER_LOG: process.env.FAKE_DOCKER_LOG }
    process.env.FAKE_DOCKER_CONTAINERS = containers.join(',')
    process.env.FAKE_DOCKER_LOG = log
    t.after(() => Object.entries(previous).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v))))
    return { dir, log }
}

test('missing Docker CLI, missing and stopped containers give clear errors', async (t) => {
    withFakeDocker(t, ['up'])
    await assert.rejects(assertContainerRunning('x', 'no-such-docker-binary'), /Docker CLI "no-such-docker-binary" not found/)
    await assert.rejects(assertContainerRunning('gone', FAKE_DOCKER), /container "gone" does not exist/)
    await assertContainerRunning('up', FAKE_DOCKER)
})

test('a failing container backup does not stop the other components', async (t) => {
    const { dir } = withFakeDocker(t, [])
    const src = path.join(dir, 'src')
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')

    const config = configFrom({
        BACKUP_PATHS: src,
        BACKUP_STORAGE_DIR: path.join(dir, 'storage'),
        DOCKER_COMMAND: FAKE_DOCKER,
        MARIADB_ENABLED: 'true',
        MARIADB_ALL: 'true',
        MARIADB_DOCKER_CONTAINER: 'mariadb',
    })
    const result = await createBackup(config, { components: COMPONENTS })
    assert.deepEqual(
        result.artifacts.map((a) => a.file),
        ['files.tar.gz']
    )
    assert.equal(result.failures[0].component, 'MariaDB')
    assert.match(result.failures[0].error.message, /container "mariadb" does not exist/)
})

test('dump tool missing inside the container is reported', async (t) => {
    const { dir, log } = withFakeDocker(t, ['pg'])
    const config = configFrom({
        BACKUP_PATHS: '',
        BACKUP_STORAGE_DIR: path.join(dir, 'storage'),
        DOCKER_COMMAND: FAKE_DOCKER,
        POSTGRES_ENABLED: 'true',
        POSTGRES_DATABASE: 'app',
        POSTGRES_PASSWORD: 'very-secret-pw',
        POSTGRES_DOCKER_CONTAINER: 'pg',
    })
    // A PATH that contains node (for the fake docker CLI) but no pg_dump.
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    fs.symlinkSync(process.execPath, path.join(bin, 'node'))
    const savedPath = process.env.PATH
    process.env.PATH = bin
    t.after(() => (process.env.PATH = savedPath))

    await assert.rejects(createBackup(config, { components: COMPONENTS.filter((c) => c.name === 'PostgreSQL') }), (err) => {
        assert.match(err.failures[0].error.message, /pg_dump app \(container "pg"\) exited with code 127/)
        return true
    })
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /very-secret-pw/)
})

test('one failing PostgreSQL database does not discard the others', async (t) => {
    const { dir } = withFakeDocker(t, ['pg'])
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    fs.symlinkSync(process.execPath, path.join(bin, 'node'))
    fs.writeFileSync(
        path.join(bin, 'pg_dump'),
        '#!/bin/sh\ncase "$*" in *--dbname=bad*) echo "database bad does not exist" >&2; exit 1;; esac\necho dump\n',
        { mode: 0o755 }
    )
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}:${savedPath}`
    t.after(() => (process.env.PATH = savedPath))

    const config = configFrom({
        BACKUP_PATHS: '',
        BACKUP_STORAGE_DIR: path.join(dir, 'storage'),
        DOCKER_COMMAND: FAKE_DOCKER,
        POSTGRES_ENABLED: 'true',
        POSTGRES_DATABASE: 'one,bad,two',
        POSTGRES_DOCKER_CONTAINER: 'pg',
    })
    const result = await createBackup(config, { components: COMPONENTS.filter((c) => c.name === 'PostgreSQL') })
    assert.deepEqual(
        result.artifacts.map((a) => a.file),
        ['postgres-one.dump', 'postgres-two.dump']
    )
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0].component, 'PostgreSQL (bad)')
    assert.match(result.failures[0].error.message, /database bad does not exist/)
})

test('a stopped container and a denied Docker daemon give clear errors', async (t) => {
    withFakeDocker(t, ['up'])
    process.env.FAKE_DOCKER_STOPPED = 'down'
    t.after(() => delete process.env.FAKE_DOCKER_STOPPED)
    await assert.rejects(assertContainerRunning('down', FAKE_DOCKER), /container "down" is not running \(status: exited\)/)

    process.env.FAKE_DOCKER_DENIED = '1'
    t.after(() => delete process.env.FAKE_DOCKER_DENIED)
    await assert.rejects(assertContainerRunning('up', FAKE_DOCKER), /No permission to talk to the Docker daemon/)
})

test('inContainerIfConfigured wraps only when a container is set', () => {
    const spec = { command: 'pg_dump', args: ['--dbname=x'], env: { PGPASSWORD: 'p' } }
    assert.equal(inContainerIfConfigured(spec, undefined, 'docker'), spec)
    assert.deepEqual(inContainerIfConfigured(spec, 'pg', 'podman').args, ['exec', '-e', 'PGPASSWORD', 'pg', 'pg_dump', '--dbname=x'])
    assert.equal(inContainerIfConfigured(spec, 'pg', 'podman').command, 'podman')
})

test('other Docker errors are passed through unchanged', async (t) => {
    withFakeDocker(t, ['up'])
    process.env.FAKE_DOCKER_ERROR = 'Cannot connect to the Docker daemon. Is the docker daemon running?'
    t.after(() => delete process.env.FAKE_DOCKER_ERROR)
    await assert.rejects(assertContainerRunning('up', FAKE_DOCKER), /exited with code 1:\nCannot connect to the Docker daemon/)
})
