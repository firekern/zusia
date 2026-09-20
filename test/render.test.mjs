import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, fixture, render, leftoverMarkup } from "./load-plugin.mjs";

const env = loadPlugin();
const texErrors = c => [...c.querySelectorAll(".zs-tex-error")].map(n => n.textContent);
const cellText = (table, row, col) => table.rows[row].cells[col].textContent.trim();

for (const name of ["fft-real.md", "metric-review-real.md", "tables.md", "latex.md", "markdown.md"]) {
	test(`${name}: no raw Markdown/LaTeX left in the rendered text`, () => {
		assert.deepEqual(leftoverMarkup(render(env, fixture(name))), []);
	});
}

test("real FFT answer: every formula renders, table is 4×4, maths after a list item stays in it", () => {
	const c = render(env, fixture("fft-real.md"));
	assert.deepEqual(texErrors(c), []);
	assert.ok(c.querySelectorAll("math").length > 80);
	const table = c.querySelector("table");
	assert.equal(table.rows.length, 5);
	assert.equal(table.rows[0].cells.length, 4);
	assert.ok(table.rows[1].cells[3].querySelector("math"), "maths inside a cell");
	const combine = [...c.querySelectorAll("li")].find(li => li.textContent.startsWith("Combine"));
	assert.ok(combine.querySelector(".zs-math-block"), "display maths belongs to its list item");
});

test("tables: alignment, math with \\| norms, escaped pipes, pipe-less syntax", () => {
	const c = render(env, fixture("tables.md"));
	const tables = c.querySelectorAll("table");
	assert.equal(tables.length, 3);
	const [first, pipeless, wide] = tables;
	assert.equal(first.rows[0].cells.length, 3);
	assert.equal(first.rows[0].cells[1].dataset.align, "center");
	assert.equal(first.rows[0].cells[2].dataset.align, "right");
	assert.ok(first.rows[3].cells[1].querySelector("math"), "\\|x\\|_2 stays one maths cell");
	assert.equal(cellText(first, 3, 2), "uses | pipes");
	assert.equal(pipeless.rows.length, 3);
	assert.equal(pipeless.rows[0].cells.length, 2);
	assert.ok(pipeless.rows[2].cells[0].querySelector("strong"));
	assert.equal(wide.rows[0].cells.length, 6);
	assert.deepEqual(texErrors(c), []);
});

test("latex: display forms, environments, lists, and broken TeX shown as source", () => {
	const c = render(env, fixture("latex.md"));
	assert.equal(c.querySelectorAll(".zs-math-block").length, 8);
	assert.equal(c.querySelectorAll(".zs-env").length, 3);
	assert.ok(c.querySelector(".zs-env-def .zs-env-title").textContent.includes("Metric"));
	assert.ok(c.querySelector(".zs-env-proof .zs-math-block"), "display maths inside a proof");
	assert.deepEqual(texErrors(c), ["$\\frac{1}{$", "$\\badmacro{x}$"]);
	assert.ok(c.textContent.includes("price of $5 or $20"), "currency is not maths");
	assert.ok(c.querySelector("ol > li .zs-math-block"), "display maths after an item stays in the list");
	assert.equal(c.querySelectorAll("ol").length, 1, "the list continues after its display maths");
});

test("markdown: nested lists, continuation lines, quotes, code, headings", () => {
	const c = render(env, fixture("markdown.md"));
	assert.ok(c.querySelector("ul > li > ul > li"), "nested bullet");
	assert.ok(c.querySelector("ol > li > ul > li"), "bullet nested in numbered list");
	assert.equal(c.querySelectorAll("ol > li").length, 3);
	const second = c.querySelectorAll("ul")[0].children[1];
	assert.ok(second.textContent.includes("continued on an indented line"));
	assert.ok(c.querySelector("blockquote math"));
	assert.equal(c.querySelector("pre code").textContent.split("\n").length, 2);
	assert.equal(c.querySelectorAll(".zs-h").length, 2);
	assert.ok(c.querySelector(".zs-link"));
	assert.ok(c.querySelector("hr"));
});

test("inline edge cases", () => {
	const para = text => render(env, text).querySelector("p");
	assert.equal(para("snake_case_name and file_name.txt").querySelector("em"), null);
	assert.equal(para("2 * 3 * 4").querySelector("em"), null);
	assert.ok(para("**bold $a*b$**").querySelector("strong math"));
	assert.ok(para("space $a\\,b$ ok").querySelector("math"));
});

test("note HTML uses Zotero note-editor maths markup", () => {
	const html = env.plugin.noteHTML("Why?", "Inline $x^2$.\n\n$$y = 1$$\n\n| a | b |\n|---|---|\n| 1 | 2 |");
	assert.match(html, /<h2>Why\?<\/h2>/);
	assert.match(html, /<span class="math">\$x\^2\$<\/span>/);
	assert.match(html, /<pre class="math">\$\$y = 1\$\$<\/pre>/);
	assert.match(html, /<table>/);
	assert.doesNotMatch(html, /<math/);
});

test("maths spacing matches TeX for norms, absolute values and unary signs", () => {
	const math = tex => render(env, "$" + tex + "$").querySelector("math");
	const norm = math("\\|a+b\\|");
	assert.deepEqual([...norm.querySelectorAll("mi")].map(n => n.textContent).filter(t => t.length === 1 && !/[a-z]/.test(t)), ["\u2016", "\u2016"]);
	assert.ok([...math("|x|").querySelectorAll("mi")].some(n => n.textContent === "|"));
	const pm = [...math("(\\pm\\,\\omega)").querySelectorAll("mo")].find(n => n.textContent === "\u00b1");
	assert.equal(pm.getAttribute("lspace"), "0");
	const plus = [...math("a + b").querySelectorAll("mo")].find(n => n.textContent === "+");
	assert.equal(plus.getAttribute("lspace"), null, "binary plus keeps its spacing");
	const afterAngle = [...math("\\langle a,b\\rangle + c").querySelectorAll("mo")].find(n => n.textContent === "+");
	assert.equal(afterAngle.getAttribute("lspace"), null, "+ after a closing ⟩ is binary");
	const slash = [...math("n/2").querySelectorAll("mo")].find(n => n.textContent === "/");
	assert.equal(slash.getAttribute("rspace"), "0");
});

test("streaming: an unfinished formula is held back until it closes", () => {
	const cut = t => env.plugin.withoutIncompleteMath(t);
	assert.equal(cut("A metric if $d(x,y) ="), "A metric if ");
	assert.equal(cut("Done $x$ and $y$."), "Done $x$ and $y$.");
	assert.equal(cut("Intro\n$$\n\\sum_i a_i"), "Intro\n");
	assert.equal(cut("Intro\n$$x$$\nnext"), "Intro\n$$x$$\nnext");
	assert.equal(cut("costs \\$5 so far"), "costs \\$5 so far");
	assert.equal(cut("see \\[ a + b"), "see ");
});

test("code blocks get a header with language and copy, except in notes", () => {
	const c = render(env, "```python\nprint(1)\n```");
	assert.equal(c.querySelector(".zs-code .zs-code-lang").textContent, "python");
	assert.equal(c.querySelector(".zs-code pre code").textContent, "print(1)");
	assert.ok(c.querySelector(".zs-code .zs-code-copy"));
	const html = env.plugin.noteHTML("", "```js\nx()\n```");
	assert.match(html, /<pre><code>x\(\)<\/code><\/pre>/);
	assert.doesNotMatch(html, /zs-code/);
});

test("drawings: an svg block renders as a themed figure on the sidebar background", () => {
	const c = render(env, [
		"Here:",
		"```svg",
		'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120">',
		'  <rect width="100%" height="100%" fill="#ffffff"/>',
		'  <rect x="10" y="10" width="80" height="40" rx="8" fill="accent-soft" stroke="accent"/>',
		'  <circle cx="150" cy="30" r="10" fill="#e6f4ea" stroke="#2e7d32"/>',
		'  <text x="50" y="35" font-family="Comic Sans MS" fill="black">A</text>',
		'  <line x1="0" y1="100" x2="300" y2="100" style="stroke: #cccccc"/>',
		"</svg>",
		"```",
	].join("\n"));
	const svg = c.querySelector(".zs-figure .zs-figure-canvas svg");
	assert.ok(svg);
	assert.equal(svg.getAttribute("viewBox"), "0 0 300 120");
	assert.equal(svg.getAttribute("width"), null);
	assert.equal(svg.querySelectorAll("rect").length, 1, "full-size background rectangle is dropped");
	const rect = svg.querySelector("rect");
	assert.equal(rect.style.getPropertyValue("fill"), "var(--zs-d-accent-soft)");
	assert.equal(rect.style.getPropertyValue("stroke"), "var(--zs-d-accent)");
	const circle = svg.querySelector("circle");
	assert.equal(circle.style.getPropertyValue("fill"), "var(--zs-d-green-soft)");
	assert.equal(circle.style.getPropertyValue("stroke"), "var(--zs-d-green)");
	const text = svg.querySelector("text");
	assert.equal(text.style.getPropertyValue("fill"), "var(--zs-d-ink)");
	assert.equal(text.getAttribute("font-family"), null);
	assert.equal(svg.querySelector("line").style.getPropertyValue("stroke"), "var(--zs-d-line)");
	const source = c.querySelector(".zs-figure > .zs-code");
	assert.equal(source.hidden, true);
	c.querySelector(".zs-figure-source").click();
	assert.equal(source.hidden, false);
});

test("drawings: scripts, handlers, external links and embedded HTML are removed", () => {
	const c = render(env, [
		"```svg",
		'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" onload="alert(1)">',
		"<script>alert(1)</script><style>rect{fill:url(http://x/y)}</style>",
		'<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>',
		'<image href="http://example.com/a.png"/>',
		'<a href="javascript:alert(1)"><rect x="1" y="1" width="5" height="5"/></a>',
		'<use xlink:href="http://evil/#x"/><use href="#ok"/>',
		'<rect x="2" y="2" width="5" height="5" onclick="alert(1)" style="fill: url(https://x/y)"/>',
		"</svg>",
		"```",
	].join("\n"));
	const svg = c.querySelector(".zs-figure svg");
	assert.ok(svg);
	assert.equal(svg.getAttribute("onload"), null);
	for (const tag of ["script", "style", "foreignObject", "image", "a", "div"]) {
		assert.equal(svg.getElementsByTagName(tag).length, 0, tag);
	}
	const uses = svg.querySelectorAll("use");
	assert.equal(uses[0].getAttribute("href"), null);
	assert.equal(uses[1].getAttribute("href"), "#ok");
	const rect = svg.querySelector("rect");
	assert.equal(rect.getAttribute("onclick"), null);
	assert.equal(rect.getAttribute("style"), null);
});

test("drawings: broken or unfinished SVG falls back to code; bare <svg> markup also renders", () => {
	assert.ok(render(env, "```svg\n<svg>not a drawing</svg>\n```").querySelector(".zs-code"), "nothing drawable falls back to code");
	assert.ok(render(env, "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/>").querySelector(".zs-code"));
	const bare = render(env, 'Look:\n\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n<circle cx="5" cy="5" r="4" fill="teal"/>\n</svg>\n\nDone.');
	assert.equal(bare.querySelector(".zs-figure svg circle").style.getPropertyValue("fill"), "var(--zs-d-teal)");
	assert.equal(bare.lastElementChild.textContent, "Done.");
});

test("drawings: a streaming svg shows a placeholder; notes keep the source", () => {
	const partial = "Intro\n\n```svg\n<svg viewBox=\"0 0 10 10\"><rect";
	const live = render(env, env.plugin.withoutIncompleteMath(partial));
	assert.ok(live.querySelector(".zs-figure-pending"));
	assert.equal(live.querySelector(".zs-code"), null);
	assert.equal(env.plugin.withoutIncompleteMath("a\n```js\nlet x"), "a\n```js\nlet x");
	const html = env.plugin.noteHTML("Q", "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>\n```");
	assert.match(html, /<pre>/);
	assert.doesNotMatch(html, /<svg/);
});

test("drawings: svg without xmlns, with xlink and with a bare & still render (as models write them)", () => {
	const noNs = render(env, '```svg\n<svg viewBox="0 0 360 200" font-family="Helvetica">\n<circle cx="10" cy="10" r="5" fill="accent"/>\n</svg>\n```');
	assert.equal(noNs.querySelector(".zs-figure svg circle").style.getPropertyValue("fill"), "var(--zs-d-accent)");
	const xlink = render(env, '```svg\n<svg viewBox="0 0 10 10"><defs><path id="p" d="M0 0L5 5"/></defs><use xlink:href="#p"/></svg>\n```');
	assert.equal(xlink.querySelector(".zs-figure svg use").getAttribute("href"), "#p");
	const amp = render(env, '```svg\n<svg viewBox="0 0 10 10"><text x="1" y="5">A & B</text></svg>\n```');
	assert.equal(amp.querySelector(".zs-figure svg text").textContent, "A & B");
});

test("notes: with a collector, each drawing becomes a numbered image placeholder", () => {
	const drawings = [];
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>';
	const html = env.plugin.noteHTML("Q", "Look:\n\n```svg\n" + svg + "\n```\n\nand\n\n```svg\n" + svg + "\n```", drawings);
	assert.equal(drawings.length, 2);
	assert.match(html, /<p><img data-zs-drawing="0"><\/p>[\s\S]*<p><img data-zs-drawing="1"><\/p>/);
	assert.doesNotMatch(html, /<pre>/);
});

test("theorem links: boxes are numbered across the chat, \\ref and [text](#label) link to them, labels never show", () => {
	const c = render(env, [
		"\\begin{definition}[Metric]\\label{def:metric}", "A metric $d$.", "\\end{definition}",
		"", "\\begin{theorem}", "\\label{thm:banach}", "Every contraction has a fixed point.", "\\end{theorem}",
		"", "\\begin{proof}[Proof of \\ref{thm:banach}]", "Uses \\ref{def:metric}.", "\\end{proof}",
		"", "By \\ref{thm:banach}, [this definition](#def:metric) and \\cref{thm:nope}. \\label{stray}",
	].join("\n"));
	env.plugin.linkTheorems(c);
	assert.deepEqual([...c.querySelectorAll(".zs-env-head")].map(h => h.textContent), ["Definition 1 — Metric", "Theorem 2", "Proof. — Proof of Theorem 2"]);
	assert.deepEqual([...c.querySelectorAll(".zs-ref")].map(r => [r.textContent, r.classList.contains("zs-ref-ok")]),
		[["Theorem 2", true], ["Definition 1", true], ["Theorem 2", true], ["this definition", true], ["thm:nope", false]]);
	assert.match(c.querySelector(".zs-ref-ok").title, /Every contraction has a fixed point\./);
	assert.doesNotMatch(c.textContent, /\\label|\\ref|\\cref/);
	assert.deepEqual(leftoverMarkup(c), []);
	const note = env.plugin.noteHTML("Q", "\\begin{lemma}\\label{lem:a}\nX\n\\end{lemma}\n\nSee \\ref{lem:a}.");
	assert.doesNotMatch(note, /zs-ref|\\label/);
	assert.match(note, /See lem:a\./);
});
