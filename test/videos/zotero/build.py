"""Cuts each recorded scene down to a short clip: captions, zoom, sped-up waits.

    python3 build.py [scene ...]

Reads ~/.cache/zusia-demo/raw/<scene>.mp4 with its marks and writes
docs/videos/candidates/<scene>.mp4 through edit.py.
"""
import json, subprocess, sys
from pathlib import Path

repo = Path(__file__).resolve().parents[3]
raw = Path.home() / ".cache/zusia-demo/raw"
out = repo / "docs/videos/candidates"
edit = repo / "test/videos/zotero/edit.py"

# scene: list of (until-mark or seconds, focus, speed, caption)
PLANS = {
	"introChat": [("pane", "full", 1, "Open the side pane"),
		("zusia", "full", 1, "Zusia sits with the paper"),
		("modes", "sidebar", 1, "Turn on Drawing and LaTeX"),
		("sent", "sidebar", 1.6, "Ask in your own words"),
		("answered", "sidebar", 8, "Claude answers (sped up)"),
		("drawing", "sidebar", 1, "A diagram, in your colours"),
		("end", "sidebar", 1, "Maths in LaTeX, numbered and linked")],
	"introStyle": [("style", "full", 1, "Settings → Zusia, live"),
		("buddy", "full", 1, "Buddy and pattern"),
		("accent", "full", 1, "Accent colour"),
		("image", "full", 1, "A background image"),
		("labels", "full", 1, "Icons, or icons with labels"),
		("end", "sidebar", 1, "Your sidebar")],
	"explain": [("selected", "reader", 1, "Select a sentence in the PDF"),
		("explain clicked", "reader", 1, "Click “Explain this”"),
		("writing", "full", 1, "It asks about exactly that passage"),
		("answered", "sidebar", 6, "Claude answers (sped up)"),
		("end", "sidebar", 1, "The passage stays quoted above the answer")],
	"figure": [("attach menu", "sidebar", 1, "Open the attachment menu"),
		("page attached", "sidebar", 1, "Send the page you are reading"),
		("sent", "sidebar", 1, "Ask about Figure 1"),
		("answered", "sidebar", 4, "Claude looks at the page (sped up)"),
		("end", "sidebar", 1, "An answer about the figure itself")],
	"clarifications": [("panel", "sidebar", 1, "Every Ask and Explain is kept"),
		("detail", "sidebar", 1, "Open one"),
		("back to the pdf", "sidebar", 1, "The passage, the exact prompt, the answer"),
		("end", "full", 1, "One click jumps back to the PDF")],
	"search": [("search open", "sidebar", 1, "Search every chat you have"),
		("results", "sidebar", 1, "Type a word"),
		("opened", "sidebar", 1, "Hits from every paper"),
		("end", "full", 1, "Opens that paper at that message")],
	"theorems": [("sent", "sidebar", 1, "Ask for a proof, in LaTeX"),
		("answered", "sidebar", 10, "Claude writes it out (sped up)"),
		("read", "sidebar", 1, "Numbered definitions, lemmas and theorems"),
		("jumped", "sidebar", 1, "Every \\ref is a link: click to jump"),
		("end", "sidebar", 1, "Back (⌥←) returns where you were")],
	"explainBetter": [("asked again", "sidebar", 1, "Too dense to follow?"),
		("writing", "sidebar", 1, "Click “Explain better”"),
		("answered", "sidebar", 6, "Claude starts again (sped up)"),
		("end", "sidebar", 1, "Intuition, steps, an example")],
	"note": [("save menu", "sidebar", 1, "A drawing in the answer"),
		("saved", "sidebar", 1, "Save it into a Zotero note"),
		("end", "full", 1, "The note lands under the paper")],
	"wizard": [("assistant", "sidebar", 1, "First run: a visual setup"),
		("look", "sidebar", 1, "Pick your assistant"),
		("buddy", "sidebar", 1, "Style and colour"),
		("answers", "sidebar", 1, "Buddy and pattern"),
		("done", "sidebar", 1, "Level, language and extras"),
		("end", "sidebar", 1, "Ready")],
	"assistants": [("model menu", "sidebar", 1, "Claude Code, Codex or Antigravity"),
		("effort picked", "sidebar", 1, "Any model your CLI offers"),
		("sent", "sidebar", 1, "And how hard it should think"),
		("answered", "sidebar", 3, "Answering (sped up)"),
		("end", "sidebar", 1, "Same sidebar, your choice of assistant")],
}

only = sys.argv[1:]
for scene, plan in PLANS.items():
	if only and scene not in only:
		continue
	source = raw / f"{scene}.mp4"
	marks = {m["name"]: m["t"] for m in json.loads((raw / f"{scene}.marks.json").read_text())}
	duration = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(source)],
		capture_output=True, text=True).stdout)
	marks["end"] = duration - 0.3
	segments, start = [], 0.0
	for until, focus, speed, caption in plan:
		stop = marks[until] if isinstance(until, str) else until
		stop = min(stop, duration - 0.2)
		if stop - start < 0.8:
			continue
		segments.append({"from": round(start, 2), "to": round(stop, 2), "speed": speed, "focus": focus, "caption": caption})
		start = stop
	edl = {"source": str(source), "out": str(out / f"{scene}.mp4"), "segments": segments}
	path = out / f"{scene}.edl.json"
	path.write_text(json.dumps(edl, indent=2))
	subprocess.run(["python3", str(edit), str(path)], check=True)
