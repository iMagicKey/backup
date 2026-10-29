// All labels and timestamps are UTC so that period boundaries do not depend on the server time zone.

const pad = (n) => String(n).padStart(2, '0')

// ISO-8601 week number (weeks start on Monday, week 1 contains the first Thursday).
export function getIsoWeek(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
    return { year: d.getUTCFullYear(), week }
}

// Filename-safe timestamp, e.g. 2026-10-30_02-15 (no colons: they break Windows downloads and tar's remote syntax).
export function getFormattedDate(date = new Date()) {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}`
}

// One label per period; a period is due when its label differs from the last successful run.
export function getTimeLabels(date = new Date()) {
    const iso = date.toISOString()
    const { year, week } = getIsoWeek(date)

    return {
        minutely: iso.slice(0, 16), // YYYY-MM-DDTHH:mm
        hourly: iso.slice(0, 13), // YYYY-MM-DDTHH
        daily: iso.slice(0, 10), // YYYY-MM-DD
        weekly: `${year}-W${pad(week)}`, // ISO week-year, YYYY-W##
        monthly: iso.slice(0, 7), // YYYY-MM
        yearly: iso.slice(0, 4), // YYYY
    }
}
