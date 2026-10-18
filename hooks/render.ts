import type { Bar, Track } from '../types'
import { CHARSETS, cellsOf, type Glyphs, widthOf } from './charset'

const UNICODE: Glyphs = CHARSETS.unicode
/** Width of the block that sweeps an indeterminate bar. */
const SWEEP = 4

/** A spinner frame; `interval` is the time per frame, shorter while the task goes faster. */
export function spinnerAt(now: number, glyphs: Glyphs = UNICODE, interval = 100): string {
  return glyphs.spinner[Math.floor(now / interval) % glyphs.spinner.length] ?? '*'
}

/** No move of the main bar for this long: the spinner slows to say so. */
const STILL_MS = 5000

/**
 * The spinner's time per frame, after alive-progress: faster while the task
 * goes faster than its average, slower while it lags or stands still.
 */
export function spinInterval(track: Track, now: number): number {
  if (track.lastSample && now - track.lastSample.at > STILL_MS) {
    return 300
  }

  return Math.min(300, Math.max(60, 100 / (track.paceRatio ?? 1)))
}

/** `75000` → `01:15`, `3_725_000` → `1:02:05`. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/** `01:15` or `1:02:05` → milliseconds; undefined when it is neither. */
export function durationMs(text: string | undefined): number | undefined {
  if (!text || !/^\d+(:\d\d){1,2}$/.test(text)) {
    return undefined
  }

  return text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) * 1000
}

/** Counts as tqdm prints them: plain up to 99,999, then `1.2M`. */
export function count(n: number): string {
  if (n < 100_000) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1)
  }

  for (const [size, suffix] of [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']] as const) {
    if (n >= size) {
      return `${(n / size).toFixed(n / size < 10 ? 2 : 1)}${suffix}`
    }
  }

  return String(n)
}

export function fractionOf(bar: Bar): number | undefined {
  return bar.total === undefined ? undefined : Math.min(1, Math.max(0, bar.n / bar.total))
}

/**
 * The bar's cells: filled to its fraction, a partial cell at its edge as
 * fine as the charset allows (tqdm's `Bar`), or, with no total, a block
 * sweeping back and forth so a running task visibly moves.
 */
export function cells(bar: Bar, width: number, now: number, glyphs: Glyphs = UNICODE): string {
  const fraction = fractionOf(bar)

  if (fraction === undefined) {
    const sweep = Math.min(SWEEP, width)
    const travel = Math.max(1, width - sweep)
    const step = Math.floor(now / 80) % (travel * 2)
    const at = step < travel ? step : travel * 2 - step

    return glyphs.empty.repeat(at) + glyphs.full.repeat(sweep) + glyphs.empty.repeat(Math.max(0, width - at - sweep))
  }

  const steps = glyphs.partials.length + 1
  const filled = Math.round(fraction * width * steps)
  const full = Math.min(width, Math.floor(filled / steps))
  const partial = full < width ? (glyphs.partials[(filled % steps) - 1] ?? '') : ''

  return glyphs.full.repeat(full) + partial + glyphs.empty.repeat(Math.max(0, width - full - (partial ? 1 : 0)))
}

/** The figures after a bar: `1840/2400  77%  312it/s`. */
export function figures(bar: Bar): string {
  const fraction = fractionOf(bar)
  const parts: string[] = []

  if (bar.unit === '%' && bar.total === 100) {
    parts.push(`${Math.floor(bar.n)}%`)
  } else if (fraction === undefined) {
    parts.push(`${count(bar.n)}${bar.unit ?? ''}`)
  } else {
    parts.push(`${count(bar.n)}/${count(bar.total as number)}`, `${Math.floor(fraction * 100)}%`)
  }

  if (bar.rate) {
    parts.push(bar.rate)
  }

  if (bar.ok !== undefined || bar.fail !== undefined) {
    parts.push([bar.ok !== undefined ? `ok ${count(bar.ok)}` : '', bar.fail ? `fail ${count(bar.fail)}` : ''].filter(Boolean).join(' '))
  }

  if (bar.postfix) {
    parts.push(clip(bar.postfix, 32))
  }

  return parts.join('  ')
}

/**
 * Ended well by its exit code, yet its main bar stopped short of its total:
 * alive-progress's `(!)`. It waits for the person, as a failure does.
 */
export function isShortOfTotal(track: Track): boolean {
  // Only a source that always prints its final state (tqdm, ##progress) can say so: other tools stop
  // short of their total on success (Spark's last line is 48/50, webpack's 99 %). And within 1 % of
  // the total is done (ffmpeg's last time= a frame before the duration).
  return (
    track.status === 'done' &&
    track.isExact === true &&
    track.main?.total !== undefined &&
    track.main.n < track.main.total * 0.99
  )
}

/** The line a finished task keeps: `200/200 in 00:20 (9.9it/s)`, alive-progress's receipt. */
export function receiptOf(track: Track): string {
  if (!track.main || track.endedAt === undefined) {
    return ''
  }

  const bar = track.main
  const amount = bar.total === undefined ? `${count(bar.n)}${bar.unit ?? ''}` : bar.unit === '%' ? `${Math.floor(bar.n)}%` : `${count(bar.n)}/${count(bar.total)}`

  return `${isShortOfTotal(track) ? '(!) ' : ''}${amount}${bar.rate ? ` (${bar.rate})` : ''}`
}

export type NotifyMode = 'failures' | 'always' | 'off'

/** A task this long is worth a notification when it ends well, in `always` mode. */
export const NOTIFY_SUCCESS_AFTER_MS = 60_000

/**
 * The native notification a task's end is worth (tqdm.contrib's
 * Telegram/Slack/Discord idea, through the person's own channel), if any:
 * `failures` tells of a failure or an early end; `always` also of a stop and
 * of a success that took a minute or more.
 */
export function endNotice(track: Track, mode: NotifyMode): { title: string; text: string } | undefined {
  if (mode === 'off' || track.status === 'running' || track.isUnconfirmed) {
    return undefined
  }

  const took = duration((track.endedAt ?? track.startedAt) - track.startedAt)

  if (track.status === 'failed') {
    return { title: 'Task failed', text: `${track.label} · ${failureOf(track)}` }
  }

  if (isShortOfTotal(track)) {
    return { title: 'Task ended early', text: `${track.label} · ${failureOf(track)}` }
  }

  if (mode !== 'always') {
    return undefined
  }

  if (track.status === 'killed') {
    return { title: 'Task stopped', text: `${track.label} · after ${took}` }
  }

  if ((track.endedAt ?? 0) - track.startedAt >= NOTIFY_SUCCESS_AFTER_MS) {
    const receipt = receiptOf(track)

    return { title: 'Task finished', text: `${track.label} · ${receipt ? `${receipt} ` : ''}in ${took}` }
  }

  return undefined
}

/** No output after this long: most often a buffered stdout, which looks exactly like a frozen task. */
export const SILENT_START_MS = 15_000

export function silentStartHint(track: Track, now: number): string | undefined {
  if (track.kind !== 'bg' || track.status !== 'running' || track.size > 0 || now - track.startedAt < SILENT_START_MS) {
    return undefined
  }

  return 'no output yet · buffered? python -u / PYTHONUNBUFFERED=1, stdbuf -oL, git --progress, docker --progress=plain'
}

/** Cuts a text to `width` terminal cells, wide characters counted as two (tqdm's `disp_trim`). */
export function clip(text: string, width: number, ellipsis = UNICODE.ellipsis): string {
  if (width <= 0) {
    return ''
  }

  if (widthOf(text) <= width) {
    return text
  }

  const room = width - widthOf(ellipsis)
  let out = ''
  let used = 0

  for (const char of text) {
    const size = cellsOf(char)

    if (used + size > room) {
      break
    }

    out += char
    used += size
  }

  return out + ellipsis
}

/**
 * A bar line in parts, each drawn in its own color: the label, the cells done
 * (ok), the cells failed, the cells left, then the figures. Without failures
 * the whole bar is in `done`, its partial cell included.
 */
export type BarParts = { head: string; done: string; failed: string; left: string; tail: string }

export function barParts(bar: Bar, prefix: string, width: number, now: number, glyphs: Glyphs = UNICODE): BarParts {
  const label = clip(bar.label ?? '', 24, glyphs.ellipsis)
  const figuresText = figures(bar)
  const head = `${prefix}${label ? `${label} ` : ''}`
  const room = width - widthOf(head) - widthOf(figuresText) - 2
  const barWidth = Math.max(6, Math.min(40, room))
  const tail = clip(`  ${figuresText}`, Math.max(0, width - widthOf(head) - barWidth), glyphs.ellipsis)
  const fraction = fractionOf(bar)

  if (!bar.fail || fraction === undefined || bar.n <= 0) {
    return { head, done: cells(bar, barWidth, now, glyphs), failed: '', left: '', tail }
  }

  // enlighten's subcounters: the filled part split by outcome, failures always at least a cell.
  const filled = Math.round(fraction * barWidth)
  // Out of the outcomes counted, when both are (a test run's percentage is no count of them).
  const outcomes = bar.ok !== undefined ? bar.ok + bar.fail : bar.n
  const failedCells = Math.min(filled, Math.max(1, Math.round((filled * bar.fail) / Math.max(1, outcomes))))

  return {
    head,
    done: glyphs.full.repeat(filled - failedCells),
    failed: glyphs.full.repeat(failedCells),
    left: glyphs.empty.repeat(barWidth - filled),
    tail,
  }
}

/** One bar line: `  Epoch 3 ██████▋░░░  1840/2400  77%  312it/s`. */
export function barLine(bar: Bar, prefix: string, width: number, now: number, glyphs: Glyphs = UNICODE): string {
  const parts = barParts(bar, prefix, width, now, glyphs)

  return clip(`${parts.head}${parts.done}${parts.failed}${parts.left}${parts.tail}`, width, glyphs.ellipsis)
}

export const STALL_MS = 60_000

/** A last line saying the work goes on quietly (a link, a compile, a download) earns a longer silence. */
export const BUSY_STALL_MS = 180_000
const BUSY = /\b(compil|link|build|bundl|transpil|generat|optimi[sz]|download|fetch|install|resolv|pull|push|upload|index|migrat|train|wait)/i

/**
 * Silent for longer than a task of its kind would be: a minute, or three after
 * a line saying the work goes on quietly (Cline's "hot" grace, after the
 * same words). Silence is measured from the output's last change.
 */
export function isStalled(track: Track, now: number): boolean {
  const limit = track.lastLine && BUSY.test(track.lastLine) ? BUSY_STALL_MS : STALL_MS

  return track.status === 'running' && track.kind === 'bg' && now - track.lastChangeAt > limit
}

/** What an exit code says beyond failure: a timeout, or the signal that ended the process (128 + n). */
export function exitMeaning(code: number | undefined): string | undefined {
  switch (code) {
    case 124:
      return 'timed out'
    case 130:
      return 'interrupted (Ctrl+C)'
    case 137:
      return 'killed (SIGKILL, often out of memory)'
    case 139:
      return 'crashed (segmentation fault)'
    case 143:
      return 'terminated (SIGTERM)'
    default:
      return undefined
  }
}

/**
 * The time on a header: elapsed while running, with an estimate of the total
 * once the main bar says (tqdm's own remaining time, smoothed by its moving
 * average, where it printed one; else from the fraction done); the run's
 * length once it ended.
 */
export function timing(track: Track, now: number): string {
  const end = track.endedAt ?? now
  const elapsed = end - track.startedAt

  if (track.status !== 'running') {
    return duration(elapsed)
  }

  const remaining = durationMs(track.main?.eta)

  if (remaining !== undefined && remaining > 0) {
    return `${duration(elapsed)} / ~${duration(elapsed + remaining)}`
  }

  const fraction = track.main ? fractionOf(track.main) : undefined
  const from = track.progressFrom

  // The pace since progress was first seen, leaving out the start-up before it (tqdm #967).
  if (fraction !== undefined && from && fraction < 1 && fraction - from.fraction >= 0.02 && now - from.at >= 2000) {
    const left = ((now - from.at) / (fraction - from.fraction)) * (1 - fraction)

    return `${duration(elapsed)} / ~${duration(elapsed + left)}`
  }

  if (fraction !== undefined && fraction >= 0.02 && fraction < 1) {
    return `${duration(elapsed)} / ~${duration(elapsed / fraction)}`
  }

  return duration(elapsed)
}

export function glyph(track: Track, now: number, glyphs: Glyphs = UNICODE): string {
  switch (track.status) {
    case 'done':
      return isShortOfTotal(track) ? glyphs.warning : glyphs.done
    case 'failed':
      return glyphs.failed
    case 'killed':
      return glyphs.killed
    default:
      return spinnerAt(now, glyphs, spinInterval(track, now))
  }
}

/** Failed and killed first (they wait for the person), then running, newest first, then done. */
export function ordered(tracks: readonly Track[]): Track[] {
  const rank = (track: Track) => (hasDetailRow(track) ? 0 : track.status === 'running' ? 1 : 2)

  return [...tracks].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt)
}

/** The footer's summary: `⠙ Train 43% · ✗ Index docs`, most urgent first. */
export function summaryOf(tracks: readonly Track[], now: number, glyphs: Glyphs = UNICODE, most = 3): string {
  const urgent = ordered(tracks).filter(one => one.status === 'running' || hasDetailRow(one))
  const parts = urgent.slice(0, most).map(one => {
    const fraction = one.status === 'running' && one.main ? fractionOf(one.main) : undefined
    const percent = fraction === undefined ? '' : ` ${Math.floor(fraction * 100)}%`

    return `${glyph(one, now, glyphs)} ${clip(one.label, 18, glyphs.ellipsis)}${percent}`
  })

  if (urgent.length > most) {
    parts.push(`+${urgent.length - most}`)
  }

  return parts.join(' · ')
}

/**
 * The footer's mode label, right of the hint line, never cut: one task by its
 * name (`⠋ Train 43%`), several by count (`⠋ 3 tasks · 43% · ✗ 1`), the
 * percentage of the most urgent running one, and the failures waiting.
 */
export function modeLabelOf(tracks: readonly Track[], now: number, glyphs: Glyphs = UNICODE): string {
  const running = ordered(tracks).filter(one => one.status === 'running')
  const waiting = tracks.filter(hasDetailRow).length

  if (running.length === 0 && waiting === 0) {
    return ''
  }

  const lead = running[0]
  const fraction = lead?.main ? fractionOf(lead.main) : undefined
  const percent = fraction === undefined ? '' : `${Math.floor(fraction * 100)}%`
  const parts: string[] = []

  if (lead) {
    const icon = glyph(lead, now, glyphs)

    parts.push(running.length === 1 ? `${icon} ${clip(lead.label, 20, glyphs.ellipsis)}${percent ? ` ${percent}` : ''}` : `${icon} ${running.length} tasks`)

    if (running.length > 1 && percent) {
      parts.push(percent)
    }
  }

  if (waiting > 0) {
    parts.push(`${glyphs.failed} ${waiting}`)
  }

  return parts.join(' · ')
}

/**
 * A running track with no main bar draws a sweeping one in its place; one
 * that ended well says it all in its header's receipt; one that ended badly
 * keeps its bar where it stopped.
 */
export function hasMainRow(track: Track): boolean {
  if (track.status === 'running') {
    return true
  }

  return track.main !== undefined && (track.status !== 'done' || isShortOfTotal(track))
}

/** Whether the track waits for the person to dismiss it. */
export function hasDetailRow(track: Track): boolean {
  return track.status === 'failed' || track.status === 'killed' || isShortOfTotal(track)
}

/** How many rows a track draws: header, main, sub, then the failure's line. */
export function rowsOf(track: Track): number {
  return 1 + (hasMainRow(track) ? 1 : 0) + (track.sub ? 1 : 0) + (hasDetailRow(track) ? 1 : 0)
}

/** What a failed or killed track says under its bars. */
export function failureOf(track: Track): string {
  const meaning = exitMeaning(track.exitCode)
  const code = track.exitCode === undefined ? '' : `exit code ${track.exitCode}${meaning ? ` (${meaning})` : ''}`
  const reason = track.error ?? track.lastLine

  if (track.status === 'killed') {
    return reason ? `stopped · ${reason}` : 'stopped'
  }

  // A clean exit short of the total: only an error line says more, not just any last line.
  if (isShortOfTotal(track) && track.main) {
    return `exited ${track.exitCode ?? 0} at ${count(track.main.n)}/${count(track.main.total ?? 0)}${track.error ? ` · ${track.error}` : ''}`
  }

  return [code, reason].filter(Boolean).join(' · ') || 'failed'
}
