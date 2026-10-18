"""Demo: fine-tuning with genuine tqdm, epochs over batches, loss in the postfix (~50 s)."""
import math
import random
import sys
import time

from tqdm import tqdm

random.seed(7)
loss = 2.4
for epoch in tqdm(range(3), desc="Epochs", position=0, ncols=90, file=sys.stdout):
    batches = tqdm(range(160), desc="Batches", position=1, leave=False, ncols=90, file=sys.stdout, mininterval=0.2)
    for step in batches:
        loss = max(0.08, loss * 0.995 + random.uniform(-0.01, 0.01))
        batches.set_postfix(loss=f"{loss:.3f}", lr=f"{2e-5 * math.cos(step / 320):.1e}")
        time.sleep(0.1)
print(f"saved checkpoint to runs/ft-llama-3b/final (loss {loss:.3f})", flush=True)
