import { describe, expect, test } from 'claude-code/testing'

import { parse } from '../hooks/parse'
import { REAL_TQDM } from './fixtures/real-tqdm'

/** The output as far as a poll in the middle of the run read it: up to the end of the update holding `marker`. */
function upTo(text: string, marker: string): string {
  const at = text.indexOf(marker)

  expect(at).toBeGreaterThan(-1)

  const end = text.slice(at).search(/[\r\n]/)

  return end === -1 ? text : text.slice(0, at + end)
}

test('an update cut mid-write is not read: the last whole one stands', () => {
  const at = REAL_TQDM.single.indexOf('| 12/30 ')

  expect(parse(REAL_TQDM.single.slice(0, at + 8)).main?.n).toBe(11)
})

describe('genuine tqdm output', () => {
  test('a single bar, finished', () => {
    expect(parse(REAL_TQDM.single).main).toMatchObject({ label: 'Train', n: 30, total: 30 })
  })

  test('a single bar, mid-run', () => {
    expect(parse(upTo(REAL_TQDM.single, '| 12/30 ')).main).toMatchObject({ label: 'Train', n: 12, total: 30 })
  })

  test('nested bars mid-run: epochs, then batches beneath', () => {
    const parsed = parse(upTo(REAL_TQDM.nested, 'Batches:  50%'))

    expect(parsed.main).toMatchObject({ label: 'Epochs', total: 3 })
    expect(parsed.sub?.label).toBe('Batches')
  })

  test('nested bars, finished: the outer bar is what is left', () => {
    expect(parse(REAL_TQDM.nested).main).toMatchObject({ label: 'Epochs', n: 3, total: 3 })
  })

  test('no total', () => {
    expect(parse(REAL_TQDM.no_total).main).toMatchObject({ label: 'Scanning', n: 40, unit: 'it' })
  })

  test('bytes with unit_scale', () => {
    const main = parse(REAL_TQDM.bytes).main

    expect(main?.label).toBe('model.bin')
    expect(main?.n).toBe(main?.total)
    expect(main?.rate).toMatch(/B\/s$/)
  })

  test('postfix stays out of the rate', () => {
    expect(parse(REAL_TQDM.postfix).main?.rate).toMatch(/^\d+(\.\d+)?it\/s$/)
  })

  test('a crash mid-bar: the bar where it stopped, and the error', () => {
    const parsed = parse(REAL_TQDM.partial_then_crash)

    expect(parsed.main).toMatchObject({ label: 'Indexing', n: 20, total: 50 })
    expect(parsed.error).toBe("KeyError: 'path'")
  })
})
