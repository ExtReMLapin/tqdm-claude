import { describe, expect, test } from 'claude-code/testing'

import type { Track } from '../types'
import {
  barLine,
  cells,
  clip,
  count,
  duration,
  failureOf,
  figures,
  isStalled,
  ordered,
  rowsOf,
  spinnerAt,
  STALL_MS,
  timing,
} from '../hooks/render'

const base: Track = {
  id: 't',
  label: 'Train',
  kind: 'bg',
  startedAt: 0,
  status: 'running',
  lastChangeAt: 0,
  size: 0,
}

describe('cells', () => {
  test('filled to the fraction', () => {
    expect(cells({ n: 0, total: 10 }, 10, 0)).toBe('░░░░░░░░░░')
    expect(cells({ n: 5, total: 10 }, 10, 0)).toBe('█████░░░░░')
    expect(cells({ n: 10, total: 10 }, 10, 0)).toBe('██████████')
  })

  test('eighths of a cell', () => {
    expect(cells({ n: 8, total: 16 }, 2, 0)).toBe('█░')
    expect(cells({ n: 3, total: 16 }, 2, 0)).toBe('▍░')
    expect(cells({ n: 12, total: 16 }, 2, 0)).toBe('█▌')
  })

  test('never wider than asked, even past the total', () => {
    expect(cells({ n: 15, total: 10 }, 8, 0)).toHaveLength(8)
  })

  test('no total: a block sweeps back and forth', () => {
    const frames = [0, 80, 160, 800, 1600].map(now => cells({ n: 3 }, 12, now))

    for (const frame of frames) {
      expect(frame).toHaveLength(12)
      expect(frame.split('█').length - 1).toBe(4)
    }

    expect(new Set(frames).size).toBeGreaterThan(1)
    expect(cells({ n: 0 }, 12, 0).startsWith('████')).toBe(true)
  })
})

describe('figures', () => {
  test('count, percent and rate', () => {
    expect(figures({ n: 1840, total: 2400, rate: '312it/s' })).toBe('1840/2400  76%  312it/s')
  })

  test('a percentage alone', () => {
    expect(figures({ n: 37, total: 100, unit: '%' })).toBe('37%')
  })

  test('no total: the count and its unit', () => {
    expect(figures({ n: 512, unit: 'it' })).toBe('512it')
  })

  test('large counts are scaled', () => {
    expect(count(2_400_000)).toBe('2.40M')
    expect(count(99_999)).toBe('99999')
  })
})

describe('text helpers', () => {
  test('duration', () => {
    expect(duration(0)).toBe('00:00')
    expect(duration(75_000)).toBe('01:15')
    expect(duration(3_725_000)).toBe('1:02:05')
  })

  test('clip', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('abc', 4)).toBe('abc')
    expect(clip('abc', 0)).toBe('')
  })

  test('spinner frames change with time', () => {
    expect(spinnerAt(0)).not.toBe(spinnerAt(100))
  })

  test('a bar line fits its width', () => {
    for (const width of [20, 40, 80, 200]) {
      const line = barLine({ n: 1840, total: 2400, label: 'A very long epoch label indeed', rate: '312.00it/s' }, '  └ ', width, 0)

      expect(line.length).toBeLessThanOrEqual(width)
    }
  })
})

describe('tracks', () => {
  test('timing: elapsed, then an estimate once the main bar says', () => {
    expect(timing({ ...base }, 30_000)).toBe('00:30')
    expect(timing({ ...base, main: { n: 1, total: 4 } }, 30_000)).toBe('00:30 / ~02:00')
    expect(timing({ ...base, status: 'done', endedAt: 45_000 }, 90_000)).toBe('00:45')
  })

  test('stalled: a running background task silent for too long', () => {
    expect(isStalled(base, STALL_MS + 1)).toBe(true)
    expect(isStalled(base, STALL_MS - 1)).toBe(false)
    expect(isStalled({ ...base, kind: 'fg' }, STALL_MS + 1)).toBe(false)
    expect(isStalled({ ...base, status: 'done' }, STALL_MS + 1)).toBe(false)
  })

  test('failures first, then running newest first, then done', () => {
    const list = ordered([
      { ...base, id: 'done', status: 'done' },
      { ...base, id: 'old', startedAt: 1 },
      { ...base, id: 'new', startedAt: 2 },
      { ...base, id: 'failed', status: 'failed' },
    ])

    expect(list.map(one => one.id)).toEqual(['failed', 'new', 'old', 'done'])
  })

  test('rows per track', () => {
    expect(rowsOf(base)).toBe(2)
    expect(rowsOf({ ...base, main: { n: 1, total: 2 }, sub: { n: 1 } })).toBe(3)
    expect(rowsOf({ ...base, status: 'failed' })).toBe(2)
    expect(rowsOf({ ...base, status: 'done' })).toBe(1)
  })

  test('what a failure says', () => {
    expect(failureOf({ ...base, status: 'failed', exitCode: 1, error: "KeyError: 'path'" })).toBe("exit code 1 · KeyError: 'path'")
    expect(failureOf({ ...base, status: 'failed' })).toBe('failed')
    expect(failureOf({ ...base, status: 'killed' })).toBe('stopped')
  })
})
