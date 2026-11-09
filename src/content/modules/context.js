"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Context: resolving the item/attachment and exporting files for the agent
	// ---------------------------------------------------------------------

	getDataDir() {
		return OS.Path.join(Zotero.DataDirectory.dir, "zusia");
	},

	getLogPath() {
		return OS.Path.join(this.getDataDir(), "debug.log");
	},

	async getContext(item) {
		let paperItem;
		let attachmentItem;

		if (item.isRegularItem()) {
			paperItem = item;
			attachmentItem = (await item.getBestAttachment()) || null;
		}
		else if (item.isAttachment()) {
			attachmentItem = item;
			paperItem = item.parentItem || item;
		}
		else {
			return null;
		}

		let dirName = paperItem.libraryID + "-" + paperItem.key;
		let dir = OS.Path.join(this.getDataDir(), dirName);
		// createDirectoryIfMissingAsync() does not create missing parents, so create
		// the shared "zusia" directory before the per-item subdirectory.
		await Zotero.File.createDirectoryIfMissingAsync(this.getDataDir());
		await Zotero.File.createDirectoryIfMissingAsync(dir);

		return { paperItem, attachmentItem, dir };
	},

	safeField(item, field) {
		try {
			return item.getField(field) || "";
		}
		catch (e) {
			return "";
		}
	},

	// `focus` lists the 0-based PDF pages the user is looking at (selection, page on
	// screen); `reader` is the open reader, whose page labels and outline the reading map
	// prefers. A file is rewritten only when its content changed, so a question about a
	// book does not rewrite megabytes of text each time.
	async exportContext(ctx, { focus = [], reader = null } = {}) {
		let { paperItem, attachmentItem, dir } = ctx;
		this.log("exportContext: updating the context files in " + dir);

		let lines = ["# " + (this.safeField(paperItem, "title") || "Untitled")];
		let creators = (paperItem.getCreators() || [])
			.map(c => (c.lastName ? [c.firstName, c.lastName].filter(Boolean).join(" ") : c.name || ""))
			.filter(Boolean);
		if (creators.length) {
			lines.push("Authors: " + creators.join(", "));
		}
		let date = this.safeField(paperItem, "date");
		if (date) {
			lines.push("Date: " + date);
		}
		let pub = this.safeField(paperItem, "publicationTitle");
		if (pub) {
			lines.push("Publication: " + pub);
		}
		let doi = this.safeField(paperItem, "DOI");
		if (doi) {
			lines.push("DOI: " + doi);
		}
		let abstractNote = this.safeField(paperItem, "abstractNote");
		if (abstractNote) {
			lines.push("\n## Abstract\n" + abstractNote);
		}
		let metadata = lines.join("\n") + "\n";
		await this.writeIfChanged(OS.Path.join(dir, "metadata.md"), metadata);

		// Pre-release versions exported an unbounded paper.txt; fulltext.md replaces it.
		let paperPath = OS.Path.join(dir, "paper.txt");
		if (await OS.File.exists(paperPath)) {
			await OS.File.remove(paperPath);
		}

		let fullText = this.getPref("fullText") === false ? { status: "off" } : await this.loadFullText(attachmentItem, dir);
		let structure = null;
		if (fullText.status === "ok") {
			// EPUBs and web pages come as one page, with no folios or page numbers to map.
			structure = fullText.paged ? await this.ensureStructure(ctx, fullText, reader) : null;
			fullText = Object.assign({}, fullText, { file: await this.writeTextFiles(dir, fullText, structure) });
		}
		else {
			await this.removeTextFiles(dir);
		}

		let annotations = "";
		if (attachmentItem && attachmentItem.isFileAttachment && attachmentItem.isFileAttachment()) {
			let items = attachmentItem.getAnnotations();
			if (items.length) {
				let parts = items.map((a) => {
					let head = "- [" + (a.annotationType || "note") + "]";
					if (a.annotationPageLabel) {
						head += " p." + a.annotationPageLabel;
					}
					let pieces = [];
					if (a.annotationText) {
						pieces.push(a.annotationText);
					}
					if (a.annotationComment) {
						pieces.push("(" + a.annotationComment + ")");
					}
					return head + " " + pieces.join(" ");
				});
				annotations = "# Annotations\n\n" + parts.join("\n");
			}
		}
		await this.writeIfChanged(OS.Path.join(dir, "annotations.md"), annotations);

		return { metadata, annotations, fullText, structure, focus };
	},

	async writeIfChanged(path, text) {
		if ((await OS.File.exists(path)) && (await Zotero.File.getContentsAsync(path)) === text) {
			return false;
		}
		await Zotero.File.putContentsAsync(path, text);
		return true;
	},

	// The attachment's text, split into PDF pages for a PDF. Extraction runs once per
	// file version (modification time and size): the result is kept in memory and, with
	// `dir`, in <dir>/cache/pages.json, so a restart does not run the PDF worker again.
	async loadFullText(attachment, dir = null) {
		if (!attachment || !attachment.isFileAttachment()) {
			return { status: "none", reason: "this item has no PDF, EPUB or web snapshot attached" };
		}
		if (!(await attachment.fileExists())) {
			return { status: "none", reason: "the attachment's file is not on this computer" };
		}
		let stamp = await this.fileStamp(attachment);
		let cached = this._fullTexts.get(attachment.id);
		if (cached && cached.stamp === stamp) {
			this._fullTexts.delete(attachment.id);
			this._fullTexts.set(attachment.id, cached);
			return cached.result;
		}
		// The sidebar rendering and a question can both ask for a book that is not cached yet;
		// the PDF worker runs once for both.
		let key = attachment.id + "@" + stamp;
		let running = this._textLoads.get(key);
		if (running) {
			return running;
		}
		let load = this.readOrExtract(attachment, stamp, dir);
		this._textLoads.set(key, load);
		let done = () => this._textLoads.delete(key);
		load.then(done, done);
		return load;
	},

	async readOrExtract(attachment, stamp, dir) {
		let cachePath = dir && OS.Path.join(dir, "cache", "pages.json");
		let saved = cachePath ? await this.readJSON(cachePath, null) : null;
		let result;
		if (saved && saved.version === this.PAGES_VERSION && saved.attachmentID === attachment.id && saved.stamp === stamp && Array.isArray(saved.pages)) {
			result = { status: "ok", paged: saved.paged, pages: saved.pages, stamp };
		}
		else {
			try {
				result = await this.extractFullText(attachment);
			}
			catch (e) {
				// Encrypted or damaged files: the assistant is told why it has no text.
				this.logError("loadFullText", e);
				return { status: "none", reason: "Zotero could not extract it (" + ((e && e.message) || e) + ")" };
			}
			if (result.status === "ok") {
				result.stamp = stamp;
				if (cachePath) {
					await this.ensureCacheDir(dir);
					await this.writeAtomic(cachePath, JSON.stringify({ version: this.PAGES_VERSION, attachmentID: attachment.id, stamp, paged: result.paged, pages: result.pages }));
				}
			}
		}
		this.rememberText(attachment.id, stamp, result);
		return result;
	},

	// "mtime:size": a file replaced within the same second, as a sync can do, still differs in size.
	async fileStamp(attachment) {
		let mtime = await attachment.attachmentModificationTime;
		let path = await attachment.getFilePathAsync();
		let size = path ? (await OS.File.stat(path)).size : "";
		return mtime + ":" + size;
	},

	// Newest last; the oldest texts go while the total is over TEXT_CACHE_CHARS, but the
	// one just loaded always stays.
	rememberText(id, stamp, result) {
		let chars = (result.pages || []).reduce((sum, page) => sum + page.length, 0);
		this._fullTexts.delete(id);
		this._fullTexts.set(id, { stamp, result, chars });
		let total = 0;
		for (let entry of this._fullTexts.values()) {
			total += entry.chars;
		}
		for (let [key, entry] of this._fullTexts) {
			if (total <= this.TEXT_CACHE_CHARS || key === id) {
				break;
			}
			this._fullTexts.delete(key);
			total -= entry.chars;
		}
	},

	async extractFullText(attachment) {
		let paged = attachment.isPDFAttachment();
		let text;
		if (paged) {
			// The PDF worker separates pages with "\f", which the index cache may not keep.
			// No page limit (null), and priority because the user is waiting.
			text = (await Zotero.PDFWorker.getFullText(attachment.id, null, true)).text;
		}
		else {
			// EPUB and snapshots: index them completely, ignoring the page and length
			// limits of background indexing, then read Zotero's cache.
			let state = await Zotero.Fulltext.getIndexedState(attachment);
			if (state !== Zotero.Fulltext.INDEX_STATE_INDEXED) {
				await Zotero.Fulltext.indexItems([attachment.id], { complete: true });
			}
			text = await attachment.attachmentText;
		}
		text = text || "";
		let pages = paged ? text.split("\f") : [text];
		// A scan yields almost nothing per page (a download stamp at most), while a short
		// real paper, one page of abstract, still has a few hundred characters.
		if (text.replace(/\s+/g, "").length < 50 * pages.length) {
			return {
				status: "none",
				reason: paged
					? "the PDF has no text layer (probably a scan), so Zotero extracted no text"
					: "Zotero extracted no text from the attachment",
			};
		}
		return { status: "ok", paged, pages };
	},

	// The focus pages that exist, and how many characters each may take: they are always
	// sent, so together they must fit in the budget.
	focusPages(pages, budget, focus = []) {
		let valid = [...new Set(focus)].filter(i => Number.isInteger(i) && i >= 0 && i < pages.length);
		return { valid, cap: Math.floor(budget / Math.max(1, valid.length)) };
	},

	// Pages that fit in `budget` characters: the focus pages always (cut to their share
	// when one is longer), then the first page (title, abstract), then rings outward from
	// the focus, then the rest in order. A page too long for what is left is skipped, so
	// one dense page (a table, an appendix) does not end the selection early.
	pickPages(pages, budget, focus = []) {
		let { valid, cap } = this.focusPages(pages, budget, focus);
		let order = new Set(valid);
		let add = (i) => {
			if (i >= 0 && i < pages.length) {
				order.add(i);
			}
		};
		add(0);
		for (let d = 1; valid.length && d < pages.length; d++) {
			valid.forEach(f => { add(f - d); add(f + d); });
		}
		pages.forEach((page, i) => add(i));
		let kept = [];
		let used = 0;
		for (let i of order) {
			let size = pages[i].length + 20;
			if (valid.includes(i)) {
				size = Math.min(size, cap);
			}
			else if (used + size > budget) {
				continue;
			}
			kept.push(i);
			used += size;
		}
		if (!kept.length) {
			kept.push(0);
		}
		return kept.sort((a, b) => a - b);
	},

	// "1, 4–7, 12" from sorted 0-based page indices.
	formatPageRanges(indices) {
		let ranges = [];
		for (let i of indices) {
			let last = ranges[ranges.length - 1];
			if (last && last[1] === i - 1) {
				last[1] = i;
			}
			else {
				ranges.push([i, i]);
			}
		}
		return ranges.map(([a, b]) => (a === b ? String(a + 1) : (a + 1) + "–" + (b + 1))).join(", ");
	},

	// The text the assistant sees, with "--- page N ---" markers and a note on what was
	// left out, cut to `budget` characters.
	renderFullText(full, budget, focus = []) {
		if (!full.paged) {
			let text = full.pages[0].trim();
			let complete = text.length <= budget;
			return {
				text: complete ? text : "[Partial text: only the first " + budget + " of " + text.length +
					" characters are included.]\n\n" + text.slice(0, budget),
				paged: false, complete,
			};
		}
		let total = full.pages.length;
		let kept = this.pickPages(full.pages, budget, focus);
		let { cap } = this.focusPages(full.pages, budget, focus);
		let parts = [];
		let next = 0;
		let cut = false;
		let gap = (from, to) => "[" + (from === to ? "page " + (from + 1) : "pages " + (from + 1) + "–" + (to + 1)) + " left out]";
		for (let i of kept) {
			if (i > next) {
				parts.push(gap(next, i - 1));
			}
			let page = full.pages[i].trim();
			if (page.length > cap) {
				page = page.slice(0, cap) + "\n[the rest of page " + (i + 1) + " was left out to fit]";
				cut = true;
			}
			parts.push("--- page " + (i + 1) + " ---\n" + page);
			next = i + 1;
		}
		if (next < total) {
			parts.push(gap(next, total - 1));
		}
		let complete = kept.length === total && !cut;
		let head = complete ? ""
			: kept.length === total ? "[Partial text: every page is included, but the longest were cut short to fit.]\n\n"
				: "[Partial text: pages " + this.formatPageRanges(kept) + " of " + total +
					" are included; the others were left out to fit.]\n\n";
		return { text: head + parts.join("\n\n"), paged: true, complete, kept, total };
	},

	// Facts that change with every question, which the system prompt cannot know: which
	// text the assistant has, where the user is in the document, and which PDF page a
	// printed page number in the question means. `withFiles` names the section file the
	// page is in, for the backends that can open it.
	contextNote(files, coverage, { withFiles = true } = {}) {
		let full = (files && files.fullText) || { status: "none", reason: "it was not exported" };
		let structure = files && files.structure;
		let parts = [];
		if (full.status === "off") {
			parts.push("the user turned off sending the full text in Zusia's settings, so only the " +
				"metadata, abstract and annotations are available");
		}
		else if (full.status !== "ok") {
			parts.push("no full text is available, because " + full.reason);
		}
		else {
			parts.push(this.coverageText(coverage || full.file));
		}
		if (Number.isInteger(files && files.selectedPage)) {
			parts.push("the quoted passage is on " + this.pdfPageName(files.selectedPage, structure));
		}
		if (Number.isInteger(files && files.currentPage)) {
			parts.push("the user is viewing " + this.pdfPageName(files.currentPage, structure) + this.placeOf(files, files.currentPage, withFiles));
		}
		if (files) {
			parts.push(...this.pageTranslations(files));
		}
		return "\n\n[Context for this question: " + parts.join("; ") + ".]";
	},

	coverageText(c) {
		if (c.resumed) {
			let earlier = c.earlier
				? (c.earlier.complete ? "the whole text" : c.earlier.paged ? "pages " + this.formatPageRanges(c.earlier.kept) + " of " + c.earlier.total
					: "the beginning of the text")
				: "no text";
			return "earlier in this conversation you were sent " + earlier + " in <paper_fulltext>" +
				(c.added && c.added.length
					? ", and " + (c.added.length > 1 ? "pages " : "page ") + this.formatPageRanges(c.added) +
						(c.added.length > 1 ? " are" : " is") + " added in " + (c.focusBlock ? "<paper_fulltext> and <focus_page>" : "<paper_fulltext>") +
						" below for this question"
					: "");
		}
		if (c.sections) {
			return "the whole text (" + c.total + " pages) is in " + c.sections + " section files in text/, listed in fulltext.md";
		}
		let name = c.name + (c.focusBlock ? " and <focus_page> hold" : " holds");
		if (c.complete) {
			return name + " the whole text" + (c.paged ? " (" + c.total + " pages)" : "") +
				(c.focusBlock ? ", the page the user is on last, in <focus_page>" : "");
		}
		if (!c.paged) {
			return name + " only the beginning of the text; the rest was left out to fit";
		}
		return c.kept.length === c.total
			? name + " every page of " + c.total + ", the longest cut short to fit"
			: name + " pages " + this.formatPageRanges(c.kept) + " of " + c.total + "; the rest was left out to fit";
	},

	// What a new Antigravity session is sent of an EPUB or a web page, which has no pages.
	antigravityPaper(files) {
		let full = files.fullText;
		return full && full.status === "ok" ? this.renderFullText(full, this.inlineFullTextBudget(), files.focus || []) : null;
	},

	// The pages a backend's session has seen, without the text, to store in session.json;
	// `chars` adds up what the conversation was sent, which caps how long it is kept.
	sessionPaper(backend, files, session) {
		if (backend !== "agy") {
			return undefined;
		}
		let inline = this.inlinePages(files, session);
		if (!inline) {
			if (session) {
				return session.paper || null;
			}
			let paper = this.antigravityPaper(files);
			return paper ? { complete: paper.complete, paged: paper.paged, kept: paper.kept || [], total: paper.total, chars: paper.text.length } : null;
		}
		let earlier = (session && session.paper) || { complete: false, paged: true, kept: [], total: inline.total, chars: 0 };
		let added = [...inline.support, ...inline.focus].map(p => p.page);
		return {
			complete: !!earlier.complete || inline.complete,
			paged: true,
			kept: [...new Set([...(earlier.kept || []), ...added])].sort((a, b) => a - b),
			total: inline.total,
			chars: (earlier.chars || 0) + inline.chars,
		};
	},

	// `paper` after a NEED_PAGES follow-up sent `pages` as well.
	addSentPages(paper, pages, files) {
		let base = paper || { complete: false, paged: true, kept: [], total: files.fullText.pages.length, chars: 0 };
		let chars = pages.reduce((sum, i) => sum + files.fullText.pages[i].length + ZusiaMap.PAGE_OVERHEAD, 0);
		return Object.assign({}, base, { kept: [...new Set([...base.kept, ...pages])].sort((a, b) => a - b), chars: (base.chars || 0) + chars });
	},

	inlineFullTextBudget() {
		return Zotero.isWin ? this.FULLTEXT_INLINE_CHARS_WINDOWS : this.FULLTEXT_INLINE_CHARS;
	},

	// The paper and the reading context travel inside these tags; a closing tag in the
	// paper's own text, an outline title or a note must not end its block early.
	escapeContextTags(text) {
		return String(text).replace(/<(\/?)(paper_metadata|paper_fulltext|user_annotations|reading_map|reading_memory|focus_page|section_gists|conversation_turns|document_sections|section_text|previous_summary)\b/gi, "&lt;$1$2");
	},

	// The PDF attachment open in the reader when it belongs to this paper, otherwise the
	// best attachment, so the text and annotations match the PDF on screen.
	withOpenAttachment(ctx, reader) {
		let open = reader && Zotero.Items.get(reader.itemID);
		return open && open.isAttachment() ? Object.assign({}, ctx, { attachmentItem: open }) : ctx;
	},

	// The 0-based page on screen, or null when the reader cannot tell.
	readerPageIndex(reader) {
		let internal = reader && reader._internalReader;
		let index = internal?._state?.primaryViewStats?.pageIndex;
		if (Number.isInteger(index)) {
			return index;
		}
		let frame = internal?._primaryView?._iframeWindow;
		frame = frame && (frame.wrappedJSObject || frame);
		let number = frame?.PDFViewerApplication?.pdfViewer?.currentPageNumber;
		return Number.isInteger(number) ? number - 1 : null;
	},
});
