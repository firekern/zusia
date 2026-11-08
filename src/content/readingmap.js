"use strict";

// The reading map of a paper or a book, as pure functions over plain data: printed page
// labels, the outline with page ranges, section files, where each equation and figure is
// defined, BM25 search, reading progress, the pages sent inline, and the memory format.
// Nothing here touches Zotero, files or the DOM, so zusia.js keeps every side effect and
// this file is tested on its own (test/readingmap.test.mjs).
//
// Page numbers: `i`, `start`, `end` and `page` in results are 0-based PDF indices, as in
// zusia.js. Labels are the numbers printed on the page ("18", "xv"). Text meant for the
// model says "page 41 (printed 18)", the PDF number first, like the page markers.
var ZusiaMap = {
	// Below this the printed numbers are a guess, so markers show the PDF number only.
	LABEL_MIN_CONFIDENCE: 0.8,
	DWELL_READ_MS: 15000,
	// A page left open over lunch counts as ten minutes, not two hours.
	DWELL_CAP_MS: 600000,
	// Claude's Read truncates long files; 45k chars stays well inside it.
	SECTION_CHARS: { min: 8000, max: 45000 },
	MAP_PROMPT_CHARS: 4000,
	MEMORY_PROMPT_CHARS: 4000,
	// What a page marker and the blank lines around it add to a page.
	PAGE_OVERHEAD: 40,
	// Room kept in a section file for the range line under its heading, the newlines and
	// the zero-width spaces of neutralised markers; the heading is measured.
	FILE_RANGE_CHARS: 160,
	// An anchor is Zotero's own label for that page, so it outweighs any folio vote.
	ANCHOR_WEIGHT: 1000,
	// Supports one offset needs, and how far apart they may be, to count as a run.
	RUN_MIN: { arabic: 3, roman: 2 },
	RUN_GAP: 12,
	// BM25 hits may fill this share of the budget; the rest goes to nearby pages.
	SEARCH_SHARE: 0.6,
	MEMORY_KINDS: ["preference", "open", "shaky", "understood", "note"],
	MEMORY_CAPS: { preference: 6, open: 8, shaky: 8, understood: 12, note: 12 },
	MEMORY_ITEM_CHARS: 280,
	MEMORY_SUMMARY_CHARS: 1500,
	// Notes are the user's own (/remember): a model's patch may neither add nor drop one.
	MODEL_KINDS: ["preference", "open", "shaky", "understood"],
	GIST_CHARS: 900,
	GIST_PROMPT_CHARS: 3000,

	// ------------------------------------------------------------ page labels

	romanValue(text) {
		let digits = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
		let total = 0;
		for (let k = 0; k < text.length; k++) {
			let value = digits[text[k]];
			total += value < (digits[text[k + 1]] || 0) ? -value : value;
		}
		return total;
	},

	toRoman(value) {
		let out = "";
		for (let [n, digits] of [[100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]]) {
			for (; value >= n; value -= n) {
				out += digits;
			}
		}
		return out;
	},

	// {style, value} for an arabic or canonical lowercase roman label, else null: "A-3",
	// "IV" in a running title or "iiii" are not folios.
	parseLabel(label) {
		let text = String(label).trim();
		if (/^\d{1,4}$/.test(text) && +text > 0) {
			return { style: "arabic", value: +text };
		}
		if (/^[ivxlc]{1,8}$/.test(text)) {
			let value = this.romanValue(text);
			if (value <= 100 && this.toRoman(value) === text) {
				return { style: "roman", value };
			}
		}
		return null;
	},

	formatLabel(style, value) {
		return style === "arabic" ? String(value) : this.toRoman(value);
	},

	// Folios sit at either end of the running header or the footer, so only the first and
	// last word of the first and last line are candidates.
	folioCandidates(text) {
		let lines = text.split("\n").map(line => line.trim()).filter(Boolean);
		if (!lines.length) {
			return [];
		}
		let tokens = new Set();
		for (let line of [lines[0], lines[lines.length - 1]]) {
			let words = line.split(/\s+/);
			tokens.add(words[0]);
			tokens.add(words[words.length - 1]);
		}
		return [...tokens].map(token => this.parseLabel(token)).filter(Boolean);
	},

	// One label per page from runs of folios that agree on an offset (page index minus
	// printed value). Runs claim pages heaviest first; a page between runs inherits the
	// run before it, pages before the first run the first run. Anchors {pageIndex, label,
	// parsed} from Zotero vote with a large weight and win their own page, unless a folio
	// run holds that page and prints another number there: Zotero reports the PDF number
	// when a PDF has no labels, and pinning it would leave the printed page unreachable
	// and its number twice in the run. Those anchors come back as `conflicts`. A run is a
	// folio run by its folios alone: anchors on every page of an unlabelled PDF plus one
	// stray number that matches them must not outrank the printed folios.
	labelRuns(candidates, anchors) {
		let votes = new Map();
		let vote = (style, offset, page, weight) => {
			let key = style + ":" + offset;
			if (!votes.has(key)) {
				votes.set(key, { style, offset, supports: [] });
			}
			votes.get(key).supports.push({ page, weight });
		};
		candidates.forEach((list, i) => list.forEach(c => vote(c.style, i - c.value, i, 1)));
		for (let { pageIndex, parsed } of anchors) {
			if (parsed) {
				vote(parsed.style, pageIndex - parsed.value, pageIndex, this.ANCHOR_WEIGHT);
			}
		}
		let clusters = [];
		for (let { style, offset, supports } of votes.values()) {
			supports.sort((a, b) => a.page - b.page);
			let group = [];
			let flush = () => {
				let weight = group.reduce((sum, s) => sum + s.weight, 0);
				if (weight >= this.RUN_MIN[style]) {
					let folios = group.filter(s => s.weight === 1).length;
					clusters.push({ style, offset, start: group[0].page, end: group[group.length - 1].page, weight, folios, folio: folios >= this.RUN_MIN[style] });
				}
				group = [];
			};
			for (let support of supports) {
				if (group.length && support.page - group[group.length - 1].page > this.RUN_GAP) {
					flush();
				}
				group.push(support);
			}
			flush();
		}
		// Anchors that no folio agrees with claim only pages no folio run holds: one odd
		// annotation label must not relabel the pages around it.
		clusters.sort((a, b) => b.folio - a.folio || (a.folio ? b.folios - a.folios : 0) || b.weight - a.weight || a.start - b.start);
		let owner = new Array(candidates.length).fill(null);
		for (let cluster of clusters) {
			let taken = 0;
			for (let i = cluster.start; i <= cluster.end; i++) {
				taken += owner[i] ? 1 : 0;
			}
			// A run mostly inside a heavier one is noise that happens to line up.
			if (taken * 2 > cluster.end - cluster.start + 1) {
				continue;
			}
			for (let i = cluster.start; i <= cluster.end; i++) {
				owner[i] = owner[i] || cluster;
			}
		}
		let held = owner.slice();
		let first = owner.findIndex(Boolean);
		if (first > 0) {
			owner.fill(owner[first], 0, first);
		}
		for (let i = 1; i < owner.length; i++) {
			owner[i] = owner[i] || owner[i - 1];
		}
		let labels = owner.map((cluster, i) => (cluster && i - cluster.offset >= 1 ? this.formatLabel(cluster.style, i - cluster.offset) : null));
		let conflicts = [];
		for (let { pageIndex, label, parsed } of anchors) {
			if (parsed && held[pageIndex] && held[pageIndex].folio && labels[pageIndex] !== label) {
				conflicts.push({ pageIndex, label });
				continue;
			}
			labels[pageIndex] = label;
		}
		let runs = [];
		owner.forEach((cluster, i) => {
			let last = runs[runs.length - 1];
			if (last && last.cluster === cluster) {
				last.end = i;
			}
			else {
				runs.push({ cluster, start: i, end: i });
			}
		});
		runs = runs.filter(run => run.cluster).map(({ cluster, start, end }) =>
			// Reported as PDF page number minus printed number, the way people say it.
			({ start, end, style: cluster.style, offset: cluster.offset + 1 }));
		return { labels, runs, conflicts };
	},

	// {labels, confidence 0..1, method, runs, conflicts}. Confidence is the share of folio-bearing
	// pages that agree with their label, scaled down when few pages carry one at all.
	inferPageLabels(pages, anchors = []) {
		let candidates = pages.map(text => this.folioCandidates(text));
		let pinned = anchors
			.filter(a => Number.isInteger(a.pageIndex) && a.pageIndex >= 0 && a.pageIndex < pages.length && a.label != null && String(a.label).trim())
			.map(a => ({ pageIndex: a.pageIndex, label: String(a.label).trim(), parsed: this.parseLabel(a.label) }));
		let { labels, runs, conflicts } = this.labelRuns(candidates, pinned);
		let anchorPages = new Set(pinned.map(a => a.pageIndex));
		let agree = 0;
		let conflict = 0;
		candidates.forEach((list, i) => {
			if (labels[i] === null || anchorPages.has(i) || !list.length) {
				return;
			}
			if (list.some(c => this.formatLabel(c.style, c.value) === labels[i])) {
				agree++;
			}
			else {
				conflict++;
			}
		});
		let labelled = labels.filter(label => label !== null).length;
		let folios = agree ? (agree / (agree + conflict)) * Math.min(1, agree / Math.max(3, 0.25 * labelled)) : 0;
		let method = agree ? (pinned.length ? "folios+anchors" : "folios") : (pinned.length ? "anchors" : "none");
		let confidence = folios;
		if (method === "anchors") {
			confidence = 0.9;
		}
		else if (method === "folios+anchors") {
			let alone = this.labelRuns(candidates, []).labels;
			if (pinned.every(a => alone[a.pageIndex] === a.label)) {
				confidence = Math.max(folios, 0.95);
			}
		}
		return { labels, confidence, method, runs, conflicts };
	},

	trusted(structure) {
		return !!structure && structure.confidence >= this.LABEL_MIN_CONFIDENCE;
	},

	runAt(structure, i) {
		return ((structure && structure.runs) || []).find(run => run.start <= i && i <= run.end) || null;
	},

	// The PDF index printed with `label`, or null. A label can repeat (an appendix that
	// restarts at 1, a pinned anchor, Zotero's arabic labels on the front matter); "18"
	// then means the page in the longest arabic run, the main matter.
	labelToIndex(structure, label) {
		let want = String(label).trim().toLowerCase();
		let labels = (structure && structure.labels) || [];
		let matches = [];
		labels.forEach((l, i) => {
			if (l !== null && l.toLowerCase() === want) {
				matches.push(i);
			}
		});
		if (!want || !matches.length) {
			return null;
		}
		if (/^\d+$/.test(want)) {
			let best = null;
			let length = -1;
			for (let i of matches) {
				let run = this.runAt(structure, i);
				if (run && run.style === "arabic" && run.end - run.start > length) {
					best = i;
					length = run.end - run.start;
				}
			}
			if (best !== null) {
				return best;
			}
		}
		return matches[0];
	},

	// What the user means by "page 18": the printed page when the labels are trusted, else
	// the PDF page, the only number they can then check. A number no page carries is the
	// PDF page too: "page 3" of a paper printed 1123–1130 is its third page.
	pageIndexFor(structure, label, pageCount) {
		let printed = this.trusted(structure) ? this.labelToIndex(structure, label) : null;
		if (printed !== null) {
			return printed;
		}
		let n = +label;
		return Number.isInteger(n) && n >= 1 && n <= pageCount ? n - 1 : null;
	},

	printedLabel(i, structure) {
		let label = this.trusted(structure) ? structure.labels[i] : null;
		return label && label !== String(i + 1) ? label : null;
	},

	pageMarker(i, structure) {
		let label = this.printedLabel(i, structure);
		return "--- page " + (i + 1) + (label ? " (printed " + label + ")" : "") + " ---";
	},

	pageName(i, structure) {
		let label = this.printedLabel(i, structure);
		return "page " + (i + 1) + (label ? " (printed " + label + ")" : "");
	},

	rangeName(start, end, structure) {
		if (start === end) {
			return this.pageName(start, structure);
		}
		let a = this.printedLabel(start, structure);
		let b = this.printedLabel(end, structure);
		return "pages " + (start + 1) + "–" + (end + 1) + (a && b ? " (printed " + a + "–" + b + ")" : "");
	},

	// A line of page text that looks like a marker would let a PDF move the model's idea
	// of where it is; a zero-width space in front keeps it readable but not a marker.
	escapeMarkers(text) {
		// Any space but a line break: `\s` would reach back over a blank line and put the
		// zero-width space there instead.
		return text.replace(/^(?=[^\S\r\n]*-{3}[^\S\r\n]*page\b)/gimu, "\u200b");
	},

	renderPage(i, text, structure) {
		return this.pageMarker(i, structure) + "\n" + this.escapeMarkers(text);
	},

	// ------------------------------------------------------------ outline

	// Lowercase letters and digits only, so "Discrete-Time\nSignals" on a chapter opener
	// matches the TOC's "Discrete-Time Signals", and squashed extraction still matches.
	squash(text) {
		return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
	},

	titleOnPage(title, text) {
		let key = this.squash(title).slice(0, 24);
		return key.length >= 3 && this.squash(text || "").includes(key);
	},

	TOC_NAMED: /^(Preface|Foreword|Acknowledge?ments|Bibliography|References|Index|Glossary|Prefazione|Ringraziamenti|Bibliografia|Indice analitico)\s*(?:(?:\.\s*){2,}|\s)\s*(\d{1,4}|[ivxlc]{1,7})\s*$/gim,
	// A numbered entry anywhere in a line, since Zotero joins TOC lines; the title cannot
	// start with a digit, which stops "… 70 3 The z-Transform 99" reading as entry 70. A
	// roman page needs dot leaders or the line end, or "Segnali e i sistemi" would stop at
	// the article "i" and point at page i.
	TOC_NUMBERED: /(?:^|\s)(\d{1,2}(?:\.\d{1,2}){0,3})\s+([^\s.\d][^\n]{0,150}?)\s*(?:(?:\.\s*){2,}(\d{1,4}|[ivxlc]{1,7})|\s(\d{1,4}|[ivxlc]{1,7}(?=[ \t]*$)))(?=\s|$)/gm,
	TOC_LETTER: /^([A-Z])\s+([^\s.\d][^\n]{1,120}?)\s*(?:(?:\.\s*){2,}|\s)(\d{1,4})\s*$/gm,

	tocEntries(text) {
		let found = [];
		for (let m of text.matchAll(this.TOC_NAMED)) {
			found.push({ at: m.index, id: m[1].toLowerCase().replace(/\s+/g, "-"), title: m[1], level: 1, label: m[2] });
		}
		for (let m of text.matchAll(this.TOC_NUMBERED)) {
			found.push({ at: m.index, id: m[1], title: m[2], level: m[1].split(".").length, label: m[3] ?? m[4] });
		}
		for (let m of text.matchAll(this.TOC_LETTER)) {
			found.push({ at: m.index, id: m[1], title: m[2], level: 1, label: m[3] });
		}
		return found
			.map(e => ({ ...e, title: e.title.replace(/[\s.]+$/, "") }))
			.filter(e => e.title && !/\.\s?\./.test(e.title) && this.parseLabel(e.label))
			.sort((a, b) => a.at - b.at);
	},

	// Entries {id, title, level, label} of the printed table of contents, found in the
	// first pages: a page with three or more entries that says "Contents" or has dot
	// leaders, and the pages right after it that still have entries.
	parsePrintedToc(pages) {
		let scan = Math.min(pages.length, Math.max(30, Math.ceil(pages.length * 0.06)));
		let raw = [];
		let inside = false;
		for (let i = 0; i < scan; i++) {
			let text = pages[i];
			let entries = this.tocEntries(text);
			let looks = /\b(contents|indice|sommario)\b/i.test(text.slice(0, 300)) || (text.match(/(?:\.\s*){4,}/g) || []).length >= 3;
			if (entries.length >= 3 && (looks || inside)) {
				inside = true;
				raw.push(...entries.map(e => ({ ...e, tocPage: i })));
			}
			else if (inside) {
				break;
			}
		}
		let out = [];
		let seen = new Set();
		let chapter = null;
		let lastPage = 0;
		for (let e of raw) {
			let parsed = this.parseLabel(e.label);
			let head = /^\d/.test(e.id) ? +e.id.split(".")[0] : null;
			// A page number misread as an entry ("… 70 Problems … 70") jumps chapters.
			if (head !== null && chapter !== null && (head < chapter || head > chapter + 3)) {
				continue;
			}
			if (parsed.style === "arabic" && parsed.value < lastPage) {
				continue;
			}
			if (seen.has(e.id)) {
				continue;
			}
			seen.add(e.id);
			chapter = head ?? chapter;
			lastPage = parsed.style === "arabic" ? parsed.value : lastPage;
			out.push({ id: e.id, title: e.title, level: e.level, label: e.label, tocPage: e.tocPage });
		}
		return out;
	},

	// TOC entries with their start page, keeping only those whose title is printed on
	// that page: a wrong label or a misparsed entry then drops out instead of misleading.
	resolveToc(entries, structure, pages) {
		let out = [];
		for (let e of entries) {
			let start = this.pageIndexFor(structure, e.label, pages.length);
			if (start !== null && this.titleOnPage(e.title, pages[start])) {
				out.push({ id: e.id, title: e.title, level: e.level, start });
			}
		}
		return out;
	},

	looksLikeTitle(line) {
		return /^[A-Z][^=[\]{}<>]{1,80}$/.test(line) && !/[.:;,]$/.test(line) && line.split(/\s+/).length <= 12;
	},

	// Whether heading number `next` can follow `prev`: a first child (x.0 or x.1), or the
	// next sibling at any depth, allowing one missed heading. Anything else is a numbered
	// line in the text (a problem, a list), not a heading.
	followsHeading(prev, next) {
		if (!prev) {
			return true;
		}
		let same = k => prev.slice(0, k).every((n, j) => n === next[j]);
		if (next.length === prev.length + 1 && same(prev.length) && next[next.length - 1] <= 1) {
			return true;
		}
		for (let k = 1; k <= prev.length; k++) {
			if (next.length === k && same(k - 1) && next[k - 1] > prev[k - 1] && next[k - 1] <= prev[k - 1] + 2) {
				return true;
			}
		}
		return false;
	},

	// Numbered headings in the text, for books with no printed TOC: "Chapter 3",
	// a chapter number alone above its title, or "3.2 Title" on its own line.
	detectHeadings(pages) {
		let found = [];
		let last = null;
		let accept = (id, title, start) => {
			let parts = id.split(".").map(Number);
			title = title.replace(/\s+\d{1,4}$/, "").trim();
			if (title && this.followsHeading(last, parts)) {
				found.push({ id, title, level: parts.length, start });
				last = parts;
			}
		};
		pages.forEach((text, i) => {
			let lines = text.split("\n").map(line => line.trim()).filter(Boolean);
			lines.forEach((line, k) => {
				let next = lines[k + 1] || "";
				let m = /^(?:chapter|capitolo)\s+(\d{1,2})\b[\s.:–—-]*(.*)$/i.exec(line);
				if (m) {
					accept(m[1], m[2] || (this.looksLikeTitle(next) ? next : ""), i);
				}
				else if (/^\d{1,2}$/.test(line) && k < 3 && this.looksLikeTitle(next)) {
					let after = lines[k + 2] || "";
					let joined = this.looksLikeTitle(after) && (next + " " + after).length < 60 ? next + " " + after : next;
					accept(line, joined, i);
				}
				else if ((m = /^(\d{1,2}(?:\.\d{1,2}){1,3})\s+(.+)$/.exec(line)) && this.looksLikeTitle(m[2])) {
					// A running header such as "2.3 Convolution 25" carries a folio.
					if (k > 0 || !this.folioCandidates(line).length) {
						accept(m[1], m[2], i);
					}
				}
			});
		});
		return found;
	},

	// Contiguous ranges {id, title, level, start, end} over all `pageCount` pages. Entries
	// give `start` or a printed `label`; one starting before the previous is dropped. A
	// "Front matter" entry covers the pages before the first one; with no entries the
	// text is cut into fixed chunks. An entry ends where the next one at its level or
	// above starts. Top-level ranges partition the pages, so of two top-level entries on
	// one page only the later stays; two subsections that begin on one page both hold it.
	outlineRanges(entries, structure, pageCount, { chunk = 20 } = {}) {
		let list = [];
		for (let e of entries) {
			let start = Number.isInteger(e.start) ? e.start : this.labelToIndex(structure, e.label);
			if (start === null || start < 0 || start >= pageCount || (list.length && start < list[list.length - 1].start)) {
				continue;
			}
			list.push({ id: e.id, title: e.title, level: e.level, start });
		}
		if (!list.length) {
			for (let start = 0; start < pageCount; start += chunk) {
				let end = Math.min(pageCount, start + chunk);
				list.push({ id: "p" + (start + 1), title: "Pages " + (start + 1) + "–" + end, level: 1, start });
			}
		}
		let top = Math.min(...list.map(e => e.level));
		list = list.map(e => ({ ...e, level: e.level - top + 1 }));
		list = list.filter((e, k) => e.level > 1 || list.slice(k + 1).find(other => other.level === 1)?.start !== e.start);
		if (list[0].start > 0) {
			list.unshift({ id: "front", title: "Front matter", level: 1, start: 0 });
		}
		return list.map((e, k) => {
			let next = list.slice(k + 1).find(other => other.level <= e.level);
			return { ...e, end: next ? Math.max(e.start, next.start - 1) : pageCount - 1 };
		});
	},

	// The deepest entry that contains page `i`, the later one when two share the page.
	sectionOf(outline, i) {
		let best = null;
		for (let e of outline || []) {
			if (e.start <= i && i <= e.end && (!best || e.level > best.level || (e.level === best.level && e.start >= best.start))) {
				best = e;
			}
		}
		return best;
	},

	chapterOf(outline, i) {
		return (outline || []).find(e => e.level === 1 && e.start <= i && i <= e.end) || null;
	},

	entryTitle(entry) {
		return (/^(\d|[A-Z]$)/.test(entry.id) ? entry.id + " " : "") + entry.title;
	},

	// TOC first, numbered headings second, fixed chunks last.
	buildOutline(pages, structure) {
		let toc = this.resolveToc(this.parsePrintedToc(pages), structure, pages);
		let entries = toc.length >= 3 ? toc : this.detectHeadings(pages);
		let method = entries.length ? (entries === toc ? "toc" : "headings") : "chunks";
		return { outline: this.outlineRanges(entries, structure, pages.length), method };
	},

	// ------------------------------------------------------------ section files

	// 32-bit FNV-1a, enough to tell whether a section's text changed.
	fnv1a(text) {
		let hash = 0x811c9dc5;
		for (let k = 0; k < text.length; k++) {
			hash ^= text.charCodeAt(k);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, "0");
	},

	slug(title) {
		let slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
		if (slug.length > 40) {
			slug = slug.slice(0, 41).replace(/-[^-]*$/, "") || slug.slice(0, 40);
		}
		return slug || "part";
	},

	// Files {name, title, start, end, chars, hash} that cover every page in order. A
	// top-level entry longer than `max` splits at its children, recursively, and by pages
	// when it has none; a file under `min` takes in the next one while both fit, so a
	// chapter's one-page opener lands with its first section, and a short last file
	// joins the one before. A page longer than a file becomes files of one part each,
	// with `from` and `to` character offsets into it.
	splitSections(pages, outline, { min, max } = this.SECTION_CHARS) {
		let size = (s, e) => {
			let total = 0;
			for (let i = s; i <= e; i++) {
				total += pages[i].length + this.PAGE_OVERHEAD;
			}
			return total;
		};
		// "# " + the longest title + a part number such as " (12)".
		let heading = 2 + Math.max("Full text".length, ...outline.map(e => this.entryTitle(e).length)) + 8;
		let limit = max - this.FILE_RANGE_CHARS - heading;
		let units = [];
		// `top` marks the unit that starts a top-level entry: a merged file is named after
		// its biggest such unit, so "Acknowledgments" does not name chapter 1's file.
		let split = (title, level, s, e, top) => {
			if (size(s, e) <= limit) {
				units.push({ title, start: s, end: e, top });
				return;
			}
			let cuts = [...new Set(outline.filter(c => c.level === level + 1 && c.start > s && c.start <= e).map(c => c.start))];
			if (!cuts.length) {
				let part = 1;
				let from = s;
				let used = 0;
				let first = top;
				let emit = (start, end, slice) => {
					units.push({ title: title + " (" + part++ + ")", start, end, top: first, ...slice });
					first = false;
				};
				for (let i = s; i <= e; i++) {
					let page = pages[i].length + this.PAGE_OVERHEAD;
					if (i > from && used + page > limit) {
						emit(from, i - 1);
						from = i;
						used = 0;
					}
					// A web page or an EPUB can come as one page of the whole text.
					if (page > limit) {
						for (let [a, b] of this.cutText(pages[i], limit - this.PAGE_OVERHEAD)) {
							emit(i, i, { from: a, to: b });
						}
						from = i + 1;
						continue;
					}
					used += page;
				}
				if (from <= e) {
					emit(from, e);
				}
				if (part === 2) {
					units[units.length - 1].title = title;
				}
				return;
			}
			let starts = [s, ...cuts];
			starts.forEach((start, k) => {
				let end = k + 1 < starts.length ? starts[k + 1] - 1 : e;
				let child = k ? outline.find(c => c.level === level + 1 && c.start === start) : null;
				split(child ? this.entryTitle(child) : title, level + 1, start, end, top && !k);
			});
		};
		let tops = outline.filter(e => e.level === 1);
		if (!tops.length) {
			tops = [{ id: "all", title: "Full text", level: 1, start: 0, end: pages.length - 1 }];
		}
		for (let top of tops) {
			split(this.entryTitle(top), 1, top.start, top.end, true);
		}
		let files = [];
		let join = (file, unit) => {
			file.end = unit.end;
			file.chars += unit.chars;
			file.units.push(unit);
		};
		// A part of a page stays alone: a file is a page range or one part.
		let joins = (file, unit) => file.from === undefined && unit.from === undefined && file.chars < min && file.chars + unit.chars <= limit;
		for (let unit of units) {
			unit.chars = unit.from === undefined ? size(unit.start, unit.end) : unit.to - unit.from + this.PAGE_OVERHEAD;
			let last = files[files.length - 1];
			if (last && joins(last, unit)) {
				join(last, unit);
			}
			else {
				files.push({ start: unit.start, end: unit.end, from: unit.from, to: unit.to, chars: unit.chars, units: [unit] });
			}
		}
		let tail = files[files.length - 1];
		let before = files[files.length - 2];
		if (before && tail.from === undefined && before.from === undefined && tail.chars < min && before.chars + tail.chars <= limit) {
			tail.units.forEach(unit => join(before, unit));
			files.pop();
		}
		for (let file of files) {
			file.title = file.units.reduce((best, u) => (u.top > best.top || (u.top === best.top && u.chars > best.chars) ? u : best)).title;
		}
		let width = Math.max(2, String(files.length).length);
		return files.map((file, k) => {
			let part = file.from !== undefined;
			let out = {
				name: String(k + 1).padStart(width, "0") + "-" + this.slug(file.title) + ".md",
				title: file.title,
				start: file.start,
				end: file.end,
				chars: file.chars,
				hash: this.fnv1a(part ? pages[file.start].slice(file.from, file.to) : pages.slice(file.start, file.end + 1).join("\f")),
			};
			return part ? { ...out, from: file.from, to: file.to } : out;
		});
	},

	// [from, to] offsets cutting `text` into pieces of at most `room` characters, at a
	// line end when one falls in the second half of the piece, else at a space.
	cutText(text, room) {
		let parts = [];
		let at = 0;
		while (text.length - at > room) {
			let piece = text.slice(at, at + room);
			let end = piece.lastIndexOf("\n");
			if (end < room / 2) {
				end = piece.lastIndexOf(" ");
			}
			end = end < room / 2 ? room : end + 1;
			parts.push([at, at + end]);
			at += end;
		}
		parts.push([at, text.length]);
		return parts;
	},

	renderSectionFile(pages, file, structure) {
		let range = this.rangeName(file.start, file.end, structure) + " of " + pages.length;
		let body = [];
		if (file.from !== undefined) {
			range += ", characters " + (file.from + 1) + "–" + file.to + " of " + pages[file.start].length;
			body.push(this.renderPage(file.start, pages[file.start].slice(file.from, file.to), structure));
		}
		else {
			for (let i = file.start; i <= file.end; i++) {
				body.push(this.renderPage(i, pages[i], structure));
			}
		}
		return "# " + file.title + "\n\n" + range + ".\n\n" + body.join("\n\n") + "\n";
	},

	// ------------------------------------------------------------ objects and refs

	OBJECT_WORDS: {
		eq: ["eq", "eqs", "eqn", "equation", "equations", "equazione", "equazioni", "formula"],
		fig: ["fig", "figs", "figure", "figures", "figura"],
		table: ["tab", "table", "tables", "tabella", "tabelle"],
		example: ["ex", "example", "examples", "esempio", "esempi"],
		theorem: ["thm", "theorem", "theorems", "teorema", "teoremi"],
		definition: ["def", "definition", "definitions", "definizione", "definizioni"],
		lemma: ["lemma", "lemmas", "lemmi"],
		corollary: ["corollary", "corollario"],
		proposition: ["proposition", "proposizione"],
	},

	objectKind(word) {
		let w = word.toLowerCase().replace(/\.$/, "");
		return Object.keys(this.OBJECT_WORDS).find(kind => this.OBJECT_WORDS[kind].includes(w)) || null;
	},

	// The page where each numbered object is defined, keyed "eq:2.14", "fig:3.2": an
	// equation tag that ends a line (not one after "Eq." or "and"), a caption word that
	// starts a line and is followed by a title, not by a verb ("Figure 3.2 shows").
	indexObjects(pages) {
		let objects = {};
		let caption = /^(Figure|Fig\.|Table|Example|Theorem|Definition|Lemma|Corollary|Proposition|Figura|Tabella|Esempio|Teorema|Definizione|Corollario|Proposizione)\s+(\d{1,2}\.\d{1,3})(?=$|\s*[:.(—–-]|\s+[A-Z(])/;
		let citing = /(?:\b(?:eqs?|eqn|equations?|equazion[ei]|formula|and|or|e|in|see|vedi)\.?|[,–—-])\s*$/i;
		pages.forEach((text, i) => {
			for (let raw of text.split("\n")) {
				let line = raw.trim();
				let m = /\((\d{1,2}\.\d{1,3}[a-z]?)\)$/.exec(line);
				if (m && !citing.test(line.slice(0, m.index))) {
					objects["eq:" + m[1]] ??= i;
				}
				if ((m = caption.exec(line))) {
					objects[this.objectKind(m[1]) + ":" + m[2]] ??= i;
				}
			}
		});
		return objects;
	},

	// What a question points at: [{kind, id}] for equations, figures, tables, examples,
	// theorems and sections, [{kind: "page", label}] for printed pages, in English and
	// Italian.
	findObjectRefs(text) {
		let refs = [];
		let seen = new Set();
		let push = (kind, key, ref) => {
			if (!seen.has(kind + ":" + key)) {
				seen.add(kind + ":" + key);
				refs.push(ref);
			}
		};
		let words = Object.values(this.OBJECT_WORDS).flat().sort((a, b) => b.length - a.length).join("|");
		let named = new RegExp("\\b(" + words + ")\\.?\\s*\\(?(\\d{1,2}\\.\\d{1,3}[a-z]?)\\)?", "gi");
		let found = [];
		for (let m of text.matchAll(named)) {
			found.push({ at: m.index, kind: this.objectKind(m[1]), id: m[2] });
		}
		for (let m of text.matchAll(/\((\d{1,2}\.\d{1,3}[a-z]?)\)/g)) {
			found.push({ at: m.index, kind: "eq", id: m[1] });
		}
		for (let m of text.matchAll(/(?:§\s*|\b(?:sections?|sec|sez|sezione|sezioni|paragrafo|paragrafi|chapters?|ch|capitolo|capitoli|cap)\.?\s*)(\d{1,2}(?:\.\d{1,2}){0,3})\b/gi)) {
			found.push({ at: m.index, kind: "section", id: m[1] });
		}
		found.sort((a, b) => a.at - b.at).forEach(({ kind, id }) => push(kind, id, { kind, id }));
		// A bare "p" needs a dot or a space, so "p1" (a pole), "2 pi" and "PC" are not pages.
		// A roman page is lowercase and follows "page" or "p.", or an Italian word when it
		// is not one letter: in "pagina i grafici" the "i" is an article.
		let pageRef = /\b(?:([Pp]ages?\s+|[Pp]p?\.\s*)|([Pp]agin[ae]\s+|[Pp]agg?\.\s*|[Pp]agg?\s+)|[Pp]p?\s+)(\d{1,4}|[ivxlc]{1,7})\b(?:\s*[-–]\s*(\d{1,4})\b)?/g;
		for (let m of text.matchAll(pageRef)) {
			let first = m[3];
			let roman = !/^\d/.test(first);
			if (!this.parseLabel(first) || (roman && !m[1] && !(m[2] && first.length > 1))) {
				continue;
			}
			let last = m[4] && !roman ? Math.min(+m[4], +first + 4) : null;
			if (last !== null && last > +first) {
				for (let n = +first; n <= last; n++) {
					push("page", String(n), { kind: "page", label: String(n) });
				}
			}
			else {
				push("page", first, { kind: "page", label: first });
			}
		}
		return refs;
	},

	refPages(refs, structure, pageCount) {
		let out = [];
		for (let ref of refs) {
			let i = null;
			if (ref.kind === "page") {
				i = this.pageIndexFor(structure, ref.label, pageCount);
			}
			else if (ref.kind === "section") {
				i = ((structure && structure.outline) || []).find(e => e.id === ref.id)?.start ?? null;
			}
			else {
				i = (structure && structure.objects && structure.objects[ref.kind + ":" + ref.id]) ?? null;
			}
			if (i !== null) {
				out.push(i);
			}
		}
		return out;
	},

	// ------------------------------------------------------------ search

	// Words that say nothing about which page answers: function words in English and
	// Italian, and the words people use to ask ("explain page 18").
	STOPWORDS: new Set(("a about above after again all also am an and any are as at be been before being below between both but by can " +
		"could did do does doing down during each few for from further had has have having he her here hers him his how i if in into " +
		"is it its itself just me more most my no nor not now of off on once only or other our out over own same she should so some " +
		"such than that the their them then there these they this those through to too under until up very was we were what when " +
		"where which while who whom why will with would you your explain talk tell please show give page pages eq equation figure fig " +
		"table section chapter example il lo la gli le un uno una di da del dello della dei degli delle con su per tra fra ed che non " +
		"sono come questo questa questi queste quello quella nel nella nei negli nelle al allo alla ai agli alle dal dalla sul sulla " +
		"cosa perche spiega spiegami parla parlami dimmi pagina pagine equazione figura tabella sezione capitolo esempio mi ti si ci " +
		"vi ne anche ma se piu").split(" ")),

	stem(word) {
		return word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word) ? word.slice(0, -1) : word;
	},

	// Lowercase words without accents, stopwords or bare numbers (folios and years match
	// everywhere), with a plural "s" dropped.
	tokenize(text) {
		let words = String(text).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[a-z0-9]+/g) || [];
		return words.filter(w => w.length > 1 && !/^\d+$/.test(w) && !this.STOPWORDS.has(w)).map(w => this.stem(w));
	},

	// Term counts per page, plain objects without a prototype so "constructor" is a word.
	buildBM25(pages) {
		let df = Object.create(null);
		let tf = [];
		let dl = [];
		for (let text of pages) {
			let counts = Object.create(null);
			let words = this.tokenize(text);
			for (let w of words) {
				counts[w] = (counts[w] || 0) + 1;
			}
			for (let w in counts) {
				df[w] = (df[w] || 0) + 1;
			}
			tf.push(counts);
			dl.push(words.length);
		}
		let total = dl.reduce((sum, n) => sum + n, 0);
		return { N: pages.length, avgdl: total / Math.max(1, pages.length), df, tf, dl };
	},

	// The `k` best pages [{page, score}] for `query`, Okapi BM25 with k1 1.2 and b 0.75.
	// `extra` terms count half: they come from a page, not from what the user asked.
	searchBM25(index, query, k = 10, extra = []) {
		let weights = new Map();
		for (let t of extra) {
			weights.set(t, 0.5);
		}
		for (let t of this.tokenize(query)) {
			weights.set(t, 1);
		}
		let terms = [...weights.keys()].filter(t => index.df[t]);
		if (!terms.length) {
			return [];
		}
		let hits = [];
		index.tf.forEach((counts, page) => {
			let score = 0;
			for (let t of terms) {
				let f = counts[t];
				if (f) {
					let idf = Math.log(1 + (index.N - index.df[t] + 0.5) / (index.df[t] + 0.5));
					score += weights.get(t) * idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * index.dl[page] / index.avgdl));
				}
			}
			if (score > 0) {
				hits.push({ page, score });
			}
		});
		return hits.sort((a, b) => b.score - a.score || a.page - b.page).slice(0, k);
	},

	// The `count` words most particular to `page` that a few other pages share: a word
	// on this page alone finds nothing else, a common one finds everything.
	pageTerms(index, page, count = 5) {
		let cap = Math.max(2, Math.ceil(0.05 * index.N));
		let counts = index.tf[page];
		let weight = t => counts[t] * Math.log(index.N / index.df[t]);
		return Object.keys(counts)
			.filter(t => index.df[t] >= 2 && index.df[t] <= cap)
			.sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))
			.slice(0, count);
	},

	// ------------------------------------------------------------ progress

	emptyProgress() {
		return { current: null, since: null, dwell: {}, read: [], frontier: null, sections: {}, section: null };
	},

	// The furthest read page that sits in a window of five pages with three read: one
	// page read after a jump is a look, not progress.
	frontierOf(read) {
		let set = new Set(read);
		for (let k = read.length - 1; k >= 0; k--) {
			let r = read[k];
			for (let s = r - 4; s <= r; s++) {
				let count = 0;
				for (let p = s; p < s + 5; p++) {
					count += set.has(p) ? 1 : 0;
				}
				if (count >= 3) {
					return r;
				}
			}
		}
		return null;
	},

	sectionState(entry, read, current) {
		let count = read.filter(p => p >= entry.start && p <= entry.end).length;
		if (count >= 0.8 * (entry.end - entry.start + 1)) {
			return "read";
		}
		return count || (current >= entry.start && current <= entry.end) ? "reading" : "unread";
	},

	// The progress after the reader shows `pageIndex` at time `t` (ms). The page left
	// gets the time spent on it, capped for idling, and is read past 15 s.
	applyPageEvent(progress, pageIndex, t, structure) {
		let base = progress || this.emptyProgress();
		let next = { ...base, dwell: { ...base.dwell }, read: [...base.read], sections: { ...base.sections } };
		let touched = [pageIndex];
		if (Number.isInteger(next.current) && Number.isFinite(next.since)) {
			let key = String(next.current);
			next.dwell[key] = (next.dwell[key] || 0) + Math.min(Math.max(0, t - next.since), this.DWELL_CAP_MS);
			if (next.dwell[key] >= this.DWELL_READ_MS && !next.read.includes(next.current)) {
				next.read.push(next.current);
				next.read.sort((a, b) => a - b);
			}
			touched.push(next.current);
		}
		next.current = pageIndex;
		next.since = t;
		next.frontier = this.frontierOf(next.read);
		let outline = (structure && structure.outline) || [];
		for (let entry of outline) {
			if (touched.some(p => p >= entry.start && p <= entry.end)) {
				next.sections[entry.id] = this.sectionState(entry, next.read, pageIndex);
			}
		}
		next.section = this.sectionOf(outline, pageIndex)?.id ?? null;
		return next;
	},

	// ------------------------------------------------------------ page selection

	// The pages to send inline, [{page, reason, ahead}], supporting pages ascending and the
	// focus pages last (the end of the prompt is where models read best). In order of
	// claim: focus pages (always, each cut to its share of the budget), pages defining
	// what the query cites, the two pages before each focus page and its section opener,
	// BM25 hits up to 60% of the budget with the reading position as a soft prior, then
	// pages nearest the focus. The search runs on the query, the selected text and the
	// focus pages' most particular words, so "explain this" still finds related pages.
	// `ahead` marks pages past both the frontier and the focus.
	selectPages({ pages, structure = null, progress = null, query = "", selection = "", focus = [], budget, index = null }) {
		let n = pages.length;
		let focusList = [...new Set(focus)].filter(i => Number.isInteger(i) && i >= 0 && i < n);
		let cap = Math.floor(budget / Math.max(1, focusList.length));
		let size = i => pages[i].length + this.PAGE_OVERHEAD;
		let picked = new Map();
		let used = 0;
		// A blank page costs a marker and says nothing; "near" would otherwise fill the
		// last few characters with them. A cited page goes however short: a figure page's
		// text may be its caption alone.
		let blank = i => pages[i].replace(/\s+/g, "").length < 50;
		let add = (i, reason, limit = budget) => {
			if (i < 0 || i >= n || picked.has(i) || (reason !== "ref" && blank(i)) || used + size(i) > limit) {
				return;
			}
			picked.set(i, reason);
			used += size(i);
		};
		for (let f of focusList) {
			picked.set(f, "focus");
			used += Math.min(size(f), cap);
		}
		let outline = (structure && structure.outline) || [];
		for (let i of this.refPages(this.findObjectRefs(query), structure, n)) {
			add(i, "ref");
		}
		for (let f of focusList) {
			add(f - 1, "context");
			add(f - 2, "context");
			// The deepest section whose first page the context pages do not already hold:
			// a one-page subsection's opener is the focus page itself.
			let opener = null;
			for (let e of outline) {
				if (e.start < f - 2 && f <= e.end && (!opener || e.level > opener.level)) {
					opener = e;
				}
			}
			if (opener) {
				add(opener.start, "opener");
			}
		}
		index = index || this.buildBM25(pages);
		let asked = query + "\n" + selection;
		let particular = focusList.flatMap(f => this.pageTerms(index, f));
		if (this.tokenize(asked).length || particular.length) {
			let here = focusList.map(f => this.sectionOf(outline, f)).filter(Boolean);
			let read = new Set((progress && progress.read) || []);
			let hits = this.searchBM25(index, asked, 50, particular)
				.map(({ page, score }) => ({
					page,
					score: score * (here.some(s => s.start <= page && page <= s.end) ? 1.5 : 1) * (read.has(page) ? 1.2 : 1),
				}))
				.sort((a, b) => b.score - a.score || a.page - b.page);
			for (let hit of hits) {
				add(hit.page, "search", this.SEARCH_SHARE * budget);
			}
		}
		let centres = focusList.length ? focusList : [0];
		if (!focusList.length) {
			add(0, "near");
		}
		for (let d = 1; d < n && used < budget; d++) {
			for (let f of centres) {
				add(f - d, "near");
				add(f + d, "near");
			}
		}
		let frontier = progress && Number.isInteger(progress.frontier) ? progress.frontier : null;
		let horizon = frontier === null ? null : Math.max(frontier, ...focusList);
		let item = page => ({ page, reason: picked.get(page), ahead: horizon !== null && page > horizon });
		let support = [...picked.keys()].filter(page => !focusList.includes(page)).sort((a, b) => a - b);
		return [...support.map(item), ...focusList.map(page => ({ ...item(page), ahead: false }))];
	},

	// ------------------------------------------------------------ prompt blocks

	// `lines` [{text, priority}] joined, dropping the lowest priority (the earliest on a
	// tie) until the text fits, with a note saying how many lines went.
	fitLines(lines, maxChars) {
		let kept = lines.map(() => true);
		let total = lines.reduce((sum, line) => sum + line.text.length + 1, 0);
		let order = lines.map((line, i) => i).sort((a, b) => lines[a].priority - lines[b].priority || a - b);
		let dropped = 0;
		for (let i of order) {
			if (total + (dropped ? 40 : 0) <= maxChars || lines[i].priority === Infinity) {
				break;
			}
			kept[i] = false;
			total -= lines[i].text.length + 1;
			dropped++;
		}
		let out = lines.filter((line, i) => kept[i]).map(line => line.text);
		if (dropped) {
			out.push("[" + dropped + " more lines left out to fit]");
		}
		let text = out.join("\n");
		return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
	},

	// The outline as the model sees it: one line per chapter, the chapter being read
	// expanded, each line with its text file, PDF and printed pages and read state.
	renderMap(structure, outline, progress, { maxChars = this.MAP_PROMPT_CHARS, files = structure.files || [], dir = "text/" } = {}) {
		let current = progress && Number.isInteger(progress.current) ? progress.current : null;
		let states = (progress && progress.sections) || {};
		let tops = outline.filter(e => e.level === 1);
		let here = current === null ? null : this.chapterOf(outline, current);
		let hereAt = here ? tops.indexOf(here) : -1;
		let filesFor = (start, end) => {
			let names = files.filter(f => f.start <= end && f.end >= start).map(f => dir + f.name);
			return names.length > 2 ? names[0] + " … " + names[names.length - 1] : names.join(", ");
		};
		let line = (e, fileText) => "  ".repeat(e.level - 1) + "- " + this.entryTitle(e) + " · " + this.rangeName(e.start, e.end, structure) +
			(fileText ? " · " + fileText : "") + " · " + (states[e.id] || "unread");
		// A backend without file access is given no files, and no folder to look in.
		let lines = [{ text: "Reading map: " + (structure.labels || []).length + " PDF pages, " + tops.length + " parts" +
			(files.length ? "; text files in " + dir : "") + ".", priority: Infinity }];
		for (let e of outline) {
			if (e.level === 1) {
				let k = tops.indexOf(e);
				let priority = 1e6 - (hereAt >= 0 ? Math.abs(k - hereAt) : k);
				lines.push({ text: line(e, filesFor(e.start, e.end)), priority: k === hereAt ? Infinity : priority });
			}
			else if (here && e.start >= here.start && e.start <= here.end) {
				let file = files.find(f => f.start <= e.start && e.start <= f.end);
				lines.push({ text: line(e, file ? dir + file.name : ""), priority: (e.level === 2 ? 5e5 : 2e5) - Math.abs(e.start - current) });
			}
		}
		return this.fitLines(lines, maxChars);
	},

	// ------------------------------------------------------------ memory

	emptyMemory() {
		return { version: 1, summary: "", items: [], nextId: 1 };
	},

	// Model text that goes into every later prompt: no tags (they could close a context
	// block) and no URLs; everything else, maths included, stays. A tag is a closing tag
	// or a name with only name="value" attributes, so "n<N and h[n]>0" is not one.
	cleanMemoryText(text, cap) {
		let clean = String(text ?? "")
			.replace(/<\/?[A-Za-z][\w:-]*(?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))*\s*\/?>/g, "")
			.replace(/\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/gi, "")
			.replace(/\s+/g, " ")
			.trim();
		return clean.length > cap ? clean.slice(0, cap - 1).trimEnd() + "…" : clean;
	},

	// The memory after `patch` {summary?, add?: [{kind, text, page?, source?}], resolve?: [id],
	// remove?: [id]}, which a model proposes, so every part is checked: the kind is known,
	// a page is a PDF page number (1-based, as the markers show it) in the paper, a
	// preference cites the index of a user message in `history`, text is cleaned and
	// capped, and a kind over its cap drops its oldest items. `kinds` are the kinds this
	// patch may add, resolve or remove. Returns {memory, rejected}.
	applyMemoryPatch(memory, patch, { history = [], pageCount = Infinity, now = null, kinds = this.MEMORY_KINDS } = {}) {
		let next = { ...memory, items: memory.items.map(item => ({ ...item })) };
		let rejected = [];
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
			return { memory: next, rejected: [{ reason: "not a patch" }] };
		}
		let ids = list => (Array.isArray(list) ? list : []);
		for (let id of ids(patch.remove)) {
			let k = next.items.findIndex(item => item.id === id);
			if (k < 0) {
				rejected.push({ id, reason: "unknown id" });
			}
			else if (!kinds.includes(next.items[k].kind)) {
				rejected.push({ id, reason: "not removable" });
			}
			else {
				next.items.splice(k, 1);
			}
		}
		for (let id of ids(patch.resolve)) {
			let k = next.items.findIndex(item => item.id === id);
			if (k < 0) {
				rejected.push({ id, reason: "unknown id" });
			}
			else if (!["open", "shaky"].includes(next.items[k].kind) || !kinds.includes(next.items[k].kind)) {
				rejected.push({ id, reason: "not resolvable" });
			}
			else {
				next.items.splice(k, 1);
			}
		}
		for (let add of ids(patch.add)) {
			if (!add || typeof add !== "object") {
				rejected.push({ item: add, reason: "not an object" });
				continue;
			}
			let reason = null;
			let text = this.cleanMemoryText(add.text, this.MEMORY_ITEM_CHARS);
			let hasPage = add.page !== undefined && add.page !== null;
			if (!this.MEMORY_KINDS.includes(add.kind)) {
				reason = "unknown kind";
			}
			else if (!kinds.includes(add.kind)) {
				reason = "kind not allowed";
			}
			else if (!text) {
				reason = "empty";
			}
			else if (hasPage && !(Number.isInteger(add.page) && add.page >= 1 && add.page <= pageCount)) {
				reason = "page out of range";
			}
			else if (add.kind === "preference" && !(Number.isInteger(add.source) && history[add.source] && history[add.source].role === "user")) {
				reason = "preference without a user message";
			}
			else if (next.items.some(item => item.kind === add.kind && item.text.toLowerCase() === text.toLowerCase())) {
				reason = "duplicate";
			}
			if (reason) {
				rejected.push({ item: add, reason });
				continue;
			}
			let item = { id: "m" + next.nextId++, kind: add.kind, text };
			if (hasPage) {
				item.page = add.page;
			}
			if (Number.isInteger(add.source)) {
				item.source = add.source;
			}
			if (now !== null) {
				item.ts = now;
			}
			next.items.push(item);
			let sameKind = next.items.filter(other => other.kind === add.kind);
			if (sameKind.length > this.MEMORY_CAPS[add.kind]) {
				next.items.splice(next.items.indexOf(sameKind[0]), 1);
			}
		}
		if (typeof patch.summary === "string") {
			next.summary = this.cleanMemoryText(patch.summary, this.MEMORY_SUMMARY_CHARS);
		}
		else if (patch.summary !== undefined && patch.summary !== null) {
			rejected.push({ reason: "summary is not text" });
		}
		return { memory: next, rejected };
	},

	// The user's own edit of one item from the Memory sheet: cleaned like a patch's text,
	// and an emptied item is refused rather than kept blank.
	editMemoryItem(memory, id, text) {
		let clean = this.cleanMemoryText(text, this.MEMORY_ITEM_CHARS);
		let k = memory.items.findIndex(item => item.id === id);
		if (k < 0) {
			return { memory, rejected: [{ id, reason: "unknown id" }] };
		}
		if (!clean) {
			return { memory, rejected: [{ id, reason: "empty" }] };
		}
		let items = memory.items.map((item, i) => (i === k ? { ...item, text: clean } : item));
		return { memory: { ...memory, items }, rejected: [] };
	},

	// A turn as the consolidation model reads it: what the user and the assistant said,
	// without the passages quoted from the document ("> …" lines) or context blocks a
	// message carries, which are the document's words, not the reader's.
	memoryInputText(text) {
		return String(text ?? "")
			.replace(/<(paper_[a-z]+|user_annotations|reading_map|reading_memory|focus_page|section_gists)\b[^>]*>[^]*?<\/\1>/gi, "")
			.split("\n")
			.filter(line => !/^\s*>/.test(line))
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	},

	// The JSON object a model answered with, fenced or with words around it, or null.
	parsePatch(text) {
		let t = String(text ?? "");
		let a = t.indexOf("{");
		let b = t.lastIndexOf("}");
		if (a < 0 || b < a) {
			return null;
		}
		try {
			let value = JSON.parse(t.slice(a, b + 1));
			return value && typeof value === "object" && !Array.isArray(value) ? value : null;
		}
		catch (e) {
			if (!(e instanceof SyntaxError)) {
				throw e;
			}
			return null;
		}
	},

	// ------------------------------------------------------------ gists

	// A gist is read as orientation in later prompts, so, like memory text, it keeps no
	// tags (they could close a context block) and no links (they can only have come from
	// the page text or a confused model); over the cap it is cut at the last sentence that
	// fits. Returns {text} or {reason}.
	validateGist(text) {
		let t = String(text ?? "").trim().replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```$/, "")
			.replace(/<\/?[A-Za-z][\w:-]*(?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))*\s*\/?>/g, "")
			.replace(/\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/gi, "")
			.replace(/[^\S\n]+/g, " ")
			.replace(/ *\n */g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		if (!t) {
			return { reason: "empty" };
		}
		if (t.length <= this.GIST_CHARS) {
			return { text: t };
		}
		let head = t.slice(0, this.GIST_CHARS);
		let end = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"));
		return { text: end >= this.GIST_CHARS / 2 ? head.slice(0, end + 1) : head.slice(0, this.GIST_CHARS - 1).trimEnd() + "…" };
	},

	// What a gist was written from: when the section's text changes, its gist is stale.
	sectionHash(pages, entry) {
		return this.fnv1a(pages.slice(entry.start, entry.end + 1).join("\f"));
	},

	childrenOf(outline, entry) {
		return (outline || []).filter(e => e.level === entry.level + 1 && e.start >= entry.start && e.end <= entry.end);
	},

	// The gists still true to the text, in outline order: [{entry, text}].
	freshGists(gists, structure, pages) {
		let sections = (gists && gists.sections) || {};
		return ((structure && structure.outline) || [])
			.filter(e => sections[e.id] && sections[e.id].hash === this.sectionHash(pages, e))
			.map(e => ({ entry: e, text: sections[e.id].text }));
	},

	// The <section_gists> body: the sections nearest the page on screen kept first, and a
	// chapter's own gist preferred over its sections' when room runs short.
	renderGists(fresh, structure, current, { maxChars = this.GIST_PROMPT_CHARS } = {}) {
		let lines = [{ text: "Summaries of sections the user has finished, for orientation only: check the pages before quoting or citing anything from them.", priority: Infinity }];
		for (let { entry, text } of fresh) {
			let distance = !Number.isInteger(current) ? entry.start
				: current < entry.start ? entry.start - current : Math.max(0, current - entry.end);
			lines.push({
				text: "- " + this.entryTitle(entry) + " (" + this.rangeName(entry.start, entry.end, structure) + "): " + text.replace(/\s+/g, " "),
				priority: 1e7 - distance - entry.level * 10,
			});
		}
		return this.fitLines(lines, maxChars);
	},

	// Rendered live from progress and never stored, so it cannot go stale.
	whereWeAre(progress, structure) {
		if (!progress || !Number.isInteger(progress.current)) {
			return "Where we are: no reading recorded yet.";
		}
		let parts = ["Where we are: " + this.pageName(progress.current, structure)];
		let section = this.sectionOf(structure && structure.outline, progress.current);
		if (section) {
			parts.push("in " + this.entryTitle(section));
		}
		parts.push(progress.read.length + (progress.read.length === 1 ? " page" : " pages") + " read");
		if (Number.isInteger(progress.frontier)) {
			parts.push("read up to " + this.pageName(progress.frontier, structure));
		}
		return parts.join(", ") + ".";
	},

	// The memory block: where we are first, then preferences, open questions, shaky
	// points, the running summary, what was understood and notes. Over `maxChars` the
	// oldest notes go first, preferences last.
	renderMemory(memory, progress, structure, { maxChars = this.MEMORY_PROMPT_CHARS } = {}) {
		let lines = [{ text: this.whereWeAre(progress, structure), priority: Infinity }];
		let base = { preference: 9e5, open: 8e5, shaky: 7e5, understood: 5e5, note: 4e5 };
		let item = (it, k) => ({
			text: "- [" + it.id + " " + it.kind + "] " + it.text + (it.page ? " (" + this.pageName(it.page - 1, structure) + ")" : ""),
			priority: base[it.kind] + k,
		});
		for (let kind of ["preference", "open", "shaky"]) {
			memory.items.filter(it => it.kind === kind).forEach((it, k) => lines.push(item(it, k)));
		}
		if (memory.summary) {
			lines.push({ text: "So far: " + memory.summary, priority: 6e5 });
		}
		for (let kind of ["understood", "note"]) {
			memory.items.filter(it => it.kind === kind).forEach((it, k) => lines.push(item(it, k)));
		}
		return this.fitLines(lines, maxChars);
	},

	// ------------------------------------------------------------ everything at once

	// structure.json for one file version: labels, outline, object index and section
	// files, from the page texts and any label anchors.
	buildStructure(pages, { anchors = [], sections = this.SECTION_CHARS } = {}) {
		let { labels, confidence, method, runs, conflicts } = this.inferPageLabels(pages, anchors);
		let structure = { version: 1, pageCount: pages.length, labels, confidence, labelMethod: method, runs, labelConflicts: conflicts };
		let { outline, method: outlineMethod } = this.buildOutline(pages, structure);
		structure.outline = outline;
		structure.outlineMethod = outlineMethod;
		structure.objects = this.indexObjects(pages);
		structure.files = this.splitSections(pages, outline, sections);
		return structure;
	},
};
