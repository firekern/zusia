"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Search across the chats of every paper
	// ---------------------------------------------------------------------

	async listChildren(dir) {
		let entries = [];
		await Zotero.File.iterateDirectory(dir, (entry) => {
			entries.push({ name: entry.name, path: entry.path, isDir: !!entry.isDir });
		});
		return entries;
	},

	// Every saved conversation: { dir, libraryID, key, path, current, history }.
	async loadAllChats() {
		let chats = [];
		let root = this.getDataDir();
		if (!(await OS.File.exists(root))) {
			return chats;
		}
		for (let folder of await this.listChildren(root)) {
			let match = folder.isDir && folder.name.match(/^(\d+)-([A-Z0-9]{8})$/);
			if (!match) {
				continue;
			}
			// cache/ and text/ hold the reading map and the book's text, never a chat.
			for (let file of await this.listChildren(folder.path)) {
				if (file.isDir || !/^chat(-.+)?\.json$/.test(file.name)) {
					continue;
				}
				try {
					let history = JSON.parse(await Zotero.File.getContentsAsync(file.path));
					if (Array.isArray(history) && history.length) {
						chats.push({
							dir: folder.path, libraryID: Number(match[1]), key: match[2],
							path: file.path, current: file.name === "chat.json", history,
						});
					}
				}
				catch (e) {
					this.log("search: skipping " + file.path + ": " + e);
				}
			}
		}
		return chats;
	},

	// Messages containing every word of the query, newest first, with a snippet around the first word.
	searchChats(chats, query, limit = 40) {
		let words = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (!words.length) {
			return [];
		}
		let results = [];
		for (let chat of chats) {
			chat.history.forEach((msg, index) => {
				let text = String(msg.text || "");
				let lower = text.toLowerCase();
				if (!words.every(word => lower.includes(word))) {
					return;
				}
				let at = lower.indexOf(words[0]);
				let start = Math.max(0, at - 50);
				let snippet = (start ? "…" : "") + text.slice(start, at + 110).replace(/\s+/g, " ").trim() +
					(at + 110 < text.length ? "…" : "");
				results.push({ chat, index, role: msg.role, snippet, ts: msg.ts || 0 });
			});
		}
		return results.sort((a, b) => b.ts - a.ts).slice(0, limit);
	},

	chatTitle(chat) {
		try {
			let item = Zotero.Items.getByLibraryAndKey(chat.libraryID, chat.key);
			return (item && this.safeField(item, "title")) || "Deleted item";
		}
		catch (e) {
			return "Unknown item";
		}
	},

	// `anchor` is the button the menu hangs from: the header's own, or the More menu's
	// button in the layout that hides it.
	openSearchMenu(root, anchor = root.querySelector(".zs-search")) {
		if (!anchor) {
			return;
		}
		let doc = root.ownerDocument;
		let win = doc.defaultView;
		let chats = null;
		let results = [];
		let timer = null;
		let input = doc.createElement("input");
		input.type = "search";
		input.className = "zs-search-input";
		input.placeholder = "Search the chats of all papers…";
		let list = this.el(doc, "div", "zs-search-results");
		let draw = () => {
			list.textContent = "";
			if (chats === null) {
				list.appendChild(this.el(doc, "div", "zs-menu-note", "Loading chats…"));
				return;
			}
			if (!input.value.trim()) {
				list.appendChild(this.el(doc, "div", "zs-menu-note",
					"Searches " + chats.length + " saved chat" + (chats.length === 1 ? "" : "s") + ", current and previous."));
				return;
			}
			if (!results.length) {
				list.appendChild(this.el(doc, "div", "zs-menu-note", "No messages match."));
				return;
			}
			for (let result of results) {
				this.menuItem(doc, list, {
					label: this.chatTitle(result.chat),
					desc: (result.role === "user" ? "You: " : "Answer: ") + result.snippet +
						(result.ts ? " · " + this.formatWhen(result.ts) : ""),
					onSelect: () => {
						this.closeMenu(root);
						this.openSearchResult(root, result).catch(e => this.logError("openSearchResult", e));
					},
				});
			}
		};
		input.addEventListener("input", () => {
			win.clearTimeout(timer);
			timer = win.setTimeout(() => {
				results = chats ? this.searchChats(chats, input.value) : [];
				draw();
			}, 120);
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				list.querySelector(".zs-menu-item")?.focus();
			}
		});
		let menu = this.openMenu(root, anchor, (menu) => {
			menu.classList.add("zs-search-menu");
			menu.append(input, list);
			draw();
		}, { placement: "below", align: "end" });
		if (!menu) {
			return;
		}
		win.setTimeout(() => input.focus(), 0);
		this.loadAllChats()
			.catch((e) => {
				this.logError("loadAllChats", e);
				return [];
			})
			.then((loaded) => {
				chats = loaded;
				results = this.searchChats(chats, input.value);
				if (menu.isConnected) {
					draw();
				}
			});
	},

	// Opens the paper the message belongs to (restoring an earlier chat if needed)
	// and scrolls to the message.
	async openSearchResult(root, result) {
		let { chat, index } = result;
		if (!chat.current) {
			if (this._pending.has(chat.dir)) {
				return;
			}
			await this.archiveHistory(chat.dir, await this.loadHistory(chat.dir));
			await this.saveHistory(chat.dir, chat.history);
			await this.saveSessions(chat.dir, {});
			await OS.File.remove(chat.path);
		}
		this._jump = { dir: chat.dir, index };
		let view = this._views.get(root);
		if (view && view.ctx.dir === chat.dir) {
			this.renderMessages(view, await this.loadHistory(chat.dir));
			this.applyJump(view);
			return;
		}
		let item = Zotero.Items.getByLibraryAndKey(chat.libraryID, chat.key);
		if (!item) {
			return;
		}
		let win = Zotero.getMainWindow();
		win.Zotero_Tabs?.select("zotero-pane");
		await win.ZoteroPane.selectItem(item.id);
		// Once the item pane has rendered the paper's section.
		win.setTimeout(() => this.revealChat(win), 300);
	},

	applyJump(view) {
		let jump = this._jump;
		if (!jump || jump.dir !== view.ctx.dir) {
			return;
		}
		this._jump = null;
		let target = [...view.logEl.children].filter(n => n.matches(".zs-user, .zs-turn"))[jump.index];
		if (target) {
			target.scrollIntoView({ block: "center" });
			target.classList.add("zs-flash");
			view.doc.defaultView.setTimeout(() => target.classList.remove("zs-flash"), 1800);
		}
	},

	openHistoryMenu(root, anchor = root.querySelector(".zs-history")) {
		let view = this._views.get(root);
		if (!view || !anchor) {
			return;
		}
		let doc = root.ownerDocument;
		let archives = null;
		let menu = this.openMenu(root, anchor, (menu) => {
			menu.classList.add("zs-history-menu");
			this.menuSection(doc, menu, "Previous chats");
			if (archives === null) {
				menu.appendChild(this.el(doc, "div", "zs-menu-note", "Loading…"));
				return;
			}
			if (!archives.length) {
				menu.appendChild(this.el(doc, "div", "zs-menu-note",
					"No earlier chats for this paper yet. Starting a new chat keeps the current one here."));
				return;
			}
			for (let archive of archives) {
				this.menuItem(doc, menu, {
					label: archive.title,
					desc: archive.count + " messages · " + this.formatWhen(archive.ts),
					disabled: this._pending.has(view.ctx.dir),
					onSelect: () => {
						this.closeMenu(root);
						this.restoreChat(root, archive).catch(e => this.logError("restoreChat", e));
					},
				});
			}
		}, { placement: "below", align: "end" });
		if (menu) {
			this.listArchives(view.ctx.dir)
				.catch((e) => {
					this.logError("listArchives", e);
					return [];
				})
				.then((list) => {
					archives = list;
					if (menu.isConnected) {
						menu.refresh();
					}
				});
		}
	},
});
