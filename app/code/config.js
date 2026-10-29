// The only module that reads environment variables. `buildConfig` is pure so it can be tested
// with any env object; it never throws and returns every problem it finds in `errors`.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT_DIR = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

export const PERIODS = ['minutely', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']

export const DEFAULT_RETENTION = {
    minutely: 60,
    hourly: 24,
    daily: 3,
    weekly: 5,
    monthly: 12,
    yearly: 15,
}

const COMPRESSIONS = ['gzip', 'zstd']

function str(value) {
    if (value === undefined || value === null) return undefined
    const trimmed = String(value).trim()
    return trimmed === '' ? undefined : trimmed
}

function bool(value, fallback = false) {
    const v = str(value)?.toLowerCase()
    if (v === undefined) return fallback
    return ['1', 'true', 'yes', 'on'].includes(v)
}

// Accepts a JSON array (`["/a","/b"]`) or a comma-separated list (`/a, /b`).
function list(value) {
    const v = str(value)
    if (v === undefined) return []
    if (v.startsWith('[')) {
        try {
            const parsed = JSON.parse(v)
            if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean)
        } catch {
            // fall through to comma splitting
        }
    }
    return v
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
}

// Splits extra CLI arguments on whitespace; a JSON array is accepted for arguments containing spaces.
function args(value) {
    const v = str(value)
    if (v === undefined) return []
    if (v.startsWith('[')) return list(v)
    return v.split(/\s+/).filter(Boolean)
}

function int(value, fallback, { min = -Infinity, max = Infinity, name, errors }) {
    const v = str(value)
    if (v === undefined) return fallback
    const parsed = Number(v)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        errors.push(`${name} must be an integer between ${min} and ${max} (got "${v}")`)
        return fallback
    }
    return parsed
}

function json(value, name, errors) {
    const v = str(value)
    if (v === undefined) return undefined
    try {
        return JSON.parse(v)
    } catch (err) {
        errors.push(`${name} is not valid JSON: ${err.message}`)
        return undefined
    }
}

export function buildConfig(env = process.env) {
    const errors = []
    const warnings = []

    const compression = str(env.BACKUP_COMPRESSION)?.toLowerCase() || 'gzip'
    if (!COMPRESSIONS.includes(compression)) errors.push(`BACKUP_COMPRESSION must be one of ${COMPRESSIONS.join(', ')} (got "${compression}")`)

    const periods = list(env.BACKUP_PERIODS)
    if (!periods.length) periods.push('daily')
    const unknownPeriods = periods.filter((p) => !PERIODS.includes(p))
    if (unknownPeriods.length) errors.push(`BACKUP_PERIODS contains unknown period(s): ${unknownPeriods.join(', ')}. Allowed: ${PERIODS.join(', ')}`)

    const retention = { ...DEFAULT_RETENTION }
    const retentionOverride = json(env.BACKUP_RETENTION, 'BACKUP_RETENTION', errors)
    if (retentionOverride !== undefined) {
        if (typeof retentionOverride !== 'object' || Array.isArray(retentionOverride) || retentionOverride === null) {
            errors.push('BACKUP_RETENTION must be a JSON object, e.g. {"daily":7}')
        } else {
            Object.entries(retentionOverride).forEach(([period, keep]) => {
                if (!PERIODS.includes(period)) errors.push(`BACKUP_RETENTION: unknown period "${period}"`)
                else if (!Number.isInteger(keep) || keep < 1) errors.push(`BACKUP_RETENTION.${period} must be a positive integer`)
                else retention[period] = keep
            })
        }
    }

    const backup = {
        paths: list(env.BACKUP_PATHS),
        excludes: list(env.BACKUP_EXCLUDES),
        prefix: str(env.BACKUP_PREFIX) ?? 'backup-',
        periods: [...new Set(periods)],
        retention,
        compression,
        zstdLevel: int(env.BACKUP_ZSTD_LEVEL, 19, { min: 1, max: 22, name: 'BACKUP_ZSTD_LEVEL', errors }),
        storageDir: path.resolve(ROOT_DIR, str(env.BACKUP_STORAGE_DIR) || 'app/storage'),
        dataDir: path.resolve(ROOT_DIR, str(env.BACKUP_DATA_DIR) || 'app/data'),
        keepLocal: bool(env.BACKUP_KEEP_LOCAL, true),
        timeoutMs: int(env.BACKUP_TIMEOUT_MINUTES, 360, { min: 1, max: 7 * 24 * 60, name: 'BACKUP_TIMEOUT_MINUTES', errors }) * 60 * 1000,
        retryMs: int(env.BACKUP_RETRY_MINUTES, 15, { min: 1, max: 24 * 60, name: 'BACKUP_RETRY_MINUTES', errors }) * 60 * 1000,
        serverName: str(env.BACKUP_SERVER_NAME) || os.hostname().toUpperCase(),
    }

    if (!/^[\w.-]*$/.test(backup.prefix)) errors.push('BACKUP_PREFIX may only contain letters, digits, ".", "_" and "-"')
    if (/[/\\]/.test(backup.serverName)) errors.push('BACKUP_SERVER_NAME must not contain slashes')
    if (path.resolve(backup.storageDir) === path.parse(backup.storageDir).root) errors.push('BACKUP_STORAGE_DIR must not be the filesystem root')

    const docker = {
        command: str(env.DOCKER_COMMAND) || 'docker',
    }

    const mariadb = {
        enabled: bool(env.MARIADB_ENABLED),
        all: bool(env.MARIADB_ALL),
        host: str(env.MARIADB_HOST),
        port: str(env.MARIADB_PORT),
        user: str(env.MARIADB_USER),
        password: env.MARIADB_PASSWORD || undefined,
        databases: list(env.MARIADB_DATABASE),
        container: str(env.MARIADB_DOCKER_CONTAINER),
        dumpCommand: str(env.MARIADB_DUMP_COMMAND),
        extraArgs: args(env.MARIADB_EXTRA_ARGS),
    }
    if (mariadb.enabled && !mariadb.all && !mariadb.databases.length) errors.push('MARIADB_DATABASE is required when MARIADB_ALL is not true')

    const postgres = {
        enabled: bool(env.POSTGRES_ENABLED),
        all: bool(env.POSTGRES_ALL),
        host: str(env.POSTGRES_HOST),
        port: str(env.POSTGRES_PORT),
        user: str(env.POSTGRES_USER) || 'postgres',
        password: env.POSTGRES_PASSWORD || undefined,
        databases: list(env.POSTGRES_DATABASE),
        container: str(env.POSTGRES_DOCKER_CONTAINER),
        extraArgs: args(env.POSTGRES_EXTRA_ARGS),
    }
    if (postgres.enabled && !postgres.all && !postgres.databases.length) errors.push('POSTGRES_DATABASE is required when POSTGRES_ALL is not true')

    const mongodb = {
        enabled: bool(env.MONGODB_ENABLED),
        uri: str(env.MONGODB_URI),
        container: str(env.MONGODB_DOCKER_CONTAINER),
        extraArgs: args(env.MONGODB_EXTRA_ARGS),
    }
    if (mongodb.enabled && !mongodb.uri && !mongodb.container) errors.push('MONGODB_URI is required unless MONGODB_DOCKER_CONTAINER is set')

    if (!backup.paths.length && !mariadb.enabled && !postgres.enabled && !mongodb.enabled) {
        errors.push('Nothing to back up: set BACKUP_PATHS and/or enable MARIADB/POSTGRES/MONGODB')
    }

    const googleApp = json(env.GOOGLE_APP, 'GOOGLE_APP', errors)
    const googleAuth = json(env.GOOGLE_AUTH, 'GOOGLE_AUTH', errors) || {}
    const google = {
        clientId: googleApp?.clientId,
        clientSecret: googleApp?.clientSecret,
        redirectURL: googleApp?.redirectURL || 'http://localhost',
        tokens: googleAuth,
        folderId: str(env.GOOGLE_DRIVE_FOLDER_ID) || 'root',
    }

    const authErrors = []
    if (!google.clientId || !google.clientSecret)
        authErrors.push('GOOGLE_APP must be JSON with "clientId" and "clientSecret" (run `npm run create-auth` for setup help)')
    if (!google.tokens.refresh_token) authErrors.push('GOOGLE_AUTH must contain a "refresh_token" (generate it with `npm run create-auth`)')

    const telegram = {
        enabled: bool(env.TELEGRAM_REPORT_ENABLED),
        token: str(env.TELEGRAM_BOT_TOKEN),
        chatId: str(env.TELEGRAM_CHANNEL_ID),
        reportSuccess: bool(env.TELEGRAM_REPORT_SUCCESS),
    }
    if (telegram.enabled && (!telegram.token || !telegram.chatId))
        warnings.push('TELEGRAM_REPORT_ENABLED is true but TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID is missing; reports are disabled')

    return {
        appEnv: str(env.APP_ENV) || 'live',
        schedulerInterval: str(env.SHEDULER_INTERVAL ?? env.SCHEDULER_INTERVAL),
        backup,
        docker,
        mariadb,
        postgres,
        mongodb,
        google,
        telegram,
        errors,
        authErrors,
        warnings,
    }
}

export function secretsOf(config) {
    return {
        values: [
            config.mariadb.password,
            config.postgres.password,
            config.google.clientSecret,
            config.google.tokens.access_token,
            config.google.tokens.refresh_token,
            config.google.tokens.id_token,
            config.telegram.token,
        ],
        uris: [config.mongodb.uri],
    }
}
