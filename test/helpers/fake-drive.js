// Minimal in-memory implementation of the Drive v3 calls used by app/code/utils/drive.js.
import crypto from 'node:crypto'
import { FOLDER_MIME } from '../../app/code/utils/drive.js'

const unescape = (value) => value.replace(/\\'/g, "'").replace(/\\\\/g, '\\')

export function createFakeDrive({ pageSize = 2 } = {}) {
    const files = new Map()
    const calls = []
    let counter = 0
    let clock = Date.parse('2026-01-01T00:00:00Z')

    const add = (data) => {
        counter += 1
        clock += 1000
        const file = { id: `id${counter}`, createdTime: new Date(clock).toISOString(), parents: ['root'], ...data }
        files.set(file.id, file)
        return file
    }

    function matches(file, q) {
        const name = q.match(/name = '((?:[^'\\]|\\.)*)'/)
        if (name && file.name !== unescape(name[1])) return false
        const parent = q.match(/'((?:[^'\\]|\\.)*)' in parents/)
        if (parent && !file.parents.includes(unescape(parent[1]))) return false
        if (q.includes(`mimeType = '${FOLDER_MIME}'`) && file.mimeType !== FOLDER_MIME) return false
        if (q.includes(`mimeType != '${FOLDER_MIME}'`) && file.mimeType === FOLDER_MIME) return false
        return true
    }

    const client = {
        files: {
            async list({ q, pageToken }) {
                calls.push({ method: 'list', q })
                const all = [...files.values()].filter((f) => matches(f, q))
                const start = Number(pageToken || 0)
                const page = all.slice(start, start + pageSize)
                return { data: { files: page, nextPageToken: start + pageSize < all.length ? String(start + pageSize) : undefined } }
            },
            async create({ requestBody, media }) {
                calls.push({ method: 'create', name: requestBody.name })
                if (!media) return { data: add({ ...requestBody }) }

                const chunks = []
                for await (const chunk of media.body) chunks.push(chunk)
                const content = Buffer.concat(chunks)
                if (client.corruptUploads) content[0] ^= 0xff
                const md5Checksum = crypto.createHash('md5').update(content).digest('hex')
                return { data: add({ ...requestBody, size: String(content.length), md5Checksum, content }) }
            },
            async copy({ fileId, requestBody }) {
                calls.push({ method: 'copy', name: requestBody.name })
                if (client.failCopies) throw new Error('copy not allowed')
                const source = files.get(fileId)
                const { id: _id, createdTime: _created, ...rest } = source
                return { data: add({ ...rest, ...requestBody }) }
            },
            async delete({ fileId }) {
                calls.push({ method: 'delete', fileId })
                files.delete(fileId)
                return { data: {} }
            },
        },
    }

    return { client, files, calls, add }
}
