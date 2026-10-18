# Scenarios

Scripts that exercise the band end to end in a real Claude Code session. They
need Python 3.8+ and nothing else (`12_real_tqdm.py` uses the real tqdm if it
is installed). They run the same on Windows, macOS and Linux.

Ask Claude, in a session with the mod loaded:

> Run `python -u scenarios/01_tqdm_single.py` in the background, description "Train".

or several at once:

> Run scenarios 01, 02 and 05 in the background, each with its own description.

| Script | Lasts | What the band should show |
|---|---|---|
| `01_tqdm_single.py` | ~20 s | One bar with count, %, rate; `elapsed / ~total` in the header; then `✓`, gone after 8 s. |
| `02_tqdm_nested.py` | ~30 s | Main bar `Epochs n/5`, sub-bar `└ Batches n/60` under it. |
| `03_tqdm_no_total.py` | ~15 s | A sweeping bar, a growing count (`123it`) and its rate. |
| `04_protocol_pipeline.py` | ~25 s | `##progress`: 4 steps, one sub-step with no total (sweeping), labels changing per step. |
| `05_crash.py` | ~8 s | Bar stops at 40 %, then `✗` and a red line `exit code 1 · KeyError: 'path'` that stays until `[x]` is pressed. |
| `06_stall.py` | ~100 s | After a minute without output: `! no output for 01:0x` in yellow; it clears when output resumes. |
| `07_plain_logs.py` | ~20 s | No progress: a sweeping bar with the latest log line beside it. |
| `08_bare_percent.py` | ~15 s | A bar from `Converting video... 37%`. |
| `09_sequential_bars.py` | ~15 s | One bar per file, following the current file (finished ones are not kept as main). |
| `10_declared_fail.py` | ~23 s | Red after 3 s (`done=fail`, `port 8080 already in use`) though the process is still running. |
| `11_huge_output.py` | ~10 s | Over 4 MiB of output: `(log too large to parse)` and a sweeping bar; nothing freezes. |
| `12_real_tqdm.py` | ~8 s | Genuine tqdm, nested with `position=`: the same as 02. |
| `13_many_tasks.py N` | ~15 s | Run six with N = 1..6: the band keeps to its rows and ends with `+N more · /tqdm`. |
| `14_other_tools.py` | ~30 s | cargo, git, ninja, Keras (epochs over steps, with metrics), docker buildx, then ffmpeg with a real percentage. |
| `python -u -c "import time; time.sleep(30)"` | 30 s | After 15 s: the yellow hint that output may be buffered. |

Also worth checking by hand:

- **Foreground**: `python -u scenarios/07_plain_logs.py` *without* background:
  nothing for 3 s, then a sweeping bar until it returns.
- **Kill**: start `06_stall.py`, then ask Claude to stop it: `■` and `stopped`.
- **Footer**: with a task running, the hint line under the prompt ends with
  `⠙ Train 43%`.
- **Subagents**: ask for a background subagent; it shows with its description
  and elapsed time, then `✓` or `✗`.
- **Charsets**: set the mod's `charset` option to `blocks`, then `ascii`
  (`/config`), and rerun 01.
- **`/tqdm`** lists followed tasks and their output files; `/tqdm
  clear` drops finished ones.

`capture_real_tqdm.py` regenerates `tests/fixtures/real-tqdm.ts` from the
installed tqdm, the genuine output the unit tests check the parser against.
