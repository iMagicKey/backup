// Interactive Google OAuth2 setup (`npm run create-auth`).
// Prints a consent URL, asks for the code (or the whole redirect URL) and prints the GOOGLE_AUTH value.
// Only the `drive.file` scope is requested: the service can see nothing but the files it created.
import readline from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { buildConfig } from './config.js'
import { createOAuthClient, DRIVE_SCOPES } from './utils/drive.js'

export function extractCode(input) {
    const value = input.trim()
    if (!value.includes('code=')) return value
    const query = value.includes('?') ? value.slice(value.indexOf('?') + 1) : value
    return new URLSearchParams(query).get('code') || value
}

export function buildAuthUrl(config) {
    return createOAuthClient(config).generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: DRIVE_SCOPES })
}

async function main() {
    const config = buildConfig(process.env)
    if (!config.google.clientId || !config.google.clientSecret) {
        console.error(
            'GOOGLE_APP must be set to {"clientId":"…","clientSecret":"…","redirectURL":"http://localhost"} (see README.md#google-drive-setup).'
        )
        process.exit(1)
    }

    const client = createOAuthClient(config)

    // Legacy flow: a code placed in GOOGLE_AUTH={"code":"…"} is exchanged without prompting.
    let code = config.google.tokens.code && !config.google.tokens.refresh_token ? config.google.tokens.code : null

    if (!code) {
        const url = buildAuthUrl(config)
        console.log('\n1. Open this URL in a browser and allow access:\n')
        console.log(`   ${url}\n`)
        console.log(`2. You will be redirected to ${config.google.redirectURL}. The page may fail to load; that is expected.`)
        console.log('   Copy the full address from the browser address bar (or just the "code" parameter).\n')

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        code = extractCode(await rl.question('Paste it here: '))
        rl.close()
    }

    const { tokens } = await client.getToken(code)
    if (!tokens.refresh_token) {
        console.error('\nGoogle did not return a refresh_token. Remove the app at https://myaccount.google.com/permissions and run this again.')
        process.exit(1)
    }

    console.log('\nAdd this line to your .env file (keep it secret):\n')
    console.log(`GOOGLE_AUTH=${JSON.stringify(tokens)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error(`Authorization failed: ${err.message}`)
        process.exit(1)
    })
}
