---
name: progress-protocol
description: Use when launching any shell command or script expected to run longer than ~30 seconds (training, builds, downloads, data processing, test suites, migrations), or when writing such a script. The tqdm-claude mod shows live progress bars for background tasks; this explains how to make them informative and how to report how a task ended.
---

# Long-running commands with tqdm-claude

The person sees a live band above the prompt for every background Bash or
PowerShell task: a bar per task, read from its output file each second, plus a
red line when a task fails and a warning when it goes silent.

## Launching

1. Run it with `run_in_background: true` when it may take more than ~30 s.
2. Give the call a short `description`: it is the task's title in the band.
3. Make output unbuffered, or the band sees nothing until the end:
   `python -u`, `PYTHONUNBUFFERED=1`, `print(..., flush=True)`, `stdbuf -oL`.
4. Keep tqdm's output: it is parsed as is (nested bars included). Do not pass
   `disable=True` or redirect it to `/dev/null`.

## Writing a script

Print progress lines, one per update, two to ten a second at most:

```text
##progress step=3/7 label="Training" sub=1840/2400 sublabel="Epoch 3"
```

`sub=1840` with no total when unknown; `pct=45` for a bare percentage;
`ok=12 fail=2` to count outcomes (the bar turns red for the failed part);
`msg="..."` for a status; `done=ok` or `done=fail` when a process that keeps
running has finished its work. The full spec is `PROTOCOL.md` in the mod.

## When it ends

You get a task notification with the exit code. Report it to the person in
one line, success or not. Never infer success from silence: a task with no
notification is still running or stuck, and the band says which.
