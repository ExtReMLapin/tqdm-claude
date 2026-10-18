import { describe, expect, test } from 'claude-code/testing'

import { parse } from '../hooks/parse'
import { barParts } from '../hooks/render'
import { REAL_TOOLS } from './fixtures/real-tools'

/** The output as far as a poll in the middle of the run read it: up to the end of the line holding `marker`. */
function upTo(text: string, marker: string): string {
  const at = text.indexOf(marker)

  expect(at).toBeGreaterThan(-1)

  const end = text.slice(at).search(/[\r\n]/)

  return end === -1 ? text : text.slice(0, at + end)
}

describe('pytest (real output)', () => {
  test('mid-run: the percentage, the file, and outcomes counted so far', () => {
    expect(parse(upTo(REAL_TOOLS.pytest, '[ 65%]')).main).toMatchObject({
      label: 'pytest',
      n: 65,
      total: 100,
      ok: 30,
      fail: 0,
      postfix: 'test_m2.py',
    })
  })

  test('at the end: 45 passed, 1 failed, and the assertion as the error', () => {
    const parsed = parse(REAL_TOOLS.pytest)

    expect(parsed.main).toMatchObject({ n: 100, ok: 45, fail: 1 })
    expect(parsed.error).toContain('AssertionError')
  })

  test('-v: one outcome per line', () => {
    expect(parse(REAL_TOOLS.pytest_verbose).main).toMatchObject({ label: 'pytest', n: 100, ok: 45, fail: 1 })
  })

  test('the bar splits by outcome, not by percentage', () => {
    const parts = barParts({ n: 100, total: 100, unit: '%', ok: 45, fail: 1 }, '', 60, 0)

    expect(parts.failed.length).toBe(1)
  })
})

describe('pip --progress-bar on (real output)', () => {
  test('the wheel being downloaded, its size, rate and estimate', () => {
    expect(parse(REAL_TOOLS.pip).main).toMatchObject({
      label: 'numpy-2.1.3-cp311-cp311-win_amd64.whl',
      n: 12.9,
      total: 12.9,
      rate: '10.9 MB/s',
      eta: '0:00:00',
      postfix: 'MB',
    })
  })

  test('mid-download', () => {
    const line = '   --------------------                     6.4/12.9 MB 10.9 MB/s eta 0:00:01'

    expect(parse(`Downloading numpy-2.1.3-cp311-cp311-win_amd64.whl (12.9 MB)\n${line}`).main).toMatchObject({ n: 6.4, total: 12.9 })
  })

  test('rich\'s own bar glyphs, as in a terminal', () => {
    expect(parse('   ━━━━━━━━━━━━━━━━━━━━╸━━━━━━━━━━━━━━━━━━━ 6.4/12.9 MB 10.9 MB/s eta 0:00:01').main).toMatchObject({ label: 'pip', n: 6.4 })
  })
})

describe('robocopy (real output, French Windows)', () => {
  test('the file being copied and its percentage, whatever the language of its words', () => {
    expect(parse(REAL_TOOLS.robocopy_mid_file).main).toMatchObject({ label: 'robocopy', total: 100, postfix: 'big.bin' })
    expect(parse(REAL_TOOLS.robocopy_mid_file).main?.n).toBeGreaterThan(0)
  })

  test('English words too', () => {
    expect(parse('\t  New File  \t\t   12.5 m\tdata.zip\r  33.3%\r').main).toMatchObject({ n: 33.3, postfix: 'data.zip' })
  })
})

describe('rclone, aws s3, git lfs, Gradle (formats from their sources)', () => {
  test('rclone', () => {
    expect(parse('Transferred:   \t    1.234 GiB / 3.000 GiB, 41%, 12.345 MiB/s, ETA 2m23s (xfr#3/10)').main).toEqual({
      label: 'rclone',
      n: 41,
      total: 100,
      unit: '%',
      rate: '12.345 MiB/s',
      eta: '02:23',
      postfix: '1.234 GiB / 3.000 GiB',
    })
    expect(parse('   12.000 MiB / 3.000 GiB, 0%, 0 B/s, ETA -').main).toMatchObject({ label: 'rclone', eta: undefined })
  })

  test('aws s3, in bytes, the total still estimated', () => {
    expect(parse('Completed 256.0 MiB/~1.0 GiB (12.3 MiB/s) with ~3 file(s) remaining\r').main).toEqual({
      label: 'aws s3',
      n: 256 * 1024 ** 2,
      total: 1024 ** 3,
      rate: '12.3 MiB/s',
      postfix: '3 file(s) left',
    })
  })

  test('aws s3, in files', () => {
    expect(parse('Completed 3 file(s) with ~5 file(s) remaining (calculating...)').main).toMatchObject({ n: 3, total: 8 })
  })

  test('git lfs', () => {
    expect(parse('Downloading LFS objects:  45% (9/20), 12 MiB | 3.4 MiB/s').main).toEqual({
      label: 'Downloading LFS objects',
      n: 9,
      total: 20,
      rate: '3.4 MiB/s',
    })
  })

  test('Gradle\'s rich console', () => {
    expect(parse('<=====--------> 37% EXECUTING [12s]').main).toMatchObject({ label: 'Gradle', n: 37, postfix: 'EXECUTING 12s' })
  })
})
