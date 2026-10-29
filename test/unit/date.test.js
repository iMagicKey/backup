import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTimeLabels, getFormattedDate, getIsoWeek } from '../../app/code/utils/date.js'

test('labels are UTC based', () => {
    assert.deepEqual(getTimeLabels(new Date('2026-10-30T02:15:42Z')), {
        minutely: '2026-10-30T02:15',
        hourly: '2026-10-30T02',
        daily: '2026-10-30',
        weekly: '2026-W44',
        monthly: '2026-10',
        yearly: '2026',
    })
})

test('ISO week uses the ISO week-year at year boundaries', () => {
    // 2027-01-01 is a Friday and belongs to week 53 of 2026.
    assert.deepEqual(getIsoWeek(new Date('2027-01-01T12:00:00Z')), { year: 2026, week: 53 })
    assert.equal(getTimeLabels(new Date('2027-01-01T12:00:00Z')).weekly, '2026-W53')
    // 2024-12-30 is a Monday and belongs to week 1 of 2025.
    assert.equal(getTimeLabels(new Date('2024-12-30T00:00:00Z')).weekly, '2025-W01')
})

test('formatted date is filename safe', () => {
    const stamp = getFormattedDate(new Date('2026-03-04T05:06:07Z'))
    assert.equal(stamp, '2026-03-04_05-06')
    assert.doesNotMatch(stamp, /[:/\\ ]/)
})
