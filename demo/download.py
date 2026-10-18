"""Demo: a dataset download with genuine tqdm in bytes (~25 s)."""
import random
import sys
import time

from tqdm import tqdm

time.sleep(2)
total = 1_850_000_000
with tqdm(total=total, unit="B", unit_scale=True, unit_divisor=1024, desc="wikitext-103.tar", ncols=90, file=sys.stdout, mininterval=0.2) as bar:
    done = 0
    while done < total:
        chunk = min(total - done, int(random.uniform(5, 12) * 1024 * 1024))
        done += chunk
        bar.update(chunk)
        time.sleep(0.08)
print("checksum ok: sha256 9f2c…e41a", flush=True)
