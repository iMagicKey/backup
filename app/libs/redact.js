// Removes credentials from any text before it is logged or sent to Telegram.
// Dump tools (mongodump in particular) echo connection strings in their error output.

const MASK = '***'
const MIN_SECRET_LENGTH = 4
const secrets = new Set()

export function registerSecret(value) {
    if (value === undefined || value === null) return
    const text = String(value)
    if (text.length < MIN_SECRET_LENGTH) return

    secrets.add(text)
    const encoded = encodeURIComponent(text)
    if (encoded !== text) secrets.add(encoded)
}

export function registerUriSecrets(uri) {
    if (!uri) return
    registerSecret(uri)
    try {
        const { password } = new URL(uri)
        if (password) {
            registerSecret(password)
            registerSecret(decodeURIComponent(password))
        }
    } catch {
        // Not a parseable URL; the generic credential pattern below still applies.
    }
}

export function clearSecrets() {
    secrets.clear()
}

export function redact(input) {
    let text = String(input)

    const ordered = [...secrets].sort((a, b) => b.length - a.length)
    for (const secret of ordered) {
        text = text.split(secret).join(MASK)
    }

    // scheme://user:password@host  ->  scheme://user:***@host
    text = text.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/?#\s@]*:)[^@\s/]+@/gi, `$1${MASK}@`)
    // Telegram bot tokens inside API URLs
    text = text.replace(/\/bot\d+:[\w-]+/g, `/bot${MASK}`)
    // OAuth bearer tokens
    text = text.replace(/(Bearer\s+)[\w.~+/-]+=*/gi, `$1${MASK}`)

    return text
}
