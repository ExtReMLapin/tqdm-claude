"""One tqdm bar with a total, ~20 s. Expect: a bar, count, %, rate, ETA in the header, then a tick."""
from _tqdm_format import run

run(200, desc="Train", delay=0.1)
print("training finished", flush=True)
