"""The ##progress protocol: 4 steps, sub-steps with and without totals, ~25 s."""
import time


def say(line):
    print(line, flush=True)


steps = [("Download", 30), ("Unpack", None), ("Index", 50), ("Report", 10)]
for i, (label, total) in enumerate(steps, start=1):
    say(f'##progress step={i}/{len(steps)} label="{label}"')
    for n in range(1, (total or 40) + 1):
        sub = f"{n}/{total}" if total else str(n)
        say(f'##progress sub={sub} sublabel="{label.lower()} items"')
        time.sleep(0.12)
say('##progress msg="pipeline complete"')
