"""tqdm with no total, ~15 s. Expect: the sweeping bar, a growing count and rate."""
import time
from _tqdm_format import meter, write

start = time.time()
for n in range(150):
    write(meter(n, None, time.time() - start, "Scanning files"))
    time.sleep(0.1)
write("", end="\n")
