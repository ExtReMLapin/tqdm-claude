import { describe, expect, test } from 'claude-code/testing'

import { parse } from '../hooks/parse'
import { REAL_TOOLS_2 } from './fixtures/real-tools-2'

/** The output as far as a poll in the middle of the run read it: up to the end of the update holding `marker`. */
function upTo(text: string, marker: string): string {
  const at = text.indexOf(marker)

  expect(at).toBeGreaterThan(-1)

  const end = text.slice(at).search(/[\r\n]/)

  return end === -1 ? text : text.slice(0, at + end)
}

describe('dask 2026.8 ProgressBar (real output)', () => {
  test('mid-compute: percentage and elapsed', () => {
    expect(parse(upTo(REAL_TOOLS_2.dask, '52% Completed')).main).toMatchObject({ label: 'dask', n: 52, total: 100, unit: '%' })
  })

  test('done', () => {
    expect(parse(REAL_TOOLS_2.dask).main).toMatchObject({ label: 'dask', n: 100, postfix: '10.04 s' })
  })
})

describe('PySpark 3.5 console progress (real output)', () => {
  test('mid-stage: tasks done of the stage, and running', () => {
    expect(parse(upTo(REAL_TOOLS_2.spark_clean, '(59 + 2) / 100]')).main).toEqual({
      label: 'Spark stage 1',
      n: 59,
      total: 100,
      postfix: '2 running',
    })
  })

  test('the last stage is what is left, never nested under the ones before', () => {
    const parsed = parse(REAL_TOOLS_2.spark_clean)

    expect(parsed.main).toMatchObject({ label: 'Spark stage 2', n: 48, total: 50 })
    expect(parsed.sub).toBeUndefined()
  })

  test('its last line stops short of the total: not a source that can say the job ended early', () => {
    expect(parse(REAL_TOOLS_2.spark_clean).isExact).toBe(false)
  })

  test('a warning printed in the middle of the bar does not break it', () => {
    expect(parse(REAL_TOOLS_2.spark).main?.label).toMatch(/^Spark stage \d$/)
  })
})

describe('XGBoost 3.2 and LightGBM 4.7 (real output)', () => {
  test('XGBoost: rounds (counted from 1) and the validation metrics', () => {
    expect(parse(REAL_TOOLS_2.xgboost).main).toEqual({
      label: 'XGBoost',
      n: 50,
      unit: ' rounds',
      postfix: 'valid-logloss:0.26546 valid-auc:0.95584',
    })
  })

  test('LightGBM: rounds and the validation metrics', () => {
    expect(parse(REAL_TOOLS_2.lightgbm).main).toEqual({
      label: 'LightGBM',
      n: 50,
      unit: ' rounds',
      postfix: 'valid binary_logloss: 0.250011 valid auc: 0.960452',
    })
  })
})

describe('webpack 5 --progress (real output)', () => {
  test('mid-build: percentage and phase', () => {
    expect(parse(upTo(REAL_TOOLS_2.webpack, '65% building')).main).toMatchObject({ label: 'webpack', n: 65, postfix: expect.stringContaining('building') })
  })

  test('done', () => {
    expect(parse(REAL_TOOLS_2.webpack).main).toMatchObject({ label: 'webpack', n: 100 })
  })
})

describe('Bazel 7 (real output, via bazelisk)', () => {
  test('mid-build: actions done of the total, and the action at work', () => {
    expect(parse(upTo(REAL_TOOLS_2.bazel, '[10 / 21]')).main).toMatchObject({
      label: 'Bazel',
      n: 10,
      total: 21,
      postfix: 'Executing genrule //:g12',
    })
  })

  test('done, plain and with --curses=yes', () => {
    expect(parse(REAL_TOOLS_2.bazel).main).toMatchObject({ n: 21, total: 21 })
    expect(parse(REAL_TOOLS_2.bazel_curses).main).toMatchObject({ n: 21, total: 21 })
  })
})
