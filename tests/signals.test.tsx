import type { On, SessionAppendInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'tqdm-claude'
const OUTPUT = 'C:\\tmp\\tasks\\b1.output'
const BACKGROUND_TEXT = `Command running in background with ID: b1. Output is being written to: ${OUTPUT}. You will be notified when it completes.`

const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 14, bodyColumns: 90, scroll: { offset: 0, bodyRows: 13 }, view: {} },
} as const

/** The engine beneath: a clock, files in memory, a Bash tool, another plugin's band, and a notification channel. */
function world(on: On, { isNumbering = false } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  let count = 0
  const files = new Map<string, string>()
  const notified: { text: string; title?: string }[] = []

  mock.env(on, {})
  on('fs.stat', ($, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    if (e.run_in_background && isNumbering) {
      count += 1

      return {
        result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `j${count}` },
        text: `Command running in background with ID: j${count}. Output is being written to: C:\\t\\j${count}.output. You will be notified`,
      }
    }

    if (e.run_in_background) {
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: BACKGROUND_TEXT }
    }

    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
  })
  on('tool.call', { tool: 'TaskStop' }, () => ({
    result: { message: 'stopped', task_id: 'b1', task_type: 'local_bash' },
    text: 'stopped',
  }))
  on('ui.notify', ($, e) => {
    notified.push({ text: e.text, title: e.title })

    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  // Another plugin's band, which must still show under ours.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>other plugin band</Text>
  })

  return { clock, files, notified }
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
          text: `<task-notification>\n<task-id>b1</task-id>\n<status>${status}</status>\n<summary>Background command "Job" ${status} (exit code ${exitCode})</summary>\n</task-notification>`,
        },
      ],
    },
  }
}

async function texts(ui: { findAll: (q: { type: 'Text' }) => Promise<readonly { text?: string }[]> }): Promise<string> {
  return (await ui.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
}

async function start($: Parameters<Parameters<typeof test>[1] & (($: never, on: On) => unknown)>[0], files: Map<string, string>, output: string) {
  await ($ as any).tool.call({ tool: 'Bash', command: 'python -u job.py', description: 'Job', run_in_background: true })
  files.set(OUTPUT, output)
}

describe('living with other plugins', () => {
  test('the band is drawn above the band below, never in its place', async ($, on) => {
    const { clock, files } = world(on)

    await start($ as never, files, 'Job:  50%|█████     | 50/100 [00:05<00:05]')
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = await texts(ui)

    expect(drawn).toContain('50/100')
    expect(drawn).toContain('other plugin band')
    expect(drawn.indexOf('50/100')).toBeLessThan(drawn.indexOf('other plugin band'))
    await ui.unmount()
  })

  test('with nothing to show, the band below is drawn alone', async ($, on) => {
    world(on)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toBe('other plugin band')
    await ui.unmount()
  })

  test('the footer summary is added after another plugin\'s tail, not in its place', async ($, on) => {
    const { clock, files } = world(on)

    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{`${e.props.hint}${e.props.tail ?? ''}`}</Text>
    })
    await start($ as never, files, 'Job:  50%|█████     | 50/100 [00:05<00:05]')
    await clock.advance(1100)

    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: true, hint: 'esc to interrupt', tail: '  other tail' },
    })
    const line = await texts(ui)

    expect(line).toContain('other tail')
    expect(line).toContain('Job 50%')
    await ui.unmount()
  })
})

describe('how a task ends', () => {
  test('TaskStop ends it at once, as stopped', async ($, on) => {
    const { clock, files } = world(on)

    await start($ as never, files, 'working')
    await clock.advance(1100)
    await $.tool.call({ tool: 'TaskStop', task_id: 'b1' })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toContain('■')
    await ui.unmount()
  })

  test('a turn\'s end that no longer lists it ends it unconfirmed; the notification then says how', async ($, on) => {
    const { clock, files, notified } = world(on)

    on('classic.Stop', () => ({}))
    await start($ as never, files, 'working')
    await clock.advance(6000)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    await clock.advance(0)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toContain('✓')
    await clock.advance(2000)
    expect(notified).toHaveLength(0)

    await $.session.append(notification('failed', 1))

    await clock.advance(0)
    expect(await texts(ui)).toContain('exit code 1')
    await clock.advance(2000)
    expect(notified).toHaveLength(1)
    await ui.unmount()
  })

  test('a turn\'s end that still lists it leaves it running', async ($, on) => {
    const { clock, files } = world(on)

    on('classic.Stop', () => ({}))
    await start($ as never, files, 'working')
    await clock.advance(6000)
    await $.classic.Stop({
      stop_hook_active: false,
      background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Job' }],
    })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).not.toContain('✓')
    await ui.unmount()
  })
})

describe('notifications', () => {
  test('a failure is told once, through the person\'s channel', async ($, on) => {
    const { clock, files, notified } = world(on)

    await start($ as never, files, "Traceback (most recent call last):\nKeyError: 'path'")
    await clock.advance(1100)
    await $.session.append(notification('failed', 1))
    await clock.advance(0)
    await $.session.append(notification('failed', 1))
    await clock.advance(0)

    await clock.advance(2000)
    expect(notified).toEqual([{ title: 'Task failed', text: "Job · exit code 1 · KeyError: 'path'" }])
  })

  test('a quick success is not worth one', async ($, on) => {
    const { clock, files, notified } = world(on)

    await start($ as never, files, 'done')
    await clock.advance(1100)
    await $.session.append(notification('completed', 0))
    await clock.advance(0)

    await clock.advance(2000)
    expect(notified).toHaveLength(0)
  })

  test('notify=always tells of a long success', { options: { notify: 'always' } }, async ($, on) => {
    const { clock, files, notified } = world(on)

    await start($ as never, files, 'Job: 100%|██████████| 10/10 [01:05<00:00]')
    await clock.advance(65_000)
    await $.session.append(notification('completed', 0))
    await clock.advance(0)

    await clock.advance(2000)
    expect(notified[0]?.title).toBe('Task finished')
    expect(notified[0]?.text).toContain('10/10')
  })

  test('notify=off tells of nothing', { options: { notify: 'off' } }, async ($, on) => {
    const { clock, files, notified } = world(on)

    await start($ as never, files, 'x')
    await clock.advance(1100)
    await $.session.append(notification('failed', 1))
    await clock.advance(0)

    await clock.advance(2000)
    expect(notified).toHaveLength(0)
  })
})

describe('a batch of endings', () => {
  test('tasks failing together are told of in one notification', async ($, on) => {
    // Each background call gets its own id and output file.
    const { clock, files, notified } = world(on, { isNumbering: true })

    for (const name of ['A', 'B', 'C']) {
      await $.tool.call({ tool: 'Bash', command: name, description: `Job ${name}`, run_in_background: true })
    }

    for (const n of [1, 2, 3]) {
      files.set(`C:\\t\\j${n}.output`, 'x')
    }

    await clock.advance(1100)

    for (const n of [1, 2, 3]) {
      const row = notification('failed', 1)
      const block = row.message.content[0] as { type: 'text'; text: string }

      await $.session.append({
        ...row,
        uuid: `n${n}`,
        message: { ...row.message, content: [{ type: 'text', text: block.text.replace('b1', `j${n}`) }] },
      })
    }

    await clock.advance(2000)
    expect(notified).toEqual([{ title: '3 tasks failed', text: 'Job A, Job B, Job C' }])
  })
})

describe('outcomes in two colors', () => {
  test('##progress ok= fail= draws a failed part and counts both', async ($, on) => {
    const { clock, files } = world(on)

    await start($ as never, files, '##progress step=40/100 label="Upload" ok=30 fail=10')
    await clock.advance(1100)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await texts(ui)).toContain('ok 30 fail 10')
    await ui.unmount()
  })
})
