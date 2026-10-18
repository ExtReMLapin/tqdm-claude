# tqdm-claude

Installation : `/plugin install tqdm-claude --marketplace ExtReMLapin/tqdm-claude`

**Live progress bars inside Claude Code for background tasks and subagents.**
A Claude Code mod (a plugin built on the function-hooks API) that draws
tqdm-style bars above the prompt for every background shell task. It reads the
task's own output (tqdm, cargo, git, Keras, ffmpeg and more, or a one-line
protocol) and shows crashes, stalls and silent failures the moment they happen.

*Named after and inspired by [tqdm](https://github.com/tqdm/tqdm); not affiliated with it.*

<img width="1675" height="526" alt="WindowsTerminal_8dZBUvjYKE" src="https://github.com/user-attachments/assets/5d5fb6c2-cfd0-49bd-a4ce-91af0346f0fd" />


…and a summary at the end of the hint line under the prompt, beside Claude
Code's own task pills: `esc to interrupt  ⠹ Train model 40% · ✗ Index docs`.

## Why

Claude Code runs long jobs in the background and gets a notification when they
end. Until then you see nothing: no progress, no ETA. And when a script dies
mid-way, or a regex in a watcher never matches, nothing says so. tqdm-claude
makes every background task visible and makes failure loud.

## Features

- **Real progress, read from the task's output**: tqdm (with or without a
  total, scaled units, postfix metrics, nested bars), cargo, ninja, CMake, git,
  Keras, docker buildx, ffmpeg (a real percentage from its duration), rsync,
  wget, curl, pnpm, apt, pytest (passes and failures in two colors), pip,
  robocopy, rclone, aws s3, git lfs, Gradle, OSC 9;4, bare percentages. See [PROTOCOL.md](PROTOCOL.md#what-else-is-read).
- **Two levels**: a main bar and a sub-bar (step 3/7, then 1840/2400 within it).
- **A one-line protocol** for scripts: `##progress step=3/7 label="Train" sub=1840/2400`.
  Claude is told about it, so the scripts it writes report progress.
- **Indeterminate tasks animate**: a sweeping bar and the latest log line.
- **Failures stay**: `✗`, the exit code and the error line (Python exceptions,
  `command not found`...), until you dismiss them. Exit 0 short of the total is
  flagged too: `! (!) 45/100`.
- **Stalls are flagged**: `! no output for 02:10`. **Silence at start** gets a
  hint: output is probably buffered (`python -u`).
- **ETA** from tqdm's own smoothed estimate, else from the pace since progress
  started (start-up left out).
- **Subagents** from the tasks list, with elapsed time and how they ended.
- **Notifications** through your own channel when a task fails or ends early
  (or, if you like, when a long one succeeds), so you can look away.
- **A stuck turn is called out**: no tool call for 3 minutes.
- **Outcomes in two colors**: `##progress ok=30 fail=10` splits the bar.
- **The spinner follows the pace**: faster when a task speeds up, slow when it
  stands still (after alive-progress).
- **Plays well with other mods**: the band is drawn above theirs, the footer
  summary is added after theirs; a task ends on its notification, on
  `TaskStop`, or when the session stops listing it at a turn's end.
- **Foreground commands** longer than 3 s get a spinner too.
- **Works everywhere Claude Code does**: Windows, macOS, Linux, terminal and
  desktop. Glyphs follow tqdm's lead: Unicode eighth-blocks by default, ASCII
  where the locale is not UTF-8, and a code-page-437 set for fonts that lack
  the others.

## Install

At the Claude Code prompt:

```
/plugin install tqdm-claude --marketplace ExtReMLapin/tqdm-claude
```

From a shell: `claude plugin install tqdm-claude --marketplace ExtReMLapin/tqdm-claude`.
In the desktop app: **+** next to the prompt → Plugins → Add marketplace
`ExtReMLapin/tqdm-claude` → Add plugin.

The mod is active at once; start a long command in the background to see it.

## Settings

In `/config` (or `pluginConfigs` in settings):

| Option | Default | |
|---|---|---|
| `charset` | `auto` | `unicode`, `blocks` (code page 437, if your font shows boxes), or `ascii`. |
| `footer` | `true` | The summary at the end of the hint line. |
| `agents` | `true` | Follow subagents too. |
| `notify` | `failures` | Native notification when a task fails or ends early; `always` adds stops and successes of a minute or more; `off`. |
| `stuck` | `true` | Warn when a turn has had no tool call for 3 minutes: Claude may be stuck. |

## Commands

- `/tqdm`: lists followed tasks with their status and output file.
- `/tqdm clear`: drops finished and failed tasks from the band.

## For scripts and other Claude Code instances

Print `##progress` lines, unbuffered. The spec, with Python, Bash, PowerShell
and Node helpers, is in [PROTOCOL.md](PROTOCOL.md). The mod adds a short note
on it to Claude's system prompt and ships the `progress-protocol` skill, which
says the same where organization policy keeps plugins out of the system prompt.

## How it works

| Hook | What it does |
|---|---|
| `tool.call` (Bash, PowerShell) | Notes each background task's id and output file; times foreground calls. |
| `tool.call` (TaskStop, every tool) | Ends a stopped task; times tool calls for the stuck-turn warning. |
| `session.append` | Reads `<task-notification>` rows: how a task ended, with its exit code. |
| `classic.Stop` | At a turn's end, ends tasks the session no longer lists. |
| `prompt.submit`, `turn.complete` | Whether a turn is running. |
| `$.ui.notify` | Tells you of a failure through your notification channel. |
| `$.clock.every` | Reads changed output files once a second; animates at ~4 fps while something runs. |
| `$.agent.list()` | Mirrors the tasks list's subagents. |
| `ui.render` `AbovePrompt` | Draws the band. |
| `ui.render` `PromptHint` | Adds the summary after Claude Code's own hint line. |
| `prompt.compose` | Tells Claude about the protocol and unbuffered output. |

It never runs your tasks, never writes to their output, and never emits OSC 9;4
itself (Claude Code drives the terminal's own progress indicator).

## What it reads, writes and sends

**Nothing leaves your machine.** The mod makes no network request (no
`$.http`), starts no process (no `$.process`) and writes no file.

What it **reads**:

- **Task output files** (`$.fs.stat`, `$.fs.read`): only the output file
  Claude Code itself names when it starts a background Bash or PowerShell task
  (`Output is being written to: …`), the last 64 KiB of it, to draw the bars.
  No other file.
- **Conversation rows** (`session.append`): only rows holding a
  `<task-notification>`, for a task's id, status and exit code. Other rows pass
  through untouched and unread.
- **Prompts** (`prompt.submit`): only the moment a turn starts, for the
  stuck-turn warning. The prompt's text is not read, kept or changed.
- **Tool calls** (`tool.call`): a Bash or PowerShell call's `description`,
  `command` (its first line, as the title when there is no description) and
  `run_in_background`, and the task id in its result; `TaskStop`'s task id; the
  start and end of every call, for the stuck-turn warning. Every call goes on
  unchanged.
- **The tasks list** (`$.agent.list`, `classic.Stop`): subagents' description
  and status, and the ids of background tasks still running at a turn's end.
- **Three environment variables** (`LC_ALL`, `LC_CTYPE`, `LANG`): to pick ASCII
  bars where the locale is not UTF-8.

What it **sends**, and where:

- **`$.ui.notify`**: when a task fails or ends early (or, with
  `notify=always`, when a long one ends), a native notification with the
  task's title, its exit code and its last error line. It goes to *your own*
  notification channel, the one Claude Code uses for its own notifications
  (your terminal's notification, or its bell), on this machine. Turn it off
  with `notify=off`.

What it **changes**:

- **The system prompt** (`prompt.compose`): adds one section, `tqdm-claude:protocol`,
  telling Claude to run long commands in the background, to keep their output
  unbuffered and to print `##progress` lines. Nothing else in the prompt is
  read or changed. It is not added under `--bare`.
- **The screen** (`ui.render`): draws the band above the prompt, above any
  other plugin's band, and adds a summary after the hint line under the prompt,
  after any other plugin's.
- **Commands** (`command.register`, `command.run`): adds `/tqdm` and answers
  only it; other commands pass through untouched.

The settings of the mod (its `charset`, `footer`, `agents`, `notify`, `stuck`
options) are Claude Code's own; the tasks it follows live in Claude Code's
session state and are gone when the session ends.

## Limits

- Foreground commands show a spinner and elapsed time only: their output is not
  readable while they run. Long jobs belong in the background anyway.
- Only the last 64 KiB of an output is parsed; past 4 MiB the band shows a
  sweeping bar and says the log is too large.
- Progress hidden by a tool when its output is not a terminal can't be read:
  see the "to get progress in a log" column in [PROTOCOL.md](PROTOCOL.md).
- Built on Claude Code's early-access function-hooks API, which may change
  between releases. Needs Claude Code 2.1.302 or later (tested on 2.1.302).
- Where an organization manages Claude Code, hooks on `prompt.compose` and
  `classic.Stop` run only for plugins it lists: there, Claude learns the
  protocol from the bundled skill instead, and a task ends on its notification
  or `TaskStop` only.

## Development

```bash
claude plugin validate .
claude plugin test .          # 164 tests: parser (on real tool output), rendering, charsets, signals, the band end to end
```

`claude --plugin-dir .` runs a session with the mod loaded from this folder.
[scenarios/](scenarios/README.md) holds scripts that exercise every case in a
real session (tqdm single and nested, crash, stall, plain logs, sequential
bars, huge output, other tools...). `tests/fixtures/real-tqdm.ts` is genuine
tqdm output, regenerated with `python scenarios/capture_real_tqdm.py`.
