"use strict";

Object.assign(Zusia, {
	// --------------------------------------------------------------- progress

	trackingReading() {
		return this.getPref("trackReading") !== false;
	},

	progressPath(dir) {
		return OS.Path.join(dir, "progress.json");
	},

	// The paper's progress, read once and then kept in memory, where page events update it.
	async progressState(dir) {
		let state = this._progress.get(dir);
		if (state) {
			return state;
		}
		let saved = await this.readJSON(this.progressPath(dir), null);
		// Another caller may have loaded it while this one waited for the file.
		if (this._progress.has(dir)) {
			return this._progress.get(dir);
		}
		state = { progress: Object.assign(ZusiaMap.emptyProgress(), { anchors: [] }, saved || {}), dirty: false, scheduled: false };
		this._progress.set(dir, state);
		return state;
	},

	async loadProgress(dir) {
		return (await this.progressState(dir)).progress;
	},

	// The reader shows `pageIndex` now. Saved within PROGRESS_SAVE_MS, or at once when the
	// page is in another section, so a crash loses at most a few page turns.
	async recordPage(dir, pageIndex, structure, t = Date.now()) {
		if (!this.trackingReading() || !Number.isInteger(pageIndex)) {
			return;
		}
		let state = await this.progressState(dir);
		let before = state.progress;
		state.progress = ZusiaMap.applyPageEvent(state.progress, pageIndex, t, structure || null);
		state.dirty = true;
		if (state.progress.section !== before.section) {
			await this.flushProgress(dir);
		}
		else {
			this.scheduleProgressSave(dir);
		}
		this.refreshReadingChips(dir);
		await this.afterPageEvent(dir, structure, before, state.progress);
	},

	// A selection carries Zotero's label for its page, which pins that page's printed number.
	// It says which page the user was on too, so it is kept only while reading is tracked.
	// One already known is left where it is: rewriting it would only change the file.
	async recordAnchor(dir, pageIndex, label) {
		if (!this.trackingReading()) {
			return;
		}
		let state = await this.progressState(dir);
		label = String(label);
		if ((state.progress.anchors || []).some(a => a.pageIndex === pageIndex && a.label === label)) {
			return;
		}
		let anchors = (state.progress.anchors || []).filter(a => a.pageIndex !== pageIndex);
		anchors.push({ pageIndex, label });
		state.progress = Object.assign({}, state.progress, { anchors: anchors.slice(-50) });
		state.dirty = true;
		this.scheduleProgressSave(dir);
	},

	scheduleProgressSave(dir) {
		let state = this._progress.get(dir);
		if (state.scheduled) {
			return;
		}
		state.scheduled = true;
		Zotero.Promise.delay(this.PROGRESS_SAVE_MS)
			.then(() => this.flushProgress(dir))
			.catch(e => this.logError("saving progress.json", e));
	},

	async flushProgress(dir) {
		let state = this._progress.get(dir);
		state.scheduled = false;
		if (!state.dirty) {
			return;
		}
		state.dirty = false;
		let text = JSON.stringify(state.progress);
		try {
			await this.withDirLock(dir, () => this.writeAtomic(this.progressPath(dir), text));
		}
		catch (e) {
			// The page events it held are still only in memory: the next save writes them.
			state.dirty = true;
			throw e;
		}
	},

	flushAllProgress() {
		return Promise.all([...this._progress.keys()].map(dir => this.flushProgress(dir)));
	},

	// Every page turn in Zotero's reader stores the attachment's last page as a synced
	// setting, and the notifier reports it: no polling and no private reader API.
	watchReading() {
		this._readingObserver = Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => {
				this.onReadingNotify(event, ids).catch(e => this.logError("reading progress", e));
			},
		}, ["setting"], "zusia");
	},

	unwatchReading() {
		if (this._readingObserver) {
			Zotero.Notifier.unregisterObserver(this._readingObserver);
			this._readingObserver = null;
		}
		this.flushAllProgress().catch(e => this.logError("saving progress.json at shutdown", e));
	},

	// "<libraryID>/lastPageIndex_u_<key>" in the user library, "..._g<groupID>_<key>" in a
	// group, as Zotero.Item._getSettingKey writes them.
	parseLastPageSetting(id) {
		let m = /^\d+\/lastPageIndex_(?:u|g(\d+))_([A-Z0-9]{8})$/.exec(String(id));
		return m ? { groupID: m[1] ? +m[1] : null, key: m[2] } : null;
	},

	async onReadingNotify(event, ids) {
		if ((event !== "add" && event !== "modify") || !this.trackingReading()) {
			return;
		}
		for (let id of ids) {
			let setting = this.parseLastPageSetting(id);
			if (!setting) {
				continue;
			}
			let libraryID = setting.groupID === null ? Zotero.Libraries.userLibraryID : Zotero.Groups.getLibraryIDFromGroupID(setting.groupID);
			let attachment = libraryID && Zotero.Items.getByLibraryAndKey(libraryID, setting.key);
			if (!attachment || !attachment.isPDFAttachment()) {
				continue;
			}
			// A sync brings pages read on other devices too; only a reader open here is reading.
			if (!(Zotero.Reader._readers || []).some(r => r.itemID === attachment.id)) {
				continue;
			}
			let dir = this.contextDirFor(attachment);
			if (!(await OS.File.exists(dir))) {
				continue;
			}
			await this.recordPage(dir, attachment.getAttachmentLastPageIndex(), await this.cachedStructure(dir, attachment));
		}
	},

	// The map last built for the paper, without building one: page events only need sections.
	// One read from cache/ is kept, so page turns after a restart parse it once; with the
	// attachment given, a map of another file version is not used.
	async cachedStructure(dir, attachment = null) {
		let cached = this._structures.get(dir);
		if (cached) {
			return cached.structure;
		}
		let saved = await this.readJSON(OS.Path.join(dir, "cache", "structure.json"), null);
		if (!saved) {
			return null;
		}
		if (attachment && !String(saved.key).startsWith([this.MAP_VERSION, attachment.id, await this.fileStamp(attachment)].join(":") + ":")) {
			return null;
		}
		this._structures.set(dir, { key: saved.key, structure: saved });
		return saved;
	},

	// "§2.3 · p. 18 · 9/15 read" for the paper chip, or "" before any page was recorded.
	readingLine(structure, progress) {
		if (!structure || !progress || !Number.isInteger(progress.current)) {
			return "";
		}
		let i = progress.current;
		let section = structure.outlineMethod !== "chunks" ? ZusiaMap.sectionOf(structure.outline, i) : null;
		let parts = [];
		if (section) {
			parts.push(/^\d/.test(section.id) ? "§" + section.id : section.title.length > 18 ? section.title.slice(0, 17) + "…" : section.title);
		}
		parts.push("p. " + (ZusiaMap.printedLabel(i, structure) || String(i + 1)));
		if (section) {
			let read = (progress.read || []).filter(p => p >= section.start && p <= section.end).length;
			parts.push(read + "/" + (section.end - section.start + 1) + " read");
		}
		return parts.join(" · ");
	},

	refreshReadingChips(dir) {
		let cached = this._structures.get(dir);
		let state = this.trackingReading() ? this._progress.get(dir) : null;
		let reading = this.readingLine(cached && cached.structure, state && state.progress);
		for (let win of Zotero.getMainWindows()) {
			for (let root of win.document.querySelectorAll(".zs-root")) {
				let view = this._views.get(root);
				if (view && view.ctx.dir === dir && view.info) {
					this.renderPaperChip(root, Object.assign({}, view.info, { reading }));
				}
			}
		}
	},

	// When the sidebar shows a paper whose PDF is open in the reader: the map is built or
	// read back and the page on screen recorded, so the chip says where the user is.
	async updateReading(view) {
		let { ctx } = view;
		let reader = this.readerFor(ctx, Zotero.getMainWindow());
		if (!reader || this.getPref("fullText") === false) {
			this.refreshReadingChips(ctx.dir);
			return;
		}
		let open = this.withOpenAttachment(ctx, reader);
		let full = await this.loadFullText(open.attachmentItem, ctx.dir);
		if (full.status !== "ok" || !full.paged) {
			return;
		}
		let structure = await this.ensureStructure(open, full, reader);
		await this.recordPage(ctx.dir, this.readerPageIndex(reader), structure);
		this.refreshReadingChips(ctx.dir);
	},

	// Settings → Troubleshooting: every paper's map is built again on its next question,
	// asking Zotero again for labels and outline. The extracted text stays.
	async rebuildReadingMaps() {
		this._structures.clear();
		this._natives.clear();
		this._sdt.clear();
		let root = this.getDataDir();
		if (!(await OS.File.exists(root))) {
			return 0;
		}
		let count = 0;
		for (let folder of await this.listChildren(root)) {
			if (!folder.isDir) {
				continue;
			}
			for (let name of ["structure.json", "native.json"]) {
				let path = OS.Path.join(folder.path, "cache", name);
				if (await OS.File.exists(path)) {
					await OS.File.remove(path);
					count += name === "structure.json" ? 1 : 0;
				}
			}
		}
		return count;
	},
});
