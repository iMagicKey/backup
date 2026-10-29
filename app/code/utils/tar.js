// Compression settings shared by the files archive (via `tar -I`) and streamed database dumps.

export function getCompression({ compression, zstdLevel }) {
    if (compression === 'zstd') {
        const levelArgs = zstdLevel > 19 ? ['--ultra', `-${zstdLevel}`] : [`-${zstdLevel}`]
        return {
            name: 'zstd',
            extension: '.zst',
            tarFlags: ['-I', `zstd -T0 ${levelArgs.join(' ')}`],
            stream: { command: 'zstd', args: ['-q', '-T0', ...levelArgs, '-c'], label: 'zstd' },
            decompress: 'zstd -dc',
        }
    }

    return {
        name: 'gzip',
        extension: '.gz',
        tarFlags: ['-z'],
        stream: { command: 'gzip', args: ['-c'], label: 'gzip' },
        decompress: 'gzip -dc',
    }
}

export function getTarExtension(backup) {
    return `.tar${getCompression(backup).extension}`
}

// GNU tar exit codes: 0 = success, 1 = some files changed/disappeared while being read, 2 = fatal error.
export const TAR_OK_CODES = [0, 1]
