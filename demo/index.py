"""Demo: a pipeline reporting with ##progress, which crashes in its third step (~22 s)."""
import time


def progress(line):
    print(f"##progress {line}", flush=True)


time.sleep(6)
progress('step=1/4 label="Load documents"')
for n in range(1, 41):
    progress(f'sub={n * 50}/2000 sublabel="files"')
    time.sleep(0.08)

progress('step=2/4 label="Embed chunks"')
for n in range(1, 61):
    progress(f'sub={n * 100}/6000 sublabel="chunks" ok={n * 100 - n // 12} fail={n // 12}')
    time.sleep(0.1)

progress('step=3/4 label="Build index"')
for n in range(1, 25):
    progress(f'sub={n}/48 sublabel="shards"')
    time.sleep(0.15)

docs = [{"title": "Q3 report", "body": "..."}]
print(docs[0]["path"])
