#!/usr/bin/env node
// Stand-in for the Docker CLI used in tests where Docker is not available.
// Supports `inspect --format {{.State.Status}} <name>` (FAKE_DOCKER_STOPPED lists stopped containers,
// FAKE_DOCKER_DENIED simulates a daemon permission error, FAKE_DOCKER_ERROR any other failure) and `exec [-i] [-e NAME[=VALUE]]... <name> <cmd> [args...]`;
// `exec` runs the command on the host. Every invocation is appended to $FAKE_DOCKER_LOG (one JSON argv per line)
// so tests can assert that no secret was passed on the command line.
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(argv)}\n`)

const containers = (process.env.FAKE_DOCKER_CONTAINERS || '').split(',').filter(Boolean)
const [subcommand, ...rest] = argv

if (process.env.FAKE_DOCKER_ERROR) {
    process.stderr.write(`${process.env.FAKE_DOCKER_ERROR}\n`)
    process.exit(1)
}

if (process.env.FAKE_DOCKER_DENIED) {
    process.stderr.write('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n')
    process.exit(1)
}

if (subcommand === 'inspect') {
    const name = rest.at(-1)
    const stopped = (process.env.FAKE_DOCKER_STOPPED || '').split(',').filter(Boolean)
    if (stopped.includes(name)) {
        process.stdout.write('exited\n')
        process.exit(0)
    }
    if (!containers.includes(name)) {
        process.stderr.write(`Error: No such container: ${name}\n`)
        process.exit(1)
    }
    process.stdout.write('running\n')
    process.exit(0)
}

if (subcommand === 'exec') {
    const env = { ...process.env }
    let i = 0
    while (rest[i]?.startsWith('-')) {
        if (rest[i] === '-e') {
            const [name, ...value] = rest[i + 1].split('=')
            if (value.length) env[name] = value.join('=')
            i += 2
        } else {
            i += 1
        }
    }
    const [name, command, ...args] = rest.slice(i)
    if (!containers.includes(name)) {
        process.stderr.write(`Error response from daemon: No such container: ${name}\n`)
        process.exit(1)
    }
    const child = spawn(command, args, { env, stdio: 'inherit' })
    child.on('error', (err) => {
        process.stderr.write(`OCI runtime exec failed: ${err.message}\n`)
        process.exit(127)
    })
    child.on('close', (code, signal) => process.exit(signal ? 1 : code))
} else {
    process.stderr.write(`fake-docker: unsupported command ${subcommand}\n`)
    process.exit(2)
}
