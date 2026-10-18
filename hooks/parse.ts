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
  /^(?:remote:\s+)?((?:Enumerating|Counting|Compressing|Receiving|Writing|Unpacking) objects|Resolving deltas|Updating files|Checking out files|(?:Downloading|Uploading) LFS objects|Filtering content):\s+\d{1,3}% \((\d+)\/(\d+)\)(?:,\s*(.*))?$/
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
/** What a tool's progress spreads over several lines: ffmpeg's duration, a test run's outcomes, the file at hand. */
export type ToolContext = {
  duration?: number
  tests?: { ok: number; fail: number }
  pipFile?: string
  copyFile?: string
  /** go test: whether -v lines (one per test) were seen; the packages done. */
  goTests?: boolean
  packages?: { ok: number; fail: number }
  /** cargo test: the tests its `running N tests` lines announced so far. */
  announced?: number
  /** The line a tool prints once its work is done, which completes its bar. */
  lastDone?: { label: string; marker: string }
  /** yt-dlp: the file its`Destination:` line names. */
  download?: string
  /** terraform: the plan's count of changes, and how many are done. */
  plan?: { total: number; done: number }
  /** kubectl rollout status: the deployment and its replicas. */
  rollout?: { name: string; total: number }
}

// terraform (captured, v1.9.8): `Plan: 4 to add, 0 to change, 0 to destroy.`, then per resource
// `time_sleep.a: Creating...`, `... Still creating... [10s elapsed]`, `... Creation complete after 35s [id=...]`
const TF_PLAN = /^Plan: (\d+) to add, (\d+) to change, (\d+) to destroy\./
const TF_DONE = /^(\S+): (?:Creation|Modifications|Destruction) complete after (\S+)/
const TF_WORKING = /^(\S+): (?:Creating|Modifying|Destroying)\.\.\.|^(\S+): Still (?:creating|modifying|destroying)\.\.\. \[(\S+) elapsed\]/
const TF_APPLIED = /^(?:Apply|Destroy) complete! Resources:/
// kubectl rollout status (captured, v1.36): `Waiting for deployment "x" rollout to finish: 1 out of 3 new
// replicas have been updated...`, `... 2 of 3 updated replicas are available...`,
// `... 1 old replicas are pending termination...`, then `deployment "x" successfully rolled out`
const KUBE_PROGRESS = /^Waiting for (?:deployment|daemon set|statefulset|rollout) "(.+?)" rollout to finish: (\d+) (?:out )?of (\d+) (new replicas have been updated|updated replicas are available|new pods have been updated|updated pods are available)/
const KUBE_PENDING = /^Waiting for (?:deployment|daemon set|statefulset) "(.+?)" rollout to finish: (\d+) old replicas are pending termination/
const KUBE_DONE = /^(?:deployment|daemon set|statefulset)(?:\.apps)? "(.+?)" successfully rolled out/

// yt-dlp (captured, 2026.08.19): `[download] Destination: v.mp4`, then
// `[download]  41.5% of   25.74MiB at    2.91MiB/s ETA 00:05`, last `[download] 100% of 25.74MiB in 00:00:09 at 2.79MiB/s`
const YTDLP_FILE = /^\[download\] Destination: (.+)$/
// (the last line has `in <time>` before `at <rate>`)
const YTDLP = /^\[download\]\s+(\d{1,3}(?:\.\d+)?)% of\s+~?\s*([\d.]+\s*\w+)(?:\s+in\s+\S+)?(?:\s+at\s+(\S+\/s))?(?:\s+ETA\s+(\S+))?/
// HandBrakeCLI (captured, 1.7.2): `Encoding: task 1 of 1, 36.33 % (159.40 fps, avg 159.40 fps, ETA 00h00m08s)`,
// a log line sometimes glued after it
const HANDBRAKE = /^Encoding: task (\d+) of (\d+), ([\d.]+) %(?: \(([\d.]+) fps, avg [\d.]+ fps, ETA (\d+)h(\d+)m(\d+)s\))?/
// pv -f (captured, 1.8.5): ` 160MiB 0:00:04 [40.0MiB/s] [=========>    ]  53% ETA 0:00:03`, or with no
// size known `80.0MiB 0:00:02 [40.0MiB/s] [ <=>     ]`
const PV = /^([\d.]+\s*[KMGT]?i?B)\s+(\d+:\d\d:\d\d)\s+\[\s*([\d.]+\s*[KMGT]?i?B\/s)\]\s+\[[=> ]*\]\s+(\d{1,3})%(?:\s+ETA\s+(\d+:\d\d:\d\d))?/
const PV_OPEN = /^([\d.]+\s*[KMGT]?i?B)\s+(\d+:\d\d:\d\d)\s+\[\s*([\d.]+\s*[KMGT]?i?B\/s)\]\s+\[\s*<=>\s*\]/
// 7-Zip -bsp1 (captured, 23.01): `  51% 1 + data.bin`, updated in place with backspaces; `- name` when extracting
const SEVEN_ZIP = /^(\d{1,3})%(?:\s+\d+)?\s+[+\-U=]\s+(.+)$/
// GNU dd status=progress (captured, coreutils 9.4): `537919488 bytes (538 MB, 513 MiB) copied, 4 s, 133 MB/s`
const DD = /^(\d+) bytes \(([\d.]+ \w+)(?:, [\d.]+ \w+)?\) copied, ([\d.]+) s, ([\d.]+ \w+\/s)/

// Test runners, all captured with no terminal (and, for jest and vitest, as Claude Code runs them: with
// CLAUDECODE set they switch to their terse agent reporters, which still print these lines).
// jest 30: `PASS jt/a.test.js`, `FAIL jt/d.test.js`, then `Tests:       2 failed, 32 passed, 34 total`
const JEST_SUITE = /^(PASS|FAIL)\s+(\S+)/
const JEST_SUMMARY = /^Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(?:(\d+) todo,\s*)?(?:(\d+) passed,\s*)?(\d+) total/
// vitest 5: ` ✓ vt/a.test.mjs (8 tests) 1264ms`, ` ❯ vt/d.test.mjs (9 tests | 1 failed) 1282ms`; with the
// verbose reporter ` ✓ vt/a.test.mjs > a case 1 156ms`; then `      Tests  2 failed | 32 passed (34)`
const VITEST_FILE = /^([✓❯×↓])\s+(\S+?\.[cm]?[jt]sx?)\s+\((\d+) tests?(?:\s*\|\s*(\d+) failed)?(?:\s*\|\s*(\d+) skipped)?\)/
const VITEST_TEST = /^([✓×↓])\s+\S+\.[cm]?[jt]sx? > .+?(?:\s+\d+ms)?$/
const VITEST_SUMMARY = /^Tests\s+(?:(\d+) failed\s*\|\s*)?(?:(\d+) passed)?(?:\s*\|\s*(\d+) skipped)?[^(]*\((\d+)\)$/
// go test 1.25: with -v `--- PASS: TestCase1 (0.10s)` per test; always `ok  \tpkg\t1.108s` or `FAIL\tpkg\t1.159s`
const GO_TEST = /^--- (PASS|FAIL|SKIP): (\S+)/
const GO_PACKAGE = /^(ok|FAIL)\s+(\S+)\s+(?:[\d.]+s|\(cached\))/
// cargo test 1.99: `running 11 tests`, `test case_10 ... ok` / `... FAILED` / `... ignored`
const CARGO_RUNNING = /^running (\d+) tests?$/
const CARGO_TEST = /^test (\S+) \.\.\. (ok|FAILED|ignored)/
// dotnet test (SDK 10, VSTest), in the system's language: `Passed Caps.A.Case7 [115 ms]` or `Réussi ...`;
// the summary `Failed!  - Failed:     2, Passed:    33, Skipped:     0, Total:    35, ...`
// (`Échoué!  - échec :     2, réussite :    33, ignorée(s) :     0, total :    35, ...` in French)
// (a test under a millisecond reads `[< 1 ms]`); with normal verbosity the run ends `Total tests: 35`
const DOTNET_TEST = /^(\S+)\s+\S+\.\S+\s+\[<?\s*\d+(?:[.,]\d+)?\s*m?s\]$/
const DOTNET_TOTAL = /^(?:Total tests|Nombre total de tests)\s*:\s*(\d+)$/
const DOTNET_PASS = /^(Passed|Réussi|Bestanden|Superado|Riuscito)$/
const DOTNET_FAIL = /^(Failed|Échoué|Fehlgeschlagen|Error)$/
const DOTNET_SUMMARY = /^\S+!\s+-\s+[^:,]+:\s*(\d+),\s*[^:,]+:\s*(\d+),\s*[^:,]+:\s*(\d+),\s*[^:,]+:\s*(\d+),/

function counted(context: ToolContext, ok: number, fail: number): { ok: number; fail: number } {
  context.tests = { ok: (context.tests?.ok ?? 0) + ok, fail: (context.tests?.fail ?? 0) + fail }

  return context.tests
}

/** Test runners: jest, vitest, go test, cargo test, dotnet test. Passes and failures go to the two-color bar. */
function testBar(line: string, context: ToolContext): Bar | undefined {
  let match = JEST_SUMMARY.exec(line)

  if (match) {
    const total = Number(match[5])

    return { label: 'jest', n: total, total, ok: Number(match[4] ?? 0), fail: Number(match[1] ?? 0), unit: ' tests' }
  }

  if ((match = JEST_SUITE.exec(line)) && /\.(test|spec)\.[cm]?[jt]sx?$|__tests__/.test(match[2] ?? '')) {
    const tests = counted(context, match[1] === 'PASS' ? 1 : 0, match[1] === 'FAIL' ? 1 : 0)

    return { label: 'jest', n: tests.ok + tests.fail, ok: tests.ok, fail: tests.fail, unit: ' suites', postfix: match[2] }
  }

  if ((match = VITEST_SUMMARY.exec(line))) {
    const total = Number(match[4])

    return { label: 'vitest', n: total, total, ok: Number(match[2] ?? 0), fail: Number(match[1] ?? 0), unit: ' tests' }
  }

  if ((match = VITEST_FILE.exec(line))) {
    const failed = Number(match[4] ?? 0)
    const tests = counted(context, Number(match[3]) - failed - Number(match[5] ?? 0), failed)

    return { label: 'vitest', n: tests.ok + tests.fail, ok: tests.ok, fail: tests.fail, unit: ' tests', postfix: match[2] }
  }

  if ((match = VITEST_TEST.exec(line))) {
    const tests = counted(context, match[1] === '✓' ? 1 : 0, match[1] === '×' ? 1 : 0)

    return { label: 'vitest', n: tests.ok + tests.fail, ok: tests.ok, fail: tests.fail, unit: ' tests' }
  }

  if ((match = GO_TEST.exec(line))) {
    // Without -v go still prints failing tests: only a passing test's line says every test is listed.
    if (match[1] !== 'FAIL') {
      context.goTests = true
    }

    const tests = counted(context, match[1] === 'PASS' ? 1 : 0, match[1] === 'FAIL' ? 1 : 0)

    return context.goTests
      ? { label: 'go test', n: tests.ok + tests.fail, ok: tests.ok, fail: tests.fail, unit: ' tests', postfix: match[2] }
      : undefined
  }

  if ((match = GO_PACKAGE.exec(line))) {
    context.packages = {
      ok: (context.packages?.ok ?? 0) + (match[1] === 'ok' ? 1 : 0),
      fail: (context.packages?.fail ?? 0) + (match[1] === 'FAIL' ? 1 : 0),
    }

    // With -v the tests are counted; without, the packages are all there is.
    const counts = context.goTests && context.tests ? context.tests : context.packages

    return {
      label: 'go test',
      n: counts.ok + counts.fail,
      ok: counts.ok,
      fail: counts.fail,
      unit: context.goTests ? ' tests' : ' packages',
      postfix: match[2],
    }
  }

  if ((match = CARGO_RUNNING.exec(line))) {
    context.announced = (context.announced ?? 0) + Number(match[1])

    return undefined
  }

  if ((match = CARGO_TEST.exec(line))) {
    const tests = counted(context, match[2] === 'FAILED' ? 0 : 1, match[2] === 'FAILED' ? 1 : 0)

    return { label: 'cargo test', n: tests.ok + tests.fail, total: context.announced, ok: tests.ok, fail: tests.fail, postfix: match[1] }
  }

  if ((match = DOTNET_SUMMARY.exec(line))) {
    const total = Number(match[4])

    return { label: 'dotnet test', n: total, total, ok: Number(match[2]), fail: Number(match[1]), unit: ' tests' }
  }

  if ((match = DOTNET_TOTAL.exec(line)) && context.tests) {
    const total = Number(match[1])

    return { label: 'dotnet test', n: total, total, ok: context.tests.ok, fail: context.tests.fail, unit: ' tests' }
  }

  if ((match = DOTNET_TEST.exec(line))) {
    const word = match[1] ?? ''

    if (DOTNET_PASS.test(word) || DOTNET_FAIL.test(word)) {
      const tests = counted(context, DOTNET_PASS.test(word) ? 1 : 0, DOTNET_FAIL.test(word) ? 1 : 0)

      return { label: 'dotnet test', n: tests.ok + tests.fail, ok: tests.ok, fail: tests.fail, unit: ' tests' }
    }
  }

  return undefined
}

// Compute and builds, all captured with no terminal.
// dask 2026.8 ProgressBar: `[####################                    ] | 52% Completed | 5.62 s`
const DASK = /^\[[# ]+\] \| (\d{1,3})% Completed \| ([\d.]+ \w+)/
// PySpark 3.5 (on by default): `[Stage 1:=================>         (59 + 2) / 100]`
const SPARK = /^\[Stage (\d+):[=> ]*\((\d+) \+ (\d+)\) \/ (\d+)\]/
// XGBoost 3.2 (verbose_eval): `[45]\ttrain-logloss:0.13592\ttrain-auc:0.99302\tvalid-logloss:0.26546\tvalid-auc:0.95584`
// LightGBM 4.7 (log_evaluation): `[25]\ttrain's binary_logloss: 0.250063\ttrain's auc: 0.9664\tvalid's ...`
const BOOSTING = /^\[(\d+)\]\t(\S+(?:'s \S+)?:\s?[-\d.e]+(?:\t.+)?)$/
// webpack 5 --progress (or ProgressPlugin): `<s> [webpack.Progress] 65% building 1/1 entries 41/41 dependencies`
const WEBPACK = /^<s> \[webpack\.Progress\] (\d{1,3})%\s*(.*)$/
// Bazel 7: `[10 / 21] Executing genrule //:g12; 2s local ... (2 actions, 1 running)`, with --curses=yes
// `[7 / 21] 2 actions running`; at the end `INFO: Build completed successfully, 21 total actions`
const BAZEL = /^\[([\d,]+) \/ ([\d,]+)\]\s+(?:\[\w+\]\s+)?([^;]+?)(?:;.*|\s+\.\.\..*)?$/
const BAZEL_DONE = /^INFO: Build completed successfully, ([\d,]+) total actions?/

/** dask, Spark, XGBoost, LightGBM, webpack, Bazel. */
function computeBar(line: string): Bar | undefined {
  let match = DASK.exec(line)

  if (match) {
    return { label: 'dask', n: Number(match[1]), total: 100, unit: '%', postfix: match[2] }
  }

  if ((match = SPARK.exec(line))) {
    return { label: `Spark stage ${match[1]}`, n: Number(match[2]), total: Number(match[4]), postfix: `${match[3]} running` }
  }

  if ((match = BOOSTING.exec(line))) {
    const fields = (match[2] ?? '').split('\t')
    const isLightGbm = fields.some(field => field.includes("'s "))
    // The validation metrics say how training goes; the training ones only that it fits.
    const shown = fields.filter(field => /^valid/.test(field))

    return {
      label: isLightGbm ? 'LightGBM' : 'XGBoost',
      // XGBoost counts rounds from 0, LightGBM from 1.
      n: Number(match[1]) + (isLightGbm ? 0 : 1),
      unit: ' rounds',
      postfix: (shown.length > 0 ? shown : fields).join(' ').replace(/'s /g, ' '),
    }
  }

  if ((match = WEBPACK.exec(line))) {
    return { label: 'webpack', n: Number(match[1]), total: 100, unit: '%', postfix: match[2]?.trim() || undefined }
  }

  if ((match = BAZEL.exec(line))) {
    return {
      label: 'Bazel',
      n: Number(match[1]?.replace(/,/g, '')),
      total: Number(match[2]?.replace(/,/g, '')),
      postfix: match[3]?.trim(),
    }
  }

  if ((match = BAZEL_DONE.exec(line))) {
    const total = Number(match[1]?.replace(/,/g, ''))

    return { label: 'Bazel', n: total, total }
  }

  return undefined
}

/** Media and files: yt-dlp, HandBrakeCLI, pv, 7-Zip, dd. */
function mediaBar(line: string, context: ToolContext): Bar | undefined {
  let match = YTDLP_FILE.exec(line)

  if (match) {
    context.download = match[1]?.trim()

    return undefined
  }

  if ((match = YTDLP.exec(line))) {
    const eta = match[4] && /^\d+:\d\d(:\d\d)?$/.test(match[4]) ? match[4] : undefined
    const rate = match[3] && !match[3].startsWith('Unknown') ? match[3] : undefined

    return {
      label: context.download ?? 'yt-dlp',
      n: Math.min(100, Number(match[1])),
      total: 100,
      unit: '%',
      rate,
      eta,
      postfix: match[2]?.replace(/\s+/g, ''),
    }
  }

  if ((match = HANDBRAKE.exec(line))) {
    context.lastDone = { label: 'HandBrake', marker: 'Encode done!' }

    const eta = match[5] ? `${Number(match[5])}:${match[6]}:${match[7]}` : undefined

    return {
      label: 'HandBrake',
      n: Math.min(100, Number(match[3])),
      total: 100,
      unit: '%',
      rate: match[4] ? `${match[4]} fps` : undefined,
      eta,
      postfix: match[2] !== '1' ? `task ${match[1]}/${match[2]}` : undefined,
    }
  }

  if ((match = PV.exec(line))) {
    return { label: 'pv', n: Number(match[4]), total: 100, unit: '%', rate: match[3], eta: match[5], postfix: match[1]?.replace(/\s+/g, '') }
  }

  if ((match = PV_OPEN.exec(line))) {
    const done = bytesOf(match[1] ?? '')

    return Number.isNaN(done) ? undefined : { label: 'pv', n: done, unit: 'B', rate: match[3] }
  }

  if ((match = SEVEN_ZIP.exec(line))) {
    context.lastDone = { label: '7-Zip', marker: 'Everything is Ok' }

    return { label: '7-Zip', n: Number(match[1]), total: 100, unit: '%', postfix: match[2]?.trim() }
  }

  // 7-Zip stops at 99 %, HandBrake at 99.94 %: their own word that the work is done completes the bar.
  if (context.lastDone && line === context.lastDone.marker) {
    return { label: context.lastDone.label, n: 100, total: 100, unit: '%' }
  }

  if ((match = DD.exec(line))) {
    return { label: 'dd', n: Number(match[1]), unit: 'B', rate: match[4], postfix: `${match[3]} s` }
  }

  return undefined
}

/** terraform applies and kubectl rollouts: steps counted over lines. */
function infraBar(line: string, context: ToolContext): Bar | undefined {
  let match = TF_PLAN.exec(line)

  if (match) {
    context.plan = { total: Number(match[1]) + Number(match[2]) + Number(match[3]), done: 0 }

    return { label: 'terraform', n: 0, total: context.plan.total || undefined, unit: ' changes' }
  }

  if ((match = TF_DONE.exec(line))) {
    context.plan = { total: context.plan?.total ?? 0, done: (context.plan?.done ?? 0) + 1 }

    return { label: 'terraform', n: context.plan.done, total: context.plan.total || undefined, unit: ' changes', postfix: `${match[1]} done` }
  }

  if ((match = TF_WORKING.exec(line))) {
    const resource = match[1] ?? match[2]
    const elapsed = match[3] ? ` ${match[3]}` : ''

    return { label: 'terraform', n: context.plan?.done ?? 0, total: context.plan?.total || undefined, unit: ' changes', postfix: `${resource}${elapsed}` }
  }

  if (TF_APPLIED.test(line) && context.plan) {
    return { label: 'terraform', n: context.plan.total, total: context.plan.total || undefined, unit: ' changes' }
  }

  if ((match = KUBE_PROGRESS.exec(line))) {
    context.rollout = { name: match[1] ?? '', total: Number(match[3]) }

    return {
      label: `rollout ${match[1]}`,
      n: Number(match[2]),
      total: Number(match[3]),
      postfix: match[4]?.startsWith('new') ? 'updated' : 'available',
    }
  }

  if ((match = KUBE_PENDING.exec(line))) {
    const total = context.rollout?.total

    return { label: `rollout ${match[1]}`, n: total ?? 0, total, postfix: `${match[2]} old pending` }
  }

  if ((match = KUBE_DONE.exec(line))) {
    const total = context.rollout?.total ?? 1

    return { label: `rollout ${match[1]}`, n: total, total }
  }

  return undefined
}

// pytest: `tests/test_api.py ....F.  [ 45%]`, or with -v `tests/test_api.py::test_a PASSED  [ 45%]`
const PYTEST = /^(\S+?\.py)\s+([.FEsxX]+)\s+\[\s*(\d{1,3})%\]$/
const PYTEST_VERBOSE = /^(\S+?\.py)::\S+\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\s+\[\s*(\d{1,3})%\]$/
// pip --progress-bar on: `   ---------------------------------------- 12.9/12.9 MB 10.9 MB/s eta 0:00:00`
const PIP = /^\s*[-━╸╺]+\s+([\d.]+)\/([\d.]+)\s+([kMG]?B)\s+([\d.]+\s*[kMG]?B\/s)\s+eta\s+(\d+:\d\d:\d\d)$/
const PIP_FILE = /^\s*Downloading (\S+)(?: \([\d.]+ [kMG]?B\))?$/
// robocopy: a file's line, `\t  New File\t\t 400.0 m\tbig.bin` (its words translated, its
// leading tab trimmed by the time it is read), then `  12.5%`
const ROBOCOPY_FILE = /^[^\t]+\t+\s*[\d.]+\s*[kmgt]?\t(.+)$/i
const ROBOCOPY_PERCENT = /^\s*(\d{1,3}(?:\.\d+)?)%$/
// rclone: `Transferred:   	    1.234 GiB / 3.000 GiB, 41%, 12.345 MiB/s, ETA 2m23s (xfr#3/10)`
const RCLONE = /^(?:Transferred:\s+)?(?:\d{4}\/\d\d\/\d\d [\d:]+\s+)?\s*([\d.]+ ?\w*B) \/ ([\d.]+ ?\w*B), (\d{1,3})%, ([\d.]+ ?\w*B\/s), ETA (\S+)/
// aws s3 cp/sync: `Completed 256.0 MiB/~1.0 GiB (12.3 MiB/s) with ~3 file(s) remaining`
const AWS_BYTES = /^Completed ([\d.]+ \w+)\/~?([\d.]+ \w+) \(([\d.]+ \w+\/s)\) with ~?(\d+) file\(s\) remaining/
const AWS_FILES = /^Completed (\d+) file\(s\) with ~?(\d+) file\(s\) remaining/
// Gradle's rich console: `<=====--------> 37% EXECUTING [12s]` (unverified; its plain console draws none)
const GRADLE = /<[=\-]+>\s*(\d{1,3})%\s+(EXECUTING|CONFIGURING|INITIALIZING|WAITING)(?:\s*\[([^\]]+)\])?/

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
}

/** `256.0 MiB` → bytes; NaN when it is no size. */
function bytesOf(text: string): number {
  const match = /^([\d.]+)\s*([KMGT]?i?B)(?:ytes)?$/i.exec(text.trim())
  const unit = match?.[2]?.toUpperCase() ?? ''

  return match && SIZE_UNITS[unit] !== undefined ? parseFloat(match[1] ?? '') * (SIZE_UNITS[unit] ?? 1) : NaN
}

/** Test runs and copies: pytest, pip downloads, robocopy, rclone, aws s3, Gradle. */
function runBar(line: string, context: ToolContext): Bar | undefined {
  let match = PYTEST.exec(line)

  if (match) {
    const marks = match[2] ?? ''
    const fail = (marks.match(/[FE]/g) ?? []).length

    context.tests = { ok: (context.tests?.ok ?? 0) + marks.length - fail, fail: (context.tests?.fail ?? 0) + fail }

    return { label: 'pytest', n: Number(match[3]), total: 100, unit: '%', ok: context.tests.ok, fail: context.tests.fail, postfix: match[1] }
  }

  if ((match = PYTEST_VERBOSE.exec(line))) {
    const isFail = match[2] === 'FAILED' || match[2] === 'ERROR'

    context.tests = { ok: (context.tests?.ok ?? 0) + (isFail ? 0 : 1), fail: (context.tests?.fail ?? 0) + (isFail ? 1 : 0) }

    return { label: 'pytest', n: Number(match[3]), total: 100, unit: '%', ok: context.tests.ok, fail: context.tests.fail, postfix: match[1] }
  }

  if ((match = PIP_FILE.exec(line))) {
    context.pipFile = match[1]

    return undefined
  }

  if ((match = PIP.exec(line))) {
    return {
      label: context.pipFile ?? 'pip',
      n: parseFloat(match[1] ?? ''),
      total: parseFloat(match[2] ?? '') || undefined,
      rate: match[4],
      eta: match[5],
      postfix: match[3],
    }
  }

  if ((match = ROBOCOPY_FILE.exec(line))) {
    context.copyFile = match[1]?.trim()

    return undefined
  }

  if (context.copyFile && (match = ROBOCOPY_PERCENT.exec(line))) {
    return { label: 'robocopy', n: Math.min(100, Number(match[1])), total: 100, unit: '%', postfix: context.copyFile }
  }

  if ((match = RCLONE.exec(line))) {
    return {
      label: 'rclone',
      n: Number(match[3]),
      total: 100,
      unit: '%',
      rate: match[4],
      eta: clockOf(match[5]),
      postfix: `${match[1]} / ${match[2]}`,
    }
  }

  if ((match = AWS_BYTES.exec(line))) {
    const done = bytesOf(match[1] ?? '')
    const total = bytesOf(match[2] ?? '')

    if (!Number.isNaN(done) && !Number.isNaN(total) && total > 0) {
      return { label: 'aws s3', n: done, total, rate: match[3], postfix: `${match[4]} file(s) left` }
    }
  }

  if ((match = AWS_FILES.exec(line))) {
    const done = Number(match[1])

    return { label: 'aws s3', n: done, total: done + Number(match[2]), unit: ' files' }
  }

  if ((match = GRADLE.exec(line))) {
    return { label: 'Gradle', n: Number(match[1]), total: 100, unit: '%', postfix: [match[2], match[3]].filter(Boolean).join(' ') }
  }

  return undefined
}

export function toolBar(line: string, context: ToolContext): Bar | undefined {
  const run =
    runBar(line, context) ?? testBar(line, context) ?? infraBar(line, context) ?? mediaBar(line, context) ?? computeBar(line)

  if (run) {
    return run
  }

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

  // 7-Zip rewrites its line with backspaces, not carriage returns: a run of them ends an update too.
  const segments = tail.replace(OSC_PROGRESS, '\n').replace(ANSI, '').replace(/\x08+/g, '\r').split(/\r\n|\n|\r/)
  const context: ToolContext = {}
  // ffmpeg prints its duration once, at the start: look for it before the tail too.
  const duration = FFMPEG_DURATION.exec(text.slice(0, 64 * 1024))

  if (duration) {
    context.duration = seconds(duration[1], duration[2], duration[3])
  }
  const parsed: Parsed = {}
  const protocol: Protocol = {}
  let hasProtocol = false
  // tqdm bars by label, in the order first seen, with the segment of their last update.
  const bars = new Map<string, { bar: Bar; at: number; isTqdm: boolean }>()
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

      bars.set(key, { bar, at, isTqdm: tqdm !== undefined })

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
    parsed.isExact = protocol.main !== undefined
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
    parsed.isExact = main.isTqdm
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
