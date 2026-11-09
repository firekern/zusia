"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Reading map: structure.json, the text files, page selection, progress, memory
	// ---------------------------------------------------------------------

	isBook(files) {
		let full = files && files.fullText;
		return !!full && full.status === "ok" && full.paged && full.pages.length >= this.BOOK_MIN_PAGES;
	},

	// Section files under text/ for a book, one fulltext.md for anything shorter, with
	// "--- page 41 (printed 18) ---" markers. cache/text.json records what each file was
	// written from (its pages' hash and labels), so only a changed file is written again.
	async writeTextFiles(dir, full, structure) {
		let book = full.paged && full.pages.length >= this.BOOK_MIN_PAGES;
		let want = new Map();
		if (book) {
			for (let file of structure.files) {
				want.set("text/" + file.name, {
					stamp: this.MAP_VERSION + ":" + file.hash + ":" + this.labelsDigest(structure, file.start, file.end),
					render: () => ZusiaMap.renderSectionFile(full.pages, file, structure),
				});
			}
			let index = this.textIndex(full, structure);
			want.set("fulltext.md", { stamp: this.MAP_VERSION + ":" + this.hashText(index), render: () => index });
		}
		else {
			let text = "# Full text\n\n" + (full.paged
				? full.pages.map((page, i) => ZusiaMap.renderPage(i, page.trim(), structure)).join("\n\n")
				: full.pages[0].trim()) + "\n";
			want.set("fulltext.md", { stamp: this.MAP_VERSION + ":" + this.hashText(text), render: () => text });
		}
		let manifestPath = OS.Path.join(dir, "cache", "text.json");
		let manifest = await this.readJSON(manifestPath, { files: {} });
		await this.ensureCacheDir(dir);
		if (book) {
			await Zotero.File.createDirectoryIfMissingAsync(OS.Path.join(dir, "text"));
		}
		let changed = false;
		for (let [name, entry] of want) {
			let path = OS.Path.join(dir, ...name.split("/"));
			if (manifest.files[name] === entry.stamp && (await OS.File.exists(path))) {
				continue;
			}
			await Zotero.File.putContentsAsync(path, entry.render());
			changed = true;
		}
		for (let name of Object.keys(manifest.files)) {
			let path = OS.Path.join(dir, ...name.split("/"));
			if (!want.has(name) && (await OS.File.exists(path))) {
				await OS.File.remove(path);
				changed = true;
			}
		}
		if (changed || Object.keys(manifest.files).length !== want.size) {
			let files = {};
			for (let [name, entry] of want) {
				files[name] = entry.stamp;
			}
			await this.writeAtomic(manifestPath, JSON.stringify({ version: this.MAP_VERSION, files }));
		}
		return { name: "fulltext.md", paged: full.paged, complete: true, total: full.pages.length, sections: book ? structure.files.length : 0 };
	},

	// Markers print the labels only when they are trusted, so a file changes with them.
	labelsDigest(structure, start, end) {
		return ZusiaMap.trusted(structure) ? this.hashText(structure.labels.slice(start, end + 1).join("|")) : "pdf";
	},

	textIndex(full, structure) {
		let lines = structure.files.map(f => "- text/" + f.name + ": " + f.title + ", " + ZusiaMap.rangeName(f.start, f.end, structure));
		return "# Full text\n\nThis document has " + full.pages.length + " PDF pages. Its text is split into " +
			structure.files.length + " section files in text/, in reading order, each with page markers:\n\n" + lines.join("\n") + "\n";
	},

	// Claude and Codex search the paper folder with ripgrep, which honours .ignore even
	// outside git: a hit in cache/pages.json, the whole book on one line with no page
	// markers, would have them read that instead of text/.
	async ensureCacheDir(dir) {
		await Zotero.File.createDirectoryIfMissingAsync(OS.Path.join(dir, "cache"));
		let ignore = OS.Path.join(dir, ".ignore");
		if (!(await OS.File.exists(ignore))) {
			await Zotero.File.putContentsAsync(ignore, "# Zusia's own bookkeeping; the text is in fulltext.md and text/.\ncache/\n");
		}
	},

	// The full text is off or gone: no stale copy stays for the assistant to read.
	async removeTextFiles(dir) {
		let manifestPath = OS.Path.join(dir, "cache", "text.json");
		let manifest = await this.readJSON(manifestPath, { files: {} });
		let names = new Set([...Object.keys(manifest.files), "fulltext.md"]);
		for (let name of names) {
			let path = OS.Path.join(dir, ...name.split("/"));
			if (await OS.File.exists(path)) {
				await OS.File.remove(path);
			}
		}
		if (await OS.File.exists(manifestPath)) {
			await OS.File.remove(manifestPath);
		}
	},

	// structure.json for this file version, built once: from memory, from cache/, or from
	// the page texts. Concurrent calls for one paper (the sidebar rendering while a
	// question starts) share one build.
	ensureStructure(ctx, full, reader = null) {
		let running = this._mapBuilds.get(ctx.dir);
		if (running) {
			return running;
		}
		let build = this.buildStructureFor(ctx, full, reader);
		this._mapBuilds.set(ctx.dir, build);
		let done = () => this._mapBuilds.delete(ctx.dir);
		build.then(done, done);
		return build;
	},

	async buildStructureFor(ctx, full, reader) {
		let { dir, attachmentItem } = ctx;
		let count = full.pages.length;
		let native = await this.nativeStructure(dir, attachmentItem, reader, full.stamp, count);
		// Sorted (stably, so a selection's label still comes after an annotation's on its
		// page): the order the anchors were recorded in carries no information, and must
		// not change the key.
		let anchors = this.annotationAnchors(attachmentItem, count).concat((await this.loadProgress(dir)).anchors || [])
			.sort((a, b) => a.pageIndex - b.pageIndex);
		// The key covers everything the map is built from, so a new annotation label or an
		// outline Zotero only now reports rebuilds it, and nothing else does.
		let key = [this.MAP_VERSION, attachmentItem.id, full.stamp,
			this.hashText(JSON.stringify([anchors, native.labels, native.outline]))].join(":");
		let cached = this._structures.get(dir);
		if (cached && cached.key === key) {
			return cached.structure;
		}
		let path = OS.Path.join(dir, "cache", "structure.json");
		let saved = await this.readJSON(path, null);
		if (saved && saved.key === key) {
			this._structures.set(dir, { key, structure: saved });
			return saved;
		}
		let started = Date.now();
		let structure = Object.assign(this.mapStructure(full.pages, { anchors, native }), { key });
		await this.ensureCacheDir(dir);
		await this.writeAtomic(path, JSON.stringify(structure));
		this._structures.set(dir, { key, structure });
		this.log("Reading map for " + dir + ": " + count + " pages, labels " + structure.labelMethod + " (" +
			structure.confidence.toFixed(2) + "), outline " + structure.outlineMethod + " (" + structure.outline.length +
			" entries), " + structure.files.length + " files, " + (Date.now() - started) + " ms");
		return structure;
	},

	// ZusiaMap.buildStructure, but with the labels and outline Zotero reports: its labels
	// vote as anchors, which lose to a folio run on the pages it holds, and its outline
	// replaces the guessed one. A label that is just the PDF number is dropped: a PDF
	// without labels reports nothing else, which says no more than the fallback does
	// and would make "18" mean PDF page 18 next to the printed 18. Titles come from the
	// PDF, so they are cleaned like model text before they reach a prompt.
	mapStructure(pages, { anchors = [], native = {} } = {}) {
		let votes = anchors.slice();
		(native.labels || []).forEach((label, i) => {
			let text = label === null ? "" : String(label).trim();
			if (text && text !== String(i + 1)) {
				votes.push({ pageIndex: i, label: text });
			}
		});
		let { labels, confidence, method, runs, conflicts } = ZusiaMap.inferPageLabels(pages, votes);
		let structure = {
			version: this.MAP_VERSION, pageCount: pages.length, labels, confidence,
			labelMethod: method + (native.labels ? "+zotero" : ""), runs, labelConflicts: conflicts.length,
		};
		let entries = this.outlineEntries(native.outline || []);
		if (entries.length >= 2) {
			structure.outline = ZusiaMap.outlineRanges(entries, structure, pages.length);
			structure.outlineMethod = "zotero";
		}
		else {
			let built = ZusiaMap.buildOutline(pages, structure);
			structure.outline = built.outline;
			structure.outlineMethod = built.method;
		}
		structure.outline = structure.outline.map(e => Object.assign({}, e, { title: this.cleanTitle(e.title) || "Untitled" }));
		structure.objects = ZusiaMap.indexObjects(pages);
		structure.files = ZusiaMap.splitSections(pages, structure.outline);
		return structure;
	},

	cleanTitle(title) {
		return ZusiaMap.cleanMemoryText(title, 120);
	},

	// Flat outline items {title, level, start} as ZusiaMap.outlineRanges wants them, with a
	// leading section number as the id ("2.3 Convolution" → id "2.3"), so "§2.3" works.
	outlineEntries(flat) {
		let seen = new Set();
		return flat.map((e, k) => {
			let title = this.cleanTitle(e.title);
			let m = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(\S.*)$/.exec(title);
			let id = m && !seen.has(m[1]) ? m[1] : "o" + (k + 1);
			seen.add(id);
			return { id, title: m ? m[2] : title, level: e.level, start: e.start };
		}).filter(e => e.title);
	},

	// Reader outline items {title, items, location.position.pageIndex} and SDT ones
	// {title, children, target.position.pageIndex}, depth first.
	flattenOutline(items, level = 1, out = []) {
		for (let item of items || []) {
			if (out.length >= 1000) {
				break;
			}
			let start = item.location?.position?.pageIndex ?? item.target?.position?.pageIndex ?? item.pageIndex;
			if (Number.isInteger(start) && String(item.title || "").trim()) {
				out.push({ title: String(item.title), level, start });
			}
			this.flattenOutline(item.items || item.children, level + 1, out);
		}
		return out;
	},

	// The labels and outline Zotero has for this file version, from cache/native.json or
	// asked for once per source while the PDF is open: the reader's own state, pdf.js, and
	// Zotero 10's structured text. Each source is skipped once it answered.
	async nativeStructure(dir, attachment, reader, stamp, count) {
		let native = this._natives.get(dir);
		if (!native || native.stamp !== stamp || native.attachmentID !== attachment.id) {
			let saved = await this.readJSON(OS.Path.join(dir, "cache", "native.json"), null);
			native = saved && saved.stamp === stamp && saved.attachmentID === attachment.id
				? saved
				: { attachmentID: attachment.id, stamp, labels: null, outline: null, tried: [] };
		}
		let before = JSON.stringify(native);
		let open = reader && reader.itemID === attachment.id ? reader : null;
		for (let source of open ? ["reader", "pdfjs", "sdt"] : []) {
			if ((native.labels && native.outline) || native.tried.includes(source)) {
				continue;
			}
			let found = await this.nativeFrom(source, open, attachment, stamp);
			if (!found) {
				continue;
			}
			if (!native.labels && Array.isArray(found.labels) && found.labels.length === count) {
				native.labels = found.labels;
			}
			if (!native.outline && found.outline && found.outline.length >= 2) {
				native.outline = found.outline;
			}
			native.tried.push(source);
		}
		if (JSON.stringify(native) !== before) {
			await this.ensureCacheDir(dir);
			await this.writeAtomic(OS.Path.join(dir, "cache", "native.json"), JSON.stringify(native));
		}
		this._natives.set(dir, native);
		return native;
	},

	// {labels, outline} from one source, or null when it is not ready yet (the reader has
	// not processed the PDF, the structured text is still being built), so it is asked
	// again next time. These are Zotero internals, unverified across versions: a source
	// that throws is logged and asked again next time, since the failure may pass (a
	// reader torn down mid-call) and caching it would disable the source until a rebuild.
	async nativeFrom(source, reader, attachment, stamp) {
		try {
			if (source === "reader") {
				let state = reader._internalReader?._state;
				let labels = state && state.pageLabels && state.pageLabels.length ? Array.from(state.pageLabels, l => (l == null ? null : String(l))) : null;
				let outline = state && state.outline && state.outline.length ? this.flattenOutline(state.outline) : null;
				return labels || outline ? { labels, outline } : null;
			}
			if (source === "pdfjs") {
				let frame = reader._internalReader?._primaryView?._iframeWindow;
				let doc = (frame && (frame.wrappedJSObject || frame))?.PDFViewerApplication?.pdfDocument;
				if (!doc) {
					return null;
				}
				let labels = await doc.getPageLabels();
				let items = await doc.getOutline();
				let resolve = async (list) => {
					let out = [];
					for (let item of list || []) {
						let dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
						let ref = dest && dest[0];
						let pageIndex = ref == null ? null : Number.isInteger(ref) ? ref : await doc.getPageIndex(ref);
						out.push({ title: String(item.title || ""), pageIndex, items: await resolve(item.items) });
					}
					return out;
				};
				return { labels: labels ? Array.from(labels, l => (l == null ? null : String(l))) : null, outline: this.flattenOutline(await resolve(items)) };
			}
			if (!Zotero.SDT) {
				return { labels: null, outline: null };
			}
			return this.sdtStructure(attachment, stamp);
		}
		catch (e) {
			this.logError("reading map: " + source + " labels and outline", e);
			return null;
		}
	},

	// Zotero.SDT.getReader() builds the structured-text pack when it is missing, which for
	// a thousand-page book takes far longer than a question should wait. It runs in the
	// background, once per file version; null until it is done, and the next build of
	// the map picks the result up.
	sdtStructure(attachment, stamp) {
		let key = attachment.id + "@" + stamp;
		let entry = this._sdt.get(key);
		if (!entry) {
			entry = { done: false, result: null };
			entry.promise = this.readSDT(attachment.id).then((result) => {
				entry.result = result;
				entry.done = true;
			}, (e) => {
				// Started again by the next build.
				this._sdt.delete(key);
				this.logError("reading map: Zotero.SDT", e);
			});
			this._sdt.set(key, entry);
		}
		return entry.done ? entry.result : null;
	},

	async readSDT(id) {
		let packReader = await Zotero.SDT.getReader(id);
		if (!packReader) {
			return { labels: null, outline: null };
		}
		let catalog = await packReader.getCatalog();
		let pages = (catalog && catalog.pages) || [];
		return {
			labels: pages.length ? pages.map(p => (p && p.label != null ? String(p.label) : null)) : null,
			outline: this.flattenOutline((catalog && catalog.outline) || []),
		};
	},

	// The user's own annotations pin their page's printed label: Zotero stores it with the
	// PDF page index in the position.
	annotationAnchors(attachment, count) {
		if (!attachment.isPDFAttachment()) {
			return [];
		}
		let anchors = new Map();
		for (let a of attachment.getAnnotations()) {
			if (!a.annotationPageLabel || !a.annotationPosition) {
				continue;
			}
			let position;
			try {
				position = JSON.parse(a.annotationPosition);
			}
			catch (e) {
				if (!(e instanceof SyntaxError)) {
					throw e;
				}
				this.log("Skipping an annotation with an unreadable position: " + e.message);
				continue;
			}
			if (Number.isInteger(position.pageIndex) && position.pageIndex < count) {
				anchors.set(position.pageIndex + ":" + a.annotationPageLabel, { pageIndex: position.pageIndex, label: a.annotationPageLabel });
			}
		}
		return [...anchors.values()];
	},

	// Pages for Antigravity, which cannot read files: a paper that fits goes whole, anything
	// else is chosen by ZusiaMap.selectPages around the focus pages and the question. A
	// resumed conversation gets only pages it was not sent yet, from half the budget.
	// Returns { support, focus, complete, total, cap, chars } with supporting pages
	// ascending and the focus pages, which go last, apart; null without paged text.
	inlinePages(files, session) {
		let full = files.fullText;
		if (!full || full.status !== "ok" || !full.paged) {
			return null;
		}
		let pages = full.pages;
		let total = pages.length;
		let earlier = session && session.paper;
		let budget = this.inlineFullTextBudget();
		let focus = [...new Set(files.focus || [])].filter(i => Number.isInteger(i) && i >= 0 && i < total);
		let cap = Math.floor(budget / Math.max(1, focus.length));
		if (earlier && earlier.complete) {
			return { support: [], focus: [], complete: true, total, cap, chars: 0 };
		}
		let size = pages.reduce((sum, page) => sum + page.length + ZusiaMap.PAGE_OVERHEAD, 0);
		let picks;
		if (total < this.BOOK_MIN_PAGES && size <= budget) {
			picks = pages.map((page, i) => ({ page: i, reason: focus.includes(i) ? "focus" : "whole", ahead: false }));
		}
		else {
			if (!this._bm25.has(pages)) {
				this._bm25.set(pages, ZusiaMap.buildBM25(pages));
			}
			picks = ZusiaMap.selectPages({
				pages, structure: files.structure || null, progress: files.progress || null,
				query: files.query || "", selection: files.selectionText || "", focus,
				budget: earlier ? Math.floor(budget / 2) : budget, index: this._bm25.get(pages),
			});
		}
		let sent = new Set((earlier && earlier.kept) || []);
		let fresh = picks.filter(p => !sent.has(p.page));
		let support = fresh.filter(p => !focus.includes(p.page));
		let focusPicks = focus.filter(i => !sent.has(i)).map(i => ({ page: i, reason: "focus", ahead: false }));
		let chars = [...support, ...focusPicks].reduce((sum, p) => sum + Math.min(pages[p.page].length, cap) + ZusiaMap.PAGE_OVERHEAD, 0);
		return { support, focus: focusPicks, complete: !earlier && picks.length === total, total, cap, chars };
	},

	renderInlinePage(files, pick, cap) {
		let text = files.fullText.pages[pick.page].trim();
		if (text.length > cap) {
			text = text.slice(0, cap) + "\n[the rest of page " + (pick.page + 1) + " was left out to fit]";
		}
		return ZusiaMap.renderPage(pick.page, (pick.ahead ? "[ahead of where the user has read so far]\n" : "") + text, files.structure || null);
	},

	contextBlock(tag, body) {
		return "<" + tag + ">\n" + this.escapeContextTags(body).trim() + "\n</" + tag + ">\n\n";
	},

	// A map is worth sending when the outline came from somewhere better than fixed chunks
	// of pages, or, for a backend that reads files, to name a book's section files.
	mapUseful(files, withFiles) {
		let s = files.structure;
		return !!s && (s.outlineMethod !== "chunks" || (withFiles && this.isBook(files)));
	},

	// The section the map is drawn around: the page last recorded, else the first focus page.
	mapSection(files) {
		let s = files.structure;
		let current = files.progress && Number.isInteger(files.progress.current) ? files.progress.current : (files.focus || [])[0];
		return s && Number.isInteger(current) ? ZusiaMap.sectionOf(s.outline, current)?.id ?? null : null;
	},

	// The whole map goes to a new session (a changed prompt resets the session too) and
	// whenever the user is in another section than when the session last saw it.
	mapDue(files, session, withFiles) {
		if (!this.mapUseful(files, withFiles)) {
			return false;
		}
		return !session || !session.map || session.map.section !== this.mapSection(files);
	},

	// <reading_map> when it is due, then <reading_memory>, which opens with where the user
	// is. Text file names only for backends that can read them, and only for books.
	readingBlocks(files, session, { withFiles = true } = {}) {
		let s = files.structure;
		let out = "";
		if (this.mapDue(files, session, withFiles)) {
			out += this.contextBlock("reading_map", ZusiaMap.renderMap(s, s.outline, files.progress || null,
				{ files: withFiles && this.isBook(files) ? s.files : [] }));
		}
		let memory = files.memory;
		let progress = files.progress;
		if (memory && (memory.items.length || memory.summary || (progress && Number.isInteger(progress.current)))) {
			out += this.contextBlock("reading_memory", ZusiaMap.renderMemory(memory, progress, s || null));
		}
		let fresh = files.gists && s && this.isPaged(files) ? ZusiaMap.freshGists(files.gists, s, files.fullText.pages) : [];
		if (fresh.length) {
			let current = progress && Number.isInteger(progress.current) ? progress.current : (files.focus || [])[0];
			out += this.contextBlock("section_gists", ZusiaMap.renderGists(fresh, s, current));
		}
		return out;
	},

	pdfPageName(i, structure) {
		return "PDF " + ZusiaMap.pageName(i, structure || null);
	},

	// ", in section 2.3 Convolution, file text/02-discrete-time-signals.md".
	placeOf(files, i, withFiles) {
		let s = files.structure;
		if (!s) {
			return "";
		}
		let out = "";
		let section = s.outlineMethod !== "chunks" ? ZusiaMap.sectionOf(s.outline, i) : null;
		if (section) {
			out += ", in section " + ZusiaMap.entryTitle(section);
		}
		let file = withFiles && this.isBook(files) ? s.files.find(f => f.start <= i && i <= f.end) : null;
		if (file) {
			out += ", file text/" + file.name;
		}
		return out;
	},

	// The user says "page 18" for the number printed on the page; the model sees PDF pages.
	pageTranslations(files) {
		let s = files.structure;
		if (!s || !files.query || !this.isPaged(files)) {
			return [];
		}
		let out = [];
		for (let ref of ZusiaMap.findObjectRefs(files.query)) {
			if (ref.kind !== "page") {
				continue;
			}
			let i = ZusiaMap.pageIndexFor(s, ref.label, files.fullText.pages.length);
			if (i !== null && String(i + 1) !== ref.label) {
				out.push("\"page " + ref.label + "\" in the question means " + this.pdfPageName(i, s));
			}
		}
		return out.slice(0, 5);
	},

	isPaged(files) {
		let full = files.fullText;
		return !!full && full.status === "ok" && full.paged;
	},

	// --------------------------------------------------------------- NEED_PAGES

	// "NEED_PAGES: 41, 52-53" as the answer's first line: Antigravity, which has only the
	// pages it was sent, asks for PDF pages; at most NEED_PAGES_MAX that exist.
	// Flash models dress the line up: "**NEED_PAGES:** 41", "NEED_PAGES 41", backticks, a
	// code fence, lower case. Group 1 is what follows the keyword on its line.
	NEED_PAGES_LINE: /^\s*(?:```[^\n]*\n\s*)?[*_`]*need[_ ]pages[*_`]*[ \t]*:?([^\n]*?)[*_` \t]*(?:\n[ \t]*```[ \t]*)?(?=\n|$)/i,
	NEED_PAGES_START: /^\s*(?:```[^\n]*\n\s*)?[*_`]*need[_ ]pages/i,

	parseNeedPages(text, files) {
		let m = this.NEED_PAGES_LINE.exec(text || "");
		if (!m) {
			return null;
		}
		let count = this.isPaged(files) ? files.fullText.pages.length : 0;
		let pages = [];
		for (let part of m[1].replace(/^[*_`:\s]+/, "").split(/[,;\s]+/)) {
			let r = /^(\d{1,4})(?:[-–](\d{1,4}))?$/.exec(part);
			if (!r) {
				continue;
			}
			let last = Math.min(r[2] ? +r[2] : +r[1], +r[1] + this.NEED_PAGES_MAX);
			for (let k = +r[1]; k <= last; k++) {
				if (k >= 1 && k <= count && !pages.includes(k - 1)) {
					pages.push(k - 1);
				}
			}
		}
		return pages.slice(0, this.NEED_PAGES_MAX);
	},

	stripNeedPages(text) {
		return String(text || "").replace(this.NEED_PAGES_LINE, "").trim();
	},

	// Streamed text that is, or may still become, a NEED_PAGES line stays off screen.
	mayBeNeedPages(text) {
		let head = String(text).trimStart();
		if (this.NEED_PAGES_START.test(head)) {
			return true;
		}
		if (head.length >= this.NEED_PAGES_HOLD) {
			return false;
		}
		// What is left once an opening fence and emphasis are peeled off must still be able
		// to grow into the keyword.
		let rest = head.replace(/^```[^\n`]*\n?/, "").replace(/^[\s*_`]+/, "").toUpperCase().replace(" ", "_");
		return "NEED_PAGES".startsWith(rest.slice(0, 10));
	},

	holdNeedPages(progress) {
		return (update) => {
			if (update.text !== undefined && this.mayBeNeedPages(update.text)) {
				let { text, ...rest } = update;
				progress(rest);
				return;
			}
			progress(update);
		};
	},

	// One more turn in the same conversation with the pages the answer asked for, and only
	// one: a second NEED_PAGES line is dropped and what follows it kept. The line itself is
	// never stored.
	async followUpWithPages(sent, result, paper, pages, pending) {
		let fail = error => ({ text: "", error, sessionId: result.sessionId });
		if (!pages.length || !result.sessionId) {
			let text = this.stripNeedPages(result.text);
			return text ? Object.assign({}, result, { text }) : fail("Antigravity asked for pages this document does not have instead of answering.");
		}
		pending.progress({ status: "reading " + (pages.length > 1 ? "pages " : "page ") + this.formatPageRanges(pages) });
		let follow = Object.assign({}, sent, { session: { id: result.sessionId, seen: 0, paper }, needPages: pages });
		let second = await this.runBackend("agy", follow);
		let sessionId = second.sessionId || result.sessionId;
		if (!second.text) {
			return Object.assign({}, second, { sessionId });
		}
		let text = this.stripNeedPages(second.text);
		return text ? { text, sessionId } : fail("Antigravity asked for more pages again instead of answering.");
	},
});
