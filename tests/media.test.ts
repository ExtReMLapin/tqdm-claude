import { describe, expect, test } from 'claude-code/testing'

import type { Track } from '../types'
import { parse } from '../hooks/parse'
import { isShortOfTotal } from '../hooks/render'
import { REAL_TOOLS_2 } from './fixtures/real-tools-2'

/** The output as far as a poll in the middle of the run read it: up to the end of the update holding `marker`. */
function upTo(text: string, marker: string): string {
  const at = text.indexOf(marker)

  expect(at).toBeGreaterThan(-1)

  const end = text.slice(at).search(/[\r\n\x08]/)

  return end === -1 ? text : text.slice(0, at + end)
}

describe('yt-dlp (real output, 2026.08.19)', () => {
  test('mid-download: the file, percentage, size, rate and estimate', () => {
    expect(parse(upTo(REAL_TOOLS_2.ytdlp, '57.6%')).main).toEqual({
      label: 'v.mp4',
      n: 57.6,
      total: 100,
      unit: '%',
      rate: '2.95MiB/s',
      eta: '00:03',
      postfix: '25.74MiB',
    })
  })

  test('an unknown rate and estimate at the start are left out', () => {
    expect(parse(upTo(REAL_TOOLS_2.ytdlp, '0.0% of')).main).toMatchObject({ n: 0, rate: undefined, eta: undefined })
  })

  test('the end, with or without --newline', () => {
    expect(parse(REAL_TOOLS_2.ytdlp).main).toMatchObject({ n: 100, rate: '2.79MiB/s' })
    expect(parse(REAL_TOOLS_2.ytdlp_newline).main).toMatchObject({ n: 100 })
  })
})

describe('HandBrakeCLI (real output, 1.7.2)', () => {
  test('mid-encode: percentage, fps and estimate', () => {
    const at = REAL_TOOLS_2.handbrake.search(/Encoding: task 1 of 1, \d+\.\d+ % \(/)
    const main = parse(REAL_TOOLS_2.handbrake.slice(0, REAL_TOOLS_2.handbrake.indexOf('\r', at))).main

    expect(main).toMatchObject({ label: 'HandBrake', total: 100, unit: '%' })
    expect(main?.rate).toMatch(/fps$/)
    expect(main?.eta).toMatch(/^\d+:\d\d:\d\d$/)
  })

  test('done: "Encode done!" completes the bar its last update left at 99.94 %', () => {
    expect(parse(REAL_TOOLS_2.handbrake).main).toMatchObject({ label: 'HandBrake', n: 100 })
  })
})

describe('pv -f (real output, 1.8.5)', () => {
  test('with a size: percentage, rate and estimate', () => {
    expect(parse(upTo(REAL_TOOLS_2.pv_size, '40%')).main).toEqual({
      label: 'pv',
      n: 40,
      total: 100,
      unit: '%',
      rate: '40.0MiB/s',
      eta: '0:00:04',
      postfix: '120MiB',
    })
  })

  test('with no size: bytes so far and rate', () => {
    expect(parse(REAL_TOOLS_2.pv_open).main).toMatchObject({ label: 'pv', n: 300 * 1024 ** 2, unit: 'B', rate: '40.2MiB/s' })
  })
})

describe('7-Zip -bsp1 (real output, 23.01, updated with backspaces)', () => {
  test('mid-archive: percentage and file', () => {
    expect(parse(upTo(REAL_TOOLS_2.sevenzip, ' 51% 1 + data.bin')).main).toEqual({
      label: '7-Zip',
      n: 51,
      total: 100,
      unit: '%',
      postfix: 'data.bin',
    })
  })

  test('done: "Everything is Ok" completes the bar its last update left at 99 %', () => {
    expect(parse(REAL_TOOLS_2.sevenzip).main).toMatchObject({ label: '7-Zip', n: 100 })
  })
})

describe('dd status=progress (real output, coreutils 9.4)', () => {
  test('bytes so far and rate, no total', () => {
    expect(parse(upTo(REAL_TOOLS_2.dd, '537919488 bytes')).main).toEqual({
      label: 'dd',
      n: 537919488,
      unit: 'B',
      rate: '133 MB/s',
      postfix: '4 s',
    })
  })

  test('the summary is the last count', () => {
    expect(parse(REAL_TOOLS_2.dd).main).toMatchObject({ n: 1073741824, rate: '135 MB/s' })
  })
})

describe('an end within 1 % of the total is no early end', () => {
  const ended = (n: number): Track => ({
    id: 't',
    label: 'x',
    kind: 'bg',
    startedAt: 0,
    endedAt: 1,
    status: 'done',
    lastChangeAt: 0,
    size: 1,
    isExact: true,
    main: { n, total: 100 },
  })

  test('99.94 % is done, 95 % is not', () => {
    expect(isShortOfTotal(ended(99.94))).toBe(false)
    expect(isShortOfTotal(ended(95))).toBe(true)
  })

  test('a source that need not print its last state (Spark ends at 48/50, webpack at 99 %) never warns', () => {
    expect(isShortOfTotal({ ...ended(96), isExact: false })).toBe(false)
    expect(isShortOfTotal({ ...ended(96), isExact: undefined })).toBe(false)
  })
})
