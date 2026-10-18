# tqdm-claude

A Claude Code mod: a plugin whose `hooks/register.tsx` hooks module draws live
progress bars for shell tasks and subagents. Read README.md for what it does,
PROTOCOL.md for the formats it reads, CONTRIBUTING.md for adding one.

## Commands

```bash
claude plugin validate .   # manifest + hooks module, as the engine and the directory read them
claude plugin test .       # every tests/*.test.ts(x), in the engine's own test kit
```

Type-check with TypeScript 5.4+ against the engine's declarations (the editor
gets them in `.claude-plugin/types/` once the mod has loaded from a folder it
watches; that folder is git-ignored and must never be committed).

## Layout

- `hooks/parse.ts`: pure. Output text → bars. One regex per tool, each with a
  comment quoting a real line and the version it came from.
- `hooks/render.ts`: pure. Bars → cells, figures, labels, notices.
- `hooks/charset.ts`: glyph sets and terminal cell widths.
- `hooks/register.tsx`: the hooks. All engine calls live here.
- `tests/fixtures/`: real tool output, captured with no terminal attached.

## Things that are not obvious (each one cost a debugging round)

**Plugin identity**
- Plugin names may not start with `claude-`, `anthropic-` or `cc-plugin-`:
  `claude plugin validate` rejects them as reserved.
- Never rename `name` in `plugin.json` while the mod is hot-loaded: the engine
  keeps the old identity, every `$.state` call is refused, the band vanishes
  silently. Restart the session after a rename.
- Never load a dev copy beside the installed plugin (same name): unloading one
  breaks the other's state for a moment.
- Users receive an update only when `version` in `plugin.json` changes. Bump it
  on every release; the directory's checklist requires the field.

**Sharing the screen**
- `AbovePrompt`: `await next(e)` first and draw it below our tree. Never return
  only our tree: that erases other plugins' bands.
- `PromptHint.tail`: append to the tail we were handed, never replace it.
- `SessionMode` (right of the hint line) is never cut; `tail` is; `$.ui.status`
  draws as a yellow plugin warning. The tasks list has no render site at all.
- Never emit OSC 9;4: Claude Code drives the terminal's progress indicator.

**Where output comes from**
- Background shells: the path is in the result text (`Output is being written
  to: …`); `backgroundOutputPath` is `@internal` and usually absent.
- Foreground shells also write live to `<tasks>/b????????.output` (checked by
  watching the file grow); the API alone says otherwise (`ToolUse.output` is
  undefined while running). We list the folder before the call and claim the
  file that appears next.
- Subagents' tool calls carry `agentId`: their shells are ignored, the subagent
  is followed as one task. Subagent output files are named otherwise (not `b` +
  8 characters), so they are never claimed.
- On Windows the engine spells paths with `\` whatever we joined them with:
  compare file names, not full paths (and make test fixtures use `\`).

**Parsing**
- Output files use `\r` (tqdm), `\b` (7-Zip) or `\n` to update in place; split
  on all three. Claude Code appends `[exited with code N]`: ignore it.
- A clean exit short of the total is flagged only for tqdm and `##progress`
  bars (`isExact`): other tools stop short on success (Spark ends at 48/50,
  7-Zip and HandBrake at 99 %).
- Under Claude Code, `CLAUDECODE` is set: jest and vitest switch to their terse
  agent reporters. Test both forms.

**Code and tests**
- In `.tsx`, a `*/` inside a comment (`claude*/…`) ends the comment and breaks
  the whole module: every test then fails at once.
- Test-kit hooks that stand for an engine operation (`fs.*`, `ui.notify`,
  `agent.list`) answer `{ value }` or `{ deny }`, not the bare value.
- `session.append` and `classic.Stop` work is deferred with `$.clock.after(0)`:
  tests `await clock.advance(0)` after raising them. Notifications are batched
  for 1.5 s: advance past that before checking them.
- Prove a regression test guards something: revert the fix, see it fail.

**The directory review**
- README's "What it reads, writes and sends" is what clears the review's data
  holds. Any new `$.fs`, `$.env`, `$.process`, `$.http` or `$.ui.notify` use
  must be listed there, and the README must stay true ("no network, no
  process").
- No binaries in the repo (`__pycache__`, images other than the icon), no file
  over 256 KiB, no local paths or names in fixtures.

## Conventions

- Match the surrounding code: comments say why, in full sentences; names read
  as English (`isShortOfTotal`, `barParts`).
- Every parser change ships with a test on real output (see CONTRIBUTING.md).
- Commits: one subject line in the imperative, a body saying why.
