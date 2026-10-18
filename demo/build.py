"""Demo: a release build printing cargo's progress bar (~30 s)."""
import sys
import time

CRATES = ["serde", "tokio", "syn", "hyper", "tracing", "regex", "clap", "rustls", "axum", "sqlx"]

time.sleep(4)
total = 312
for n in range(0, total + 1, 3):
    filled = n * 27 // total
    crates = ", ".join(CRATES[(n // 3) % len(CRATES):][:2])
    sys.stdout.write(f"    Building [{'=' * filled}>{' ' * (27 - filled)}] {n}/{total}: {crates}\r")
    sys.stdout.flush()
    time.sleep(0.09)
sys.stdout.write("\n    Finished `release` profile [optimized] target(s) in 29.84s\n")
sys.stdout.flush()
