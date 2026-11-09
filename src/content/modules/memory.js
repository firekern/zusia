"use strict";

Object.assign(Zusia, {
	// --------------------------------------------------------------- memory

	memoryPath(dir) {
		return OS.Path.join(dir, "memory.json");
	},

	// `coveredThrough` is the index in chat.json of the last message folded into the memory,
	// and `epoch` counts the chats (New chat, a restored chat), so a consolidation of the
	// chat before never moves the new one's `coveredThrough`.
	// `pendingArchives` ([{file, from}]) are put-away chats not yet folded in, from chat
	// index `from` on, kept on disk so a quit or a long rate-limit pause loses none, and
	// `generation` counts resets, so a patch computed before one is dropped.
	async loadMemory(dir) {
		return Object.assign(ZusiaMap.emptyMemory(), { turns: [], coveredThrough: -1, epoch: 0, pendingArchives: [], generation: 0 },
			await this.readJSON(this.memoryPath(dir), null));
	},

	// `change` gets the stored memory and returns the next one; read and write happen under
	// the folder's lock, so a note typed while an answer is recorded is not lost.
	updateMemory(dir, change) {
		return this.withDirLock(dir, async () => {
			let next = change(await this.loadMemory(dir));
			await this.writeAtomic(this.memoryPath(dir), JSON.stringify(next, null, 1));
			return next;
		});
	},

	// Where each question was asked and what it cited, the raw log phase two summarises.
	recordTurn(dir, turn) {
		return this.updateMemory(dir, memory => Object.assign({}, memory, { turns: [...memory.turns, turn].slice(-this.MEMORY_TURNS) }));
	},

	// "/remember <text>", "ricorda: <text>" and "/forget <n>" are notes for the memory, not
	// questions: handled before anything is sent.
	memoryCommand(text) {
		let t = String(text || "").trim();
		let m;
		if ((m = /^\/remember(?:\s+([\s\S]*))?$/i.exec(t))) {
			return { kind: "remember", text: (m[1] || "").trim() };
		}
		if ((m = /^ricorda\s*:\s*([\s\S]*)$/i.exec(t))) {
			return { kind: "remember", text: m[1].trim() };
		}
		if ((m = /^\/forget(?:\s+#?m?(\d+))?\s*$/i.exec(t))) {
			return { kind: "forget", id: m[1] ? "m" + m[1] : null };
		}
		return null;
	},

	async runMemoryCommand(view, command) {
		let dir = view.ctx.dir;
		let number = id => id.replace(/^m/, "");
		if (command.kind === "forget") {
			let removed = null;
			if (command.id) {
				await this.updateMemory(dir, (memory) => {
					removed = memory.items.find(item => item.id === command.id) || null;
					return ZusiaMap.applyMemoryPatch(memory, { remove: removed ? [command.id] : [] }).memory;
				});
			}
			this.appendMemo(view, removed
				? "Forgot note " + number(removed.id) + ": " + removed.text
				: "There is no note " + (command.id ? number(command.id) : "with that number") + ". Type /remember alone to list them.");
			return;
		}
		let structure = await this.cachedStructure(dir);
		if (!command.text) {
			let notes = (await this.loadMemory(dir)).items.filter(item => item.kind === "note");
			this.appendMemo(view, notes.length
				? "Notes for this paper: " + notes.map(item => number(item.id) + ". " + item.text).join(" · ") + ". /forget <number> drops one."
				: "No notes yet. Type /remember and what to keep, and it goes with every question about this paper.");
			return;
		}
		let reader = this.readerFor(view.ctx, Zotero.getMainWindow());
		let page = this.readerPageIndex(reader);
		let rejected = [];
		let memory = await this.updateMemory(dir, (current) => {
			let result = ZusiaMap.applyMemoryPatch(current,
				{ add: [Object.assign({ kind: "note", text: command.text }, Number.isInteger(page) ? { page: page + 1 } : {})] },
				{ pageCount: structure ? structure.pageCount : Infinity, now: Date.now() });
			rejected = result.rejected;
			return result.memory;
		});
		if (rejected.length) {
			this.appendMemo(view, "Not noted: " + rejected[0].reason + ".");
			return;
		}
		let item = memory.items[memory.items.length - 1];
		this.appendMemo(view, "Noted (" + number(item.id) + "): " + item.text +
			(item.page ? ", " + ZusiaMap.pageName(item.page - 1, structure) : "") +
			". It goes with every question about this paper; /forget " + number(item.id) + " drops it.");
	},

	// A line in the chat that is not a message: never stored, never sent.
	appendMemo(view, text) {
		view.logEl.querySelector(".zs-empty")?.remove();
		let memo = this.el(view.doc, "div", "zs-memo", text);
		memo.setAttribute("role", "status");
		view.logEl.appendChild(memo);
		this.scrollToEnd(view.logEl);
	},
});
