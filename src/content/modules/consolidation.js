"use strict";

Object.assign(Zusia, {
	// --------------------------------------------------------------- consolidation

	// Queues what `reason` calls for: "turn" after an answer (every CONSOLIDATE_TURNS
	// questions, or past CONSOLIDATE_CHARS of turns), "chapter" (the reader moved to another
	// chapter), "leave" (the sidebar left the paper or closed) and "open" (it showed the
	// paper: the first chance after a restart) whenever an answered question is not in the
	// memory yet. A put-away chat still owed goes first, with any consolidation that is
	// due, and on its own unless its fold already failed in this session.
	async scheduleConsolidation(dir, reason) {
		if (this._jobsStopped || !this.memoryJobsAvailable()) {
			return false;
		}
		let due = await this.consolidationDue(dir, reason);
		let queued = false;
		for (let { file } of (await this.loadMemory(dir)).pendingArchives) {
			if (due || !this._archiveFailed.has(dir + "\n" + file)) {
				queued = this.queueConsolidation(dir, { archive: file }) || queued;
			}
		}
		return (due && this.queueConsolidation(dir, { reason })) || queued;
	},

	// Showing a paper picks up what a quit or a pause left unconsolidated.
	resumeMemory(dir) {
		return this.scheduleConsolidation(dir, "open");
	},

	// After a call that came back without a usable patch, only the turns after the ones it
	// was given count, whatever the reason: a model that keeps failing costs a call per
	// five questions, not one per question, paper switch or chapter.
	async consolidationDue(dir, reason) {
		let memory = await this.loadMemory(dir);
		let history = await this.loadHistory(dir);
		let counted = history.slice(Math.max(memory.coveredThrough + 1, this._memoryFailed.get(dir) || 0));
		if (!counted.some(m => m.role === "assistant")) {
			return false;
		}
		if (reason !== "turn") {
			return true;
		}
		let questions = counted.filter(m => m.role === "user").length;
		let chars = counted.reduce((sum, m) => sum + String(m.text || "").length, 0);
		return questions >= this.CONSOLIDATE_TURNS || chars > this.CONSOLIDATE_CHARS;
	},

	// The check runs again when the job starts: a job that waited behind a question may
	// find the memory already updated. An `archive` is the file of a put-away chat listed
	// in pendingArchives, folded in as it was.
	queueConsolidation(dir, { reason = "leave", archive = null } = {}) {
		return this.queueJob({
			key: "memory:" + dir + (archive ? "@" + archive : ""),
			dir,
			run: async job => (archive || (await this.consolidationDue(dir, reason)) ? this.consolidateMemory({ dir }, { job, archive }) : null),
		});
	},

	// Reset memory: the paper's queued updates go and its failures are forgotten. One
	// already running is dropped when it writes, by the generation it read.
	forgetMemoryJobs(dir) {
		this._jobs = this._jobs.filter(job => !(job.dir === dir && job.key.startsWith("memory:")));
		this._memoryFailed.delete(dir);
		for (let key of [...this._archiveFailed].filter(k => k.startsWith(dir + "\n"))) {
			this._archiveFailed.delete(key);
		}
	},

	// How much turns or section text a background prompt may carry beside its `fixed`
	// part. agy gets the whole prompt inline, so it is held to the inline budget (12k on
	// Windows, whose stdin is not checked yet; escaped tags lengthen a text slightly, hence
	// the margin). Claude has no such limit.
	jobInputChars(backend, cap, fixed) {
		if (backend !== "agy") {
			return cap;
		}
		return Math.max(this.JOB_MIN_INPUT_CHARS, Math.min(cap, this.inlineFullTextBudget() - fixed - 200));
	},

	// The messages one consolidation reads from chat index `from` on: each cleaned and cut,
	// at most `maxChars` in all with their markers, ending on an answer. Null when no
	// answered question is left; `more` when the next call has some.
	consolidationBatch(history, from, maxChars = this.CONSOLIDATE_INPUT_CHARS) {
		let cap = Math.min(this.CONSOLIDATE_MESSAGE_CHARS, maxChars - this.TURN_MARKER_CHARS);
		let messages = [];
		let total = 0;
		for (let i = Math.max(0, from); i < history.length; i++) {
			// A line that looks like a turn marker is the message's own text (a pasted chat,
			// a passage); escaped, it cannot pass for a turn of the user's.
			let text = ZusiaMap.memoryInputText(history[i].text).replace(/^(\s*)#(?=\d)/gm, "$1\\#");
			if (text.length > cap) {
				text = text.slice(0, cap - 1) + "…";
			}
			if (messages.length && total + text.length + this.TURN_MARKER_CHARS > maxChars) {
				break;
			}
			messages.push({ index: i, role: history[i].role, text, page: history[i].page ?? null });
			total += text.length + this.TURN_MARKER_CHARS;
		}
		while (messages.length && messages[messages.length - 1].role !== "assistant") {
			messages.pop();
		}
		if (!messages.length) {
			return null;
		}
		let through = messages[messages.length - 1].index;
		return { messages, through, more: history.slice(through + 1).some(m => m.role === "assistant") };
	},

	consolidationPrompt(memory, progress, structure, batch) {
		let turns = batch.messages.map(m => "#" + m.index + " " + (m.role === "user" ? "User" : "Assistant") +
			(m.role === "user" && m.page ? " (on " + this.pdfPageName(m.page - 1, structure) + ")" : "") + ": " + m.text).join("\n\n");
		let sections = structure && structure.outlineMethod !== "chunks"
			? ZusiaMap.renderMap(structure, structure.outline, progress, { maxChars: 2000, files: [] })
			: "";
		return (
			"You keep the reading memory of Zusia, a study assistant that helps one person read one document. " +
			"The next conversation about the document starts from this memory, so it should hold what the turns " +
			"below show about the reader: what they understood, what is still shaky, which of their questions are " +
			"still open, and how they want to be answered. Record the reader, not the document: the document is " +
			"always at hand, so do not summarise its content.\n\n" +
			"Answer with one JSON object and nothing else, every field optional:\n" +
			"{\"summary\": \"...\", \"add\": [{\"kind\": \"understood\", \"text\": \"...\", \"page\": 41}], \"resolve\": [\"m3\"], \"remove\": [\"m5\"]}\n\n" +
			"- summary: the running summary of the conversation, rewritten to take in these turns, at most " +
			ZusiaMap.MEMORY_SUMMARY_CHARS + " characters. Leave it out to keep the current one.\n" +
			"- add: new items. kind is understood (the reader got it, for example restated it correctly), shaky " +
			"(they struggled or got it wrong), open (a question of theirs still unanswered) or preference (how they " +
			"want answers, only from something they said themselves; give \"source\": the number of that User turn " +
			"below). text is one short sentence, at most " + ZusiaMap.MEMORY_ITEM_CHARS + " characters. page is the PDF " +
			"page number the turn was on, when there is one. Do not add what the memory already says.\n" +
			"- resolve: ids of open or shaky items these turns settled.\n" +
			"- remove: ids of items that proved wrong or no longer matter. Items marked note are the reader's own " +
			"and stay as they are.\n" +
			"- Plain text: LaTeX maths is fine, HTML and links are not. Answer {} when nothing changed.\n" +
			"- Each turn starts with #number and who spoke. A line starting with \\# is text inside a turn, not a turn.\n\n" +
			this.contextBlock("reading_memory", ZusiaMap.renderMemory(memory, progress, structure)) +
			(sections ? this.contextBlock("document_sections", sections) : "") +
			this.contextBlock("conversation_turns", turns) +
			"Answer with the JSON object only."
		);
	},

	// One consolidation: the model proposes an id'd patch from the turns the memory does
	// not cover yet, of the current chat or of a put-away one (`archive`), and only
	// applyMemoryPatch, limited to the model's kinds, changes the memory. `coveredThrough`
	// moves only for the current chat's turns, an archive's `from` only for its own.
	async consolidateMemory(ctx, { job = null, archive = null } = {}) {
		let { dir } = ctx;
		// Checked again here: the setting or the assistant may have changed while it waited.
		let backend = this.jobBackend();
		if (!backend || !this.consolidating()) {
			return null;
		}
		let memory = await this.loadMemory(dir);
		let owed = archive ? memory.pendingArchives.find(a => a.file === archive) : null;
		if (archive && !owed) {
			return null;
		}
		let history = archive ? await this.readJSON(OS.Path.join(dir, archive), null) : await this.loadHistory(dir);
		if (!history) {
			this.log("The put-away chat " + archive + " is gone; it is no longer folded into the memory");
			await this.updateMemory(dir, current => Object.assign({}, current, { pendingArchives: current.pendingArchives.filter(a => a.file !== archive) }));
			return null;
		}
		let structure = await this.cachedStructure(dir);
		let progress = this.trackingReading() ? await this.loadProgress(dir) : null;
		let fixed = this.consolidationPrompt(memory, progress, structure, { messages: [] }).length;
		let batch = this.consolidationBatch(history, archive ? owed.from : memory.coveredThrough + 1,
			this.jobInputChars(backend, this.CONSOLIDATE_INPUT_CHARS, fixed));
		if (!batch) {
			if (archive) {
				await this.updateMemory(dir, current => Object.assign({}, current, { pendingArchives: current.pendingArchives.filter(a => a.file !== archive) }));
			}
			return null;
		}
		let result = await this.runBackgroundCall(backend, this.consolidationPrompt(memory, progress, structure, batch), job);
		if (job && job.cancelled) {
			return { called: true };
		}
		let patch = result.error ? null : ZusiaMap.parsePatch(result.text);
		if (!patch) {
			this.log(result.error
				? "Memory consolidation got no answer: " + result.error.slice(0, 300)
				: "Memory consolidation answered without a JSON object: " + result.text.slice(0, 300));
			if (!result.rateLimited) {
				if (archive) {
					this._archiveFailed.add(dir + "\n" + archive);
				}
				else {
					this._memoryFailed.set(dir, batch.through + 1);
				}
			}
			return { called: true, rateLimited: result.rateLimited };
		}
		if (archive) {
			this._archiveFailed.delete(dir + "\n" + archive);
		}
		else {
			this._memoryFailed.delete(dir);
		}
		// A preference may cite only a user message the model was shown.
		let shown = [];
		for (let m of batch.messages) {
			shown[m.index] = history[m.index];
		}
		// What the user edited during the call is theirs: the patch neither removes nor
		// resolves it.
		let read = new Map(memory.items.map(item => [item.id, item.text]));
		let rejected = [];
		let dropped = false;
		await this.updateMemory(dir, (current) => {
			if (current.generation !== memory.generation) {
				dropped = true;
				return current;
			}
			let untouched = id => current.items.some(item => item.id === id && item.text === read.get(id));
			let checked = Object.assign({}, patch);
			for (let key of ["remove", "resolve"]) {
				if (Array.isArray(patch[key])) {
					checked[key] = patch[key].filter(untouched);
					rejected.push(...patch[key].filter(id => !untouched(id)).map(id => ({ id, reason: "edited or gone meanwhile" })));
				}
			}
			let applied = ZusiaMap.applyMemoryPatch(current, checked, {
				history: shown,
				pageCount: structure ? structure.pageCount : Infinity,
				now: Date.now(),
				kinds: ZusiaMap.MODEL_KINDS,
			});
			rejected.push(...applied.rejected);
			let next = applied.memory;
			if (archive) {
				next.pendingArchives = batch.more
					? current.pendingArchives.map(a => (a.file === archive ? Object.assign({}, a, { from: batch.through + 1 }) : a))
					: current.pendingArchives.filter(a => a.file !== archive);
			}
			else if (current.epoch === memory.epoch && batch.through > current.coveredThrough) {
				next.coveredThrough = batch.through;
			}
			return next;
		});
		if (dropped) {
			this.log("Memory update dropped: the memory was reset while it ran");
			return { called: true };
		}
		if (rejected.length) {
			this.log("Memory patch applied without " + rejected.length + " parts: " + JSON.stringify(rejected).slice(0, 500));
		}
		if (batch.more) {
			this.queueConsolidation(dir, { archive });
		}
		return { called: true };
	},

	// New chat and a restored chat start a new epoch with nothing covered. The chat put
	// away (`archived`, its file) is owed to the memory from where the memory had got to,
	// noted in memory.json before it is queued; a `restored` chat is the current one again,
	// so no longer owed. Failures of the chat before no longer hold the counts back.
	async startMemoryEpoch(dir, history, archived, { restored = null } = {}) {
		let owe = false;
		await this.updateMemory(dir, (memory) => {
			let from = memory.coveredThrough + 1;
			let pendingArchives = memory.pendingArchives.filter(a => a.file !== restored && a.file !== archived);
			owe = !!archived && this.memoryJobsAvailable() && history.slice(from).some(m => m.role === "assistant");
			if (owe) {
				pendingArchives.push({ file: archived, from });
			}
			return Object.assign({}, memory, { coveredThrough: -1, epoch: memory.epoch + 1, pendingArchives });
		});
		this._memoryFailed.delete(dir);
		if (owe) {
			this.queueConsolidation(dir, { archive: archived });
		}
	},

	// The sidebar moved to another paper or closed.
	leavePaper(dir) {
		this.scheduleConsolidation(dir, "leave").catch((e) => {
			// A paper left as Zotero quits: the plugin's globals are gone by the time the
			// files are read, and the next start picks up what this would have queued.
			if (!this._jobsStopped) {
				this.logError("scheduling memory consolidation", e);
			}
		});
	},

	// A page turn into another chapter folds the conversation so far into the memory, and a
	// section turning read gets its gist when gists are on.
	async afterPageEvent(dir, structure, before, progress) {
		let outline = (structure && structure.outline) || [];
		let from = Number.isInteger(before.current) ? ZusiaMap.chapterOf(outline, before.current) : null;
		let to = ZusiaMap.chapterOf(outline, progress.current);
		if (from && to && from.id !== to.id) {
			await this.scheduleConsolidation(dir, "chapter").catch(e => this.logError("scheduling memory consolidation", e));
		}
		if (this.gisting() && this.jobBackend()) {
			this.queueGists(dir, outline.filter(e => progress.sections[e.id] === "read" && (before.sections || {})[e.id] !== "read"));
		}
	},

	// --------------------------------------------------------------- gists

	gistsPath(dir) {
		return OS.Path.join(dir, "gists.json");
	},

	async loadGists(dir) {
		return Object.assign({ version: 1, sections: {} }, await this.readJSON(this.gistsPath(dir), null));
	},

	updateGists(dir, change) {
		return this.withDirLock(dir, async () => {
			let next = change(await this.loadGists(dir));
			await this.writeAtomic(this.gistsPath(dir), JSON.stringify(next, null, 1));
			return next;
		});
	},

	queueGist(dir, id) {
		return this.queueJob({ key: "gist:" + dir + ":" + id, dir, run: job => this.gistSection({ dir }, id, { job }) });
	},

	// Sections before the part they belong to, which is merged from their gists.
	queueGists(dir, entries) {
		[...entries].sort((a, b) => b.level - a.level).forEach(e => this.queueGist(dir, e.id));
	},

	// Every question checks for read sections whose gist is missing or stale (the text
	// changed, or gists were off while they were read): page turns only see a section the
	// moment it turns read. One whose gist failed in this session is not asked for again.
	queueMissingGists(dir, structure, pages, progress, gists) {
		if (!this.jobBackend() || !progress) {
			return;
		}
		let fresh = new Set(ZusiaMap.freshGists(gists, structure, pages).map(g => g.entry.id));
		this.queueGists(dir, structure.outline.filter(e => progress.sections[e.id] === "read" && !fresh.has(e.id) &&
			!this._gistFailed.has(dir + "\n" + e.id + "\n" + ZusiaMap.sectionHash(pages, e))));
	},

	// A section the reader finished, summarised from its pages with the gist before it for
	// continuity, or a part merged from its sections' gists. Stored with the hash of the
	// text it was written from: a changed file makes it stale, and it is written again.
	async gistSection(ctx, id, { job = null } = {}) {
		let { dir } = ctx;
		let backend = this.jobBackend();
		let structure = await this.cachedStructure(dir);
		let entry = structure && structure.outline.find(e => e.id === id);
		let saved = entry ? await this.readJSON(OS.Path.join(dir, "cache", "pages.json"), null) : null;
		if (!backend || !this.gisting() || !saved || saved.pages.length !== structure.pageCount) {
			return null;
		}
		let pages = saved.pages;
		let hash = ZusiaMap.sectionHash(pages, entry);
		let gists = await this.loadGists(dir);
		if (gists.sections[id] && gists.sections[id].hash === hash) {
			return null;
		}
		let fresh = new Map(ZusiaMap.freshGists(gists, structure, pages).map(g => [g.entry.id, g]));
		let children = ZusiaMap.childrenOf(structure.outline, entry);
		let prompt;
		if (children.length) {
			let parts = children.filter(c => fresh.has(c.id)).map(c => fresh.get(c.id));
			if (!parts.length) {
				return null;
			}
			prompt = this.gistMergePrompt(entry, parts, structure);
		}
		else {
			let previous = structure.outline.filter(e => e.end < entry.start && fresh.has(e.id))
				.sort((a, b) => a.end - b.end || a.level - b.level).pop();
			prompt = this.gistPrompt(entry, pages, structure, previous ? fresh.get(previous.id) : null, backend);
		}
		let result = await this.runBackgroundCall(backend, prompt, job);
		if (job && job.cancelled) {
			return { called: true };
		}
		let failed = dir + "\n" + id + "\n" + hash;
		if (result.error) {
			this.log("Gist of " + id + " got no answer: " + result.error.slice(0, 300));
			if (!result.rateLimited) {
				this._gistFailed.add(failed);
			}
			return { called: true, rateLimited: result.rateLimited };
		}
		let gist = ZusiaMap.validateGist(result.text);
		if (gist.reason) {
			this.log("Gist of " + id + " not kept: " + gist.reason);
			this._gistFailed.add(failed);
			return { called: true };
		}
		this._gistFailed.delete(failed);
		await this.updateGists(dir, g => Object.assign({}, g, {
			sections: Object.assign({}, g.sections, { [id]: { hash, text: gist.text, ts: Date.now() } }),
		}));
		return { called: true };
	},

	gistPrompt(entry, pages, structure, previous, backend = null) {
		let body = [];
		for (let i = entry.start; i <= entry.end; i++) {
			body.push(ZusiaMap.renderPage(i, pages[i], structure));
		}
		let text = body.join("\n\n");
		let frame = section => (
			"You write short summaries of a document's sections for a study assistant, which reads them later to " +
			"find its way around what the reader has already read. Summarise the section below in at most " +
			ZusiaMap.GIST_CHARS + " characters of plain prose: what it covers, the ideas, definitions and results it " +
			"introduces, and the numbers of its key equations, figures or theorems, in the document's own terms. " +
			"Say only what the text says. No headings, no HTML, no links, no preamble: answer with the summary alone.\n\n" +
			(previous ? "The summary of the part before it, for continuity (do not repeat it):\n" + this.contextBlock("previous_summary", previous.text) : "") +
			"Section " + ZusiaMap.entryTitle(entry) + ", " + ZusiaMap.rangeName(entry.start, entry.end, structure) + ":\n" +
			this.contextBlock("section_text", section)
		);
		let cut = "\n[The rest of the section is left out.]";
		let limit = this.jobInputChars(backend, this.GIST_INPUT_CHARS, frame("").length + cut.length);
		return frame(text.length > limit ? text.slice(0, limit) + cut : text);
	},

	gistMergePrompt(entry, parts, structure) {
		return (
			"You write short summaries of a document's parts for a study assistant, which reads them later to find " +
			"its way around what the reader has already read. Below are the summaries of the sections of " +
			ZusiaMap.entryTitle(entry) + " (" + ZusiaMap.rangeName(entry.start, entry.end, structure) + "). Merge them " +
			"into one summary of the whole part, at most " + ZusiaMap.GIST_CHARS + " characters of plain prose, keeping " +
			"the key results and equation numbers. Say only what the summaries say. No headings, no HTML, no links, " +
			"no preamble: answer with the summary alone.\n\n" +
			this.contextBlock("section_gists", parts.map(p => "- " + ZusiaMap.entryTitle(p.entry) + ": " + p.text.replace(/\s+/g, " ")).join("\n"))
		);
	},
});
