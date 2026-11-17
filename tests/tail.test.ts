import { describe, expect, test } from 'claude-code/testing'

import { TAIL_BYTES, tailCommand } from '../hooks/tail'
import { agentLineOf } from '../hooks/render'

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
