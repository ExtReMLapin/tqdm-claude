"""Imitates the progress lines of other tools in turn, ~30 s: cargo, git, ninja, Keras, docker buildx, ffmpeg.

Expect the bar's label to follow each tool: Building, Receiving objects, Build,
Epoch with Steps beneath and metrics, Docker build, ffmpeg with a real percentage.
"""

import sys
import time


def out(text, end="\n"):
    sys.stdout.write(text + end)
    sys.stdout.flush()


for n in range(0, 301, 15):
    filled = n * 25 // 300
    out(f"    Building [{'=' * filled}>{' ' * (25 - filled)}] {n}/300: serde, syn", end="\r")
    time.sleep(0.15)
out("")

for n in range(0, 1001, 50):
    out(f"Receiving objects: {n * 100 // 1000:3d}% ({n}/1000), {n / 400:.2f} MiB | 2.40 MiB/s", end="\r")
    time.sleep(0.15)
out("Receiving objects: 100% (1000/1000), 2.50 MiB | 2.40 MiB/s, done.")

for n in range(1, 41, 2):
    out(f"[{n}/40] Building CXX object src/file_{n}.o")
    time.sleep(0.1)

for epoch in range(1, 3):
    out(f"Epoch {epoch}/2")
    for step in range(0, 101, 10):
        bar = "=" * (step * 30 // 100)
        out(f"{step}/100 [{bar}>{'.' * (30 - len(bar))}] - ETA: 0:0{9 - step // 12} - loss: {1 / (step + 1):.4f} - accuracy: {step / 110:.4f}", end="\r")
        time.sleep(0.15)
    out("")

for step in range(1, 6):
    out(f"#{step + 3} [builder {step}/5] RUN step number {step}")
    time.sleep(0.6)

out("Input #0, mov,mp4, from 'in.mp4':")
out("  Duration: 00:01:40.00, start: 0.000000, bitrate: 1205 kb/s")
for second in range(0, 101, 5):
    out(f"frame={second * 30:5d} fps= 60 q=28.0 size= {second * 20:6d}kB time=00:{second // 60:02d}:{second % 60:02d}.00 bitrate= 407.9kbits/s speed=2.0x", end="\r")
    time.sleep(0.2)
out("")
