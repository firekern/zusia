import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

// readingmap.js is loaded on its own, in a context with no Zotero, no DOM and no files:
// if it reached for any of them, these tests would throw.
const source = readFileSync(new URL("../src/content/readingmap.js", import.meta.url), "utf8");
function loadMap() {
	const context = vm.createContext({});
	vm.runInContext(source, context, { filename: "readingmap.js" });
	return context.ZusiaMap;
}
const M = loadMap();
// Values made in the vm context have its own prototypes, which strict deepEqual rejects.
const plain = value => JSON.parse(JSON.stringify(value));

// A 60-page synthetic book: five roman front-matter pages (i–v) with a printed table of
// contents, two unnumbered pages, then printed pages 1–53 at PDF index 7–59, so PDF page
// number = printed + 7. Even pages carry "N Chapter …" headers, odd pages "Section … N",
// chapter openers only a footer folio.
const CHAPTERS = [
	{ id: "1", title: "Introduction", start: 1, topic: "history overview applications", sections: [] },
	{
		id: "2", title: "Discrete-Time Signals", start: 11, topic: "sequence signal",
		sections: [
			{ id: "2.1", title: "Sequences", start: 11, topic: "impulse unit step" },
			{ id: "2.2", title: "Linear Systems", start: 15, topic: "linearity superposition" },
			{ id: "2.3", title: "Convolution", start: 22, topic: "convolution sum" },
		],
	},
	{
		id: "3", title: "Sampling", start: 31, topic: "sampling sinusoid",
		sections: [
			{ id: "3.1", title: "Periodic Sampling", start: 31, topic: "nyquist rate" },
			{ id: "3.2", title: "Aliasing", start: 38, topic: "aliasing folding" },
			{ id: "3.3", title: "Rate Conversion", start: 45, topic: "decimation interpolation" },
		],
	},
];
const PRINTED_LAST = 53;
const OFFSET = 7;

function filler(topic, size = 1500) {
	let text = "";
	for (let k = 0; text.length < size; k++) {
		text += "Paragraph " + k + " about the " + topic + " on this page, in plain words for the reader.\n";
	}
	return text;
}

function bookPage(printed) {
	const chapter = CHAPTERS.filter(c => c.start <= printed).pop();
	const section = chapter.sections.filter(s => s.start <= printed).pop();
	const opener = chapter.start === printed;
	const lines = [];
	if (opener) {
		// Chapter 3 opens Oppenheim-style: the number alone, then the title.
		lines.push(chapter.id === "3" ? "3" : "Chapter " + chapter.id, chapter.title);
	}
	else if (printed % 2 === 0) {
		lines.push(printed + " Chapter " + chapter.id + " " + chapter.title);
	}
	else {
		lines.push("Section " + (section || chapter).id + " " + (section || chapter).title + " " + printed);
	}
	if (section && section.start === printed) {
		lines.push(section.id + " " + section.title);
	}
	const extra = {
		16: ["The first difference system is", "y[n] = x[n] + 2x[n − 1]. (2.14)"],
		20: ["Example 2.3 Moving Average", "The moving average smooths the moving average input."],
		26: ["The same system appears again, as shown in Eq. (2.14)"],
		33: ["--- page 99 ---", "That line above is page text, not a marker."],
		40: ["Figure 3.2 Aliasing of a sinusoid sampled too slowly."],
		48: ["Figure 3.2 shows the same samples again, and see Figure 4.5 for details."],
	}[printed] || [];
	lines.push(...extra, filler((section || chapter).topic).trimEnd());
	if (opener) {
		lines.push(String(printed));
	}
	return lines.join("\n");
}

const TOC_FIRST = [
	"Contents",
	"Preface . . . . . . . . . . v",
	"1 Introduction . . . . . . . . . . 1",
	"2 Discrete-Time Signals . . . . . . . 11",
	"2.1 Sequences .................... 11",
	"2.2 Linear Systems . . . . . . . . . 15",
	"2.3 Convolution . . . . . . . . . . 22",
	"2.4 Phantom Section . . . . . . . . 25",
	"iii",
].join("\n");
// The second page joins its entries on one line, as Zotero extracted Oppenheim's.
const TOC_SECOND = [
	"iv Contents",
	"3 Sampling 31 3.1 Periodic Sampling . . . . . 31 3.2 Aliasing . . . . . . 38 3.3 Rate Conversion . . . . 45",
].join("\n");

function syntheticBook() {
	const pages = [
		"A Synthetic Book\nof Signals\nThe Authors",
		"Copyright notice for testing only.\nii",
		TOC_FIRST,
		TOC_SECOND,
		"Preface\n" + filler("preface") + "v",
		"Part One\nFoundations",
		"",
	];
	for (let printed = 1; printed <= PRINTED_LAST; printed++) {
		pages.push(bookPage(printed));
	}
	return pages;
}
const BOOK = syntheticBook();
const idx = printed => printed + OFFSET - 1;

// 1132 pages like the Oppenheim run: roman front matter on PDF 2–23, printed 1 on PDF 24
// (offset +23, so PDF 41 = printed 18), a few figure pages with no header and a few last
// lines that end with a stray number.
function bigBook() {
	const pages = [];
	for (let i = 0; i < 1132; i++) {
		const body = ("Text of page " + i + " about filters, transforms and spectra. ").repeat(45);
		if (i === 0) {
			pages.push("Cover");
		}
		else if (i < 23) {
			pages.push("Front matter page\n" + body + "\n" + M.toRoman(i + 1));
		}
		else {
			const printed = i - 22;
			let text = i % 37 === 0 ? body
				: printed % 2 === 0 ? printed + " Chapter " + (1 + Math.floor(printed / 80)) + " Signals\n" + body
				: "Section " + (1 + Math.floor(printed / 80)) + ".1 Systems " + printed + "\n" + body;
			if (i % 53 === 0) {
				text += "\nSee Problem 12";
			}
			if (i === 40) {
				text += "\nExample 2.3 Moving Average\nThe general moving-average system is defined by the equation (2.21)";
			}
			if (i === 300) {
				text += "\nA moving average is a lowpass filter, and the moving average of white noise is coloured.";
			}
			pages.push(text);
		}
	}
	return pages;
}
const BIG = bigBook();
const BIG_LABELS = M.inferPageLabels(BIG);

// ---------------------------------------------------------------- page labels

test("labels: the roman run and the +7 arabic offset are found from folios", () => {
	const result = M.inferPageLabels(BOOK);
	assert.deepEqual(plain(result.labels.slice(0, 9)), ["i", "ii", "iii", "iv", "v", "vi", "vii", "1", "2"]);
	assert.equal(result.labels[idx(34)], "34");
	assert.equal(result.labels[59], "53");
	assert.equal(result.method, "folios");
	assert.ok(result.confidence >= 0.95, "confidence " + result.confidence);
	const arabic = result.runs.find(run => run.style === "arabic");
	assert.deepEqual(plain(arabic), { start: 7, end: 59, style: "arabic", offset: 7 });
});

test("labels: a 1132-page book with offset +23 maps PDF 41 to printed 18", () => {
	const result = M.inferPageLabels(BIG);
	assert.equal(result.labels.length, 1132);
	assert.equal(result.labels[40], "18");
	assert.equal(result.labels[23], "1");
	assert.equal(result.labels[1131], "1109");
	assert.equal(result.labels[14], "xv");
	assert.equal(result.labels[37 * 10], String(37 * 10 - 22), "a page with no header inherits its run");
	assert.ok(result.confidence >= 0.8, "confidence " + result.confidence);
	assert.ok(result.runs.some(run => run.style === "arabic" && run.offset === 23));
});

test("labels: anchors override, agree, or stand alone", () => {
	const agreeing = M.inferPageLabels(BOOK, [{ pageIndex: idx(20), label: "20" }]);
	assert.equal(agreeing.method, "folios+anchors");
	assert.ok(agreeing.confidence >= 0.95);

	const odd = M.inferPageLabels(BOOK, [{ pageIndex: idx(20), label: "A-3" }, { pageIndex: 999, label: "5" }]);
	assert.equal(odd.labels[idx(20)], "A-3", "the anchor wins on its own page");
	assert.equal(odd.labels[idx(21)], "21", "the rest of the run is untouched");

	// A book whose pages carry no folios at all: two annotations label it.
	const bare = BOOK.map(text => "Body\n" + filler("plain"));
	assert.equal(M.inferPageLabels(bare).method, "none");
	assert.equal(M.inferPageLabels(bare).confidence, 0);
	const anchored = M.inferPageLabels(bare, [{ pageIndex: 20, label: "14" }, { pageIndex: 30, label: "24" }]);
	assert.equal(anchored.method, "anchors");
	assert.equal(anchored.labels[25], "19");
	assert.equal(anchored.labels[59], "53");
	assert.equal(anchored.labels[6], null, "no printed page 0");
	assert.ok(anchored.confidence >= 0.8);
});

test("labels: an anchor that contradicts the folios on its page is dropped and reported", () => {
	// Zotero reports the PDF number as the label when the PDF has none.
	const pdfNumber = M.inferPageLabels(BOOK, [{ pageIndex: idx(20), label: String(idx(20) + 1) }]);
	assert.equal(pdfNumber.labels[idx(20)], "20");
	assert.equal(M.labelToIndex(pdfNumber, "20"), idx(20), "the printed page stays reachable");
	assert.equal(M.labelToIndex(pdfNumber, String(idx(20) + 1)), idx(idx(20) + 1), "no duplicate label in the run");
	assert.deepEqual(plain(pdfNumber.conflicts), [{ pageIndex: idx(20), label: String(idx(20) + 1) }]);
	assert.ok(pdfNumber.confidence >= 0.95);

	const neighbour = M.inferPageLabels(BOOK, [{ pageIndex: idx(20), label: "21" }]);
	assert.equal(M.labelToIndex(neighbour, "21"), idx(21));
	assert.equal(M.labelToIndex(neighbour, "20"), idx(20));
	assert.equal(neighbour.conflicts.length, 1);
	assert.equal(M.inferPageLabels(BOOK, [{ pageIndex: idx(20), label: "20" }]).conflicts.length, 0);
});

test("labels: anchors with the PDF number on every page lose to the folios, a stray matching number too", () => {
	// An unlabelled PDF: Zotero reports "1".."1132". One last line ending in its own PDF
	// number agrees with them, which once made their giant cluster a folio run.
	const pages = BIG.slice();
	pages[105] += "\nSee Problem 106";
	const identity = pages.map((_, i) => ({ pageIndex: i, label: String(i + 1) }));
	const result = M.inferPageLabels(pages, identity);
	assert.equal(result.labels[40], "18");
	assert.equal(result.labels[14], "xv");
	assert.equal(M.labelToIndex(result, "18"), 40);
	assert.equal(M.pageIndexFor(result, "18", pages.length), 40);
	assert.ok(M.trusted(result), "confidence " + result.confidence);
	assert.ok(result.conflicts.length > 1000, "the PDF numbers are reported, not pinned");
});

test("labelToIndex: a number that two arabic runs carry means the page in the longer run", () => {
	// Zotero's labels for Oppenheim are 1–23 on the front matter, then 1–1109: here the
	// front matter has no folios of its own, so its anchors stand.
	const pages = BIG.map((text, i) => (i < 23 ? "Front matter page\n" + text.split("\n")[1] : text));
	const front = Array.from({ length: 23 }, (_, i) => ({ pageIndex: i, label: String(i + 1) }));
	const result = M.inferPageLabels(pages, front);
	assert.equal(result.labels[17], "18", "the front matter keeps Zotero's label");
	assert.equal(result.labels[40], "18");
	assert.equal(M.labelToIndex(result, "18"), 40);
	assert.equal(M.labelToIndex(result, "5"), 27);
	assert.equal(M.pageIndexFor(result, "18", pages.length), 40);
});

test("labels: a handful of folios in a long text stays below the marker threshold", () => {
	const pages = Array.from({ length: 200 }, (_, i) => "Body of this page\n" + filler("noise", 300));
	for (let i = 10; i < 15; i++) {
		pages[i] += "\n" + (i - 4);
	}
	const sparse = M.inferPageLabels(pages);
	assert.equal(sparse.labels[12], "8");
	assert.ok(sparse.confidence < M.LABEL_MIN_CONFIDENCE, "confidence " + sparse.confidence);
	assert.equal(M.pageMarker(12, sparse), "--- page 13 ---");
});

test("labelToIndex prefers the arabic run and ignores case", () => {
	const structure = M.inferPageLabels(BOOK);
	assert.equal(M.labelToIndex(structure, "18"), idx(18));
	assert.equal(M.labelToIndex(structure, 18), idx(18));
	assert.equal(M.labelToIndex(structure, "IV"), 3);
	assert.equal(M.labelToIndex(structure, "99"), null);
	// An anchor that pinned "3" on the copyright page: "3" still means the arabic page.
	const pinned = M.inferPageLabels(BOOK, [{ pageIndex: 1, label: "3" }]);
	assert.equal(M.labelToIndex(pinned, "3"), idx(3));
});

test("page markers carry the printed number only when it is trusted and different", () => {
	const structure = M.inferPageLabels(BIG);
	assert.equal(M.pageMarker(40, structure), "--- page 41 (printed 18) ---");
	assert.equal(M.pageMarker(40, { ...plain(structure), confidence: 0.5 }), "--- page 41 ---");
	assert.equal(M.pageMarker(4, { labels: ["1", "2", "3", "4", "5"], confidence: 1 }), "--- page 5 ---");
	assert.equal(M.pageMarker(2, null), "--- page 3 ---");
});

test("page text that would forge a marker gets a zero-width space", () => {
	const text = "--- page 99 ---\n  --- Page 3 (printed 1) ---\nA line --- page 4 --- inside";
	const safe = M.escapeMarkers(text);
	const lines = safe.split("\n");
	assert.equal(lines[0], "\u200b--- page 99 ---");
	assert.equal(lines[1], "\u200b  --- Page 3 (printed 1) ---");
	assert.equal(lines[2], "A line --- page 4 --- inside");
	assert.ok(!/^\s*---\s*page/im.test(safe));
});

test("a marker behind a no-break space or after blank lines is neutralised too", () => {
	const safe = M.escapeMarkers("\u00a0--- page 5 ---\n\n\u2003---page 6---\n\n--- page 7 ---");
	assert.deepEqual(safe.split("\n"), ["\u200b\u00a0--- page 5 ---", "", "\u200b\u2003---page 6---", "", "\u200b--- page 7 ---"]);
});

// ---------------------------------------------------------------- outline

test("the printed table of contents is parsed, dot leaders and joined lines alike", () => {
	const entries = plain(M.parsePrintedToc(BOOK));
	assert.deepEqual(entries.map(e => [e.id, e.title, e.level, e.label]), [
		["preface", "Preface", 1, "v"],
		["1", "Introduction", 1, "1"],
		["2", "Discrete-Time Signals", 1, "11"],
		["2.1", "Sequences", 2, "11"],
		["2.2", "Linear Systems", 2, "15"],
		["2.3", "Convolution", 2, "22"],
		["2.4", "Phantom Section", 2, "25"],
		["3", "Sampling", 1, "31"],
		["3.1", "Periodic Sampling", 2, "31"],
		["3.2", "Aliasing", 2, "38"],
		["3.3", "Rate Conversion", 2, "45"],
	]);
});

test("toc parsing skips stray numbers between entries and needs a contents page", () => {
	const toc = "Contents\n2.10 Random Signals . . . . 64 2.11 Summary . . . . 70 Problems . . . . 70\n3 The z-Transform 99 3.0 Introduction . . . 99\nA Random Signals 1043\nIndex 1091";
	const entries = plain(M.parsePrintedToc([toc]));
	assert.deepEqual(entries.map(e => e.id), ["2.10", "2.11", "3", "3.0", "A", "index"]);
	assert.deepEqual(plain(M.parsePrintedToc(["1 Introduction 1\n2 Methods 3\n3 Results 5"])), [], "no contents page, no leaders");
});

test("toc titles keep short words that look roman; a roman page needs leaders or the line end", () => {
	const italian = "Indice\n1 Introduzione . . . . . 1\n2 Segnali e i sistemi lineari . . . . 12\n2.1 I segnali . . . . 12\n2.2 Proprietà dei sistemi . . . . 15";
	assert.deepEqual(plain(M.parsePrintedToc([italian])).map(e => [e.id, e.title, e.label]), [
		["1", "Introduzione", "1"], ["2", "Segnali e i sistemi lineari", "12"], ["2.1", "I segnali", "12"], ["2.2", "Proprietà dei sistemi", "15"],
	]);
	const civil = "Contents\n1 Intro . . . 1\n2 Signals in civil engineering . . . 5\n3 More . . . 9";
	assert.deepEqual(plain(M.parsePrintedToc([civil])).map(e => e.title), ["Intro", "Signals in civil engineering", "More"]);
	const roman = "Contents\n1 Notation xi\n2 Symbols . . . xiv\n3 Start 1\n4 Next 9";
	assert.deepEqual(plain(M.parsePrintedToc([roman])).map(e => e.label), ["xi", "xiv", "1", "9"]);
});

test("toc entries whose title is not on the target page are rejected; ranges cover all pages", () => {
	const structure = M.inferPageLabels(BOOK);
	const resolved = plain(M.resolveToc(M.parsePrintedToc(BOOK), structure, BOOK));
	assert.ok(!resolved.some(e => e.id === "2.4"), "Phantom Section is not on printed page 25");
	assert.equal(resolved.find(e => e.id === "2.2").start, idx(15));

	const outline = plain(M.outlineRanges(resolved, structure, BOOK.length));
	const top = outline.filter(e => e.level === 1);
	assert.deepEqual(top.map(e => [e.id, e.start, e.end]), [
		["front", 0, 3], ["preface", 4, 6], ["1", 7, 16], ["2", 17, 36], ["3", 37, 59],
	]);
	for (let k = 1; k < top.length; k++) {
		assert.equal(top[k].start, top[k - 1].end + 1, "contiguous");
	}
	const sec = id => outline.find(e => e.id === id);
	assert.deepEqual([sec("2.1").start, sec("2.1").end], [idx(11), idx(15) - 1]);
	assert.deepEqual([sec("3.3").start, sec("3.3").end], [idx(45), 59]);
	assert.equal(M.sectionOf(outline, idx(16)).id, "2.2");
	assert.equal(M.sectionOf(outline, idx(11)).id, "2.1", "the deepest entry wins on a shared first page");
	assert.equal(M.sectionOf(outline, 2).id, "front");
	assert.equal(M.sectionOf(outline, 500), null);
});

test("outlineRanges resolves labels, drops entries out of order and falls back to chunks", () => {
	const structure = M.inferPageLabels(BOOK);
	const outline = plain(M.outlineRanges([
		{ id: "1", title: "One", level: 1, label: "1" },
		{ id: "2", title: "Two", level: 1, label: "11" },
		{ id: "9", title: "Backwards", level: 1, label: "5" },
		{ id: "3", title: "Nowhere", level: 1, label: "999" },
	], structure, BOOK.length));
	assert.deepEqual(outline.map(e => [e.id, e.start, e.end]), [["front", 0, 6], ["1", 7, 16], ["2", 17, 59]]);

	const chunks = plain(M.outlineRanges([], structure, 45, { chunk: 20 }));
	assert.deepEqual(chunks.map(e => [e.title, e.start, e.end]), [["Pages 1–20", 0, 19], ["Pages 21–40", 20, 39], ["Pages 41–45", 40, 44]]);
});

test("outlineRanges keeps top-level ranges disjoint when two start on one page", () => {
	const outline = plain(M.outlineRanges([
		{ id: "1", title: "A", level: 1, start: 0 },
		{ id: "2", title: "B", level: 1, start: 3 },
		{ id: "3", title: "C", level: 1, start: 3 },
		{ id: "3.1", title: "C1", level: 2, start: 5 },
		{ id: "3.2", title: "C2", level: 2, start: 5 },
		{ id: "3.3", title: "C3", level: 2, start: 7 },
	], null, 10));
	const top = outline.filter(e => e.level === 1);
	assert.deepEqual(top.map(e => [e.id, e.start, e.end]), [["1", 0, 2], ["3", 3, 9]]);
	// Two subsections that both begin on page 5 both hold it; the later one is where it ends.
	assert.deepEqual(outline.filter(e => e.level === 2).map(e => [e.id, e.start, e.end]), [["3.1", 5, 5], ["3.2", 5, 6], ["3.3", 7, 9]]);
	assert.equal(M.sectionOf(outline, 5).id, "3.2");
});

test("numbered headings are found when there is no table of contents", () => {
	const pages = BOOK.map((text, i) => (i === 2 || i === 3 ? "Notes\n" + filler("notes") : text));
	assert.deepEqual(plain(M.parsePrintedToc(pages)), []);
	const headings = plain(M.detectHeadings(pages));
	assert.deepEqual(headings.map(e => [e.id, e.title, e.start]), [
		["1", "Introduction", idx(1)],
		["2", "Discrete-Time Signals", idx(11)],
		["2.1", "Sequences", idx(11)],
		["2.2", "Linear Systems", idx(15)],
		["2.3", "Convolution", idx(22)],
		["3", "Sampling", idx(31)],
		["3.1", "Periodic Sampling", idx(31)],
		["3.2", "Aliasing", idx(38)],
		["3.3", "Rate Conversion", idx(45)],
	]);
	const { outline, method } = plain(M.buildOutline(pages, M.inferPageLabels(pages)));
	assert.equal(method, "headings");
	assert.equal(outline[0].id, "front");
	assert.equal(outline[outline.length - 1].end, 59);
});

test("headings that break the numbering are ignored", () => {
	const pages = [
		"1\nIntroduction\n" + filler("a"),
		"1.1 Scope\n" + filler("b"),
		"7.4 Later Stuff\n" + filler("c"),
		"1.2 Plan\n" + filler("d"),
		"Chapter 1 Introduction 3\n1.3 Goals\n" + filler("e"),
		"2\nMethods\n" + filler("f"),
	];
	assert.deepEqual(plain(M.detectHeadings(pages)).map(e => e.id), ["1", "1.1", "1.2", "1.3", "2"]);
});

// ---------------------------------------------------------------- section files

test("section files cover every page in order, within the size limits", () => {
	const structure = M.buildStructure(BOOK);
	const files = plain(structure.files);
	assert.equal(files[0].start, 0);
	assert.equal(files[files.length - 1].end, BOOK.length - 1);
	for (let k = 1; k < files.length; k++) {
		assert.equal(files[k].start, files[k - 1].end + 1);
	}
	for (const file of files) {
		assert.match(file.name, /^\d{2}-[a-z0-9-]+\.md$/);
		assert.match(file.hash, /^[0-9a-f]{8}$/);
		assert.ok(M.renderSectionFile(BOOK, file, structure).length <= M.SECTION_CHARS.max);
	}
	assert.equal(new Set(files.map(f => f.name)).size, files.length);
	assert.ok(files.some(f => /discrete-time-signals/.test(f.name)));

	const small = plain(M.splitSections(BOOK, structure.outline, { min: 2000, max: 12000 }));
	assert.ok(small.length > files.length);
	assert.ok(small.some(f => /sequences|linear-systems/.test(f.name)), "a long chapter splits at its sections");
	for (const file of small) {
		assert.ok(M.renderSectionFile(BOOK, file, structure).length <= 12000);
	}
	assert.equal(small[small.length - 1].end, BOOK.length - 1);
});

test("small units merge, long ones split by pages, the hash follows the text", () => {
	const pages = Array.from({ length: 30 }, (_, i) => "p" + i + " " + "x".repeat(900));
	const outline = M.outlineRanges([
		{ id: "1", title: "Tiny", level: 1, start: 0 },
		{ id: "2", title: "Also Tiny", level: 1, start: 1 },
		{ id: "3", title: "Long One", level: 1, start: 2 },
	], null, 30);
	const files = plain(M.splitSections(pages, outline, { min: 2000, max: 6000 }));
	assert.equal(files[0].start, 0);
	assert.ok(files[0].end >= 1, "the two tiny chapters share a file");
	assert.ok(files.every(f => f.chars <= 6000));
	assert.ok(files.filter(f => /long-one/.test(f.name)).length > 1);

	const again = plain(M.splitSections(pages, outline, { min: 2000, max: 6000 }));
	assert.deepEqual(again.map(f => f.hash), files.map(f => f.hash));
	const edited = pages.slice();
	edited[files[1].start] += " changed";
	const changed = plain(M.splitSections(edited, outline, { min: 2000, max: 6000 }));
	assert.notEqual(changed[1].hash, files[1].hash);
	assert.equal(changed[0].hash, files[0].hash);
	assert.equal(M.fnv1a(""), "811c9dc5");
	assert.equal(M.fnv1a("a"), "e40c292c");
});

test("a small chapter opener joins the section after it, not the chapter before", () => {
	const pages = Array.from({ length: 30 }, (_, i) => "p" + i + " " + "x".repeat(900));
	const outline = M.outlineRanges([
		{ id: "preface", title: "Preface", level: 1, start: 0 },
		{ id: "1", title: "One", level: 1, start: 2 },
		{ id: "2", title: "Two", level: 1, start: 10 },
		{ id: "2.1", title: "First", level: 2, start: 11 },
		{ id: "2.2", title: "Second", level: 2, start: 20 },
	], null, 30);
	const files = plain(M.splitSections(pages, outline, { min: 2000, max: 12000 }));
	// The short preface takes chapter 1 in, and the file is named after the chapter.
	assert.deepEqual(files.map(f => [f.title, f.start, f.end]), [["1 One", 0, 9], ["2 Two", 10, 19], ["2.2 Second", 20, 29]]);
	assert.equal(files[0].name, "01-1-one.md");
});

test("a section file has a heading, both page numbers and no forged markers", () => {
	const structure = M.buildStructure(BOOK);
	const file = structure.files.find(f => f.start <= idx(33) && f.end >= idx(33));
	const text = M.renderSectionFile(BOOK, file, structure);
	assert.ok(text.startsWith("# "));
	assert.ok(text.includes("--- page " + (idx(33) + 1) + " (printed 33) ---"));
	assert.ok(text.includes("\u200b--- page 99 ---"));
	assert.ok(!text.includes("\n--- page 99 ---"));
});

test("a 1132-page book splits into files no Read call truncates", () => {
	const structure = M.buildStructure(BIG);
	assert.equal(structure.files[structure.files.length - 1].end, 1131);
	for (const file of structure.files) {
		assert.ok(M.renderSectionFile(BIG, file, structure).length <= M.SECTION_CHARS.max);
	}
});

test("a page longer than a file splits by characters, and long titles still fit", () => {
	const lines = Array.from({ length: 2500 }, (_, k) => "line " + k + " " + "a".repeat(14)).join("\n");
	const pages = [lines, "b".repeat(100)];
	const files = plain(M.splitSections(pages, M.outlineRanges([], null, 2), M.SECTION_CHARS));
	assert.ok(files.length >= 2);
	for (const file of files) {
		assert.ok(M.renderSectionFile(pages, file, null).length <= M.SECTION_CHARS.max, file.name);
	}
	const parts = files.filter(f => f.start === 0 && f.end === 0);
	assert.ok(parts.length >= 2);
	assert.equal(parts.map(f => pages[0].slice(f.from, f.to)).join(""), pages[0], "the parts are the page");
	assert.ok(parts.slice(0, -1).every(f => pages[0][f.to - 1] === "\n"), "cut at a line end");
	assert.ok(M.renderSectionFile(pages, parts[1], null).includes("characters " + (parts[1].from + 1) + "–" + parts[1].to));
	assert.deepEqual(files.map(f => f.end).slice(-1), [1]);

	const title = "A".repeat(150);
	const wide = Array.from({ length: 40 }, () => "w".repeat(2200));
	const outline = M.outlineRanges([{ id: "12.10.3", title, level: 1, start: 0 }], null, 40);
	for (const file of M.splitSections(wide, outline, M.SECTION_CHARS)) {
		assert.ok(M.renderSectionFile(wide, file, BIG_LABELS).length <= M.SECTION_CHARS.max, file.title);
	}
});

// ---------------------------------------------------------------- objects and refs

test("indexObjects records where things are defined, not where they are cited", () => {
	const objects = plain(M.indexObjects(BOOK));
	assert.equal(objects["eq:2.14"], idx(16));
	assert.equal(objects["fig:3.2"], idx(40));
	assert.equal(objects["example:2.3"], idx(20));
	assert.equal(objects["fig:4.5"], undefined, "mid-line mention");
	const extra = plain(M.indexObjects([
		"see (2.1) and (2.2)\nas in Equation (2.3)\nTable 4.1: Results\nTeorema 1.2 Unicità\nx = y (5.7a)",
	]));
	assert.deepEqual(extra, { "table:4.1": 0, "theorem:1.2": 0, "eq:5.7a": 0 });
});

test("findObjectRefs reads English and Italian forms", () => {
	const refs = text => plain(M.findObjectRefs(text)).map(r => r.kind + ":" + (r.id || r.label));
	assert.deepEqual(refs("explain eq. (2.104) and Eq 2.3"), ["eq:2.104", "eq:2.3"]);
	assert.deepEqual(refs("cosa dice l'equazione 2.3? e la (2.14)"), ["eq:2.3", "eq:2.14"]);
	assert.deepEqual(refs("Figure 2.7, fig. 2.8, figura 2.9, Table 3.1, tabella 3.2"), ["fig:2.7", "fig:2.8", "fig:2.9", "table:3.1", "table:3.2"]);
	assert.deepEqual(refs("Example 2.3, esempio 2.4, Theorem 1.1, teorema 1.2, definizione 3.1"), ["example:2.3", "example:2.4", "theorem:1.1", "theorem:1.2", "definition:3.1"]);
	assert.deepEqual(refs("Section 2.3, §4.1, sezione 5.2, chapter 3"), ["section:2.3", "section:4.1", "section:5.2", "section:3"]);
	assert.deepEqual(refs("talk about p. 18, then pagina 20 and pp. 30–32, page xv"), ["page:18", "page:20", "page:30", "page:31", "page:32", "page:xv"]);
	assert.deepEqual(refs("nothing here, happy 2024"), []);
});

test("findObjectRefs does not read maths words as pages", () => {
	const refs = text => plain(M.findObjectRefs(text)).map(r => r.kind + ":" + (r.id || r.label));
	assert.deepEqual(refs("why is the DTFT periodic with period 2 pi? and the poles p1 and p2, also PC"), []);
	assert.deepEqual(refs("spiegami il pi greco"), []);
	assert.deepEqual(refs("what is the pole p1"), []);
	assert.deepEqual(refs("nella pagina i grafici, Page 12, P. 13, p 14, p. xv, pagina xii"), ["page:12", "page:13", "page:14", "page:xv", "page:xii"]);
	assert.deepEqual(refs("page I mean"), []);
});

// ---------------------------------------------------------------- search

test("tokenize lowercases, strips accents, stopwords, numbers and plurals", () => {
	assert.deepEqual(plain(M.tokenize("The Moving Averages of SYSTEMS, perché è così? 2.14 x1")), ["moving", "average", "system", "cosi", "x1"]);
	assert.deepEqual(plain(M.tokenize("talk about page 18 please")), []);
});

test("BM25 ranks the page that is about the query first", () => {
	const index = M.buildBM25(BOOK);
	const hits = plain(M.searchBM25(index, "decimation interpolation", 5));
	assert.equal(hits.length, 5);
	assert.ok(hits.every(h => h.page >= idx(45)), "rate conversion pages");
	assert.ok(hits[0].score >= hits[4].score);
	assert.equal(plain(M.searchBM25(index, "moving average", 3))[0].page, idx(20));
	assert.deepEqual(plain(M.searchBM25(index, "the of", 5)), []);
	assert.deepEqual(plain(M.searchBM25(index, "constructor __proto__", 5)), []);
});

// ---------------------------------------------------------------- progress

const OUTLINE = M.buildStructure(BOOK);

test("a page counts as read after 15 s; idle time is capped at 10 minutes", () => {
	let progress = M.applyPageEvent(null, 20, 0, OUTLINE);
	assert.equal(progress.current, 20);
	progress = M.applyPageEvent(progress, 21, 10000, OUTLINE);
	assert.deepEqual(plain(progress.read), [], "10 s is not reading");
	const before = plain(progress);
	progress = M.applyPageEvent(progress, 22, 10000 + 3600000, OUTLINE);
	assert.deepEqual(plain(progress.read), [21]);
	assert.equal(progress.dwell["21"], M.DWELL_CAP_MS);
	assert.deepEqual(plain(M.applyPageEvent(before, 22, 20000, OUTLINE)), plain(M.applyPageEvent(before, 22, 20000, OUTLINE)));
	assert.deepEqual(before.read, [], "the input is not changed");
	// Coming back to the same page adds up.
	let back = M.applyPageEvent(null, 5, 0, OUTLINE);
	back = M.applyPageEvent(back, 5, 9000, OUTLINE);
	back = M.applyPageEvent(back, 6, 18000, OUTLINE);
	assert.deepEqual(plain(back.read), [5]);
});

test("the frontier follows runs of reading and ignores a jump", () => {
	let progress = null;
	let t = 0;
	for (const page of [17, 18, 19, 20, 21]) {
		progress = M.applyPageEvent(progress, page, t, OUTLINE);
		t += 20000;
	}
	progress = M.applyPageEvent(progress, 50, t, OUTLINE);
	assert.equal(progress.frontier, 21, "17–21 read; 50 is still open");
	progress = M.applyPageEvent(progress, 51, t + 60000, OUTLINE);
	assert.ok(progress.read.includes(50));
	assert.equal(progress.frontier, 21, "one page read far ahead does not move it");
	// Three of five pages read is enough to move it.
	for (const page of [23, 25, 27, 28]) {
		progress = M.applyPageEvent(progress, page, (t += 100000), OUTLINE);
	}
	assert.equal(progress.frontier, 27);
});

test("section states go unread, reading, read", () => {
	const s21 = OUTLINE.outline.find(e => e.id === "2.1");
	let progress = M.applyPageEvent(null, s21.start, 0, OUTLINE);
	assert.equal(progress.sections["2.1"], "reading");
	assert.equal(progress.section, "2.1");
	assert.equal(progress.sections["2.2"], undefined);
	let t = 0;
	for (let page = s21.start + 1; page <= s21.end + 1; page++) {
		progress = M.applyPageEvent(progress, page, (t += 30000), OUTLINE);
	}
	assert.equal(progress.sections["2.1"], "read");
	assert.equal(progress.sections["2.2"], "reading");
	assert.equal(progress.sections["2"], "reading");
	progress = M.applyPageEvent(progress, 40, t + 1000, OUTLINE);
	assert.equal(progress.sections["2.2"], "unread", "passing through is not reading");
});

// ---------------------------------------------------------------- page selection

function sizeOf(pages, list, budget) {
	const focus = list.filter(p => p.reason === "focus");
	const cap = Math.floor(budget / Math.max(1, focus.length));
	return list.reduce((sum, p) => sum + (p.reason === "focus" ? Math.min(pages[p.page].length + M.PAGE_OVERHEAD, cap) : pages[p.page].length + M.PAGE_OVERHEAD), 0);
}

test("selectPages: refs, context and opener, ascending, focus last", () => {
	const structure = OUTLINE;
	const list = plain(M.selectPages({ pages: BOOK, structure, progress: null, query: "explain eq. (2.14) here", focus: [idx(34)], budget: 20000 }));
	const pages = list.map(p => p.page);
	assert.equal(pages[pages.length - 1], idx(34), "focus last");
	assert.deepEqual(pages.slice(0, -1), [...pages.slice(0, -1)].sort((a, b) => a - b), "supporting pages ascending");
	const reason = page => list.find(p => p.page === page)?.reason;
	assert.equal(reason(idx(16)), "ref");
	assert.equal(reason(idx(33)), "context");
	assert.equal(reason(idx(32)), "context");
	assert.equal(reason(idx(31)), "opener");
	assert.ok(sizeOf(BOOK, list, 20000) <= 20000);
	assert.equal(new Set(pages).size, pages.length);
});

test("selectPages: a printed page in the question resolves through the labels", () => {
	const list = plain(M.selectPages({ pages: BOOK, structure: OUTLINE, query: "what about p. 5?", focus: [idx(40)], budget: 20000 }));
	assert.equal(list.find(p => p.page === idx(5)).reason, "ref");
	const untrusted = { ...plain(OUTLINE), confidence: 0.2 };
	const pdf = plain(M.selectPages({ pages: BOOK, structure: untrusted, query: "what about p. 5?", focus: [idx(40)], budget: 20000 }));
	assert.equal(pdf.find(p => p.page === 4).reason, "ref", "PDF page 5 when labels are a guess");
});

test("selectPages: BM25 stops at 60% and the reading position is a soft prior", () => {
	const pages = Array.from({ length: 12 }, (_, i) => ("filler words here page " + i).padEnd(100, "."));
	pages[5] = "zeta function notes".padEnd(100, ".");
	pages[10] = "zeta function notes".padEnd(100, ".");
	const outline = M.outlineRanges([
		{ id: "1", title: "A", level: 1, start: 0 },
		{ id: "2", title: "B", level: 1, start: 4 },
		{ id: "3", title: "C", level: 1, start: 8 },
	], null, 12);
	const structure = { labels: [], confidence: 0, outline };
	const pick = (focus, read, budget) => plain(M.selectPages({
		pages, structure, progress: { ...M.emptyProgress(), read }, query: "zeta", focus: [focus], budget,
	}));
	// 500 chars: the focus page and one hit fill the 60%, a near page the rest.
	assert.deepEqual(pick(0, [], 500).map(p => [p.page, p.reason]), [[1, "near"], [5, "search"], [0, "focus"]]);
	assert.equal(pick(0, [10], 500).find(p => p.reason === "search").page, 10, "×1.2 for a page already read");
	const inSection = pick(8, [5], 1000);
	assert.deepEqual(inSection.filter(p => p.reason === "search").map(p => p.page), [10], "×1.5 for the current section beats ×1.2");
});

test("selectPages: the opener is the first section start the context pages miss; blank pages are skipped", () => {
	const pages = Array.from({ length: 12 }, (_, i) => ("words on page " + i).padEnd(100, "."));
	pages[9] = "  \n ";
	const outline = M.outlineRanges([
		{ id: "1", title: "A", level: 1, start: 0 },
		{ id: "2", title: "B", level: 1, start: 3 },
		{ id: "2.1", title: "B1", level: 2, start: 7 },
	], null, 12);
	const list = plain(M.selectPages({ pages, structure: { labels: [], confidence: 0, outline }, query: "", focus: [8], budget: 2000 }));
	const reason = page => list.find(p => p.page === page)?.reason;
	assert.equal(reason(3), "opener");
	assert.equal(reason(7), "context");
	assert.equal(reason(9), undefined, "a blank page says nothing");
});

test("selectPages: a cited figure whose page is only a short caption is still sent", () => {
	const pages = Array.from({ length: 20 }, (_, i) => "Body of page " + i + " " + "words ".repeat(60));
	pages[12] = "Figure 2.7 Graph of x[n].";
	const structure = { labels: [], confidence: 0, outline: [], objects: M.indexObjects(pages) };
	const list = plain(M.selectPages({ pages, structure, query: "explain Figure 2.7", focus: [3], budget: 20000 }));
	assert.equal(list.find(p => p.page === 12)?.reason, "ref");
});

test("selectPages: a query with no content words searches with the focus page's rare terms", () => {
	const pages = Array.from({ length: 40 }, (_, i) => ("common words on page " + i + " ").repeat(20));
	pages[10] += " the hilbert transformer quadrature";
	pages[30] += " a hilbert transformer again with quadrature";
	const structure = { labels: [], confidence: 0, outline: [] };
	for (const query of ["explain this", "spiegami"]) {
		const list = plain(M.selectPages({ pages, structure, query, focus: [10], budget: 4000 }));
		assert.equal(list.find(p => p.page === 30)?.reason, "search", query);
	}
	const selected = plain(M.selectPages({ pages, structure, query: "explain this", selection: "quadrature", focus: [2], budget: 6000 }));
	assert.ok(selected.some(p => p.page === 30 && p.reason === "search"), "the selection is searched too");
});

test("a page number no printed page carries falls back to the PDF page", () => {
	assert.equal(M.pageIndexFor(OUTLINE, "55", BOOK.length), 54, "printed 55 does not exist, PDF page 55 does");
	assert.equal(M.pageIndexFor(OUTLINE, "99", BOOK.length), null);
	assert.equal(M.pageIndexFor(OUTLINE, "xx", BOOK.length), null);
	// A journal paper printed 1123–1130: "page 3" is the third page of the PDF.
	const paper = M.inferPageLabels(Array.from({ length: 8 }, (_, i) => "IEEE TRANS\n" + "text ".repeat(50) + "\n" + (1123 + i)));
	assert.ok(paper.confidence >= M.LABEL_MIN_CONFIDENCE);
	assert.equal(M.pageIndexFor(paper, "3", 8), 2);
	assert.equal(M.pageIndexFor(paper, "1125", 8), 2);
	assert.equal(M.pageIndexFor(OUTLINE, "5", BOOK.length), idx(5));
	assert.equal(M.pageIndexFor({ ...plain(OUTLINE), confidence: 0.1 }, "5", BOOK.length), 4);
});

test("selectPages: hits beyond the frontier are kept and tagged ahead", () => {
	let progress = null;
	let t = 0;
	for (let page = idx(31); page <= idx(36); page++) {
		progress = M.applyPageEvent(progress, page, (t += 20000), OUTLINE);
	}
	const list = plain(M.selectPages({ pages: BOOK, structure: OUTLINE, progress, query: "decimation interpolation", focus: [idx(36)], budget: 20000 }));
	const ahead = list.filter(p => p.ahead);
	assert.ok(ahead.length, "rate-conversion pages are still sent");
	assert.ok(ahead.every(p => p.page > idx(36)));
	assert.ok(list.filter(p => p.page <= idx(36)).every(p => !p.ahead));
	assert.ok(list.some(p => p.reason === "search" && p.ahead));
});

test("selectPages: 60k and 12k budgets on the 1132-page book", () => {
	const structure = M.buildStructure(BIG);
	const index = M.buildBM25(BIG);
	for (const budget of [60000, 12000]) {
		const list = plain(M.selectPages({ pages: BIG, structure, query: "talk about moving average on page 18", focus: [40], budget, index }));
		assert.equal(list[list.length - 1].page, 40);
		assert.ok(sizeOf(BIG, list, budget) <= budget, budget + ": " + sizeOf(BIG, list, budget));
		assert.ok(list.some(p => p.page === 39), "the previous page");
	}
	const wide = plain(M.selectPages({ pages: BIG, structure, query: "talk about moving average on page 18", focus: [40], budget: 60000, index }));
	assert.ok(wide.some(p => p.page === 300 && p.reason === "search"));
	const nothing = plain(M.selectPages({ pages: BIG, structure, query: "", focus: [], budget: 12000 }));
	assert.equal(nothing[0].page, 1, "no focus: from the start, past the blank cover");
});

// ---------------------------------------------------------------- map

test("renderMap expands the current chapter and gives files, pages and state", () => {
	let progress = null;
	let t = 0;
	for (let page = idx(31); page <= idx(40); page++) {
		progress = M.applyPageEvent(progress, page, (t += 20000), OUTLINE);
	}
	const map = M.renderMap(OUTLINE, OUTLINE.outline, progress);
	const lines = map.split("\n");
	assert.ok(lines[0].includes("60 PDF pages"));
	const chapter3 = lines.find(l => l.includes("3 Sampling"));
	assert.match(chapter3, /pages 38–60 \(printed 31–53\)/);
	assert.match(chapter3, /text\/\d{2}-[a-z0-9-]+\.md/);
	assert.match(chapter3, /reading$/);
	assert.ok(lines.some(l => /^ {2}- 3\.1 Periodic Sampling .* read$/.test(l)));
	assert.ok(lines.some(l => /^ {2}- 3\.2 Aliasing .* reading$/.test(l)));
	assert.ok(!lines.some(l => l.includes("2.1 Sequences")), "other chapters stay one line");
	assert.ok(lines.some(l => /^- 2 Discrete-Time Signals .* unread$/.test(l)));
	assert.ok(map.length <= M.MAP_PROMPT_CHARS);

	const tight = M.renderMap(OUTLINE, OUTLINE.outline, progress, { maxChars: 400 });
	assert.ok(tight.length <= 400);
	assert.ok(tight.includes("3 Sampling"), "the current chapter survives");
	assert.match(tight, /left out/);
	assert.ok(M.renderMap(OUTLINE, OUTLINE.outline, null).includes("1 Introduction"));
});

// ---------------------------------------------------------------- memory

const HISTORY = [
	{ role: "user", text: "Spiegami in italiano, per favore" },
	{ role: "assistant", text: "Certo." },
	{ role: "user", text: "Why is the DTFT periodic?" },
];

test("memory patches: kinds, ids, provenance, pages and cleaning", () => {
	const empty = M.emptyMemory();
	const { memory, rejected } = M.applyMemoryPatch(empty, {
		summary: "We covered <b>LTI</b> systems, see https://example.com/x for more.",
		add: [
			{ kind: "understood", text: "DTFT is 2π-periodic", page: 41 },
			{ kind: "preference", text: "Answers in Italian", source: 0 },
			{ kind: "preference", text: "Lots of jokes", source: 1 },
			{ kind: "open", text: "Why must |ω| < π hold here?", page: 9999 },
			{ kind: "open", text: "Why must |ω| < π hold here?" },
			{ kind: "secret", text: "rm -rf" },
			{ kind: "note", text: "<b></b> " },
			{ kind: "shaky", text: "ROC of left-sided sequences", page: 0 },
			{ kind: "understood", text: "dtft is 2π-periodic" },
			"not an object",
		],
	}, { history: HISTORY, pageCount: 1132 });
	assert.deepEqual(plain(memory.items).map(i => [i.id, i.kind, i.text]), [
		["m1", "understood", "DTFT is 2π-periodic"],
		["m2", "preference", "Answers in Italian"],
		["m3", "open", "Why must |ω| < π hold here?"],
	]);
	assert.equal(memory.items[0].page, 41);
	assert.equal(memory.summary, "We covered LTI systems, see for more.");
	assert.deepEqual(plain(rejected).map(r => r.reason), [
		"preference without a user message", "page out of range", "unknown kind", "empty",
		"page out of range", "duplicate", "not an object",
	]);
	assert.deepEqual(plain(empty.items), [], "the input is not changed");
	const maths = M.applyMemoryPatch(M.emptyMemory(), {
		add: [{ kind: "understood", text: "causal means h[n]=0 for n<N and h[n]>0 elsewhere; a<b and c>d" }],
		summary: "<b>bold</b> <span class=\"x\">s</span></reading_map> x<y",
	}).memory;
	assert.equal(maths.items[0].text, "causal means h[n]=0 for n<N and h[n]>0 elsewhere; a<b and c>d");
	assert.equal(maths.summary, "bold s x<y");
});

test("memory patches: resolve and remove by id, caps drop the oldest", () => {
	let { memory } = M.applyMemoryPatch(M.emptyMemory(), {
		add: [{ kind: "open", text: "Q1" }, { kind: "shaky", text: "S1" }, { kind: "understood", text: "U1" }],
	});
	let result = M.applyMemoryPatch(memory, { resolve: ["m1", "m3", "m9"], remove: ["m2"] });
	assert.deepEqual(plain(result.memory.items).map(i => i.id), ["m3"]);
	assert.deepEqual(plain(result.rejected).map(r => [r.id, r.reason]), [["m3", "not resolvable"], ["m9", "unknown id"]]);
	const many = Array.from({ length: M.MEMORY_CAPS.understood + 2 }, (_, k) => ({ kind: "understood", text: "fact " + k }));
	result = M.applyMemoryPatch(M.emptyMemory(), { add: many });
	const kept = result.memory.items.filter(i => i.kind === "understood");
	assert.equal(kept.length, M.MEMORY_CAPS.understood);
	assert.equal(kept[0].text, "fact 2");
	const long = M.applyMemoryPatch(M.emptyMemory(), { add: [{ kind: "note", text: "w ".repeat(400) }], summary: "s".repeat(5000) });
	assert.ok(long.memory.items[0].text.length <= M.MEMORY_ITEM_CHARS);
	assert.ok(long.memory.summary.length <= M.MEMORY_SUMMARY_CHARS);
	assert.deepEqual(plain(M.applyMemoryPatch(M.emptyMemory(), null).rejected), [{ reason: "not a patch" }]);
});

test("renderMemory puts the live position first and fits the cap", () => {
	const { memory } = M.applyMemoryPatch(M.emptyMemory(), {
		summary: "Covered sampling.",
		add: [
			{ kind: "understood", text: "Nyquist rate", page: idx(31) + 1 },
			{ kind: "preference", text: "Answers in Italian", source: 0 },
			{ kind: "open", text: "Why low-pass before decimation?" },
		],
	}, { history: HISTORY, pageCount: BOOK.length });
	let progress = null;
	let t = 0;
	for (let page = idx(31); page <= idx(35); page++) {
		progress = M.applyPageEvent(progress, page, (t += 20000), OUTLINE);
	}
	const text = M.renderMemory(memory, progress, OUTLINE);
	const lines = text.split("\n");
	assert.match(lines[0], /^Where we are: page 42 \(printed 35\), in 3\.1 Periodic Sampling, 4 pages read, read up to page 41 \(printed 34\)\.$/);
	assert.ok(text.includes("[m2 preference] Answers in Italian"));
	assert.ok(text.includes("[m1 understood] Nyquist rate (page 38 (printed 31))"));
	assert.ok(text.includes("So far: Covered sampling."));
	assert.ok(text.indexOf("preference") < text.indexOf("understood"));

	const many = Array.from({ length: 12 }, (_, k) => ({ kind: "note", text: "note number " + k + " " + "z".repeat(60) }));
	const full = M.applyMemoryPatch(memory, { add: many }).memory;
	const tight = M.renderMemory(full, progress, OUTLINE, { maxChars: 500 });
	assert.ok(tight.length <= 500);
	assert.ok(tight.startsWith("Where we are:"));
	assert.ok(tight.includes("Answers in Italian"), "preferences outlive notes");
	assert.ok(!tight.includes("note number 0 "), "the oldest note goes first");
	assert.equal(M.renderMemory(M.emptyMemory(), null, OUTLINE), "Where we are: no reading recorded yet.");
});
