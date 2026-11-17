import { describe, expect, test } from 'claude-code/testing'

import { TAIL_BYTES, tailCommand } from '../hooks/tail'
import { CHARSETS } from '../hooks/charset'
import { agentLineOf, reportOf, rowProgressOf } from '../hooks/render'

/** The script inside `-EncodedCommand`: base64 of UTF-16LE. */
function scriptOf(argv: string[]): string {
  const binary = atob(argv[argv.length - 1] ?? '')
  let text = ''

  for (let i = 0; i < binary.length; i += 2) {
    text += String.fromCharCode(binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8))
  }

  return text
}

describe('reading the end of a large log', () => {
  test('a Windows path is read by PowerShell, with the path quoted inside the script', () => {
    const { argv, isBase64 } = tailCommand("C:\\Users\\me\\it's\\b1.output")

    expect(argv.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(isBase64).toBe(true)
    // The quote is doubled: the path can never end the PowerShell string.
    expect(scriptOf(argv)).toContain("[IO.File]::Open('C:\\Users\\me\\it''s\\b1.output', 'Open', 'Read', 'ReadWrite, Delete')")
    expect(scriptOf(argv)).toContain(`[Math]::Min(${TAIL_BYTES}, $f.Length)`)
  })

  test('a path spelled with / after the drive letter is a Windows path too', () => {
    expect(tailCommand('C:/tmp/tasks/b1.output').argv[0]).toBe('powershell')
  })

  test('a POSIX path is read by tail', () => {
    expect(tailCommand('/tmp/claude-1000/x/tasks/b1.output')).toEqual({
      argv: ['tail', '-c', String(TAIL_BYTES), '/tmp/claude-1000/x/tasks/b1.output'],
      isBase64: false,
    })
  })
})

describe("a subagent's line", () => {
  const base = { type: 'Explore', description: 'Research tqdm', status: 'running' }

  test('its type until the tasks list has a summary', () => {
    expect(agentLineOf({ ...base, label: 'Research tqdm' })).toBe('Explore')
    expect(agentLineOf(base)).toBe('Explore')
  })

  test('the summary, then the tokens', () => {
    expect(agentLineOf({ ...base, label: 'Reading std.py', tokenCount: 950 })).toBe('Reading std.py · 950 tokens')
    expect(agentLineOf({ ...base, label: 'Reading std.py', tokenCount: 1_250_000 })).toBe('Reading std.py · 1.3M tokens')
    expect(agentLineOf({ ...base, tokenCount: 0 })).toBe('Explore')
  })

  test('waiting and idle are said first', () => {
    expect(agentLineOf({ ...base, status: 'waiting' })).toBe('waiting · Explore')
    expect(agentLineOf({ ...base, status: 'idle', label: 'Done reading' })).toBe('idle · Done reading')
  })
})

describe('a progress report', () => {
  test('step, total and label make a bar', () => {
    expect(reportOf({ step: 3, total: 7, label: '  Running   tests ' })).toEqual({ bar: { n: 3, total: 7, label: 'Running tests' }, isDone: false })
  })

  test('a label alone is a step with no count; done is read', () => {
    expect(reportOf({ label: 'Wrapping up', done: true })).toEqual({ bar: { n: 0, label: 'Wrapping up' }, isDone: true })
  })

  test('a step past the total stops at the total; nonsense is refused', () => {
    expect(reportOf({ step: 9, total: 7 })).toEqual({ bar: { n: 7, total: 7 }, isDone: false })
    expect(reportOf({ total: 7 })).toEqual({ problem: 'give at least `step` or `label`' })
    expect(reportOf({ step: 'two' as unknown as number })).toEqual({ problem: 'give at least `step` or `label`' })
  })
})

describe("what goes on a subagent's row", () => {
  test('its step, then its command', () => {
    expect(rowProgressOf({ n: 3, total: 7, label: 'Tests' }, { n: 45, total: 100, label: 'pytest' }, 0)).toBe('███▍░░░░ 3/7 Tests · pytest 45%')
  })

  test('a command alone gets the bar', () => {
    expect(rowProgressOf(undefined, { n: 2, total: 5, label: 'Epochs' }, 0)).toBe('███▎░░░░ Epochs 40%')
  })

  test('ascii where the charset says so', () => {
    expect(rowProgressOf({ n: 1, total: 2 }, undefined, 0, CHARSETS.ascii)).toMatch(/^[#\- 0-9]+ 1\/2$/)
  })
})
