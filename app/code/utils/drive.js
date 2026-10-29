import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { auth, drive } from '@googleapis/drive'
import Logger from '../../libs/logger.js'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file']

const FILE_FIELDS = 'id, name, size, md5Checksum, createdTime'
// Without a timeout a stalled request would block all further backups.
const API = { timeout: 5 * 60 * 1000 }

export function createOAuthClient({ google }) {
    return new auth.OAuth2(google.clientId, google.clientSecret, google.redirectURL)
}

export function createDriveClient(config) {
    const oauth = createOAuthClient(config)
    oauth.setCredentials(config.google.tokens)
    return drive({ version: 'v3', auth: oauth })
}

// Escapes a value for use inside a single-quoted Drive query string.
export function escapeQuery(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export async function findOrCreateFolder(client, { name, parentId = 'root' }) {
    const res = await client.files.list(
        {
            q: `name = '${escapeQuery(name)}' and mimeType = '${FOLDER_MIME}' and '${escapeQuery(parentId)}' in parents and trashed = false`,
            fields: 'files(id, name)',
            orderBy: 'createdTime',
            pageSize: 10,
            spaces: 'drive',
        },
        API
    )

    const [existing] = res.data.files || []
    if (existing) return existing

    const created = await client.files.create(
        {
            requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
            fields: 'id, name',
        },
        API
    )
    Logger.plog('Drive', `Created folder "${name}"`)
    return created.data
}

// Folder layout: <GOOGLE_DRIVE_FOLDER_ID or My Drive>/<SERVER NAME>/<period>/
export async function getPeriodFolder(client, { rootFolderId = 'root', serverName, period }) {
    const serverFolder = await findOrCreateFolder(client, { name: serverName, parentId: rootFolderId })
    return findOrCreateFolder(client, { name: period, parentId: serverFolder.id })
}

export async function listFolderFiles(client, folderId) {
    const files = []
    let pageToken
    do {
        const res = await client.files.list(
            {
                q: `'${escapeQuery(folderId)}' in parents and mimeType != '${FOLDER_MIME}' and trashed = false`,
                fields: `nextPageToken, files(${FILE_FIELDS})`,
                orderBy: 'createdTime',
                pageSize: 1000,
                spaces: 'drive',
                pageToken,
            },
            API
        )
        files.push(...(res.data.files || []))
        pageToken = res.data.nextPageToken
    } while (pageToken)

    return files.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime))
}

async function verifyRemote(client, file, { md5, size }) {
    const sizeOk = size === undefined || Number(file.size) === size
    const md5Ok = !md5 || !file.md5Checksum || file.md5Checksum === md5
    if (sizeOk && md5Ok) return file

    await client.files.delete({ fileId: file.id }, API).catch(() => {})
    throw new Error(`Integrity check failed for "${file.name}" (remote size ${file.size}, md5 ${file.md5Checksum}; expected ${size}, ${md5})`)
}

async function withRetries(label, fn, { retries, retryDelayMs }) {
    let lastError
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            return await fn()
        } catch (err) {
            lastError = err
            if (attempt < retries) {
                const delay = retryDelayMs * 2 ** (attempt - 1)
                Logger.pwarn('Drive', `${label} failed (attempt ${attempt}/${retries}): ${err.message}; retrying in ${Math.round(delay / 1000)}s`)

                await sleep(delay)
            }
        }
    }
    throw lastError
}

export async function uploadFile(
    client,
    { filePath, name, folderId, mimeType, md5, size, retries = 3, retryDelayMs = 5000, timeoutMs = 6 * 3600 * 1000 }
) {
    return withRetries(
        `Upload of "${name}"`,
        async () => {
            const res = await client.files.create(
                {
                    requestBody: { name, parents: [folderId] },
                    media: { mimeType, body: fs.createReadStream(filePath) },
                    fields: FILE_FIELDS,
                },
                { timeout: timeoutMs }
            )
            return verifyRemote(client, res.data, { md5, size })
        },
        { retries, retryDelayMs }
    )
}

// Server-side copy: avoids uploading the same archive again for every period.
export async function copyFile(client, { fileId, name, folderId, md5, size, retries = 3, retryDelayMs = 5000 }) {
    return withRetries(
        `Copy to "${name}"`,
        async () => {
            const res = await client.files.copy({ fileId, requestBody: { name, parents: [folderId] }, fields: FILE_FIELDS }, API)
            return verifyRemote(client, res.data, { md5, size })
        },
        { retries, retryDelayMs }
    )
}

// Deletes the oldest files so that at most `keep` remain in the folder.
export async function applyRetention(client, { folderId, keep, label }) {
    const files = await listFolderFiles(client, folderId)
    const excess = files.slice(0, Math.max(files.length - keep, 0))
    const deleted = []
    const failed = []

    for (const file of excess) {
        try {
            await client.files.delete({ fileId: file.id }, API)
            deleted.push(file.name)
            Logger.plog('Drive', `[${label}] removed old backup "${file.name}"`)
        } catch (err) {
            failed.push(file.name)
            Logger.perror('Drive', `[${label}] failed to remove "${file.name}": ${err.message}`)
        }
    }

    return { deleted, failed }
}
