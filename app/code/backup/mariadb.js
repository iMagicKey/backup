import path from 'node:path'
import { runToFile } from '../utils/exec.js'
import { getCompression } from '../utils/tar.js'
import { inContainerIfConfigured, assertContainerRunning } from '../utils/docker.js'

// MariaDB >= 11 images ship only `mariadb-dump`; MySQL and older MariaDB ship `mysqldump`.
const DUMP_RESOLVER = 'if command -v mariadb-dump >/dev/null 2>&1; then exec mariadb-dump "$@"; else exec mysqldump "$@"; fi'

export function buildMariaDbCommand({ mariadb, docker }) {
    const args = ['--single-transaction', '--quick', '--routines', '--triggers']
    if (mariadb.host) args.push(`--host=${mariadb.host}`)
    if (mariadb.port) args.push(`--port=${mariadb.port}`)
    if (mariadb.user) args.push(`--user=${mariadb.user}`)

    if (mariadb.all) args.push('--all-databases', '--events')
    else args.push('--databases', ...mariadb.databases)

    args.push(...mariadb.extraArgs)

    const spec = mariadb.dumpCommand
        ? { command: mariadb.dumpCommand, args }
        : { command: 'sh', args: ['-c', DUMP_RESOLVER, 'mariadb-dump', ...args] }

    return inContainerIfConfigured(
        {
            ...spec,
            // MYSQL_PWD keeps the password out of argv (supported by mariadb-dump and mysqldump). An option file on
            // /dev/stdin is not an alternative: Node passes stdin as a socket, which cannot be opened as a file.
            env: mariadb.password ? { MYSQL_PWD: mariadb.password } : {},
            label: 'mariadb-dump',
        },
        mariadb.container,
        docker.command
    )
}

export default async function backupMariaDB(config, { runDir, timeoutMs }) {
    const { mariadb, docker } = config
    if (!mariadb.enabled) return []

    if (mariadb.container) await assertContainerRunning(mariadb.container, docker.command)

    const compression = getCompression(config.backup)
    const file = `mariadb.sql${compression.extension}`
    await runToFile({ ...buildMariaDbCommand(config), timeoutMs }, path.join(runDir, file), { compressor: compression.stream })

    return [{ component: 'mariadb', file }]
}
