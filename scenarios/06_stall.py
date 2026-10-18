"""Progress, then 90 s of silence, then the end. Expect: '! no output for 01:0x' in yellow after a minute."""
import time
from _tqdm_format import meter, write

start = time.time()
for n in range(30):
    write(meter(n, 100, time.time() - start, "Download"))
    time.sleep(0.1)
time.sleep(90)
write(meter(100, 100, time.time() - start, "Download"), end="\n")
