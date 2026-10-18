"""Progress, then a Python crash (exit 1), ~8 s. Expect: a red line with exit code 1 and the KeyError, kept until dismissed."""
import time
from _tqdm_format import meter, write

start = time.time()
for n in range(40):
    write(meter(n, 100, time.time() - start, "Indexing"))
    time.sleep(0.15)
write("", end="\n")
docs = [{"title": "a"}]
print(docs[0]["path"])
