# The `##progress` protocol

A line protocol any process can print to report progress to **tqdm-claude**,
the Claude Code mod that draws live progress bars above the prompt. It is meant
for scripts that Claude Code (or you) write, and for tools wrapped by them. tqdm
output needs nothing extra: the mod already reads it.

## Rules

- One directive per line, starting with `##progress` (leading spaces allowed).
- Then `key=value` pairs separated by spaces. Quote values that hold spaces:
  `label="Build docs"`. There is no escaping inside quotes.
- Write to stdout or stderr, **unbuffered** (see [Flushing](#flushing)).
- Every directive updates the state left by the previous ones: send only what
  changed.
- Unknown keys are ignored, so later versions stay compatible.

## Keys

| Key | Value | Effect |
|---|---|---|
| `step` | `N/TOTAL` or `N` | The main bar: step N of TOTAL. A new step clears the last step's sub-bar, unless the same line sets `sub`. |
| `label` | text | The main bar's label. |
| `sub` | `N/TOTAL`, `N` or `N/?` | The sub-bar under the main one. With no total it draws as a count with a sweeping bar. |
| `sublabel` | text | The sub-bar's label. |
| `pct` | number 0–100 | The main bar as a bare percentage. |
| `rate` | text | Shown after the bar the line updates (`sub` if the line has `sub`/`sublabel`, else main). Example: `rate=312it/s`. |
| `eta` | `mm:ss` or `h:mm:ss` | Time left for that bar. On the main bar it sets the header's estimate. |
| `unit` | text | Unit shown after a count with no total (`files`, `MB`). |
| `ok`, `fail` | numbers | Of the bar's count, how many succeeded and failed: the filled part is drawn green and red, and both are counted after the figures. |
| `msg` | text | A status line, shown on failure or when there are no bars. |
| `done` | `ok` or `fail` | The work is finished even though the process may keep running (a server after warm-up, a watcher). `fail` turns the task red at once. |

The process's exit code is still the final word: a task that exits non-zero is
shown as failed, whatever it declared.

## Examples

```text
##progress step=1/4 label="Download"
##progress sub=120/400 sublabel="files"
##progress sub=400/400
##progress step=2/4 label="Unpack"
##progress sub=37 unit=archives
##progress step=3/4 label="Train" sub=1840/2400 sublabel="Epoch 3" rate=312it/s eta=00:06
##progress pct=97.5
##progress msg="writing report"
##progress done=ok
```

### Python

```python
def progress(**fields):
    parts = [f'{k}="{v}"' if " " in str(v) else f"{k}={v}" for k, v in fields.items()]
    print("##progress " + " ".join(parts), flush=True)

for i, shard in enumerate(shards, 1):
    progress(step=f"{i}/{len(shards)}", label=f"Shard {shard}")
    for j, row in enumerate(rows, 1):
        if j % 100 == 0:
            progress(sub=f"{j}/{len(rows)}", sublabel="rows")
```

### Bash

```bash
total=${#files[@]}; i=0
for f in "${files[@]}"; do
  i=$((i+1)); echo "##progress step=$i/$total label=\"$f\""
  process "$f"
done
```

### PowerShell

```powershell
$i = 0
foreach ($f in $files) {
  $i++; Write-Output "##progress step=$i/$($files.Count) label=`"$($f.Name)`""
  Process-File $f
}
```

### Node

```js
const progress = fields => console.log('##progress ' + Object.entries(fields)
  .map(([k, v]) => (String(v).includes(' ') ? `${k}="${v}"` : `${k}=${v}`)).join(' '))
```

## Flushing

The mod reads the task's output file. Output held in a buffer is invisible
until it is flushed, which looks exactly like a frozen task.

| Runtime | Make it unbuffered |
|---|---|
| Python | `python -u script.py`, or `PYTHONUNBUFFERED=1`, or `print(..., flush=True)` |
| Node | `console.log` is line-buffered to files; `process.stdout.write` too |
| C / C++ / most Unix tools | `stdbuf -oL cmd` (Linux), `setvbuf(stdout, NULL, _IOLBF, 0)` |
| Ruby | `$stdout.sync = true` |
| Bash / PowerShell | `echo` / `Write-Output` lines are written at once |

## Rate

Two to ten updates a second is plenty: the band redraws once a second from the
file. Printing on every loop iteration of a tight loop only grows the log; the
mod reads the last 64 KiB and stops parsing logs over 4 MiB (it then shows a
sweeping bar and says the log is too large).

## What else is read

Without directives the mod falls back, in order, on:

1. **tqdm** bars (`desc: 45%|████▌     | 45/100 [00:09<00:11, 4.90it/s]`), with
   or without a total, scaled units, postfix (`loss=0.23`, shown beside the
   bar), and nested bars (`position=`): the outer bar is the main one, the
   latest inner one the sub-bar. Hugging Face and PyTorch Lightning print tqdm.
2. **Other tools**, each by its exact shape:

   | Tool | Line | To get progress in a log |
   |---|---|---|
   | cargo | `Building [=====>   ] 120/300: serde, syn` | `CARGO_TERM_PROGRESS_WHEN=always CARGO_TERM_PROGRESS_WIDTH=80` |
   | ninja | `[12/345] Building CXX object a.o` | on by default |
   | CMake (make) | `[ 45%] Building CXX object a.o` | on by default |
   | git | `Receiving objects:  45% (450/1000), 1.20 MiB \| 2.40 MiB/s` | `git clone --progress` |
   | Keras | `Epoch 3/10` then `32/100 [====>....] - ETA: 0:02 - loss: 0.3` | `verbose=1` |
   | docker buildx | `#7 [builder 3/5] RUN pip install ...` | `docker build --progress=plain` |
   | ffmpeg | `Duration: 00:05:00.00` then `... time=00:01:15.00 ... speed=2x` | on by default (stderr) |
   | rsync | `1,234,567  45%  12.34MB/s  0:00:05 (xfr#12, to-chk=88/100)` | `--info=progress2` |
   | wget | `file.iso  45%[=====>   ]  1.08G  2.31MB/s  eta 20s`, or the dot style | `--progress=bar:force` |
   | curl | its default meter, or `#####   48.2%` with `-#` | on by default (stderr) |
   | pnpm | `Progress: resolved 123, reused 100, downloaded 20, added 0` | `--reporter=append-only` |
   | apt | `Progress: [ 45%]`, or `pmstatus:dpkg-exec:50.0:...` | `-o Dpkg::Progress-Fancy=1`, `-o APT::Status-Fd=1` |
   | pytest | `tests/test_api.py ....F.  [ 45%]`, or `-v` lines `... PASSED  [ 45%]`; passes and failures are counted into a two-color bar | on by default |
   | pip | `---------------------------------------- 6.4/12.9 MB 10.9 MB/s eta 0:00:01` | `--progress-bar on` (off when not a terminal) |
   | robocopy | the file's line, then `  12.5%` (in any language) | on by default (`/NP` turns it off) |
   | rclone | `Transferred: 1.234 GiB / 3.000 GiB, 41%, 12.3 MiB/s, ETA 2m23s` | `--progress` or `--stats 1s` |
   | aws s3 | `Completed 256.0 MiB/~1.0 GiB (12.3 MiB/s) with ~3 file(s) remaining` | on by default (`--no-progress` turns it off) |
   | git lfs | `Downloading LFS objects:  45% (9/20), 12 MiB \| 3.4 MiB/s` | as git |
   | Gradle | `<=====-----> 37% EXECUTING [12s]` (unverified) | `--console=rich`; the plain console draws no bar |
   | any | OSC 9;4 sequences (`ESC ] 9 ; 4 ; 1 ; 42 BEL`) | as the tool emits them |

   PowerShell's `Write-Progress` (and `Invoke-WebRequest`'s bar) goes to a
   stream of its own that never reaches a task's output file: use
   `Write-Output "##progress ..."` in PowerShell scripts instead.

   A bare `n/m` in an ordinary line is never read as progress: it is too
   often something else (`Saved 10/11 files`, a date).
3. A **bare percentage** in the last line that has one (`Converting... 37%`).
4. Nothing: a sweeping bar with the last line of output; after 15 s with no
   output at all, a hint that the output is probably buffered.

It also keeps the last line that looks like an error (a Python exception,
`command not found`, `No such file or directory`, `Permission denied`, `FATAL`,
`panic:`, `Killed`...) and shows it if the task fails.
