// Runs dump tools inside Docker containers via `docker exec`.
// Secrets are forwarded with `-e NAME` (no value): the Docker CLI reads the value from its own
// environment, so passwords never appear in the host process list.
import { run, CommandError } from './exec.js'

export function wrapInContainer(spec, { container, dockerCommand = 'docker' }) {
    const envFlags = Object.keys(spec.env || {}).flatMap((name) => ['-e', name])
    const interactive = spec.input !== undefined ? ['-i'] : []

    return {
        ...spec,
        command: dockerCommand,
        args: ['exec', ...interactive, ...envFlags, container, spec.command, ...(spec.args || [])],
        label: `${spec.label || spec.command} (container "${container}")`,
    }
}

// Wraps the spec when a container is configured, otherwise returns it unchanged.
export function inContainerIfConfigured(spec, container, dockerCommand) {
    return container ? wrapInContainer(spec, { container, dockerCommand }) : spec
}

export async function assertContainerRunning(container, dockerCommand = 'docker') {
    let result
    try {
        result = await run({
            command: dockerCommand,
            args: ['inspect', '--type', 'container', '--format', '{{.State.Status}}', container],
            captureStdout: true,
            timeoutMs: 30 * 1000,
            label: `${dockerCommand} inspect`,
        })
    } catch (err) {
        if (err instanceof CommandError && err.code === null && /command not found/.test(err.message)) {
            throw new Error(`Docker CLI "${dockerCommand}" not found; install Docker or set DOCKER_COMMAND`, { cause: err })
        }
        if (/permission denied/i.test(err.stderr || '')) {
            throw new Error(`No permission to talk to the Docker daemon; run the service as root or add its user to the "docker" group`, {
                cause: err,
            })
        }
        if (/no such (object|container)/i.test(err.stderr || '')) {
            throw new Error(`Docker container "${container}" does not exist`, { cause: err })
        }
        throw err
    }

    const status = result.stdout.trim()
    if (status !== 'running') throw new Error(`Docker container "${container}" is not running (status: ${status || 'unknown'})`)
}
