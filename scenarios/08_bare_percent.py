"""A tool that only prints a percentage, ~15 s. Expect: a bar from the bare percentage."""
import time

for pct in range(0, 101, 2):
    print(f"Converting video... {pct}%", flush=True)
    time.sleep(0.3)
