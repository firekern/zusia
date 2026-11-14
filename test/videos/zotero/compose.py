"""Makes the film of a scene recorded from inside Zotero (INSIDE=1 npm run videos).

    python3 compose.py <frames folder> <out.mp4>

The folder holds what camera.js saved: one JPEG for every time the window changed, named
by its time in milliseconds, and pointer.json, where the pointer was told to be. The
film is what a screen recording gives edit.py: 30 pictures a second, each the window as
it was then, with the pointer macOS would have drawn.
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image

FPS = 30
here = Path(__file__).resolve().parent
cursors = Path.home() / ".cache/zusia-demo/cursors"

frames = Path(sys.argv[1])
out = Path(sys.argv[2])
pointer = json.loads((frames / "pointer.json").read_text())
scale = pointer["scale"]
track = pointer["track"]
pictures = sorted((int(path.stem), path) for path in frames.glob("*.jpg"))
if not pictures:
	sys.exit(f"no pictures in {frames}: the camera never saw the window painted")

# The pointers are the system's own images, so they are made here, not kept in the repo.
if not (cursors / "spots.json").exists():
	cursors.mkdir(parents=True, exist_ok=True)
	subprocess.run(["swift", str(here / "cursors.swift"), str(cursors)], check=True)
spots = json.loads((cursors / "spots.json").read_text())
drawn = {}
for kind, (spot_x, spot_y, width, height) in spots.items():
	image = Image.open(cursors / f"{kind}.png").convert("RGBA")
	drawn[kind] = (image.resize((round(width * scale), round(height * scale)), Image.LANCZOS), spot_x * scale, spot_y * scale)


def pointer_at(ms, start):
	"""Where the pointer is at a time, between the two places it was told to be, and its kind."""
	i = start
	while i + 1 < len(track) and track[i + 1]["t"] <= ms:
		i += 1
	here_, next_ = track[i], track[min(i + 1, len(track) - 1)]
	span = next_["t"] - here_["t"]
	part = min(1.0, max(0.0, (ms - here_["t"]) / span)) if span > 0 else 0.0
	x = here_["x"] + (next_["x"] - here_["x"]) * part
	y = here_["y"] + (next_["y"] - here_["y"]) * part
	return i, x, y, here_["kind"]


size = Image.open(pictures[0][1]).size
encoder = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
	"-s", f"{size[0]}x{size[1]}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16",
	"-pix_fmt", "yuv420p", str(out)], stdin=subprocess.PIPE)
end = max(track[-1]["t"], pictures[-1][0])
shown, base, at = -1, None, 0
for n in range(int(end / 1000 * FPS) + 1):
	ms = n * 1000 / FPS
	latest = shown
	while latest + 1 < len(pictures) and pictures[latest + 1][0] <= ms:
		latest += 1
	# Before the first picture there is nothing else to show.
	latest = max(latest, 0)
	if latest != shown:
		shown = latest
		base = Image.open(pictures[shown][1]).convert("RGB")
	at, x, y, kind = pointer_at(ms, at)
	image, spot_x, spot_y = drawn[kind]
	picture = base.copy()
	picture.paste(image, (round(x * scale - spot_x), round(y * scale - spot_y)), image)
	encoder.stdin.write(picture.tobytes())
encoder.stdin.close()
if encoder.wait():
	sys.exit("ffmpeg could not encode the film")
print(f"  {out.name}: {len(pictures)} pictures over {end / 1000:.1f}s")
