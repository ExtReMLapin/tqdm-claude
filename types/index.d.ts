/** One progress bar: `n` of `total` (total absent when unknown). */
export type Bar = {
  label?: string
  n: number
  total?: number
  unit?: string
  rate?: string
  eta?: string
  /** What follows the rate: tqdm's postfix (`loss=0.231`), Keras metrics, cargo's crates. */
  postfix?: string
  /** Of `n`, how many succeeded and failed (`##progress ok=12 fail=2`): the bar is drawn in two colors. */
  ok?: number
  fail?: number
}

/** What the main loop is doing, to tell a long think from a stuck one. */
export type Activity = {
  isTurnRunning: boolean
  /** The last time a tool call started or ended, or a turn started. */
  lastAt: number
  /** Tool calls running now: while one runs, the turn is waiting on it, not stuck. */
  runningTools: number
}

/** What the parser reads out of a task's output. */
export type Parsed = {
  main?: Bar
  sub?: Bar
  lastLine?: string
  error?: string
  /** Set by a `##progress done=ok|fail` line. */
  declared?: 'ok' | 'fail'
}

export type TrackStatus = 'running' | 'done' | 'failed' | 'killed'

/** One task followed by the band. */
export type Track = {
  id: string
  label: string
  /**
   * `bg`: a background shell whose output file is polled; `fg`: a foreground
   * call; `agent`: a subagent from `$.agent.list()`, the tasks list's own rows.
   */
  kind: 'bg' | 'fg' | 'agent'
  outputFile?: string
  startedAt: number
  endedAt?: number
  status: TrackStatus
  exitCode?: number
  main?: Bar
  sub?: Bar
  lastLine?: string
  error?: string
  /** Last time the output changed (file mtime), for stall detection. */
  lastChangeAt: number
  size: number
  /** The output file is past what one read may copy: progress is no longer parsed. */
  isTooBig?: boolean
  /** When the main bar was first seen, and how far along: the estimate leaves out the start-up before it. */
  progressFrom?: { at: number; fraction: number }
  /** The main bar at the last poll that moved it, for the recent pace. */
  lastSample?: { at: number; fraction: number }
  /** Recent pace over average pace, 0.25 to 4: the spinner turns faster or slower with it (alive-progress). */
  paceRatio?: number
  /**
   * Ended because the session stopped listing it at a turn's end, before its
   * notification said how: shown as done until the notification corrects it.
   */
  isUnconfirmed?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'tqdm-claude': { tracks: Track[]; now: number; second: number; activity: Activity }
  }
}
