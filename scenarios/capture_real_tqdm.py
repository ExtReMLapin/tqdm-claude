"""Captures the genuine tqdm output the tests check the parser against.

Needs: pip install tqdm. Writes tests/fixtures/real-tqdm.ts.
"""

import json
import os
import subprocess
import sys

import tqdm

CASES = {
    "single": "from tqdm import tqdm\nimport time\nfor _ in tqdm(range(30), desc='Train', mininterval=0):\n    time.sleep(0.01)",
    "nested": "from tqdm import tqdm\nimport time\nfor e in tqdm(range(3), desc='Epochs', position=0, mininterval=0):\n    for b in tqdm(range(20), desc='Batches', position=1, leave=False, mininterval=0):\n        time.sleep(0.005)",
    "no_total": "from tqdm import tqdm\nimport time\nfor _ in tqdm(iter(range(40)), desc='Scanning', mininterval=0):\n    time.sleep(0.005)",
    "bytes": "from tqdm import tqdm\nimport time\nwith tqdm(total=2_400_000, unit='B', unit_scale=True, unit_divisor=1024, desc='model.bin', mininterval=0) as p:\n    for _ in range(24):\n        p.update(100_000); time.sleep(0.01)",
    "postfix": "from tqdm import tqdm\nimport time\np = tqdm(range(20), desc='Fit', mininterval=0)\nfor i in p:\n    p.set_postfix(loss=1/(i+1)); time.sleep(0.01)",
    "partial_then_crash": "from tqdm import tqdm\nimport time\nfor i in tqdm(range(50), desc='Indexing', mininterval=0):\n    time.sleep(0.005)\n    if i == 20: raise KeyError('path')",
}

out = {}
for name, code in CASES.items():
    # Bytes, not text mode: universal newlines would turn tqdm's carriage returns into line feeds.
    run = subprocess.run(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    out[name] = run.stdout.decode("utf-8")
    print(name, run.returncode, out[name].count("\r"), "CR,", out[name].count("\n"), "LF")

target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures", "real-tqdm.ts")
with open(target, "w", encoding="utf-8", newline="\n") as f:
    f.write(f"// Output of tqdm {tqdm.__version__} (Python {sys.version.split()[0]}, {sys.platform}) as a file receives it.\n")
    f.write("// Regenerate with: python scenarios/capture_real_tqdm.py\n")
    f.write("export const REAL_TQDM = " + json.dumps(out, ensure_ascii=False, indent=2) + " as const\n")
