"use strict";

Object.assign(Zusia, {
	// Keeps a conversation next to the current one (chat-<time>.json) so it can be reopened.
	// Returns the file's name, or null for an empty chat.
	async archiveHistory(dir, history) {
		if (!history.length) {
			return null;
		}
		let stamp = new Date(history[history.length - 1].ts || Date.now()).toISOString().replace(/[:.]/g, "-");
		let name = "chat-" + stamp + ".json";
		await Zotero.File.putContentsAsync(OS.Path.join(dir, name), JSON.stringify(history, null, 2));
		return name;
	},

	async listArchives(dir) {
		let names = [];
		if (typeof IOUtils !== "undefined") {
			names = (await IOUtils.getChildren(dir)).map(path => OS.Path.basename(path));
		}
		else {
			await Zotero.File.iterateDirectory(dir, (entry) => {
				names.push(entry.name);
			});
		}
		let archives = [];
		for (let name of names.filter(n => /^chat-.+\.json$/.test(n))) {
			let path = OS.Path.join(dir, name);
			try {
				let history = JSON.parse(await Zotero.File.getContentsAsync(path));
				let first = history.find(m => m.role === "user");
				let last = history[history.length - 1] || {};
				archives.push({
					path,
					title: first ? first.text.replace(/\s+/g, " ").trim() : "Empty chat",
					count: history.length,
					ts: last.ts || 0,
				});
			}
			catch (e) {
				this.log("Skipping unreadable archive " + name + ": " + e);
			}
		}
		return archives.sort((a, b) => b.ts - a.ts);
	},

	async newChat(root) {
		let view = this._views.get(root);
		if (!view || this._pending.has(view.ctx.dir)) {
			return;
		}
		let history = await this.loadHistory(view.ctx.dir);
		let archived = await this.archiveHistory(view.ctx.dir, history);
		await this.saveHistory(view.ctx.dir, []);
		await this.saveSessions(view.ctx.dir, {});
		await this.startMemoryEpoch(view.ctx.dir, history, archived);
		this.renderMessages(view, []);
		view.input.focus();
	},

	async restoreChat(root, archive) {
		let view = this._views.get(root);
		if (!view || this._pending.has(view.ctx.dir)) {
			return;
		}
		let restored = JSON.parse(await Zotero.File.getContentsAsync(archive.path));
		let replaced = await this.loadHistory(view.ctx.dir);
		let archived = await this.archiveHistory(view.ctx.dir, replaced);
		await this.saveHistory(view.ctx.dir, restored);
		// The agents' own sessions belong to the chat being replaced; the restored
		// chat is replayed to them as a transcript on its next question.
		await this.saveSessions(view.ctx.dir, {});
		// Whether the memory took in the restored chat before is not known, so it counts
		// as not covered: replayed (up to MEMORY_TRANSCRIPT_CHARS), and folded in again, so
		// a fold of it still owed is dropped.
		await this.startMemoryEpoch(view.ctx.dir, replaced, archived, { restored: OS.Path.basename(archive.path) });
		await OS.File.remove(archive.path);
		this.renderMessages(view, restored);
		this.setBusy(view, false);
	},

	formatWhen(ts) {
		if (!ts) {
			return "";
		}
		let date = new Date(ts);
		let sameDay = date.toDateString() === new Date().toDateString();
		return sameDay
			? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
			: date.toLocaleDateString([], { day: "numeric", month: "short" }) + ", " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	},

	// ---------------------------------------------------------------------
	// Conversation persistence
	// ---------------------------------------------------------------------

	// A damaged chat.json is moved aside by readJSON, so appendHistory starts a new one
	// next to it instead of writing over the only copy; a file that cannot be read at all
	// throws, and nothing is written.
	async loadHistory(dir) {
		return this.readJSON(OS.Path.join(dir, "chat.json"), []);
	},

	// Read and rewritten under the folder's lock, so two answers finishing together
	// (a NEED_PAGES follow-up, a retry) cannot drop each other's messages.
	async appendHistory(dir, messages) {
		await this.withDirLock(dir, async () => {
			let history = await this.loadHistory(dir);
			history.push(...messages);
			await this.writeAtomic(OS.Path.join(dir, "chat.json"), JSON.stringify(history, null, 2));
		});
	},

	async saveHistory(dir, history) {
		await this.withDirLock(dir, () => this.writeAtomic(OS.Path.join(dir, "chat.json"), JSON.stringify(history, null, 2)));
	},

	// A crash or a full disk mid-write leaves the old file whole: the text goes to a
	// temporary file first, and a move replaces the target in one step.
	async writeAtomic(path, text) {
		let tmp = path + ".tmp";
		await Zotero.File.putContentsAsync(tmp, text);
		await OS.File.move(tmp, path);
	},

	// Runs `fn` after every earlier write queued for `dir`, so chat.json, session.json,
	// progress.json and memory.json updates never interleave. A failed write rejects its
	// own caller only; the next one still runs.
	withDirLock(dir, fn) {
		let previous = this._dirQueue.get(dir) || Promise.resolve();
		let run = previous.then(() => fn(), () => fn());
		this._dirQueue.set(dir, run);
		let release = () => {
			if (this._dirQueue.get(dir) === run) {
				this._dirQueue.delete(dir);
			}
		};
		run.then(release, release);
		return run;
	},

	// Parsed JSON, or `fallback` when the file is missing. A damaged file is moved aside
	// rather than overwritten, so what it held can still be recovered by hand.
	async readJSON(path, fallback) {
		if (!(await OS.File.exists(path))) {
			return fallback;
		}
		let text = await Zotero.File.getContentsAsync(path);
		try {
			return JSON.parse(text);
		}
		catch (e) {
			if (!(e instanceof SyntaxError)) {
				throw e;
			}
			this.log("Damaged " + path + " (" + e.message + "), moved to " + path + ".damaged");
			await OS.File.move(path, path + ".damaged");
			return fallback;
		}
	},

	// session.json maps each backend to { id, seen }, where `seen` is how many
	// chat.json messages that session already knows about.
	async loadSessions(dir) {
		let path = OS.Path.join(dir, "session.json");
		try {
			if (!(await OS.File.exists(path))) {
				return {};
			}
			let data = JSON.parse(await Zotero.File.getContentsAsync(path));
			if (data.sessions) {
				return data.sessions;
			}
			// Files written before multi-backend support hold a single Claude session.
			if (data.sessionId) {
				let history = await this.loadHistory(dir);
				return { claude: { id: data.sessionId, seen: history.length } };
			}
			return {};
		}
		catch (e) {
			this.log("loadSessions failed: " + e);
			return {};
		}
	},

	async saveSessions(dir, sessions) {
		await this.withDirLock(dir, () => this.writeAtomic(OS.Path.join(dir, "session.json"), JSON.stringify({ sessions })));
	},
});
