import { describe, expect, test } from 'claude-code/testing'

import { parse } from '../hooks/parse'
import { REAL_TOOLS_2 } from './fixtures/real-tools-2'

/** The output as far as a poll in the middle of the run read it: up to the end of the line holding `marker`. */
function upTo(text: string, marker: string): string {
  const at = text.indexOf(marker)

  expect(at).toBeGreaterThan(-1)

  const end = text.slice(at).search(/[\r\n]/)

  return end === -1 ? text : text.slice(0, at + end)
}

describe('terraform apply (real output, v1.9.8, colored as it writes to a file)', () => {
  test('mid-apply: changes done of the plan, and the resource at work', () => {
    const main = parse(upTo(REAL_TOOLS_2.terraform, 'time_sleep.a: Still creating... [30s elapsed]')).main

    // The three sleeps take 35 s each: at 30 s none is done yet.
    expect(main).toMatchObject({ label: 'terraform', n: 0, total: 4, unit: ' changes', postfix: 'time_sleep.a 30s' })
  })

  test('each change done counts', () => {
    const first = REAL_TOOLS_2.terraform_nocolor.match(/\S+: Creation complete after \S+/)?.[0] ?? ''

    expect(parse(upTo(REAL_TOOLS_2.terraform_nocolor, first)).main).toMatchObject({ n: 1, total: 4 })
  })

  test('the end: all four done', () => {
    expect(parse(REAL_TOOLS_2.terraform).main).toMatchObject({ n: 4, total: 4 })
    expect(parse(REAL_TOOLS_2.terraform_nocolor).main).toMatchObject({ n: 4, total: 4 })
  })

  test('colors are no part of what is read', () => {
    expect(parse(REAL_TOOLS_2.terraform).lastLine ?? '').not.toContain('\x1b')
  })
})

describe('kubectl rollout status (real output, v1.36 on kind)', () => {
  test('a new deployment: replicas available', () => {
    const main = parse(upTo(REAL_TOOLS_2.kubectl_initial, '1 of 3 updated replicas are available')).main

    expect(main).toEqual({ label: 'rollout x', n: 1, total: 3, postfix: 'available' })
  })

  test('an update: replicas updated, then the old ones terminating', () => {
    expect(parse(upTo(REAL_TOOLS_2.kubectl_update, '2 out of 3 new replicas')).main).toMatchObject({ n: 2, total: 3, postfix: 'updated' })
    expect(parse(upTo(REAL_TOOLS_2.kubectl_update, 'pending termination')).main).toMatchObject({ n: 3, total: 3, postfix: '1 old pending' })
  })

  test('rolled out: complete', () => {
    expect(parse(REAL_TOOLS_2.kubectl_update).main).toMatchObject({ label: 'rollout x', n: 3, total: 3 })
    expect(parse(REAL_TOOLS_2.kubectl_initial).main).toMatchObject({ n: 3, total: 3 })
  })
})
