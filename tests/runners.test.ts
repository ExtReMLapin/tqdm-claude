import { describe, expect, test } from 'claude-code/testing'

import { parse } from '../hooks/parse'
import { REAL_TOOLS_2 } from './fixtures/real-tools-2'

// Every capture: 35 or 34 tests, 2 of them failing on purpose, no terminal attached.

/** The output as far as a poll in the middle of the run read it: up to the end of the line holding `marker`. */
function upTo(text: string, marker: string): string {
  const at = text.indexOf(marker)

  expect(at).toBeGreaterThan(-1)

  const end = text.slice(at).search(/[\r\n]/)

  return end === -1 ? text : text.slice(0, at + end)
}

describe('jest 30', () => {
  test('as Claude Code runs it (agent reporter): failed suites so far, then the summary', () => {
    expect(parse(upTo(REAL_TOOLS_2.jest_agent, 'FAIL jt/d.test.js')).main).toMatchObject({ label: 'jest', ok: 0, fail: 1, unit: ' suites' })
    expect(parse(REAL_TOOLS_2.jest_agent).main).toEqual({ label: 'jest', n: 34, total: 34, ok: 32, fail: 2, unit: ' tests' })
  })

  test('in a terminal-less run without the agent reporter: every suite', () => {
    expect(parse(upTo(REAL_TOOLS_2.jest, 'FAIL jt/d.test.js')).main).toMatchObject({ ok: 2, fail: 1, unit: ' suites' })
    expect(parse(REAL_TOOLS_2.jest).main).toMatchObject({ n: 34, ok: 32, fail: 2 })
  })
})

describe('vitest 5', () => {
  test('agent reporter: the failing files, then the summary', () => {
    expect(parse(REAL_TOOLS_2.vitest_agent).main).toEqual({ label: 'vitest', n: 34, total: 34, ok: 32, fail: 2, unit: ' tests' })
  })

  test('default reporter: tests counted file by file', () => {
    // Colors sit between the file and its count even with no terminal: the marker is the file alone.
    expect(parse(upTo(REAL_TOOLS_2.vitest, 'vt/c.test.mjs')).main).toMatchObject({ ok: 16, fail: 0, postfix: 'vt/c.test.mjs' })
    expect(parse(REAL_TOOLS_2.vitest).main).toMatchObject({ n: 34, ok: 32, fail: 2 })
  })

  test('verbose reporter: test by test', () => {
    const lines = REAL_TOOLS_2.vitest_verbose.split('\n')
    const firstFive = lines.slice(0, lines.findIndex(line => line.includes('a case 1')) + 1).join('\n')

    expect(parse(firstFive).main).toMatchObject({ label: 'vitest', ok: 1, fail: 0 })
    expect(parse(REAL_TOOLS_2.vitest_verbose).main).toMatchObject({ n: 34, ok: 32, fail: 2 })
  })
})

describe('go test 1.25', () => {
  test('-v: tests counted; packages do not count twice', () => {
    expect(parse(REAL_TOOLS_2.go_v).main).toMatchObject({ label: 'go test', n: 35, ok: 33, fail: 2, unit: ' tests' })
  })

  test('plain: packages, though failing tests are printed too', () => {
    expect(parse(upTo(REAL_TOOLS_2.go, 'example.com/caps/alpha')).main).toMatchObject({ n: 1, ok: 1, fail: 0, unit: ' packages' })
    expect(parse(REAL_TOOLS_2.go).main).toMatchObject({ n: 3, ok: 1, fail: 2, unit: ' packages', postfix: 'example.com/caps/gamma' })
  })
})

describe('cargo test 1.99 (--no-fail-fast)', () => {
  test('tests done of those announced', () => {
    expect(parse(REAL_TOOLS_2.cargo).main).toMatchObject({ label: 'cargo test', n: 35, total: 35, ok: 33, fail: 2 })
  })

  test('mid-run: the total grows as each target announces its tests', () => {
    const main = parse(upTo(REAL_TOOLS_2.cargo, 'test case_11 ... ok')).main

    expect(main?.total).toBe(11)
    expect(main?.n).toBe(1)
  })
})

describe('dotnet test (SDK 10)', () => {
  test('English, normal verbosity: test by test, then the total', () => {
    expect(parse(upTo(REAL_TOOLS_2.dotnet, 'Passed Caps.BetaTests.Case7')).main).toMatchObject({ label: 'dotnet test', n: 1, ok: 1, fail: 0 })
    expect(parse(REAL_TOOLS_2.dotnet).main).toEqual({ label: 'dotnet test', n: 35, total: 35, ok: 33, fail: 2, unit: ' tests' })
  })

  test('a test under a millisecond (`[< 1 ms]`) is counted', () => {
    expect(parse('  Failed Caps.GammaTests.AlsoFails [< 1 ms]').main).toMatchObject({ fail: 1 })
  })

  test('French, normal verbosity (CRLF): the same counts', () => {
    expect(parse(REAL_TOOLS_2.dotnet_fr).main).toEqual({ label: 'dotnet test', n: 35, total: 35, ok: 33, fail: 2, unit: ' tests' })
  })

  test('French, default verbosity: the summary line', () => {
    expect(parse(REAL_TOOLS_2.dotnet_fr_quiet).main).toMatchObject({ n: 35, total: 35, ok: 33, fail: 2 })
  })
})
