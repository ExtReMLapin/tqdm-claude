import type { AgentInfo, AgentStatus, On, SessionAppendInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'tqdm-claude'
const OUTPUT = 'C:\\tmp\\tasks\\b1.output'
const BACKGROUND_TEXT = `Command running in background with ID: b1. Output is being written to: ${OUTPUT}. You will be notified when it completes.`

const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 14, bodyColumns: 90, scroll: { offset: 0, bodyRows: 13 }, view: {} },
} as const

/** A tasks-list row as `$.agent.list()` gives it, with the fields the band does not read filled in. */
function agent(row: Pick<AgentInfo, 'id' | 'description' | 'type' | 'status'> & Partial<AgentInfo>): AgentInfo {
  return {
    kind: 'local_agent',
    taskStatus: 'running',
    label: row.description,
    startTime: 1_000_000,
    cwd: 'C:\\work',
    tokenCount: 0,
    tokenSamples: [0],
    hasRow: true,
    ...row,
  } as AgentInfo
}

/** The text of the last tasks-list row drawn. */
let drawnRow = ''

/** The engine beneath the plugin: a clock, a file system in memory, and a Bash tool. */
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { WT_SESSION: 'test', OS: 'Windows_NT' })
  const files = new Map<string, string>()

  on('fs.stat', ($, e) => {
    const text = files.get(e.path)

    return text === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })

  on('fs.read', ($, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })

  // What the engine draws when the plugin has nothing to show.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>(engine band)</Text>
  })

  // Claude Code's own drawing of a tasks-list row: its text, as the plugin passed it on.
  on('ui.render', { component: 'AgentRow' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    drawnRow = e.props.label ?? e.props.description

    return <Text>{drawnRow}</Text>
  })

  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    if (e.run_in_background) {
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: BACKGROUND_TEXT }
    }

    await clock.sleep(e.timeout ?? 0)

    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
  })

  return { clock, files }
}

function notification(status: string, exitCode: number): SessionAppendInput {
  return {
    door: 'delivery',
    origin: { kind: 'task-notification' },
    uuid: `n-${status}`,
    message: {
      type: 'user',
      role: 'user',
      isMeta: true,
      content: [
        {
          type: 'text',
          text: `<task-notification>\n<task-id>b1</task-id>\n<output-file>${OUTPUT}</output-file>\n<status>${status}</status>\n<summary>Background command "Train" ${status} (exit code ${exitCode})</summary>\n</task-notification>`,
        },
      ],
    },
  }
}

async function texts(ui: { findAll: (q: { type: 'Text' }) => Promise<readonly { text?: string }[]> }): Promise<string> {
  return (await ui.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
}

describe('the band', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a background tqdm task draws its bars (${surface})`, async ($, on) => {
      const { clock, files } = world(on)

      await $.tool.call({ tool: 'Bash', command: 'python -u train.py', description: 'Train model', run_in_background: true })
      files.set(
        OUTPUT,
        'Epochs:  40%|████      | 2/5 [01:00<01:30, 30.0s/it]\rBatches:  77%|███████▋  | 77/100 [00:07<00:02, 9.9it/s]',
      )
      await clock.advance(1100)

      const ui = await $.ui.mount({ ...BAND, surface })
      const drawn = await texts(ui)

      expect(drawn).toContain('Train model')
      expect(drawn).toContain('2/5')
      expect(drawn).toContain('└ Batches')
      expect(drawn).toContain('77/100')
      await ui.unmount()
    })
  }

  test('progress follows the output as it grows', async ($, on) => {
    const { clock, files } = world(on)

    await $.tool.call({ tool: 'Bash', command: 'python -u job.py', description: 'Job', run_in_background: true })
    files.set(OUTPUT, '##progress step=1/4 label="Fetch"')
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toContain('1/4')

    files.set(OUTPUT, '##progress step=1/4 label="Fetch"\n##progress step=3/4 label="Index" sub=10/20')
    await clock.advance(1100)

    const later = await texts(ui)

    expect(later).toContain('3/4')
    expect(later).toContain('10/20')
    await ui.unmount()
  })

  test('a task with no progress shows a sweeping bar and its last line', async ($, on) => {
    const { clock, files } = world(on)

    await $.tool.call({ tool: 'Bash', command: 'robocopy a b', description: 'Copy', run_in_background: true })
    files.set(OUTPUT, 'copying a.txt\ncopying b.txt')
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = await texts(ui)

    expect(drawn).toContain('████')
    expect(drawn).toContain('copying b.txt')
    await ui.unmount()
  })

  test('a failure stays with its exit code and error until dismissed', async ($, on) => {
    const { clock, files } = world(on)

    await $.tool.call({ tool: 'Bash', command: 'python index.py', description: 'Index docs', run_in_background: true })
    files.set(OUTPUT, "Traceback (most recent call last):\n  File \"index.py\", line 3\nKeyError: 'path'\n")
    await clock.advance(1100)
    await $.session.append(notification('failed', 1))
    await clock.advance(0)
    await clock.advance(60_000)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = await texts(ui)

    expect(drawn).toContain('✗')
    expect(drawn).toContain("exit code 1 · KeyError: 'path'")

    await ui.press({ key: 'dismiss-b1' })
    expect(await texts(ui)).not.toContain('Index docs')
    await ui.unmount()
  })

  test('a non-zero exit code is a failure even when the status says completed', async ($, on) => {
    const { clock, files } = world(on)

    await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build', run_in_background: true })
    files.set(OUTPUT, 'make: *** [all] Error 2')
    await clock.advance(1100)
    await $.session.append(notification('completed', 2))
    await clock.advance(0)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toContain('exit code 2')
    await ui.unmount()
  })

  test('a success shows a tick, then leaves the band', async ($, on) => {
    const { clock, files } = world(on)

    await $.tool.call({ tool: 'Bash', command: 'python ok.py', description: 'Quick job', run_in_background: true })
    files.set(OUTPUT, 'done')
    await clock.advance(1100)
    await $.session.append(notification('completed', 0))
    await clock.advance(0)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toContain('✓')

    await clock.advance(10_000)
    expect(await texts(ui)).not.toContain('Quick job')
    await ui.unmount()
  })

  test('a task that stops writing is flagged as silent', async ($, on) => {
    const { clock, files } = world(on)

    await $.tool.call({ tool: 'Bash', command: 'python hang.py', description: 'Hangs', run_in_background: true })
    files.set(OUTPUT, 'Load:  10%|█         | 1/10 [00:01<00:09]')
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).not.toContain('no output for')

    await clock.advance(65_000)
    expect(await texts(ui)).toContain('! no output for 01:0')
    await ui.unmount()
  })

  test('a declared failure (##progress done=fail) ends the task without a notification', async ($, on) => {
    const { clock, files } = world(on)

    await $.tool.call({ tool: 'Bash', command: 'node server.js', description: 'Server warmup', run_in_background: true })
    files.set(OUTPUT, '##progress step=1/2\n##progress done=fail msg="port 8080 in use"')
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toContain('port 8080 in use')
    await ui.unmount()
  })

  test('a quick foreground command never shows; a long one does', async ($, on) => {
    const { clock } = world(on)

    void $.tool.call({ tool: 'Bash', command: 'sleep 10', description: 'Long build', timeout: 10_000 })
    await clock.advance(1000)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).not.toContain('Long build')

    await clock.advance(3000)
    expect(await texts(ui)).toContain('Long build')

    await clock.advance(7000)
    expect(await texts(ui)).not.toContain('Long build')
    await ui.unmount()
  })

  test('many tasks: the band keeps to its rows and counts the rest', async ($, on) => {
    const { clock } = world(on)

    for (let i = 0; i < 8; i++) {
      void $.tool.call({ tool: 'Bash', command: `job ${i}`, description: `Job ${i}`, timeout: 60_000 })
    }

    await clock.advance(4000)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 7 } })

    expect(await texts(ui)).toContain('more · /tqdm')
    await ui.unmount()
  })
})

describe('the footer', () => {
  const HINT = {
    plugin: PLUGIN,
    component: 'PromptHint',
    props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' },
  } as const

  function engineHint(on: On) {
    // The engine's line, with whatever tail the plugins handed it.
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{`${e.props.hint}${e.props.tail ?? ''}`}</Text>
    })
  }

  test('running and failed tasks are summed up after the engine line', { options: { footer: 'tail' } }, async ($, on) => {
    const { clock, files } = world(on)

    engineHint(on)
    await $.tool.call({ tool: 'Bash', command: 'python -u t.py', description: 'Train', run_in_background: true })
    files.set(OUTPUT, 'Train:  43%|████▎     | 43/100 [00:05<00:06]')
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    const line = await texts(ui)

    expect(line).toContain('esc to interrupt')
    expect(line).toContain('Train 43%')

    await $.session.append(notification('failed', 1))

    await clock.advance(0)
    expect(await texts(ui)).toContain('✗ Train')
    await ui.unmount()
  })

  test('nothing to sum up: the line is the engine one alone', async ($, on) => {
    world(on)
    engineHint(on)

    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })

    expect(await texts(ui)).toBe('esc to interrupt')
    await ui.unmount()
  })

  test('footer=false leaves the line alone', { options: { footer: false } }, async ($, on) => {
    const { clock, files } = world(on)

    engineHint(on)
    await $.tool.call({ tool: 'Bash', command: 'x', description: 'Train', run_in_background: true })
    files.set(OUTPUT, 'working')
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })

    expect(await texts(ui)).toBe('esc to interrupt')
    await ui.unmount()
  })
})

describe('subagents', () => {
  test('a subagent from the tasks list is followed until it ends', async ($, on) => {
    const { clock } = world(on)
    let status: AgentStatus = 'running'

    on('agent.list', () => ({
      value: [
        agent({ id: 'a1', description: 'Research tqdm internals', type: 'general-purpose', status }),
        agent({ id: 'old', description: 'Finished long ago', type: 'Explore', status: 'completed' }),
        agent({ id: 't1', teammateId: 'bob@team', description: 'Teammate', type: 'teammate', status: 'idle' }),
      ],
    }))
    void $.tool.call({ tool: 'Bash', command: 'true', description: 'kick' })
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = await texts(ui)

    expect(drawn).toContain('Research tqdm internals')
    expect(drawn).not.toContain('Finished long ago')
    expect(drawn).not.toContain('Teammate')

    status = 'failed'
    await clock.advance(1100)
    expect(await texts(ui)).toContain('✗')
    await ui.unmount()
  })

  test('agents=false follows no subagent', { options: { agents: false } }, async ($, on) => {
    const { clock } = world(on)

    on('agent.list', () => ({ value: [agent({ id: 'a1', description: 'Research', type: 'general-purpose', status: 'running' })] }))
    void $.tool.call({ tool: 'Bash', command: 'true', description: 'kick' })
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).not.toContain('Research')
    await ui.unmount()
  })
})

describe('subagents, as the tasks list describes them', () => {
  test('the line under the title says what the agent is doing now, and its tokens', async ($, on) => {
    const { clock } = world(on)
    let row = agent({ id: 'a1', description: 'Research tqdm internals', type: 'Explore', status: 'running' })

    on('agent.list', () => ({ value: [row] }))
    void $.tool.call({ tool: 'Bash', command: 'true', description: 'kick' })
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    // No summary yet: the tasks list's label is the description, so the type is shown.
    expect(await texts(ui)).toContain('Explore')

    row = { ...row, label: 'Reading tqdm/std.py', tokenCount: 12_400 }
    await clock.advance(1100)

    const drawn = await texts(ui)

    expect(drawn).toContain('Research tqdm internals')
    expect(drawn).toContain('Reading tqdm/std.py · 12.4k tokens')

    row = { ...row, status: 'waiting' }
    await clock.advance(1100)
    expect(await texts(ui)).toContain('waiting · Reading tqdm/std.py')
    await ui.unmount()
  })

  test('an agent started before the mod saw it is timed from its own start', async ($, on) => {
    const { clock } = world(on)

    on('agent.list', () => ({
      value: [agent({ id: 'a1', description: 'Long research', type: 'Explore', status: 'running', startTime: 1_000_000 - 125_000 })],
    }))
    void $.tool.call({ tool: 'Bash', command: 'true', description: 'kick' })
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toContain('02:06')
    await ui.unmount()
  })
})

const PROGRESS = 'mcp__tqdm-claude__progress'

/** A tasks-list row as Claude Code asks for it, and what reached the bottom of the chain: Claude Code's own drawing. */
type Mounter = { ui: { mount(target: never): Promise<{ unmount(): Promise<void> }> } }

async function agentRow($: Mounter, row: AgentInfo): Promise<string> {
  drawnRow = ''

  const ui = await $.ui.mount({
    surface: 'terminal',
    plugin: PLUGIN,
    component: 'AgentRow',
    props: { ...row, columns: 120, isHidden: false },
  } as never)

  await ui.unmount()

  return drawnRow
}

describe('steps an agent reports', () => {
  test('the main conversation: a bar of its own in the band, done when the turn ends', async ($, on) => {
    const { clock } = world(on)

    const ran = await $.tool.call({ tool: PROGRESS, step: 2, total: 5, label: 'Running the tests' })

    expect(JSON.stringify(ran)).toContain('Shown.')
    await clock.advance(300)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = await texts(ui)

    expect(drawn).toContain('main')
    expect(drawn).toContain('2/5')
    expect(drawn).toContain('Running the tests')

    await $.turn.complete({ turnId: 't1', answer: 'done' } as Parameters<typeof $.turn.complete>[0]).catch(() => undefined)
    await clock.advance(300)
    expect(await texts(ui)).toContain('✓')
    await ui.unmount()
  })

  test('a call with nothing to show is refused, and says why', async ($, on) => {
    world(on)

    const ran = await $.tool.call({ tool: PROGRESS, total: 5 })

    expect(JSON.stringify(ran)).toContain('give at least')
  })

  test("a subagent: its step goes after Claude Code's text on its row, and in the band", async ($, on) => {
    const { clock } = world(on)
    const row = agent({ id: 'a1', description: 'Port the parser', type: 'general-purpose', status: 'running', label: 'Editing parse.ts' })

    on('agent.list', () => ({ value: [row] }))
    void $.tool.call({ tool: 'Bash', command: 'true', description: 'kick' })
    await clock.advance(1100)
    await $.tool.call({ tool: PROGRESS, step: 3, total: 7, label: 'Tests', agentId: 'a1' } as Parameters<typeof $.tool.call>[0])
    await clock.advance(300)

    const drawn = await agentRow($, row)

    expect(drawn).toMatch(/^Editing parse\.ts {2}\S+ 3\/7 Tests$/)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toContain('3/7')
    await ui.unmount()
  })

  test('a step reported before the tasks list showed the subagent is kept for it', async ($, on) => {
    const { clock } = world(on)
    const row = agent({ id: 'a2', description: 'Early bird', type: 'Explore', status: 'running' })
    let listed: AgentInfo[] = []

    on('agent.list', () => ({ value: listed }))
    await $.tool.call({ tool: PROGRESS, step: 1, total: 2, label: 'Reading', agentId: 'a2' } as Parameters<typeof $.tool.call>[0])
    listed = [row]
    void $.tool.call({ tool: 'Bash', command: 'true', description: 'kick' })
    await clock.advance(1100)

    expect(await agentRow($, row)).toContain('1/2 Reading')
  })

  test("a subagent's command: no row of its own, its bar on the subagent's row, gone with the subagent", async ($, on) => {
    const { clock, files } = world(on)
    let row = agent({ id: 'a1', description: 'Train', type: 'general-purpose', status: 'running' })

    on('agent.list', () => ({ value: [row] }))
    await $.tool.call({
      tool: 'Bash',
      command: 'python -u train.py',
      description: 'Fine-tune',
      run_in_background: true,
      agentId: 'a1',
    } as Parameters<typeof $.tool.call>[0])
    files.set(OUTPUT, 'Epochs:  40%|████      | 2/5 [01:00<01:30, 30.0s/it]')
    await clock.advance(1100)

    expect(await agentRow($, row)).toContain('Epochs 40%')

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = await texts(ui)

    // Shown under the subagent, never as a task of its own.
    expect(drawn).not.toContain('Fine-tune')
    expect(drawn).toContain('Epochs')

    row = { ...row, status: 'completed' }
    await clock.advance(1100)
    expect(await texts(ui)).not.toContain('Epochs')
    await ui.unmount()
  })

  test('a row with nothing reported is left as Claude Code draws it', async ($, on) => {
    const { clock } = world(on)
    const row = agent({ id: 'a1', description: 'Quiet', type: 'Explore', status: 'running', label: 'Reading files' })

    on('agent.list', () => ({ value: [row] }))
    void $.tool.call({ tool: 'Bash', command: 'true', description: 'kick' })
    await clock.advance(1100)

    expect(await agentRow($, row)).toBe('Reading files')
  })
})

describe('large logs', () => {
  const BIG = 'x'.repeat(4 * 1024 * 1024 + 10)
  const TAIL = 'Train:  42%|████▏     | 420/1000 [00:10<00:14, 41.2it/s]'

  test('past 4 MiB, the last 64 KiB are read by a process and the bars still drawn', async ($, on) => {
    const { clock, files } = world(on)
    const runs: string[][] = []

    on('process.run', ($, e) => {
      runs.push([...e.argv])

      // PowerShell prints the file's bytes in base64: UTF-8 here, as tqdm writes it.
      return { value: { exitCode: 0, stdout: btoa(String.fromCharCode(...new TextEncoder().encode(TAIL))), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await $.tool.call({ tool: 'Bash', command: 'python -u train.py', description: 'Train', run_in_background: true })
    files.set(OUTPUT, BIG)
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = await texts(ui)

    expect(runs[0]?.[0]).toBe('powershell')
    expect(drawn).toContain('420/1000')
    expect(drawn).not.toContain('too large')
    await ui.unmount()
  })

  test('when no process can read it, the band says the log is too large', async ($, on) => {
    const { clock, files } = world(on)

    on('process.run', () => ({ deny: 'no processes here' }))
    await $.tool.call({ tool: 'Bash', command: 'python -u train.py', description: 'Train', run_in_background: true })
    files.set(OUTPUT, BIG)
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toContain('(log too large to parse)')
    await ui.unmount()
  })
})

describe('glyphs', () => {
  test('charset=ascii draws # and - bars and an ascii spinner', { options: { charset: 'ascii' } }, async ($, on) => {
    const { clock, files } = world(on)

    await $.tool.call({ tool: 'Bash', command: 'python -u t.py', description: 'Train', run_in_background: true })
    files.set(OUTPUT, 'Train:  50%|#####     | 50/100 [00:05<00:05]')
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = await texts(ui)

    expect(drawn).toContain('#####')
    expect(drawn).not.toContain('█')
    expect(drawn).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    await ui.unmount()
  })

  test('Windows with no terminal variable at all still draws unicode', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.env(on, { OS: 'Windows_NT' })
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>(engine band)</Text>
    })
    on('tool.call', { tool: 'Bash' }, async ($, e) => {
      await clock.sleep(10_000)

      return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
    })

    void $.tool.call({ tool: 'Bash', command: 'build', description: 'Build' })
    await clock.advance(4000)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    await ui.unmount()
  })

  test('charset=blocks keeps to code page 437', { options: { charset: 'blocks' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.env(on, {})
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>(engine band)</Text>
    })
    on('tool.call', { tool: 'Bash' }, async ($, e) => {
      await clock.sleep(10_000)

      return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
    })

    void $.tool.call({ tool: 'Bash', command: 'build', description: 'Build' })
    await clock.advance(4000)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = await texts(ui)

    expect(drawn).toContain('█')
    expect(drawn).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏▏▎▍▌▋▊▉]/)
    await ui.unmount()
  })
})

describe('the model is told the protocol', () => {
  test('a section is added to the system prompt', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))

    const composed = await $.prompt.compose({
      model: 'claude-opus-5-5',
      promptModel: 'claude-opus-5-5',
      surfaces: ['terminal'],
      tools: ['Bash'],
      outputStyle: null,
      traits: [],
    })
    const section = composed.sections.find(one => one.id === 'tqdm-claude:protocol')

    expect(section?.text).toContain('##progress step=')
    expect(section?.scope).toBe('session')
  })
})
