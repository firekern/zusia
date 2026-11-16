"""Create the original, synthetic study note used in the API walkthrough.

Requires reportlab. No public paper or personal library content is used.
"""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import simpleSplit

target = Path(__file__).resolve().parents[3] / "test/out/pr-media/api-backends/study-note.pdf"
target.parent.mkdir(parents=True, exist_ok=True)
pdf = canvas.Canvas(str(target), pagesize=(612, 792), invariant=1)
pdf.setTitle("A short note on attention - synthetic study material")
pdf.setAuthor("Zusia demo")


def base(page, title, subtitle):
    pdf.setFillColor(HexColor("#243b48"))
    pdf.setFont("Helvetica", 10)
    pdf.drawString(54, 747, "ZUSIA / SYNTHETIC STUDY NOTE")
    pdf.setFont("Helvetica-Bold", 25)
    pdf.drawString(54, 699, title)
    pdf.setFont("Helvetica", 12)
    pdf.setFillColor(HexColor("#53616a"))
    pdf.drawString(54, 674, subtitle)
    pdf.setFont("Helvetica", 10)
    pdf.drawString(54, 36, "Original demo material. No personal data or model benchmark claims.")
    pdf.drawRightString(558, 36, str(page))


def paragraph(text, y, bold=False):
    pdf.setFillColor(HexColor("#1f2930"))
    font = "Helvetica-Bold" if bold else "Helvetica"
    pdf.setFont(font, 14)
    for line in simpleSplit(text, font, 14, 504):
        pdf.drawString(54, y, line)
        y -= 23
    return y - 16


base(1, "A short note on attention", "Queries, keys and values - a two-page worked explanation")
y = paragraph("A query represents what a token is looking for. A key describes what another token offers. Comparing the query with each key produces attention scores.", 624)
y = paragraph("The scores are normalized into weights. The output is a weighted sum of the values: relevant tokens contribute more to the resulting representation.", y)
pdf.setFillColor(HexColor("#eef4f5"))
pdf.roundRect(54, 333, 504, 73, 6, fill=1, stroke=0)
pdf.setFillColor(HexColor("#243b48"))
pdf.setFont("Helvetica-Bold", 14)
pdf.drawString(73, 376, "Query + keys -> scores -> weights")
pdf.setFont("Helvetica", 14)
pdf.drawString(73, 350, "Weights + values -> attention output")
paragraph("For example, when resolving a pronoun, the current token can assign more weight to the earlier token that supplies the relevant subject. This example illustrates the mechanism; it is not an experiment or a performance result.", 298)
paragraph("Page 2 contains a context-budget example and a verification code for the document-tool walkthrough.", 165)
pdf.showPage()

base(2, "Context is a runtime budget", "Use the active provider profile, then reserve room for the answer")
y = paragraph("A model's advertised maximum is not necessarily the context window currently configured on the server. A reading assistant should use the effective running context reported by the provider.", 624)
y = paragraph("In this synthetic example, the running context is 16,384 tokens. Reserving 2,048 tokens for the answer leaves 14,336 tokens before instructions, history and tool schemas are counted.", y)
y = paragraph("A provider tokenizer can count text exactly for its current model. Without a supported counting route, a conservative estimate must be labelled as an estimate.", y)
pdf.setFillColor(HexColor("#eef4f5"))
pdf.roundRect(54, 230, 504, 98, 6, fill=1, stroke=0)
pdf.setFillColor(HexColor("#243b48"))
pdf.setFont("Helvetica", 12)
pdf.drawString(73, 301, "Document-tool verification code")
pdf.setFont("Helvetica-Bold", 24)
pdf.drawString(73, 262, "ORCHID-427")
paragraph("The verification code belongs to this document, on page 2. A grounded answer should return that code and cite this page instead of inventing a different one.", 194)
pdf.showPage()
pdf.save()
print(target)
