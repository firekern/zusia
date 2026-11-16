"""Render annotated SVG compositions while retaining their original UI image.

Requires PyMuPDF. SVGs are the reproducible sources; PNGs are the PR attachments.
"""
from pathlib import Path
import sys
import pymupdf

folder = Path(__file__).resolve().parents[3] / "test/out/pr-media/api-backends"
for name in sys.argv[1:]:
    if not name.replace("-", "").isalnum():
        raise ValueError("Invalid capture name")
    source = folder / (name + ".svg")
    with pymupdf.open(source) as doc:
        doc[0].get_pixmap(alpha=False).save(folder / (name + ".png"))
    print(name + ".png")
