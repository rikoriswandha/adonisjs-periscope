import assert from 'node:assert/strict'
import test from 'node:test'

import { formatChartDateLabels, hmsTimeFmt, shortDateFmt, shortDateTimeFmt } from './chart-formatters.ts'

test('formatChartDateLabels uses time when every sample shares a local day', () => {
  const dates = [
    new Date(2026, 6, 27, 14, 32, 5),
    new Date(2026, 6, 27, 14, 32, 8),
    new Date(2026, 6, 27, 15, 1, 0),
  ]

  assert.deepEqual(
    formatChartDateLabels(dates),
    dates.map((date) => hmsTimeFmt.format(date))
  )
})

test('formatChartDateLabels keeps short dates across distinct days', () => {
  const dates = [new Date(2026, 6, 26, 9, 0, 0), new Date(2026, 6, 27, 9, 0, 0)]

  assert.deepEqual(
    formatChartDateLabels(dates),
    dates.map((date) => shortDateFmt.format(date))
  )
})

test('formatChartDateLabels upgrades to date+time when short dates collide', () => {
  const dates = [
    new Date(2026, 6, 26, 9, 0, 0),
    new Date(2026, 6, 27, 10, 0, 0),
    new Date(2026, 6, 27, 18, 0, 0),
  ]

  assert.deepEqual(
    formatChartDateLabels(dates),
    dates.map((date) => shortDateTimeFmt.format(date))
  )
})
