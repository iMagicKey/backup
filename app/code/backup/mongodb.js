import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runToFile } from '../utils/exec.js'
import { getCompression } from '../utils/tar.js'
import { inContainerIfConfigured, assertContainerRunning } from '../utils/docker.js'

// The connection string (which usually contains the password) is passed to mongodump through a
// private YAML config file instead of `--uri`, so it never shows up in the process list.
// Inside a container the config is streamed over stdin into a temporary file.
const CONTAINER_SCRIPT = [
    'umask 077',
    'f=$(mktemp) || exit 1',
    'trap \'rm -f "$f"\' EXIT',
    'cat > "$f" || exit 1',
    'mongodump --config="$f" --archive "$@"',
].join('; ')

export function mongoConfigYaml(uri) {
    // JSON strings are valid YAML double-quoted scalars.
    return `uri: ${JSON.stringify(uri)}\n`
}

export function buildMongoDumpCommand({ mongodb, docker }, { configFile } = {}) {
    if (mongodb.container) {
        const spec = mongodb.uri
            ? { command: 'sh', args: ['-c', CONTAINER_SCRIPT, 'mongodump', ...mongodb.extraArgs], input: mongoConfigYaml(mongodb.uri) }
            : { command: 'mongodump', args: ['--archive', ...mongodb.extraArgs] }
        return inContainerIfConfigured({ ...spec, label: 'mongodump' }, mongodb.container, docker.command)
    }

    const args = configFile ? [`--config=${configFile}`, '--archive'] : ['--archive']
    return { command: 'mongodump', args: [...args, ...mongodb.extraArgs], label: 'mongodump' }
}

export default async function backupMongoDB(config, { runDir, timeoutMs }) {
    const { mongodb, docker } = config
    if (!mongodb.enabled) return []

    if (mongodb.container) await assertContainerRunning(mongodb.container, docker.command)

    const compression = getCompression(config.backup)
    const file = `mongodb.archive${compression.extension}`
    const outPath = path.join(runDir, file)

    let secretDir = null
    try {
        let configFile
        if (!mongodb.container && mongodb.uri) {
            secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-mongo-'))
            configFile = path.join(secretDir, 'mongodump.yaml')
            fs.writeFileSync(configFile, mongoConfigYaml(mongodb.uri), { mode: 0o600 })
        }
        await runToFile({ ...buildMongoDumpCommand(config, { configFile }), timeoutMs }, outPath, { compressor: compression.stream })
    } finally {
        if (secretDir) fs.rmSync(secretDir, { recursive: true, force: true })
    }

    return [{ component: 'mongodb', file }]
}
