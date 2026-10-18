# Contributing

Thanks for helping. The most useful contribution is **a tool whose progress the
band does not read yet**. Bug reports with a screenshot and the task's output
file are the next most useful.

## Before you start

You need Claude Code 2.1.302 or later. From the repository:

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .        # a session with your working copy loaded
```

If you also installed the mod from the marketplace, uninstall it while you
work: two copies with one name get in each other's way.

## Adding a tool

Every format the mod reads was checked against the tool's real output. Please
keep it that way: no formats from memory or from documentation alone.

1. **Capture real output, the way Claude Code sees it.** Run the tool with its
   output redirected to a file and no terminal attached, stdout and stderr
   together:

   ```bash
   my-tool --its-progress-flag > out.txt 2>&1 < /dev/null
   ```

   Many tools print no progress when they are not on a terminal: find the flag
   that forces it (`--progress`, `-bsp1`, `--console=rich`...) and note it.
   Keep the bytes as they are: carriage returns and backspaces matter. In
   Python, read and write in binary mode.

2. **Scrub it.** Replace local paths, user names and host names. Keep the rest
   byte for byte. Add it to a fixture in `tests/fixtures/` (keep each file under
   256 KiB: the tail is what matters).

3. **Write the regex** in `hooks/parse.ts`, beside the tools of its family,
   with a comment quoting one real line and the tool's version:

   ```ts
   // mytool 2.3 (--progress): `[mytool] 45% 120/267 files, 3.2 MB/s`
   const MYTOOL = /^\[mytool\] (\d{1,3})% (\d+)\/(\d+) files, (\S+\/s)/
   ```

   Anchor it (`^`) and match the tool's own words: a bare `n/m` anywhere in a
   line is never read as progress, it is too often something else.

4. **Test it on the capture**, at least:
   - mid-run: cut the capture after one update and check the bar;
   - at the end: the whole capture;
   - a line that only looks like it, which must not match.

   See `tests/media.test.ts` for the pattern (`upTo(fixture, marker)`).

5. **Document it** in PROTOCOL.md's table: the line, and the flag that makes
   the tool print it to a file.

If the tool cannot be installed where you are, capturing it in a container
(`docker run` without `-t`) is fine. If it truly cannot be run, say so in the
pull request and point at the source code that prints the line.

## Other changes

- Run `claude plugin validate .` and `claude plugin test .` before you push.
- A bug fix comes with a test that fails without the fix.
- If you add a call to `$.fs`, `$.env`, `$.process`, `$.http` or `$.ui.notify`,
  update README's "What it reads, writes and sends": the Anthropic directory's
  review reads it.
- Keep `CLAUDE.md` true: it lists the traps we already fell into.

## Releasing (maintainers)

Bump `version` in `.claude-plugin/plugin.json`: users only receive a new copy
when it changes.
