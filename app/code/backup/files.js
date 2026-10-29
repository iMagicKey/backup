import fs from 'node:fs'
import path from 'node:path'
import { run } from '../utils/exec.js'
import { getCompression, TAR_OK_CODES } from '../utils/tar.js'
import { ROOT_DIR } from '../config.js'

export function buildFilesCommand({ backup }, archivePath, paths) {
    const { tarFlags } = getCompression(backup)
    // Never archive the service's own working directories (they may be inside BACKUP_PATHS).
    const ownDirs = [backup.storageDir, backup.dataDir, path.join(ROOT_DIR, 'app/logs')]
    return {
        command: 'tar',
        args: [
            '--create',
            ...tarFlags,
            '--file',
            archivePath,
            '--warning=no-file-ignored', // sockets and similar special files are skipped silently
            ...ownDirs.map((dir) => `--exclude=${dir}`),
            ...backup.excludes.map((pattern) => `--exclude=${pattern}`),
            '--',
            ...paths,
        ],
        okCodes: TAR_OK_CODES,
        label: 'tar',
    }
}

export default async function backupFiles(config, { runDir, timeoutMs, warnings }) {
    const { backup } = config
    if (!backup.paths.length) return []

    const existing = backup.paths.filter((p) => {
        if (fs.existsSync(p)) return true
        warnings.push(`files: path does not exist and was skipped: ${p}`)
        return false
    })
    if (!existing.length) throw new Error('None of the BACKUP_PATHS exist')

    const file = `files.tar${getCompression(backup).extension}`
    const archivePath = path.join(runDir, file)
    const { code, stderr } = await run({ ...buildFilesCommand(config, archivePath, existing), timeoutMs })

    if (code === 1) {
        const details = stderr
            .split('\n')
            .filter((line) => line && !line.includes('Removing leading'))
            .slice(0, 10)
        warnings.push(`files: some files changed while being archived (archive is still valid):\n${details.join('\n')}`)
    }

    return [{ component: 'files', file }]
}
