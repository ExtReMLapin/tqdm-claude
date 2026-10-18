"""Prints bars the way tqdm's format_meter does, with no dependency.

The scenarios use it so they run anywhere Python 3.8+ runs; `real_tqdm.py`
uses the real library to check the parser against the genuine article.
"""

import sys
import time

UTF = " " + "".join(chr(c) for c in range(0x258F, 0x2587, -1))  # tqdm's Bar.UTF


def interval(seconds):
    seconds = int(seconds)
    minutes, s = divmod(seconds, 60)
    hours, m = divmod(minutes, 60)
    return f"{hours:d}:{m:02d}:{s:02d}" if hours else f"{m:02d}:{s:02d}"


def bar(frac, width=10):
    frac = min(max(frac, 0.0), 1.0)
    steps = len(UTF) - 1
    filled, rest = divmod(int(frac * width * steps), steps)
    out = UTF[-1] * filled
    if filled < width:
        out += UTF[rest] + UTF[0] * (width - filled - 1)
    return out


def meter(n, total, elapsed, desc="", unit="it"):
    prefix = f"{desc}: " if desc else ""
    rate = n / elapsed if elapsed > 0 else 0
    rate_text = f"{rate:5.2f}{unit}/s" if rate else f"?{unit}/s"
    if total is None:
        return f"{prefix}{n}{unit} [{interval(elapsed)}, {rate_text}]"
    remaining = interval((total - n) / rate) if rate else "?"
    pct = int(100 * n / total)
    return f"{prefix}{pct:3d}%|{bar(n / total)}| {n}/{total} [{interval(elapsed)}<{remaining}, {rate_text}]"


def write(text, end="\r"):
    sys.stdout.write(text + end)
    sys.stdout.flush()


def run(total, desc="", delay=0.1, unit="it", leave=True):
    start = time.time()
    for n in range(total + 1):
        write(meter(n, total, time.time() - start, desc, unit))
        if n < total:
            time.sleep(delay)
    if leave:
        write("", end="\n")
