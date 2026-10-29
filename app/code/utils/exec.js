// Process helpers. Commands are always spawned without a shell and with an argument array,
// so paths and passwords never go through shell interpolation. Secrets are passed via
// environment variables or stdin, never via argv (argv is visible to every user via `ps`).
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

const STDERR_LIMIT = 16 * 1024
const KILL_GRACE_MS = 10 * 1000
const activeChildren = new Set()

export class CommandError extends Error {
    constructor(message, { command, code = null, signal = null, stderr = '' } = {}) {
        super(message)
        this.name = 'CommandError'
        this.command = command
        this.code = code
        this.signal = signal
        this.stderr = stderr
    }
}

function describe(spec) {
    return spec.label || spec.command
}

function lastLines(text, count = 15) {
    return text.trim().split('\n').slice(-count).join('\n')
}

function failureMessage(spec, code, signal, stderr, timedOut) {
    const name = describe(spec)
    let reason
    if (timedOut) reason = `timed out after ${Math.round(spec.timeoutMs / 1000)}s`
    else if (signal) reason = `killed by ${signal}`
    else if (code === 127) reason = 'exited with code 127 (command not found)'
    else reason = `exited with code ${code}`

    const details = lastLines(stderr)
    return details ? `${name} ${reason}:\n${details}` : `${name} ${reason}`
}

// Starts a process and returns { child, done }. `done` resolves with { code, stderr, stdout }.
function start(spec, stdio) {
    const okCodes = spec.okCodes || [0]
    const child = spawn(spec.command, spec.args || [], {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env || {}) },
        stdio,
    })
    activeChildren.add(child)

    let stderr = ''
    let stdout = ''
    child.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT)
    })
    if (spec.captureStdout) {
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString()
        })
    }

    let timedOut = false
    let killTimer = null
    const timeoutTimer =
        spec.timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true
                  child.kill('SIGTERM')
                  killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
              }, spec.timeoutMs)
            : null

    const done = new Promise((resolve, reject) => {
        child.on('error', (err) => {
            clearTimeout(timeoutTimer)
            clearTimeout(killTimer)
            activeChildren.delete(child)
            const message = err.code === 'ENOENT' ? `${describe(spec)}: command not found ("${spec.command}")` : `${describe(spec)}: ${err.message}`
            reject(new CommandError(message, { command: spec.command }))
        })

        child.on('close', (code, signal) => {
            clearTimeout(timeoutTimer)
            clearTimeout(killTimer)
            activeChildren.delete(child)

            if (!timedOut && signal === null && okCodes.includes(code)) {
                resolve({ code, stderr, stdout })
                return
            }
            reject(new CommandError(failureMessage(spec, code, signal, stderr, timedOut), { command: spec.command, code, signal, stderr }))
        })
    })

    if (spec.input !== undefined && child.stdin) {
        child.stdin.on('error', () => {}) // the process may exit before reading stdin; its exit code reports the problem
        child.stdin.end(spec.input)
    }

    return { child, done }
}

/**
 * Runs a command to completion.
 * spec: { command, args, env, cwd, input, okCodes, timeoutMs, captureStdout, label }
 */
export function run(spec) {
    const stdin = spec.input !== undefined ? 'pipe' : 'ignore'
    const stdout = spec.captureStdout ? 'pipe' : 'ignore'
    return start(spec, [stdin, stdout, 'pipe']).done
}

/**
 * Streams the stdout of `producer` (optionally through `compressor`) into `outPath`.
 * Equivalent to `producer | compressor > outPath` with pipefail semantics: any failing stage
 * rejects, kills the remaining stages and removes the partial output file.
 */
export async function runToFile(producer, outPath, { compressor = null } = {}) {
    const output = fs.createWriteStream(outPath, { mode: 0o600 })
    const first = start(producer, [producer.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'])
    const stages = [first]
    const transfers = []

    if (compressor) {
        const second = start({ ...compressor, timeoutMs: compressor.timeoutMs ?? producer.timeoutMs }, ['pipe', 'pipe', 'pipe'])
        stages.push(second)
        transfers.push(pipeline(first.child.stdout, second.child.stdin))
        transfers.push(pipeline(second.child.stdout, output))
    } else {
        transfers.push(pipeline(first.child.stdout, output))
    }

    // When one stage fails the others are terminated; their SIGTERM failures are consequences, not causes.
    let terminated = false
    const killAll = () => {
        if (terminated) return
        terminated = true
        stages.forEach(({ child }) => {
            if (child.exitCode !== null || child.signalCode !== null) return
            child.kill('SIGTERM')
            setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), KILL_GRACE_MS).unref()
        })
    }
    const processErrors = []
    const transferErrors = []
    const track = (promise, bucket) =>
        promise.catch((err) => {
            bucket.push({ err, afterKill: terminated })
            killAll()
            throw err
        })

    await Promise.allSettled([...stages.map((stage) => track(stage.done, processErrors)), ...transfers.map((t) => track(t, transferErrors))])
    // Root cause: a process that failed on its own (exit code, timeout) > a stream error (e.g. ENOSPC) > anything else.
    const failure =
        processErrors.find(({ err, afterKill }) => !(afterKill && err.signal === 'SIGTERM'))?.err ||
        transferErrors.find(({ err }) => err.code !== 'EPIPE')?.err ||
        processErrors[0]?.err ||
        transferErrors[0]?.err

    if (failure) {
        await fs.promises.rm(outPath, { force: true })
        throw failure
    }

    return { stderr: (await first.done).stderr }
}

export function killActiveProcesses(signal = 'SIGTERM') {
    activeChildren.forEach((child) => child.kill(signal))
}
