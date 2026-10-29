import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { tempDir } from '../helpers/setup.js'
import { run, runToFile, CommandError } from '../../app/code/utils/exec.js'

test('run passes env without a shell and captures output', async () => {
    const { stdout } = await run({ command: 'sh', args: ['-c', 'printf "%s" "$SECRET"'], env: { SECRET: 'a b $(c)' }, captureStdout: true })
    assert.equal(stdout, 'a b $(c)')
})

test('run rejects with stderr and exit code', async () => {
    await assert.rejects(run({ command: 'sh', args: ['-c', 'echo bad >&2; exit 3'], label: 'thing' }), (err) => {
        assert.ok(err instanceof CommandError)
        assert.equal(err.code, 3)
        assert.match(err.message, /thing exited with code 3:\nbad/)
        return true
    })
})

test('run accepts extra ok codes', async () => {
    const { code } = await run({ command: 'sh', args: ['-c', 'exit 1'], okCodes: [0, 1] })
    assert.equal(code, 1)
})

test('run reports missing commands', async () => {
    await assert.rejects(run({ command: 'definitely-not-a-command-xyz' }), /command not found/)
})

test('run enforces timeouts', async () => {
    await assert.rejects(run({ command: 'sleep', args: ['5'], timeoutMs: 100 }), /timed out/)
})

test('runToFile streams through a compressor', async (t) => {
    const dir = tempDir(t)
    const out = path.join(dir, 'out.gz')
    await runToFile({ command: 'sh', args: ['-c', 'echo hello; cat'], input: 'world\n' }, out, { compressor: { command: 'gzip', args: ['-c'] } })
    assert.equal(zlib.gunzipSync(fs.readFileSync(out)).toString(), 'hello\nworld\n')
    assert.equal(fs.statSync(out).mode & 0o777, 0o600)
})

test('runToFile fails like pipefail and removes the partial file', async (t) => {
    const dir = tempDir(t)
    const out = path.join(dir, 'out.gz')
    await assert.rejects(
        runToFile({ command: 'sh', args: ['-c', 'echo partial; echo "dump failed" >&2; exit 2'], label: 'dump' }, out, {
            compressor: { command: 'gzip', args: ['-c'] },
        }),
        /dump exited with code 2:\ndump failed/
    )
    assert.equal(fs.existsSync(out), false)
})

test('runToFile fails when the compressor fails', async (t) => {
    const dir = tempDir(t)
    const out = path.join(dir, 'out')
    await assert.rejects(
        runToFile({ command: 'sh', args: ['-c', 'yes | head -c 1000000'] }, out, {
            compressor: { command: 'sh', args: ['-c', 'exit 5'], label: 'zip' },
        }),
        /zip exited with code 5/
    )
    assert.equal(fs.existsSync(out), false)
})

test('runToFile reports an output error as the root cause, not the SIGTERM it triggers', async (t) => {
    const out = path.join(tempDir(t), 'missing-dir', 'out.gz')
    await assert.rejects(
        runToFile({ command: 'sh', args: ['-c', 'yes | head -c 10000000'] }, out, { compressor: { command: 'gzip', args: ['-c'] } }),
        /ENOENT/
    )
})
