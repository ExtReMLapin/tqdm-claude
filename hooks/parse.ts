import type { Bar, Parsed } from '../types'

/** Only the end of an output is read: progress lives in its last updates. */
const TAIL_CHARS = 64 * 1024

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

const MULTIPLIER: Record<string, number> = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }

// `Epoch 3:  77%|███████▋  | 1840/2400 [00:05<00:01, 312.00it/s]`
const TQDM =
  /^(?:(.*?):\s*)?(\d{1,3})%\|[^|]*\|\s*(\d+(?:\.\d+)?[kKMGT]?)\/(\d+(?:\.\d+)?[kKMGT]?)\s*\[([\d:]+)<([\d:?]+)(?:,\s*([^\]]*))?\]/

// `Scanning: 1840it [00:05, 312.00it/s]` (tqdm without a total)
const TQDM_OPEN =
  /^(?:(.*?):\s*)?(\d+(?:\.\d+)?[kKMGT]?)([A-Za-z]+)\s*\[(\d+:\d\d(?::\d\d)?)(?:,\s*([^\]]*))?\]/

// `##progress step=3/7 label="Train" sub=1840/2400 sublabel="Epoch 3"`
const PROTOCOL = /^##progress\b(.*)$/
const PAIR = /(\w+)=(?:"([^"]*)"|(\S+))/g

const ERROR =
  /Traceback \(most recent call last\)|\b(?:[A-Z]\w*)?(?:Error|Exception)\b|\bFATAL\b|\b[Ff]atal error\b|^(?:error|ERROR)(?:\[[\w-]+\])?:|\bKilled\b|^panic:|Segmentation fault|command not found|No such file or directory|Permission denied|is not recognized as/

// The line Claude Code appends to a background task's output when it ends: no output of the task's own.
const EXIT_TRAILER = /^\[exited with code -?\d+\]$/

const PERCENT = /(\d{1,3}(?:\.\d+)?)\s?%/g

/** `1.84k` → 1840; NaN when it is no number. */
export function toNumber(text: string): number {
  const match = /^(\d+(?:\.\d+)?)([kKMGT]?)$/.exec(text.trim())

  return match ? parseFloat(match[1] ?? '') * (MULTIPLIER[match[2] ?? ''] ?? 1) : NaN
}

/** `3/7` or `3` → `{ n, total }`; undefined when it is neither. */
function fraction(text: string): { n: number; total?: number } | undefined {
  const [left, right] = text.split('/')
  const n = toNumber(left ?? '')

  if (Number.isNaN(n)) {
    return undefined
  }

  const total = right === undefined || right === '?' ? undefined : toNumber(right)

  return { n, total: total === undefined || Number.isNaN(total) || total <= 0 ? undefined : total }
}

function firstPart(text: string | undefined): string | undefined {
  const part = text?.split(',')[0]?.trim()

  return part ? part : undefined
}

/** What follows the first comma-separated part: tqdm's postfix. */
function restParts(text: string | undefined): string | undefined {
  const rest = text?.split(',').slice(1).join(',').trim()

  return rest ? rest : undefined
}

/** One tqdm line as a bar, or undefined when the line is no tqdm bar. */
export function tqdmBar(line: string): Bar | undefined {
  const known = TQDM.exec(line)

  if (known) {
    const n = toNumber(known[3] ?? '')
    const total = toNumber(known[4] ?? '')

    if (!Number.isNaN(n) && !Number.isNaN(total) && total > 0) {
      return {
        label: known[1]?.trim() || undefined,
        n,
        total,
        eta: known[6] === '?' ? undefined : known[6],
        rate: firstPart(known[7]),
        postfix: restParts(known[7]),
      }
    }
  }

  const open = TQDM_OPEN.exec(line)

  if (open) {
    const n = toNumber(open[2] ?? '')

    if (!Number.isNaN(n)) {
      return { label: open[1]?.trim() || undefined, n, unit: open[3], rate: firstPart(open[5]), postfix: restParts(open[5]) }
    }
  }

  return undefined
}

// cargo: `    Building [=============>     ] 120/300: serde, syn`
const CARGO = /^Building \[[=> -]*\]\s*(\d+)\/(\d+)(?::\s*(.*))?$/
// ninja: `[12/345] Building CXX object src/a.o`; CMake makefiles: `[ 45%] Building CXX object ...`
const NINJA = /^\[(\d+)\/(\d+)\]\s+(.*)$/
const CMAKE = /^\[\s*(\d{1,3})%\]\s+(.*)$/
// git: `Receiving objects:  45% (450/1000), 1.20 MiB | 2.40 MiB/s`
const GIT =
  /^(?:remote:\s+)?((?:Enumerating|Counting|Compressing|Receiving|Writing|Unpacking) objects|Resolving deltas|Updating files|Checking out files):\s+\d{1,3}% \((\d+)\/(\d+)\)(?:,\s*(.*))?$/
// Keras: `Epoch 3/10`, then `32/100 [========>.....] - ETA: 2s - loss: 0.3` or `32/100 ━━━━━━━ 1s 15ms/step - loss: 0.3`
const KERAS_EPOCH = /^Epoch (\d+)\/(\d+)$/
const KERAS_STEP = /^(\d+)\/(\d+)\s+(?:\[[=>.]*\]|[─-╿]+)\s*(.*)$/
// docker buildx (--progress=plain): `#7 [builder 3/5] RUN pip install -r requirements.txt`
const DOCKER = /^#\d+ \[(?:[\w.-]+ )?(\d+)\/(\d+)\] (.*)$/
// ffmpeg: `Duration: 00:05:00.00, ...` once, then `frame= 1234 ... time=00:00:41.13 ... speed=2.0x`
const FFMPEG_DURATION = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/
const FFMPEG_TIME = /\btime=\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)(?:.*?speed=\s*([\d.]+x))?/
// OSC 9;4, the terminal progress sequence (ConEmu, Windows Terminal) cargo and others emit: ESC ] 9 ; 4 ; state ; pct BEL
const OSC_PROGRESS = /\x1b\]9;4;(\d)(?:;(\d{1,3}))?(?:\x07|\x1b\\)/g

// rsync --info=progress2: `  1,234,567  45%   12.34MB/s    0:00:05 (xfr#12, to-chk=88/100)`
const RSYNC = /^\s*[\d,]+\s+(\d{1,3})%\s+(\S+\/s)\s+(\d+:\d\d:\d\d)(?:\s+\((.*)\))?/
// wget --progress=bar:force: `ubuntu.iso      45%[=======>        ]  1.08G  2.31MB/s    eta 20s`
const WGET_BAR = /^(.+?)\s+(\d{1,3})%\[[=> ]*\]\s+(\S+)\s+(\S+\/s)(?:\s+eta\s+(.+))?$/
// wget dot style (its default in a log): `  4096K .......... .......... ..........  9% 2.31M 20s`
const WGET_DOTS = /^\s*\d+[KMG]\s+[. ]+\s(\d{1,3})%\s+(\S+)\s+(\S+)$/
// curl's meter: ` 45 10.0M   45 4608k    0     0  1234k      0  0:00:08  0:00:03  0:00:05 1234k`
const CURL_METER =
  /^\s*(\d{1,3})\s+\S+\s+\d{1,3}\s+\S+\s+\d{1,3}\s+\S+\s+(\S+)\s+\S+\s+([\d:-]+)\s+([\d:-]+)\s+([\d:-]+)\s+(\S+)$/
// curl -#: `######################                        48.2%`
const CURL_HASHES = /^#+\s+(\d{1,3}(?:\.\d+)?)%$/
// pnpm --reporter=append-only: `Progress: resolved 123, reused 100, downloaded 20, added 0`
const PNPM = /^Progress: resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)(?:, (done))?$/
// apt: `Progress: [ 45%] [#####.....]`; with -o APT::Status-Fd=1: `pmstatus:dpkg-exec:50.0:Running dpkg`
const APT = /^Progress: \[\s*(\d{1,3})%\]/
const APT_STATUS = /^(?:pm|dl)status:[^:]*:(\d+(?:\.\d+)?):(.*)$/

/** `20s`, `1m5s`, `2h3m` (wget's estimates) → `00:20`, `01:05`, `2:03:00`. */
function clockOf(text: string | undefined): string | undefined {
  const match = text ? /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(text.trim()) : null

  if (!match || (!match[1] && !match[2] && !match[3])) {
    return undefined
  }

  const hours = Number(match[1] ?? 0)
  const mm = String(Number(match[2] ?? 0)).padStart(2, '0')
  const ss = String(Number(match[3] ?? 0)).padStart(2, '0')

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/** rsync, wget, curl, pnpm and apt: transfers and installs, one bar each. */
function transferBar(line: string): Bar | undefined {
  let match = RSYNC.exec(line)

  if (match) {
    return { label: 'rsync', n: Number(match[1]), total: 100, unit: '%', rate: match[2], eta: match[3], postfix: match[4] }
  }

  if ((match = WGET_BAR.exec(line))) {
    return { label: match[1]?.trim(), n: Number(match[2]), total: 100, unit: '%', rate: match[4], eta: clockOf(match[5]) }
  }

  if ((match = WGET_DOTS.exec(line))) {
    return { label: 'wget', n: Number(match[1]), total: 100, unit: '%', rate: `${match[2]}B/s`, eta: clockOf(match[3]) }
  }

  if ((match = CURL_METER.exec(line))) {
    const left = match[5]

    return {
      label: 'curl',
      n: Number(match[1]),
      total: 100,
      unit: '%',
      rate: `${match[6]}B/s`,
      eta: left && /^\d+:\d\d:\d\d$/.test(left) ? left : undefined,
    }
  }

  if ((match = CURL_HASHES.exec(line))) {
    return { label: 'curl', n: Math.min(100, Number(match[1])), total: 100, unit: '%' }
  }

  if ((match = PNPM.exec(line))) {
    return {
      label: 'pnpm',
      n: Number(match[1]),
      unit: ' resolved',
      postfix: `reused ${match[2]}, downloaded ${match[3]}, added ${match[4]}${match[5] ? ', done' : ''}`,
    }
  }

  if ((match = APT.exec(line))) {
    return { label: 'apt', n: Number(match[1]), total: 100, unit: '%' }
  }

  if ((match = APT_STATUS.exec(line))) {
    return { label: 'apt', n: Math.min(100, Number(match[1])), total: 100, unit: '%', postfix: match[2]?.trim() }
  }

  return undefined
}

/**
 * Tool bars of one family nest: Keras's steps under its epochs. A bar of
 * another family replaces them all: tools run one after another.
 */
function familyOf(label: string): string {
  return label === 'Epoch' || label === 'Steps' ? 'keras' : label
}

function seconds(h: string | undefined, m: string | undefined, s: string | undefined): number {
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)
}

/** Keras's tail, `1s 15ms/step - loss: 0.3 - acc: 0.9`: its rate, estimate and metrics. */
function kerasTail(tail: string): Pick<Bar, 'rate' | 'eta' | 'postfix'> {
  const parts = tail
    .replace(/^-\s*/, '')
    .split(/\s+-\s+/)
    .map(part => part.trim())
    .filter(Boolean)
  const eta = parts.find(part => part.startsWith('ETA:'))?.slice(4).trim()
  const rate = /(\d+(?:\.\d+)?m?s\/step)/.exec(parts[0] ?? '')?.[1]
  const metrics = parts.filter(part => /^\w+: /.test(part) && !part.startsWith('ETA:'))

  return {
    rate,
    eta: eta && /^\d+:\d\d/.test(eta) ? eta : undefined,
    postfix: metrics.length > 0 ? metrics.join(' ') : undefined,
  }
}

/**
 * The progress lines of common tools besides tqdm, each by its own exact
 * shape: a bare `n/m` anywhere in a line is never read, it is too often no
 * progress at all. `context` carries ffmpeg's duration across lines.
 */
export function toolBar(line: string, context: { duration?: number }): Bar | undefined {
  let match = CARGO.exec(line)

  if (match) {
    return { label: 'Building', n: Number(match[1]), total: Number(match[2]), postfix: match[3]?.trim() || undefined }
  }

  if ((match = GIT.exec(line))) {
    const speed = match[4]?.split('|').pop()?.trim()

    return {
      label: match[1],
      n: Number(match[2]),
      total: Number(match[3]),
      rate: speed && /\/s$/.test(speed) ? speed : undefined,
    }
  }

  if ((match = NINJA.exec(line))) {
    return { label: 'Build', n: Number(match[1]), total: Number(match[2]), postfix: match[3]?.trim() }
  }

  if ((match = CMAKE.exec(line))) {
    return { label: 'Build', n: Math.min(100, Number(match[1])), total: 100, unit: '%', postfix: match[2]?.trim() }
  }

  if ((match = KERAS_EPOCH.exec(line))) {
    return { label: 'Epoch', n: Number(match[1]) - 1, total: Number(match[2]) }
  }

  if ((match = KERAS_STEP.exec(line))) {
    return { label: 'Steps', n: Number(match[1]), total: Number(match[2]), ...kerasTail(match[3] ?? '') }
  }

  if ((match = DOCKER.exec(line))) {
    return { label: 'Docker build', n: Number(match[1]), total: Number(match[2]), postfix: match[3]?.trim() }
  }

  const transfer = transferBar(line)

  if (transfer) {
    return transfer
  }

  const duration = FFMPEG_DURATION.exec(line)

  if (duration) {
    context.duration = seconds(duration[1], duration[2], duration[3])
  }

  if (context.duration && (match = FFMPEG_TIME.exec(line))) {
    return {
      label: 'ffmpeg',
      n: Math.round(Math.min(context.duration, seconds(match[1], match[2], match[3]))),
      total: Math.round(context.duration),
      unit: 's',
      rate: match[4],
    }
  }

  return undefined
}

type Protocol = { main?: Bar; sub?: Bar; declared?: 'ok' | 'fail'; message?: string }

function applyProtocol(state: Protocol, rest: string): void {
  const pairs: Record<string, string> = {}

  for (const match of rest.matchAll(PAIR)) {
    pairs[match[1] ?? ''] = match[2] ?? match[3] ?? ''
  }

  const hasSub = pairs.sub !== undefined || pairs.sublabel !== undefined

  if (pairs.step !== undefined) {
    const step = fraction(pairs.step)

    if (step) {
      if (!hasSub && state.main?.n !== step.n) {
        state.sub = undefined
      }

      state.main = { ...state.main, ...step, total: step.total }
    }
  }

  if (pairs.pct !== undefined && !Number.isNaN(parseFloat(pairs.pct))) {
    state.main = { ...state.main, n: Math.min(100, parseFloat(pairs.pct)), total: 100, unit: '%' }
  }

  if (pairs.label !== undefined) {
    state.main = { n: 0, ...state.main, label: pairs.label }
  }

  if (pairs.sub !== undefined) {
    const sub = fraction(pairs.sub)

    if (sub) {
      state.sub = { ...state.sub, ...sub, total: sub.total }
    }
  }

  if (pairs.sublabel !== undefined) {
    state.sub = { n: 0, ...state.sub, label: pairs.sublabel }
  }

  const target = hasSub ? state.sub : state.main

  if (target) {
    if (pairs.rate !== undefined) target.rate = pairs.rate
    if (pairs.eta !== undefined) target.eta = pairs.eta
    if (pairs.unit !== undefined) target.unit = pairs.unit
    if (pairs.ok !== undefined && !Number.isNaN(Number(pairs.ok))) target.ok = Number(pairs.ok)
    if (pairs.fail !== undefined && !Number.isNaN(Number(pairs.fail))) target.fail = Number(pairs.fail)
  }

  if (pairs.done === 'ok' || pairs.done === 'fail') {
    state.declared = pairs.done
  }

  if (pairs.msg !== undefined) {
    state.message = pairs.msg
  }
}

function isComplete(bar: Bar): boolean {
  return bar.total !== undefined && bar.n >= bar.total
}

/**
 * Reads a task's output: the progress protocol first, then tqdm bars, then a
 * bare percentage; the last plain line; the last line that looks like an error.
 */
export function parse(text: string): Parsed {
  const tail = text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text
  let terminal: Bar | undefined

  for (const osc of tail.matchAll(OSC_PROGRESS)) {
    const state = osc[1]

    terminal =
      state === '1' || state === '2' || state === '4'
        ? { n: Math.min(100, Number(osc[2] ?? 0)), total: 100, unit: '%' }
        : state === '3'
          ? { n: 0 }
          : undefined
  }

  const segments = tail.replace(OSC_PROGRESS, '\n').replace(ANSI, '').split(/\r\n|\n|\r/)
  const context: { duration?: number } = {}
  // ffmpeg prints its duration once, at the start: look for it before the tail too.
  const duration = FFMPEG_DURATION.exec(text.slice(0, 64 * 1024))

  if (duration) {
    context.duration = seconds(duration[1], duration[2], duration[3])
  }
  const parsed: Parsed = {}
  const protocol: Protocol = {}
  let hasProtocol = false
  // tqdm bars by label, in the order first seen, with the segment of their last update.
  const bars = new Map<string, { bar: Bar; at: number }>()
  const toolKeys = new Set<string>()
  let percent: Bar | undefined

  segments.forEach((raw, at) => {
    const line = raw.trim()

    if (line === '' || EXIT_TRAILER.test(line)) {
      return
    }

    const directive = PROTOCOL.exec(line)

    if (directive) {
      hasProtocol = true
      applyProtocol(protocol, directive[1] ?? '')

      return
    }

    const tqdm = tqdmBar(line)
    const bar = tqdm ?? toolBar(line, context)

    if (bar) {
      const key = bar.label ?? ''

      // Tools run one after another (a build, then a push): a new tool's bar replaces
      // the last one's. Only Keras nests its own, steps under epochs.
      if (!tqdm) {
        const family = familyOf(key)

        for (const tool of toolKeys) {
          if (familyOf(tool) !== family) {
            bars.delete(tool)
            toolKeys.delete(tool)
          }
        }

        toolKeys.add(key)
      }

      bars.set(key, { bar, at })

      return
    }

    if (ERROR.test(line)) {
      parsed.error = line.slice(0, 300)
    }

    let last: RegExpExecArray | null = null

    for (const match of line.matchAll(PERCENT)) {
      last = match as RegExpExecArray
    }

    if (last) {
      percent = { n: Math.min(100, parseFloat(last[1] ?? "0")), total: 100, unit: '%' }
    }

    parsed.lastLine = line.slice(0, 300)
  })

  if (hasProtocol) {
    parsed.main = protocol.main
    parsed.sub = protocol.sub
    parsed.declared = protocol.declared
    parsed.lastLine = protocol.message ?? parsed.lastLine
  } else if (bars.size > 0) {
    const entries = [...bars.values()]
    const latest = entries.reduce((a, b) => (b.at > a.at ? b : a))
    // A finished bar that is not the latest is a step already behind (pip, sequential loops).
    const active = entries.filter(one => one === latest || !isComplete(one.bar))
    const main = active[0] ?? latest
    const others = active.filter(one => one !== main)

    parsed.main = main.bar
    parsed.sub = others.length > 0 ? others.reduce((a, b) => (b.at > a.at ? b : a)).bar : undefined

    // Keras's `Epoch 2/2` opens the epoch: once its steps are all done, so is the epoch.
    if (parsed.main.label === 'Epoch' && parsed.sub?.label === 'Steps' && isComplete(parsed.sub)) {
      parsed.main = { ...parsed.main, n: Math.min(parsed.main.n + 1, parsed.main.total ?? Infinity) }
    }
  } else if (terminal) {
    parsed.main = terminal
  } else if (percent) {
    parsed.main = percent
  }

  return parsed
}

const BACKGROUND = /with ID: (\S+?)\.?\s+Output is being written to: (.+?\.output)\b/

/** The task id and output file a backgrounded shell call reports, if it does. */
export function backgroundOf(
  text: string | undefined,
  record?: { backgroundTaskId?: string; backgroundOutputPath?: string },
): { taskId: string; outputFile?: string } | undefined {
  const match = text ? BACKGROUND.exec(text) : null
  const taskId = record?.backgroundTaskId ?? match?.[1]

  if (!taskId) {
    return undefined
  }

  return { taskId, outputFile: record?.backgroundOutputPath ?? match?.[2] }
}

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g

export type Notification = { taskId: string; status: string; exitCode?: number }

/** The background-task notifications a conversation row carries. */
export function notificationsOf(text: string): Notification[] {
  const found: Notification[] = []

  for (const block of text.matchAll(NOTIFICATION)) {
    const body = block[1] ?? ''
    const taskId = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1]?.trim()
    const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim() ?? 'completed'
    const code = /exit code (-?\d+)/.exec(body)?.[1]

    if (taskId) {
      found.push({ taskId, status, exitCode: code === undefined ? undefined : Number(code) })
    }
  }

  return found
}
