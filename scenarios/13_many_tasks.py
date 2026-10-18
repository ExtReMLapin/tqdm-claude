"""Run this 6 times in the background at once. Expect: the band keeps to its rows and says '+N more'."""
import random
import sys
from _tqdm_format import run

run(random.randint(80, 160), desc=f"Job {sys.argv[1] if len(sys.argv) > 1 else '?'}", delay=0.1)
