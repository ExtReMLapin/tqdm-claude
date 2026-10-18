"""pip-like: one bar per file, one after another, ~15 s. Expect: the bar follows the current file, not the finished ones."""
from _tqdm_format import run

for name, size in [("numpy.whl", 40), ("torch.whl", 80), ("tqdm.whl", 20)]:
    run(size, desc=name, delay=0.05)
