import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { Activity, Track } from '../types'
import { CHARSETS, type CharsetEnv, chooseCharset } from './charset'
import { backgroundOf, notificationsOf, parse } from './parse'
import {
  barParts,
  cells,
  clip,
  duration,
  endNotice,
  failureOf,
  fractionOf,
  glyph,
  hasDetailRow,
  hasMainRow,
  isShortOfTotal,
  isStalled,
  type NotifyMode,
  ordered,
  receiptOf,
  rowsOf,
  silentStartHint,
  modeLabelOf,
  summaryOf,
  timing,
} from './render'

const tracks = atom({ plugin: 'tqdm-claude', key: 'tracks' } as const, [])
const clock = atom({ plugin: 'tqdm-claude', key: 'now' } as const, 0)
/** The clock to the second: the footer redraws once a second, not at the band's frame rate. */
const second = atom({ plugin: 'tqdm-claude', key: 'second' } as const, 0)
const activity = atom({ plugin: 'tqdm-claude', key: 'activity' } as const, { isTurnRunning: false, lastAt: 0, runningTools: 0 })

const POLL_MS = 1000
/** A redraw of the band costs real time (#91870 measured 150–190 ms): four frames a second is enough. */
const FRAME_MS = 250
/** An output this large is read every few seconds only: each read copies all of it. */
const LARGE_OUTPUT_BYTES = 256 * 1024
const LARGE_OUTPUT_EVERY_MS = 5000
/** Endings this close together are told of in one notification. */
const NOTIFY_BATCH_MS = 1500
/** A foreground call shows once it has run this long: quick commands never flicker the band. */
const FOREGROUND_AFTER_MS = 3000
/** A task that ended well leaves the band after this long; a failed one stays until dismissed. */
const DONE_LINGER_MS = 8000
/** A turn with no tool call starting or ending for this long may be stuck. A guess, said as one. */
const STUCK_MS = 3 * 60_000
/** `$.fs.read` refuses past 4 MiB. */
const MAX_READ_BYTES = 4 * 1024 * 1024 - 1024
const MAX_TRACKS = 20

const PROTOCOL_SECTION = {
  id: 'tqdm-claude:protocol',
  scope: 'session',
  text: [
    '# Long-running commands (tqdm-claude)',
    'The person sees a live progress band above the prompt for every background Bash/PowerShell task: it reads the task\'s output file, parses tqdm bars, and shows crashes and stalls.',
    '- Run anything expected to take more than ~30 seconds with run_in_background, and give it a short `description`: it is the band\'s title.',
    '- Make output unbuffered so progress reaches the file: `python -u` or PYTHONUNBUFFERED=1, `print(..., flush=True)`, `stdbuf -oL` for other tools.',
    '- In scripts you write, report progress with one line per update: `##progress step=3/7 label="Training" sub=1840/2400 sublabel="Epoch 3"` (`sub=1840` with no total when unknown; `pct=45` for a bare percentage; `ok=12 fail=2` to count outcomes; `msg="..."` for a status; `done=ok` or `done=fail` when a long-lived process finished its work). tqdm output needs nothing extra.',
    '- Do not poll a background task\'s output file or sleep to wait for it: the band shows its progress to the person, and you are notified when it ends.',
    '- When a background task ends, report its exit code; never take silence for success.',
  ].join('\n'),
} as const

type ShellInput = {
  tool_use_id: string
  command: string
  description?: string
  run_in_background?: boolean
}

type ShellResult = { deny?: string; isError?: true; text?: string; result?: unknown }

type Patch = Partial<Track>

let timers: { cancel(): void }[] | undefined
/** A tick that finds the last one still running skips: two polls must not end a task twice. */
let isPolling = false
let isAnimating = false
let pending: { title: string; text: string }[] = []
let env: CharsetEnv | undefined

/**
 * The session's tasks folder, where Claude Code writes every shell call's
 * output as it runs, foreground calls included (checked live: a foreground
 * command's `b????????.output` grows line by line). Learned from a background
 * call's or a subagent's output path, else found from the session's id.
 */
let tasksDir: string | undefined
let sessionInfo: { id: string; cwd: string } | undefined
/** Foreground calls waiting for their output file: the folder's files before each started. */
const pendingForeground = new Map<string, { dir: string; before: Set<string> }>()
/** A shell call's output file: `b` and eight characters. A subagent's transcript is named otherwise. */
const SHELL_OUTPUT = /^b[a-z0-9]{8}\.output$/

function folderOf(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, '')
}

function learnTasksDir(outputFile: string | undefined): void {
  if (outputFile && !tasksDir) {
    tasksDir = folderOf(outputFile)
  }
}

/** The tasks folder: learned, or found under the temporary folder, as `<tmp>/claude…/<cwd slug>/<session>/tasks`. */
async function findTasksDir($: EngineInterface): Promise<string | undefined> {
  if (tasksDir || !sessionInfo) {
    return tasksDir
  }

  const slug = sessionInfo.cwd.replace(/[^A-Za-z0-9]/g, '-')
  const roots = [await $.env.get('TMPDIR'), await $.env.get('TEMP'), await $.env.get('TMP'), '/tmp'].filter(
    (root): root is string => Boolean(root),
  )

  for (const root of roots) {
    let entries: Awaited<ReturnType<typeof $.fs.list>>

    try {
      entries = await $.fs.list(root)
    } catch {
      continue
    }

    for (const entry of entries.filter(one => one.kind === 'dir' && one.name.startsWith('claude'))) {
      const candidate = `${root}/${entry.name}/${slug}/${sessionInfo.id}/tasks`

      try {
        if ((await $.fs.stat(candidate)).kind === 'dir') {
          tasksDir = candidate

          return tasksDir
        }
      } catch {
        // Not this one.
      }
    }
  }

  return undefined
}

/** Shell output files in the tasks folder now. */
async function shellOutputs($: EngineInterface, dir: string): Promise<Set<string>> {
  try {
    return new Set((await $.fs.list(dir)).filter(one => SHELL_OUTPUT.test(one.name)).map(one => one.name))
  } catch {
    return new Set()
  }
}

/**
 * Gives each running foreground call the output file that appeared after it
 * started and that no other task holds, oldest first: two calls started
 * together may swap files, never share one.
 */
async function claimForegroundOutputs($: EngineInterface, list: readonly Track[]): Promise<Map<string, Patch>> {
  const patches = new Map<string, Patch>()
  // By file name: the engine spells the folder with `\` on Windows where a path was joined with `/`.
  const held = new Set(list.map(one => one.outputFile?.split(/[\\/]/).pop()).filter((name): name is string => Boolean(name)))
  const waiting = list
    .filter(one => one.kind === 'fg' && one.status === 'running' && !one.outputFile && pendingForeground.has(one.id))
    .sort((a, b) => a.startedAt - b.startedAt)

  for (const track of waiting) {
    const pending = pendingForeground.get(track.id)

    if (!pending) {
      continue
    }

    const now = await shellOutputs($, pending.dir)
    const fresh = [...now].find(name => !pending.before.has(name) && !held.has(name))

    if (fresh) {
      held.add(fresh)
      patches.set(track.id, { outputFile: `${pending.dir}/${fresh}`, size: -1 })
      pendingForeground.delete(track.id)
    }
  }

  return patches
}
/** The person's options, set as the module registers. */
let notifyMode: NotifyMode = 'failures'
let isFollowingAgents = true

/** The variables the charset is chosen from, read once per load (names must be literals). */
async function loadEnv($: EngineInterface): Promise<CharsetEnv> {
  env ??= {
    LC_ALL: await $.env.get('LC_ALL'),
    LC_CTYPE: await $.env.get('LC_CTYPE'),
    LANG: await $.env.get('LANG'),
  }

  return env
}

function labelOf(e: ShellInput): string {
  const text = e.description?.trim() || (e.command.trim().split(/\r?\n/)[0] ?? '')

  return clip(text, 80)
}

function upsert(list: readonly Track[], track: Track): Track[] {
  return [...list.filter(one => one.id !== track.id), track].slice(-MAX_TRACKS)
}

function patchAll(list: readonly Track[], patches: Map<string, Patch>, removed: Set<string>): Track[] {
  return list
    .filter(one => !removed.has(one.id))
    .map(one => (patches.has(one.id) ? { ...one, ...patches.get(one.id) } : one))
}

/**
 * Tells the person of a task's end by their own notification channel, where it
 * is worth it. Endings that come together (a batch of jobs failing at once)
 * are told of in one notification: nothing else limits how often one is sent.
 */
async function tell($: EngineInterface, track: Track | undefined): Promise<void> {
  const notice = track ? endNotice(track, notifyMode) : undefined

  if (!notice) {
    return
  }

  pending.push(notice)

  if (pending.length === 1) {
    $.clock.after(NOTIFY_BATCH_MS, () => void flush($))
  }
}

async function flush($: EngineInterface): Promise<void> {
  const batch = pending

  pending = []

  if (batch.length === 1 && batch[0]) {
    await $.ui.notify(batch[0].text, { title: batch[0].title }).catch(() => undefined)
  } else if (batch.length > 1) {
    const failed = batch.filter(one => one.title === 'Task failed').length
    const title = failed === batch.length ? `${failed} tasks failed` : `${batch.length} tasks ended`

    await $.ui.notify(batch.map(one => one.text.split(' · ')[0]).join(', '), { title }).catch(() => undefined)
  }
}

/** Reads a task's output again when it grew; undefined when nothing changed. */
async function refresh($: EngineInterface, track: Track, now: number): Promise<Patch | undefined> {
  if (!track.outputFile) {
    return undefined
  }

  let size: number

  try {
    size = (await $.fs.stat(track.outputFile)).size
  } catch {
    return undefined
  }

  if (size === track.size) {
    return undefined
  }

  // A large output grows while it is read in whole: read it less often (it still counts as output).
  if (size > LARGE_OUTPUT_BYTES && track.size > 0 && now - track.lastChangeAt < LARGE_OUTPUT_EVERY_MS) {
    return undefined
  }

  if (size > MAX_READ_BYTES) {
    return { size, lastChangeAt: now, isTooBig: true }
  }

  let text: string

  try {
    text = await $.fs.read(track.outputFile)
  } catch {
    return undefined
  }

  const parsed = parse(text)
  const patch: Patch = {
    size,
    lastChangeAt: now,
    main: parsed.main,
    sub: parsed.sub,
    lastLine: parsed.lastLine,
    error: parsed.error,
    isExact: parsed.isExact,
  }

  const fraction = parsed.main ? fractionOf(parsed.main) : undefined
  const isNewBar = parsed.main?.label !== track.main?.label

  if (fraction !== undefined && (!track.progressFrom || isNewBar)) {
    patch.progressFrom = { at: now, fraction }
    patch.lastSample = { at: now, fraction }
    patch.paceRatio = 1
  } else if (fraction !== undefined && track.lastSample && track.progressFrom && fraction > track.lastSample.fraction) {
    // alive-progress: the recent pace against the average one turns the spinner faster or slower.
    const recent = (fraction - track.lastSample.fraction) / Math.max(1, now - track.lastSample.at)
    const average = (fraction - track.progressFrom.fraction) / Math.max(1, now - track.progressFrom.at)

    patch.paceRatio = average > 0 ? Math.min(4, Math.max(0.25, recent / average)) : 1
    patch.lastSample = { at: now, fraction }
  }

  if (parsed.declared && track.status === 'running') {
    patch.status = parsed.declared === 'ok' ? 'done' : 'failed'
    patch.endedAt = now
  }

  return patch
}

const AGENT_ENDED: Partial<Record<AgentInfo['status'], Track['status']>> = {
  completed: 'done',
  failed: 'failed',
  killed: 'killed',
}

/**
 * Mirrors the tasks list's subagents: one seen running is followed until it
 * ends; one already ended when first seen is history, never shown. A
 * teammate idles between turns and is left to the team's own view.
 */
async function syncAgents($: EngineInterface): Promise<void> {
  let agents: AgentInfo[]

  try {
    agents = await $.agent.list()
  } catch {
    return
  }

  const now = await $.clock.now()
  const ended: string[] = []

  await update($, tracks, list => {
    let next = [...list]

    ended.length = 0

    for (const agent of agents) {
      if (agent.teammateId !== undefined) {
        continue
      }

      const id = `agent:${agent.id}`
      const known = next.find(one => one.id === id)
      const end = AGENT_ENDED[agent.status]

      if (!known && !end) {
        next = upsert(next, {
          id,
          label: clip(agent.description || agent.type, 80),
          kind: 'agent',
          startedAt: now,
          status: 'running',
          lastChangeAt: now,
          size: 0,
          lastLine: agent.type,
        })
      } else if (known && known.status === 'running' && end) {
        next = next.map(one => (one.id === id ? { ...one, status: end, endedAt: now } : one))
        ended.push(id)
      }
    }

    // One the list no longer holds has ended: its timer must not run on (claude-code #99613).
    const listed = new Set(agents.map(agent => `agent:${agent.id}`))

    next = next.map(one => {
      if (one.kind === 'agent' && one.status === 'running' && !listed.has(one.id)) {
        ended.push(one.id)

        return { ...one, status: 'done', endedAt: now }
      }

      return one
    })

    return next
  })

  if (ended.length > 0) {
    const list = await read($, tracks)

    for (const id of ended) {
      await tell($, list.find(one => one.id === id))
    }
  }
}

async function poll($: EngineInterface): Promise<void> {
  if (isFollowingAgents) {
    await syncAgents($)
  }

  const list = await read($, tracks)

  if (list.length === 0) {
    return
  }

  const now = await $.clock.now()
  const patches = await claimForegroundOutputs($, list)
  const removed = new Set<string>()
  const declared: string[] = []

  for (const track of list.map(one => (patches.has(one.id) ? { ...one, ...patches.get(one.id) } : one))) {
    if (track.status === 'done' && !isShortOfTotal(track) && now - (track.endedAt ?? now) > DONE_LINGER_MS) {
      removed.add(track.id)
    } else if (track.status === 'running' && track.kind !== 'agent' && track.outputFile) {
      const patch = await refresh($, track, now)

      if (patch) {
        patches.set(track.id, { ...patches.get(track.id), ...patch })

        if (patch.status) {
          declared.push(track.id)
        }
      }
    }
  }

  if (patches.size > 0 || removed.size > 0) {
    await update($, tracks, current => patchAll(current, patches, removed))
  }

  if (declared.length > 0) {
    const current = await read($, tracks)

    for (const id of declared) {
      await tell($, current.find(one => one.id === id))
    }
  }
}

function isShown(track: Track, now: number): boolean {
  return track.kind !== 'fg' || now - track.startedAt >= FOREGROUND_AFTER_MS
}

function isStuck(state: Activity, now: number): boolean {
  return state.isTurnRunning && state.runningTools === 0 && state.lastAt > 0 && now - state.lastAt > STUCK_MS
}

async function animate($: EngineInterface): Promise<void> {
  const list = await read($, tracks)
  const now = await $.clock.now()
  const last = await read($, clock)
  const isMoving = list.some(track => track.status === 'running' && isShown(track, now))

  if (isMoving) {
    await update($, clock, () => now)
  } else if ((list.length > 0 || (await read($, activity)).isTurnRunning) && last < now - POLL_MS) {
    // Nothing moves, but finished tracks age out and a quiet turn's time goes on.
    await update($, clock, () => now)
  }

  const whole = Math.floor(now / 1000) * 1000

  if ((isMoving || list.length > 0) && (await read($, second)) !== whole) {
    await update($, second, () => whole)
  }
}

/** Runs `work` unless the last run of it is still going. */
function once(isRunning: () => boolean, setRunning: (value: boolean) => void, work: () => Promise<void>): void {
  if (isRunning()) {
    return
  }

  setRunning(true)
  void work()
    .catch(() => undefined)
    .finally(() => setRunning(false))
}

function startTimers($: EngineInterface): void {
  if (timers) {
    return
  }

  timers = [
    $.clock.every(POLL_MS, () => once(() => isPolling, value => (isPolling = value), () => poll($))),
    $.clock.every(FRAME_MS, () => once(() => isAnimating, value => (isAnimating = value), () => animate($))),
  ]
}

/**
 * Ends a task. The notification is the word that counts: it ends a running
 * task and corrects one a turn's end had ended unconfirmed. A later word on
 * a task already ended is ignored, so it is told of once.
 */
async function settle($: EngineInterface, taskId: string, status: string, exitCode: number | undefined, isUnconfirmed = false) {
  const list = await read($, tracks)
  const track = list.find(one => one.id === taskId)

  if (!track || (track.status !== 'running' && !track.isUnconfirmed) || (isUnconfirmed && track.status !== 'running')) {
    return
  }

  const now = await $.clock.now()
  // One last read: the final bars and, on a failure, the error line.
  const last = (await refresh($, { ...track, size: -1 }, now)) ?? {}
  const ended: Track['status'] =
    status === 'killed' || status === 'stopped'
      ? 'killed'
      : status === 'failed' || (exitCode !== undefined && exitCode !== 0)
        ? 'failed'
        : 'done'
  const patch: Patch = {
    ...last,
    lastChangeAt: now,
    status: ended,
    exitCode,
    endedAt: track.isUnconfirmed ? track.endedAt : now,
    isUnconfirmed,
  }

  await update($, tracks, current => patchAll(current, new Map([[taskId, patch]]), new Set()))
  await tell($, { ...track, ...patch })
}

async function followShell<R extends ShellResult>(
  $: EngineInterface,
  e: ShellInput,
  run: () => Promise<R>,
): Promise<R> {
  const startedAt = await $.clock.now()
  const label = labelOf(e)
  const isBackground = e.run_in_background === true

  if (!isBackground) {
    const dir = await findTasksDir($)

    // The files there before this call started: its own is the one that appears next.
    if (dir) {
      pendingForeground.set(e.tool_use_id, { dir, before: await shellOutputs($, dir) })
    }

    await update($, tracks, list =>
      upsert(list, { id: e.tool_use_id, label, kind: 'fg', startedAt, status: 'running', lastChangeAt: startedAt, size: 0 }),
    )
  }

  let ran: R

  try {
    ran = await run()
  } finally {
    pendingForeground.delete(e.tool_use_id)
  }
  const isAnswered = ran.deny === undefined && ran.isError !== true
  const record = isAnswered ? (ran.result as { backgroundTaskId?: string; backgroundOutputPath?: string } | undefined) : undefined
  const background = isAnswered ? backgroundOf(ran.text, record ?? undefined) : undefined
  const now = await $.clock.now()

  learnTasksDir(background?.outputFile)

  await update($, tracks, list => {
    const rest = list.filter(one => one.id !== e.tool_use_id)

    return background
      ? upsert(rest, {
          id: background.taskId,
          label,
          kind: 'bg',
          outputFile: background.outputFile,
          startedAt,
          status: 'running',
          lastChangeAt: now,
          size: -1,
        })
      : rest
  })

  return ran
}

/**
 * Counts running tool calls. The state is written only when the count leaves
 * or reaches zero, the moments the stuck-turn guess turns on: a write per call
 * would redraw the band on every tool call of every kind.
 */
let runningTools = 0

async function touch($: EngineInterface, change: number): Promise<void> {
  const before = runningTools

  runningTools = Math.max(0, runningTools + change)

  if ((before === 0) !== (runningTools === 0)) {
    const now = await $.clock.now()
    const count = runningTools

    await update($, activity, state => ({ ...state, lastAt: now, runningTools: count }))
  }
}

export const register: Register = (on, options) => {
  const charset = typeof options.charset === 'string' ? options.charset : 'auto'
  // Where the footer summary goes: the mode labels right of the hint line (never cut), the hint line's
  // tail (cut where the line runs out), both, or nowhere. A boolean is the option's earlier form.
  const footer = options.footer === false || options.footer === 'off' ? 'off' : options.footer === 'tail' || options.footer === 'both' ? options.footer : 'mode'
  const isWarningStuck = options.stuck !== false

  notifyMode = options.notify === 'always' || options.notify === 'off' ? options.notify : 'failures'
  isFollowingAgents = options.agents !== false

  on('session.start', async ($, e, next) => {
    startTimers($)
    await loadEnv($)

    try {
      // Last, as registering a name another plugin holds throws.
      await $.command.register({
        name: 'tqdm',
        description: 'Task progress band: `/tqdm` lists tasks, `/tqdm clear` drops finished ones',
      })
    } catch {
      // The band works without its command.
    }

    return next(e)
  })

  on('command.run', { command: 'tqdm' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, tracks, list => list.filter(one => one.status === 'running'))

      return { text: 'Cleared finished tasks from the progress band.' }
    }

    const list = await read($, tracks)
    const now = await $.clock.now()

    if (list.length === 0) {
      return { text: 'No task is followed.' }
    }

    return {
      text: ordered(list)
        .map(one => `${glyph(one, now)} ${one.label} (${one.status}, ${timing(one, now)})${one.outputFile ? ` ${one.outputFile}` : ''}`)
        .join('\n'),
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    // `--bare` asks for the bare prompt: no section of a plugin's in it.
    if (e.traits.includes('bare')) {
      return composed
    }

    return { sections: [...composed.sections.filter(one => one.id !== PROTOCOL_SECTION.id), PROTOCOL_SECTION] }
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()

    runningTools = 0
    await update($, activity, () => ({ isTurnRunning: true, lastAt: now, runningTools: 0 }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    runningTools = 0
    await update($, activity, state => ({ ...state, isTurnRunning: false, runningTools: 0 }))

    return next(e)
  }).catch(($, e, next) => next(e))

  // Every tool call, for the stuck-turn guess: while one runs, the turn is waiting, not stuck.
  on('tool.call', async ($, e, next) => {
    if (!isWarningStuck) {
      return next(e)
    }

    await touch($, 1)

    try {
      return await next(e)
    } finally {
      await touch($, -1)
    }
  }).catch(($, e, next) => next(e))

  // A subagent's own commands are its business: the subagent is followed as one task, with its time and end.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    startTimers($)

    return e.agentId === undefined ? followShell($, e, () => next(e)) : next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'PowerShell' }, ($, e, next) => {
    startTimers($)

    return e.agentId === undefined ? followShell($, e, () => next(e)) : next(e)
  }).catch(($, e, next) => next(e))

  // A subagent starting is the moment to begin polling the tasks list.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    startTimers($)

    const ran = await next(e)
    // A subagent's output file sits in the session's tasks folder, the one foreground calls write to.
    const launched = ran.isError !== true && ran.deny === undefined ? (ran.result as { outputFile?: unknown } | undefined) : undefined

    learnTasksDir(typeof launched?.outputFile === 'string' ? launched.outputFile : undefined)

    return ran
  }).catch(($, e, next) => next(e))

  // A task Claude stopped has ended now, whatever its notification says later.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id

    if (id && ran.deny === undefined && ran.isError !== true) {
      await settle($, id, 'killed', undefined)
      await settle($, `agent:${id}`, 'killed', undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // At a turn's end the session lists the background work still in flight: a task it no
  // longer lists has ended, though its notification has not come yet (the desktop app).
  // The session's id and folder, to find its tasks folder before any background call names it.
  on('classic.SessionStart', async ($, e, next) => {
    sessionInfo = { id: e.session_id, cwd: e.cwd }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    sessionInfo ??= { id: e.session_id, cwd: e.cwd }

    const result = await next(e)
    const inFlight = e.background_tasks?.map(task => task.id)

    if (inFlight) {
      const open = new Set(inFlight)

      // After the hook has answered: the reads and the notification hold up no one.
      $.clock.after(0, () => {
        void (async () => {
          const now = await $.clock.now()

          for (const track of await read($, tracks)) {
            if (track.kind === 'bg' && track.status === 'running' && !open.has(track.id) && now - track.startedAt > 5000) {
              await settle($, track.id, 'completed', undefined, true)
            }
          }
        })().catch(() => undefined)
      })
    }

    return result
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const content = e.message.content as unknown
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map(block => (block && typeof block.text === 'string' ? block.text : '')).join('\n')
          : ''

    if (text.includes('<task-notification>')) {
      const ended = notificationsOf(text)

      // Rows are stored in order: the last read of the output waits until this one is stored.
      $.clock.after(0, () => {
        void (async () => {
          for (const one of ended) {
            await settle($, one.taskId, one.status, one.exitCode)
          }
        })().catch(() => undefined)
      })
    }

    return stored
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    await read($, second)

    if (footer !== 'mode' && footer !== 'both') {
      return next(e)
    }

    const now = await $.clock.now()
    const list = (await read($, tracks)).filter(one => isShown(one, now))
    const label = modeLabelOf(list, now, CHARSETS[chooseCharset(charset, await loadEnv($), e.surface)])

    // Added after the engine's own labels and any other plugin's, never in their place.
    return label ? next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } }) : next(e)
  })
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    await read($, second)

    if (footer !== 'tail' && footer !== 'both') {
      return next(e)
    }

    const now = await $.clock.now()
    const list = (await read($, tracks)).filter(one => isShown(one, now))
    const glyphs = CHARSETS[chooseCharset(charset, await loadEnv($), e.surface)]
    const summary = summaryOf(list, now, glyphs)

    // Added to what another plugin's hook above already put there, never in its place.
    return summary ? next({ ...e, props: { ...e.props, tail: [e.props.tail, `  ${summary}`].filter(Boolean).join('') } }) : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, clock)

    const now = await $.clock.now()
    const list = ordered((await read($, tracks)).filter(one => isShown(one, now)))
    const state = await read($, activity)
    const stuck = isWarningStuck && isStuck(state, now)

    // What the other plugins and the engine draw here stays: the band is drawn above it.
    const below = await next(e)

    if (e.props.hasSurvey || (list.length === 0 && !stuck)) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const glyphs = CHARSETS[chooseCharset(charset, await loadEnv($), e.surface)]
    const width = Math.max(20, e.props.bodyColumns)
    const room = Math.max(2, e.props.maxRows - 1 - (stuck ? 1 : 0))
    const shown: Track[] = []
    let rows = 0

    for (const track of list) {
      if (rows + rowsOf(track) > room && shown.length > 0) {
        break
      }

      shown.push(track)
      rows += rowsOf(track)
    }

    const hidden = list.length - shown.length

    const bar = (track: Track, which: 'main' | 'sub', prefix: string, stalled: boolean) => {
      const parts = barParts(track[which] ?? { n: 0 }, prefix, width, now, glyphs)
      const tone = stalled ? 'warning' : undefined

      return (
        <Text dimColor={which === 'sub' && track.status !== 'running'}>
          {parts.head}
          <Text color={tone}>{parts.done}</Text>
          {parts.failed && <Text color="error">{parts.failed}</Text>}
          {parts.left && <Text color={tone}>{parts.left}</Text>}
          {parts.tail}
        </Text>
      )
    }

    return (
      <Box flexDirection="column">
        {stuck && (
          <Text color="warning">
            {clip(`${glyphs.warning} no tool call for ${duration(now - state.lastAt)} · Claude may be stuck (esc to interrupt)`, width, glyphs.ellipsis)}
          </Text>
        )}
        {shown.map(track => {
          const receipt = track.status === 'done' ? receiptOf(track) : ''
          const time = receipt ? `${timing(track, now)}  ${receipt}` : timing(track, now)
          const stalled = isStalled(track, now)
          const silent = silentStartHint(track, now)
          const warning = stalled ? `  ${glyphs.warning} no output for ${duration(now - track.lastChangeAt)}` : ''
          const tooBig = track.isTooBig && track.status === 'running' ? '  (log too large to parse)' : ''
          const titleRoom = width - time.length - warning.length - tooBig.length - 6
          const color =
            track.status === 'failed' || track.status === 'killed'
              ? 'error'
              : isShortOfTotal(track)
                ? 'warning'
                : track.status === 'done'
                  ? 'success'
                  : 'claude'

          return (
            <Box key={`track-${track.id}`} flexDirection="column">
              <Box flexDirection="row">
                <Text>
                  <Text color={color}>{glyph(track, now, glyphs)}</Text> <Text bold>{clip(track.label, titleRoom, glyphs.ellipsis)}</Text>
                  <Text dimColor>  {time}</Text>
                  {warning && <Text color="warning">{warning}</Text>}
                  {tooBig && <Text dimColor>{tooBig}</Text>}
                </Text>
                {hasDetailRow(track) && (
                  <Button key={`dismiss-${track.id}`} plain label=" [x]" onPress={() => update($, tracks, l => l.filter(one => one.id !== track.id))} />
                )}
              </Box>
              {hasMainRow(track) &&
                (track.main ? (
                  bar(track, 'main', '  ', stalled)
                ) : (
                  <Text>
                    <Text color={stalled ? 'warning' : 'claude'}>{`  ${cells({ n: 0 }, 20, now, glyphs)}`}</Text>
                    {silent ? (
                      <Text color="warning">{`  ${clip(silent, width - 24, glyphs.ellipsis)}`}</Text>
                    ) : (
                      <Text dimColor>{`  ${clip(track.lastLine ?? '', width - 24, glyphs.ellipsis)}`}</Text>
                    )}
                  </Text>
                ))}
              {track.sub && bar(track, 'sub', `  ${glyphs.branch} `, false)}
              {hasDetailRow(track) && (
                <Text color={isShortOfTotal(track) ? 'warning' : 'error'}>{clip(`  ${failureOf(track)}`, width, glyphs.ellipsis)}</Text>
              )}
            </Box>
          )
        })}
        {hidden > 0 && <Text dimColor>  +{hidden} more · /tqdm</Text>}
        {below}
      </Box>
    )
  })
}
