"""Cuts a recorded scene into a short clip: trimmed waits, zoom on what matters, captions.

    python3 edit.py <edl.json>

The edit decision list:
{
  "source": "chat.mp4",            # 2880x1800 screen capture
  "out": "docs/videos/x.mp4",
  "segments": [
    {"from": 0, "to": 6, "speed": 1, "focus": "full", "caption": "Select the sentence"},
    {"from": 6, "to": 40, "speed": 8, "focus": "sidebar", "caption": "Claude is thinking (sped up)"}
  ]
}
"from"/"to" are seconds in the source; "focus" is "full", "sidebar", "reader", "settings"
or [x, y, w, h] in source pixels. Captions are rendered here and overlaid.
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1440, 900  # output size
FOCUS = {  # 16:10 regions of the 2880x1800 capture, so nothing is letterboxed
	"full": (0, 0, 2880, 1800),
	"sidebar": (1400, 300, 1480, 925),
	"reader": (0, 200, 2160, 1350),
	"settings": (0, 150, 2400, 1500),
}
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

edl = json.loads(Path(sys.argv[1]).read_text())
source = Path(edl["source"])
out = Path(edl["out"])
work = out.parent / (out.stem + "-parts")
work.mkdir(parents=True, exist_ok=True)


def caption_png(text, step, path):
	"""A rounded pill with a step number, sized to the text."""
	font = ImageFont.truetype(FONT, 34)
	small = ImageFont.truetype(FONT, 28)
	pad_x, pad_y, gap = 26, 18, 16
	badge = 46 if step else 0
	measure = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
	tw = measure.textbbox((0, 0), text, font=font)[2]
	w = pad_x * 2 + badge + (gap if badge else 0) + tw
	h = pad_y * 2 + 44
	image = Image.new("RGBA", (w, h), (0, 0, 0, 0))
	draw = ImageDraw.Draw(image)
	draw.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=(17, 17, 19, 232))
	x = pad_x
	if badge:
		draw.ellipse((x, (h - badge) // 2, x + badge, (h + badge) // 2), fill=(212, 42, 60, 255))
		bw = draw.textbbox((0, 0), str(step), font=small)[2]
		draw.text((x + (badge - bw) / 2, (h - 34) / 2), str(step), font=small, fill="white")
		x += badge + gap
	draw.text((x, (h - 44) / 2 + 2), text, font=font, fill="white")
	image.save(path)
	return w, h


inputs = ["-i", str(source)]
filters = []
labels = []
overlays = []
step = 0
for i, segment in enumerate(edl["segments"]):
	speed = segment.get("speed", 1)
	x, y, w, h = FOCUS.get(segment.get("focus", "full"), segment.get("focus"))
	filters.append(
		f"[0:v]trim={segment['from']}:{segment['to']},setpts=(PTS-STARTPTS)/{speed},"
		f"crop={w}:{h}:{x}:{y},scale={W}:{H}:force_original_aspect_ratio=decrease,"
		f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v{i}]")
	labels.append(f"[v{i}]")
	length = (segment["to"] - segment["from"]) / speed
	overlays.append((segment.get("caption"), length, segment.get("step", True)))

filters.append("".join(labels) + f"concat=n={len(labels)}:v=1,fps=30[base]")

# Captions ride on the concatenated timeline.
chain = "[base]"
clock = 0.0
for i, (text, length, numbered) in enumerate(overlays):
	if text:
		if numbered:
			step += 1
		png = work / f"caption{i}.png"
		caption_png(text, step if numbered else 0, png)
		inputs += ["-loop", "1", "-t", f"{length:.2f}", "-i", str(png)]
		index = len(inputs) // 2 - 1 if False else inputs.count("-i") - 1
		start, end = clock + 0.15, clock + length - 0.15
		filters.append(f"[{index}:v]format=rgba,fade=t=in:st=0:d=0.25:alpha=1,"
			f"fade=t=out:st={max(0.3, length - 0.4):.2f}:d=0.3:alpha=1,setpts=PTS-STARTPTS+{start:.2f}/TB[c{i}]")
		filters.append(f"{chain}[c{i}]overlay=40:H-h-40:enable='between(t,{start:.2f},{end:.2f})'[o{i}]")
		chain = f"[o{i}]"
	clock += length

filters.append(f"{chain}null[outv]")
command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs,
	"-filter_complex", ";".join(filters), "-map", "[outv]",
	"-c:v", "libx264", "-crf", "20", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
subprocess.run(command, check=True)
size = out.stat().st_size / 1e6
duration = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
	capture_output=True, text=True).stdout.strip()
print(f"  {out.name}: {float(duration):.1f}s, {size:.1f} MB")
