import fs from 'node:fs'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'

export async function hashFile(filePath, algorithm = 'sha256') {
    const hash = crypto.createHash(algorithm)
    await pipeline(fs.createReadStream(filePath), hash)
    return hash.digest('hex')
}

export function formatBytes(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function ensurePrivateDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

// Start time of a process (clock ticks since boot, /proc/<pid>/stat field 22); null if it does not exist.
// Together with the pid it identifies a process even after the pid was reused (e.g. after a reboot).
export function processStartTime(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
    } catch {
        return null
    }
}

function isRunning(pid, startTime) {
    if (fs.existsSync('/proc/self/stat')) return processStartTime(pid) === startTime
    try {
        process.kill(pid, 0)
        return true
    } catch (err) {
        return err.code === 'EPERM'
    }
}

// Lock file that keeps the service and `npm run backup:once` from working in the same directory.
// It is created atomically with link(), so a reader never sees a half-written file. A lock whose owner
// no longer runs is taken over. Returns a release function.
export function acquireLock(lockPath) {
    const content = `${process.pid} ${processStartTime(process.pid) ?? ''}`
    const tmp = `${lockPath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, content, { mode: 0o600 })

    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                fs.linkSync(tmp, lockPath)
                return () => fs.rmSync(lockPath, { force: true })
            } catch (err) {
                if (err.code !== 'EEXIST') throw err
                const [pid, startTime = ''] = fs.readFileSync(lockPath, 'utf8').trim().split(' ')
                if (Number(pid) && isRunning(Number(pid), startTime)) {
                    throw new Error(`Another backup is already running (pid ${pid}, lock ${lockPath})`, { cause: err })
                }
                fs.rmSync(lockPath, { force: true })
            }
        }
        throw new Error(`Could not acquire lock ${lockPath}`)
    } finally {
        fs.rmSync(tmp, { force: true })
    }
}
