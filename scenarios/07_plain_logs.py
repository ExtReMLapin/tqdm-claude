"""No progress at all, only log lines, ~20 s. Expect: the sweeping bar with the last log line beside it."""
import time

for i in range(20):
    print(f"copying shard_{i:03d}.parquet", flush=True)
    time.sleep(1)
print("copy complete", flush=True)
