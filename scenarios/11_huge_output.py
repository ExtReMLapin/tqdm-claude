"""Writes more than 4 MiB of output. Expect: '(log too large to parse)' and the sweeping bar, no freeze."""
import sys
import time

chunk = "x" * 1023 + "\n"
for i in range(5 * 1024):
    sys.stdout.write(chunk)
    if i % 256 == 0:
        sys.stdout.flush()
        time.sleep(0.2)
sys.stdout.flush()
time.sleep(5)
