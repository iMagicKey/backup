import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { configFrom, tempDir } from '../helpers/setup.js'
import { createFakeDrive } from '../helpers/fake-drive.js'
import {
    escapeQuery,
    findOrCreateFolder,
    getPeriodFolder,
    applyRetention,
    listFolderFiles,
    uploadFile,
    FOLDER_MIME,
} from '../../app/code/utils/drive.js'
import { uploadBackup } from '../../app/code/backup/index.js'
import { extractCode } from '../../app/code/create.js'

test('escapeQuery', () => {
    assert.equal(escapeQuery("it's a \\ test"), "it\\'s a \\\\ test")
})

test('folders are looked up by name and parent, then reused', async () => {
    const { client, files } = createFakeDrive()
    // A same-named folder somewhere else must not be picked up.
    files.set('other', { id: 'other', name: "O'HOST", mimeType: FOLDER_MIME, parents: ['elsewhere'] })

    const a = await getPeriodFolder(client, { serverName: "O'HOST", period: 'daily' })
    const b = await getPeriodFolder(client, { serverName: "O'HOST", period: 'daily' })
    assert.equal(a.id, b.id)
    const server = [...files.values()].find((f) => f.name === "O'HOST" && f.parents.includes('root'))
    assert.ok(server)
    assert.notEqual(server.id, 'other')

    const custom = await findOrCreateFolder(client, { name: 'X', parentId: 'parent123' })
    assert.deepEqual(files.get(custom.id).parents, ['parent123'])
})

test('retention keeps the newest files across pages', async () => {
    const { client, add } = createFakeDrive({ pageSize: 2 })
    for (let i = 1; i <= 5; i += 1) add({ name: `daily-${i}.tar`, parents: ['folder'] })
    add({ name: 'subfolder', mimeType: FOLDER_MIME, parents: ['folder'] })

    const { deleted } = await applyRetention(client, { folderId: 'folder', keep: 3, label: 'daily' })
    assert.deepEqual(deleted, ['daily-1.tar', 'daily-2.tar'])
    assert.deepEqual(
        (await listFolderFiles(client, 'folder')).map((f) => f.name),
        ['daily-3.tar', 'daily-4.tar', 'daily-5.tar']
    )
})

test('upload is verified with md5 and retried', async (t) => {
    const { client, files } = createFakeDrive()
    const file = path.join(tempDir(t), 'b.tar')
    fs.writeFileSync(file, 'content')
    client.corruptUploads = true

    await assert.rejects(
        uploadFile(client, { filePath: file, name: 'b.tar', folderId: 'root', md5: '9a0364b9e99bb480dd25e1f0284c8555', retries: 2, retryDelayMs: 1 }),
        /Integrity check failed/
    )
    assert.equal([...files.values()].filter((f) => f.name === 'b.tar').length, 0)
})

test('uploadBackup uploads once, copies to other periods and applies retention', async (t) => {
    const dir = tempDir(t)
    const bundlePath = path.join(dir, 'backup.tar')
    fs.writeFileSync(bundlePath, 'bundle-bytes')
    const config = configFrom({ BACKUP_SERVER_NAME: 'SRV', BACKUP_RETENTION: '{"daily":1}' })
    const { client, files, calls } = createFakeDrive()

    const bundle = { bundlePath, stamp: '2026-10-30_00-00', size: fs.statSync(bundlePath).size }
    await uploadBackup(config, client, { ...bundle, stamp: '2026-10-29_00-00' }, ['daily'])
    const result = await uploadBackup(config, client, bundle, ['daily', 'weekly', 'monthly'])

    assert.deepEqual(result.succeeded, ['daily', 'weekly', 'monthly'])
    assert.equal(calls.filter((c) => c.method === 'create' && c.name.endsWith('.tar')).length, 2) // one per uploadBackup call
    assert.equal(calls.filter((c) => c.method === 'copy').length, 2)

    const names = [...files.values()].filter((f) => f.mimeType !== FOLDER_MIME).map((f) => f.name)
    assert.deepEqual(names.sort(), ['daily-2026-10-30_00-00.tar', 'monthly-2026-10-30_00-00.tar', 'weekly-2026-10-30_00-00.tar'])
})

test('uploadBackup falls back to uploading when copy fails', async (t) => {
    const bundlePath = path.join(tempDir(t), 'backup.tar')
    fs.writeFileSync(bundlePath, 'x')
    const { client, calls } = createFakeDrive()
    client.failCopies = true

    const result = await uploadBackup(configFrom({}), client, { bundlePath, stamp: 's', size: 1 }, ['daily', 'weekly'])
    assert.deepEqual(result.succeeded, ['daily', 'weekly'])
    assert.equal(calls.filter((c) => c.method === 'create' && c.name.endsWith('.tar')).length, 2)
})

test('create-auth accepts a bare code or the redirect URL', () => {
    assert.equal(extractCode(' 4/abc '), '4/abc')
    assert.equal(extractCode('http://localhost/?code=4%2Fabc&scope=x'), '4/abc')
})
