"""The real tqdm library (pip install tqdm), nested with position=. Skips if tqdm is missing."""
import sys
import time

try:
    from tqdm import tqdm
except ImportError:
    print("tqdm is not installed: pip install tqdm", flush=True)
    sys.exit(0)

for epoch in tqdm(range(3), desc="Epochs", position=0):
    for batch in tqdm(range(50), desc="Batches", position=1, leave=False):
        time.sleep(0.05)
