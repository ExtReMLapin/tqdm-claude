"""Nested bars (epochs x batches), ~30 s. Expect: main = Epochs, sub = Batches under a branch."""
import time
from _tqdm_format import meter, write

start = time.time()
for epoch in range(5):
    write(meter(epoch, 5, time.time() - start, "Epochs"), end="\n")
    batch_start = time.time()
    for batch in range(0, 61):
        write(meter(batch, 60, time.time() - batch_start, "Batches"))
        time.sleep(0.1)
    write("", end="\n")
write(meter(5, 5, time.time() - start, "Epochs"), end="\n")
