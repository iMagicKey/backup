import fs from 'node:fs'
import path from 'node:path'

import backupFiles from './files.js'
import backupMariaDB from './mariadb.js'
import backupPostgres from './postgres.js'
import backupMongoDB from './mongodb.js'

import Logger from '../../libs/logger.js'
import { run } from '../utils/exec.js'
import { getFormattedDate } from '../utils/date.js'
import { hashFile, formatBytes, ensurePrivateDir, acquireLock } from '../utils/fs.js'
import { getPeriodFolder, uploadFile, copyFile, applyRetention } from '../utils/drive.js'
import { report } from '../utils/report.js'

export const COMPONENTS = [
    { name: 'files', run: backupFiles },
    { name: 'MariaDB', run: backupMariaDB },
    { name: 'PostgreSQL', run: backupPostgres },
    { name: 'MongoDB', run: backupMongoDB },
]

const BUNDLE_MIME = 'application/x-tar'
const STAMP = '\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}'
const LEGACY_STAMP = '\\d{4}\\.\\d{2}\\.\\d{2}-\\d{2}:\\d{2}'
const RUN_DIR_PATTERN = new RegExp(`^run-${STAMP}$`)

const lockPath = ({ storageDir }) => path.join(storageDir, '.backup.lock')

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Only removes entries matching the exact names this service creates, so BACKUP_STORAGE_DIR may be a shared directory.
export function cleanStorage({ storageDir, prefix }) {
    if (!fs.existsSync(storageDir)) return
    const p = escapeRegExp(prefix)
    const filePatterns = [
        new RegExp(`^${p}${STAMP}\\.tar$`),
        // archives written by versions < 2, e.g. backup-2026.10.26-21:00.tar.zst
        new RegExp(`^(?:${p}|files-)${LEGACY_STAMP}\\.tar\\.(?:gz|zst)$`),
        new RegExp(`^(?:mariadb-${LEGACY_STAMP}\\.sql|mongodb-${LEGACY_STAMP}\\.archive|${p}postgres-${LEGACY_STAMP}\\.pgsql)$`),
    ]

    for (const entry of fs.readdirSync(storageDir, { withFileTypes: true })) {
        const isOurs = (entry.isDirectory() && RUN_DIR_PATTERN.test(entry.name)) || (entry.isFile() && filePatterns.some((re) => re.test(entry.name)))
        if (isOurs) {
            fs.rmSync(path.join(storageDir, entry.name), { recursive: true, force: true })
            Logger.plog('Backup', `Removed old local file: ${entry.name}`)
        }
    }
}

async function writeManifest(runDir, { stamp, config, artifacts, warnings, failures }) {
    const entries = []
    for (const artifact of artifacts) {
        const filePath = path.join(runDir, artifact.file)

        const sha256 = await hashFile(filePath)
        entries.push({ ...artifact, size: fs.statSync(filePath).size, sha256 })
    }

    const manifest = {
        format: 2,
        createdAt: new Date().toISOString(),
        stamp,
        server: config.backup.serverName,
        compression: config.backup.compression,
        artifacts: entries,
        warnings,
        failures: failures.map(({ component, error }) => ({ component, error: error.message })),
    }

    fs.writeFileSync(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    fs.writeFileSync(path.join(runDir, 'SHA256SUMS'), entries.map((e) => `${e.sha256}  ${e.file}\n`).join(''), { mode: 0o600 })
    return manifest
}

/**
 * Runs every enabled component in parallel and packs the results into one uncompressed tar bundle
 * (the members are compressed individually, so the bundle is not compressed a second time).
 * Throws only if no component produced an artifact.
 */
export async function createBackup(config, { now = new Date(), components = COMPONENTS, lock = true } = {}) {
    const { backup } = config
    const stamp = getFormattedDate(now)
    const warnings = []
    const failures = []

    ensurePrivateDir(backup.storageDir)
    const releaseLock = lock ? acquireLock(lockPath(backup)) : () => {}
    cleanStorage(backup)

    const runDir = path.join(backup.storageDir, `run-${stamp}`)
    ensurePrivateDir(runDir)

    try {
        // Components that back up several things (e.g. PostgreSQL databases) record partial failures in ctx.failures.
        const ctx = { runDir, timeoutMs: backup.timeoutMs, warnings, failures }
        const results = await Promise.allSettled(components.map((component) => component.run(config, ctx)))

        const artifacts = []
        results.forEach((result, index) => {
            const { name } = components[index]
            if (result.status === 'fulfilled') artifacts.push(...result.value)
            else failures.push({ component: name, error: result.reason })
        })
        failures.forEach(({ component, error }) => Logger.perror('Backup', `${component} backup failed: ${error?.message || error}`))
        warnings.forEach((warning) => Logger.pwarn('Backup', warning))

        if (!artifacts.length) {
            const error = new Error(`No backup artifacts were created (${failures.map((f) => f.component).join(', ') || 'nothing enabled'})`)
            error.failures = failures
            throw error
        }

        const manifest = await writeManifest(runDir, { stamp, config, artifacts, warnings, failures })
        const members = ['manifest.json', 'SHA256SUMS', ...artifacts.map((a) => a.file)]

        const bundlePath = path.join(backup.storageDir, `${backup.prefix}${stamp}.tar`)
        await run({
            command: 'tar',
            args: ['--create', '--file', bundlePath, '--directory', runDir, '--', ...members],
            timeoutMs: backup.timeoutMs,
            label: 'tar (bundle)',
        })

        const size = fs.statSync(bundlePath).size
        Logger.plog('Backup', `Created ${path.basename(bundlePath)} (${formatBytes(size)}): ${artifacts.map((a) => a.file).join(', ')}`)

        return { stamp, bundlePath, size, manifest, artifacts, warnings, failures }
    } finally {
        fs.rmSync(runDir, { recursive: true, force: true })
        releaseLock()
    }
}

/**
 * Uploads the bundle once, copies it server-side into the folders of the remaining periods and
 * applies retention. Returns the list of periods that now hold this backup.
 */
export async function uploadBackup(config, client, bundle, periods) {
    const { backup, google } = config
    const md5 = await hashFile(bundle.bundlePath, 'md5')
    const succeeded = []
    const failed = []
    const warnings = []
    let source = null

    for (const period of periods) {
        const name = `${period}-${bundle.stamp}.tar`
        try {
            const folder = await getPeriodFolder(client, { rootFolderId: google.folderId, serverName: backup.serverName, period })

            let uploaded = null
            if (source) {
                uploaded = await copyFile(client, { fileId: source.id, name, folderId: folder.id, md5, size: bundle.size, retries: 1 }).catch(
                    (err) => {
                        Logger.pwarn('Drive', `[${period}] server-side copy failed (${err.message}); uploading instead`)
                        return null
                    }
                )
            }

            if (!uploaded)
                uploaded = await uploadFile(client, {
                    filePath: bundle.bundlePath,
                    name,
                    folderId: folder.id,
                    mimeType: BUNDLE_MIME,
                    md5,
                    size: bundle.size,
                    timeoutMs: backup.timeoutMs,
                })
            source = source || uploaded

            Logger.plog('Drive', `[${period}] stored "${uploaded.name}"`)
            succeeded.push(period)

            try {
                const { failed: notDeleted } = await applyRetention(client, { folderId: folder.id, keep: backup.retention[period], label: period })
                if (notDeleted.length) warnings.push(`retention [${period}]: could not delete ${notDeleted.join(', ')}`)
            } catch (err) {
                warnings.push(`retention [${period}]: ${err.message}`)
                Logger.pwarn('Drive', `[${period}] retention failed: ${err.message}`)
            }
        } catch (err) {
            failed.push({ period, error: err })
            Logger.perror('Drive', `[${period}] upload failed: ${err.message}`)
        }
    }

    return { succeeded, failed, warnings }
}

/**
 * Full cycle used by the scheduler and `npm run backup:once`.
 * Returns { succeeded: [...periods] }; periods missing from it should be retried.
 * A bundle with failed components still counts as stored (it is flagged in its manifest and reported):
 * retrying would re-upload the whole bundle every BACKUP_RETRY_MINUTES while a database stays down.
 */
export async function runBackup(config, { client, periods, upload = true, now = new Date() }) {
    Logger.plog('Backup', `Backup started for: ${periods.join(', ')}`)
    const startedAt = Date.now()
    let bundle

    ensurePrivateDir(config.backup.storageDir)
    const releaseLock = acquireLock(lockPath(config.backup))

    try {
        bundle = await createBackup(config, { now, lock: false })
    } catch (err) {
        releaseLock()
        await report(`❌ Backup failed for ${periods.join(', ')}:`, err.message)
        err.reported = true
        throw err
    }

    let uploadFailed = true
    try {
        const result = upload ? await uploadBackup(config, client, bundle, periods) : { succeeded: [], failed: [], warnings: [] }
        const seconds = Math.round((Date.now() - startedAt) / 1000)

        const problems = [
            ...bundle.failures.map(({ component, error }) => `• ${component}: ${error.message}`),
            ...result.failed.map(({ period, error }) => `• upload [${period}]: ${error.message}`),
            ...result.warnings.map((warning) => `• ${warning}`),
        ]

        if (problems.length) {
            await report(`⚠️ Backup ${bundle.stamp} finished with errors (${formatBytes(bundle.size)}, ${seconds}s):\n${problems.join('\n')}`)
        } else if (config.telegram.reportSuccess && upload) {
            await report(`✅ Backup ${bundle.stamp} uploaded to ${result.succeeded.join(', ')} (${formatBytes(bundle.size)}, ${seconds}s)`)
        }

        uploadFailed = result.failed.length > 0
        Logger.plog('Backup', `Backup ${bundle.stamp} finished in ${seconds}s; stored for: ${result.succeeded.join(', ') || 'none'}`)
        return { ...result, bundle }
    } finally {
        // Keep a bundle whose upload failed: it is the only copy until the retry succeeds.
        if (upload && !config.backup.keepLocal && !uploadFailed) fs.rmSync(bundle.bundlePath, { force: true })
        releaseLock()
    }
}
