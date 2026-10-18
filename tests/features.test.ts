import { describe, expect, test } from 'claude-code/testing'

import type { Track } from '../types'
import { parse } from '../hooks/parse'
import { barParts, endNotice, modeLabelOf, spinInterval } from '../hooks/render'

const base: Track = { id: 't', label: 'Job', kind: 'bg', startedAt: 0, status: 'running', lastChangeAt: 0, size: 10 }

describe('transfers and installs', () => {
  test('rsync --info=progress2', () => {
    expect(parse('     1,234,567  45%   12.34MB/s    0:00:05 (xfr#12, to-chk=88/100)').main).toEqual({
      label: 'rsync',
      n: 45,
      total: 100,
      unit: '%',
      rate: '12.34MB/s',
      eta: '0:00:05',
      postfix: 'xfr#12, to-chk=88/100',
    })
  })

  test('wget, bar style', () => {
    expect(parse('ubuntu.iso          45%[=======>          ]   1.08G  2.31MB/s    eta 1m 5s').main).toMatchObject({
      label: 'ubuntu.iso',
      n: 45,
      rate: '2.31MB/s',
      eta: '01:05',
    })
  })

  test('wget, dot style', () => {
    expect(parse('  4096K .......... .......... .......... .......... ..........  9% 2.31M 20s').main).toMatchObject({
      label: 'wget',
      n: 9,
      rate: '2.31MB/s',
      eta: '00:20',
    })
  })

  test('curl\'s meter, and curl -#', () => {
    expect(parse(' 45 10.0M   45 4608k    0     0  1234k      0  0:00:08  0:00:03  0:00:05 1234k').main).toMatchObject({
      label: 'curl',
      n: 45,
      rate: '1234kB/s',
      eta: '0:00:05',
    })
    expect(parse('######################                        48.2%').main).toMatchObject({ label: 'curl', n: 48.2 })
  })

  test('curl\'s header lines are no progress', () => {
    expect(parse('  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current').main).toBeUndefined()
  })

  test('pnpm --reporter=append-only', () => {
    expect(parse('Progress: resolved 123, reused 100, downloaded 20, added 0').main).toMatchObject({
      label: 'pnpm',
      n: 123,
      postfix: 'reused 100, downloaded 20, added 0',
    })
    expect(parse('Progress: resolved 123, reused 100, downloaded 20, added 0').main?.total).toBeUndefined()
  })

  test('apt, fancy and Status-Fd', () => {
    expect(parse('Progress: [ 45%] [##########..............]').main).toMatchObject({ label: 'apt', n: 45 })
    expect(parse('pmstatus:dpkg-exec:50.0:Running dpkg').main).toMatchObject({ label: 'apt', n: 50, postfix: 'Running dpkg' })
  })
})

describe('outcome counters', () => {
  test('ok and fail are read', () => {
    expect(parse('##progress step=40/100 ok=30 fail=10').main).toMatchObject({ n: 40, total: 100, ok: 30, fail: 10 })
  })

  test('the filled part splits by outcome, failures at least one cell', () => {
    const parts = barParts({ n: 40, total: 100, ok: 30, fail: 10 }, '  ', 60, 0)

    expect(parts.done.length + parts.failed.length + parts.left.length).toBeGreaterThan(5)
    expect(parts.failed.length).toBeGreaterThan(0)
    expect(parts.failed.length).toBeLessThan(parts.done.length)
    expect(barParts({ n: 100, total: 100, fail: 1 }, '', 60, 0).failed.length).toBe(1)
  })

  test('no failure: one bar, partial cell kept', () => {
    const parts = barParts({ n: 3, total: 16 }, '', 30, 0)

    expect(parts.failed).toBe('')
    expect(parts.done).toMatch(/[▏▎▍▌▋▊▉]/)
  })
})

describe('the footer mode label', () => {
  const at = (patch: Partial<Track>): Track => ({ ...base, ...patch })

  test('one running task: its name and percentage', () => {
    expect(modeLabelOf([at({ label: 'Train', main: { n: 43, total: 100 } })], 0)).toMatch(/^⠋ Train 43%$/)
  })

  test('several: their count, the most urgent one\'s percentage, the failures waiting', () => {
    const label = modeLabelOf(
      [at({ id: 'a', main: { n: 43, total: 100 }, startedAt: 2 }), at({ id: 'b', startedAt: 1 }), at({ id: 'c', status: 'failed' })],
      0,
    )

    expect(label).toBe('⠋ 2 tasks · 43% · ✗ 1')
  })

  test('nothing running or waiting: nothing', () => {
    expect(modeLabelOf([at({ status: 'done', endedAt: 1 })], 0)).toBe('')
  })
})

describe('the spinner follows the pace', () => {
  test('faster when ahead of the average, slower behind, slowest when still', () => {
    expect(spinInterval({ ...base, paceRatio: 4, lastSample: { at: 0, fraction: 0.5 } }, 1000)).toBe(60)
    expect(spinInterval({ ...base, paceRatio: 0.25, lastSample: { at: 0, fraction: 0.5 } }, 1000)).toBe(300)
    expect(spinInterval({ ...base, paceRatio: 1, lastSample: { at: 0, fraction: 0.5 } }, 1000)).toBe(100)
    expect(spinInterval({ ...base, paceRatio: 4, lastSample: { at: 0, fraction: 0.5 } }, 6000)).toBe(300)
    expect(spinInterval(base, 0)).toBe(100)
  })
})

describe('what a task\'s end is worth telling', () => {
  const ended = (patch: Partial<Track>): Track => ({ ...base, endedAt: 90_000, ...patch })

  test('failures mode', () => {
    expect(endNotice(ended({ status: 'failed', exitCode: 2 }), 'failures')).toEqual({ title: 'Task failed', text: 'Job · exit code 2' })
    expect(endNotice(ended({ status: 'done', isExact: true, main: { n: 4, total: 10 } }), 'failures')?.title).toBe('Task ended early')
    expect(endNotice(ended({ status: 'done' }), 'failures')).toBeUndefined()
    expect(endNotice(ended({ status: 'killed' }), 'failures')).toBeUndefined()
  })

  test('always mode', () => {
    expect(endNotice(ended({ status: 'done' }), 'always')).toEqual({ title: 'Task finished', text: 'Job · in 01:30' })
    expect(endNotice(ended({ status: 'done', endedAt: 30_000 }), 'always')).toBeUndefined()
    expect(endNotice(ended({ status: 'killed' }), 'always')?.title).toBe('Task stopped')
  })

  test('off, still running, or unconfirmed: nothing', () => {
    expect(endNotice(ended({ status: 'failed' }), 'off')).toBeUndefined()
    expect(endNotice(base, 'always')).toBeUndefined()
    expect(endNotice(ended({ status: 'done', isUnconfirmed: true }), 'always')).toBeUndefined()
  })
})
