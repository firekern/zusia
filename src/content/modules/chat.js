"use strict";

Object.assign(Zusia, {
	renderPaperTitle(root, info) {
		let paper = root.querySelector(".zs-header-paper");
		let title = info ? info.title || info.label : "";
		paper.textContent = title;
		paper.title = title;
	},

	renderPaperChip(root, info) {
		let holder = root.querySelector(".zs-context");
		if (!holder) {
			return;
		}
		holder.textContent = "";
		holder.hidden = !info;
		if (!info) {
			return;
		}
		let doc = root.ownerDocument;
		let chip = this.el(doc, "span", "zs-context-chip");
		chip.title = (info.title ? info.title + "\n" : "") +
			(this.getPref("fullText") === false
				? "Answers use the title, authors, abstract and your annotations, not the paper's full text"
				: "Answers use the paper's full text, its metadata and your annotations");
		chip.append(this.svgIcon(doc, "paper", "zs-context-icon"), this.el(doc, "span", "zs-context-label", info.label));
		if (info.reading) {
			chip.append(this.el(doc, "span", "zs-context-reading", info.reading));
			chip.title += "\nWhere you are and what you have read in this section, from the page shown in the reader";
		}
		// The chip opens the Memory sheet: what Zusia keeps about this paper.
		chip.title += "\nClick to see the reading map and what Zusia remembers";
		chip.setAttribute("role", "button");
		chip.tabIndex = 0;
		let open = () => this.openMemory(root).catch(e => this.logError("openMemory", e));
		chip.addEventListener("click", open);
		chip.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				open();
			}
		});
		holder.appendChild(chip);
		let status = this.memoryStatus(this._views.get(root)?.ctx.dir);
		if (status) {
			let line = this.el(doc, "span", "zs-memory-status", status);
			line.setAttribute("role", "status");
			holder.appendChild(line);
		}
	},

	// "Memory: updating" while a job for this paper runs, "Memory: paused" while a rate
	// limit holds one back; nothing otherwise.
	memoryStatus(dir) {
		if (!dir) {
			return "";
		}
		if (this._job && this._job.dir === dir) {
			return "Memory: updating";
		}
		if (this._jobBackoff.until > Date.now() && this._jobs.some(job => job.dir === dir)) {
			return "Memory: paused (rate limit)";
		}
		return "";
	},

	// "Read fulltext.md · searched twice · thought for 8s", from the recorded steps.
	summarizeActivity(activity) {
		let steps = (activity && activity.steps) || [];
		let parts = [];
		let reads = steps.filter(s => s.kind === "read");
		let searches = steps.filter(s => s.kind === "search");
		let other = steps.filter(s => s.kind !== "read" && s.kind !== "search");
		if (reads.length) {
			let files = [...new Set(reads.map(s => s.target).filter(Boolean))];
			parts.push(files.length === 1 ? "read " + files[0] : "read " + (files.length || reads.length) + " files");
		}
		if (searches.length) {
			parts.push(searches.length === 1 ? "searched once" : searches.length === 2 ? "searched twice" : "searched " + searches.length + " times");
		}
		if (other.length) {
			parts.push(other.length === 1 ? other[0].label.toLowerCase() : other.length + " other steps");
		}
		let seconds = Math.round(((activity && activity.thoughtMs) || 0) / 1000);
		if (seconds >= 1) {
			parts.push("thought for " + seconds + "s");
		}
		let text = parts.join(" · ");
		return text ? text[0].toUpperCase() + text.slice(1) : "";
	},

	renderStepRow(doc, step) {
		let row = this.el(doc, "div", "zs-step");
		let icon = { read: "paper", search: "search", thought: "thought" }[step.kind] || "terminal";
		row.appendChild(this.svgIcon(doc, icon, "zs-step-icon"));
		let label = this.el(doc, "span", "zs-step-label", step.label);
		label.title = step.label;
		row.appendChild(label);
		return row;
	},

	// Beaver's tool/thinking parts: one muted line that expands to the individual steps.
	renderActivity(doc, activity) {
		let summary = this.summarizeActivity(activity);
		if (!summary) {
			return null;
		}
		let box = this.el(doc, "div", "zs-activity");
		let head = this.el(doc, "button", "zs-activity-head");
		head.type = "button";
		head.setAttribute("aria-expanded", "false");
		head.append(this.svgIcon(doc, "chevronRight", "zs-activity-chevron"), this.el(doc, "span", "zs-activity-summary", summary));
		let list = this.el(doc, "div", "zs-activity-list");
		list.hidden = true;
		for (let step of activity.steps || []) {
			list.appendChild(this.renderStepRow(doc, step));
		}
		if (activity.thoughtMs >= 1000) {
			list.appendChild(this.renderStepRow(doc, { kind: "thought", label: "Thought for " + Math.round(activity.thoughtMs / 1000) + "s" }));
		}
		head.addEventListener("click", () => {
			list.hidden = !list.hidden;
			head.setAttribute("aria-expanded", String(!list.hidden));
			box.classList.toggle("zs-open", !list.hidden);
		});
		box.append(head, list);
		return box;
	},

	appendAssistant(view, msg, options = {}) {
		let turn = this.el(view.doc, "div", "zs-turn");
		let activity = msg.activity ? this.renderActivity(view.doc, msg.activity) : null;
		if (activity) {
			turn.appendChild(activity);
		}
		let bubble = this.el(view.doc, "div", "zs-msg zs-assistant");
		this.renderRich(view.doc, bubble, msg.text);
		if (msg.stopped) {
			bubble.appendChild(this.el(view.doc, "div", "zs-stopped", "Stopped"));
		}
		turn.appendChild(bubble);
		if (options.footer) {
			turn.appendChild(this.renderFooter(view, msg, options));
		}
		view.logEl.appendChild(turn);
		this.scrollToEnd(view.logEl);
		return turn;
	},

	// Beaver's answer footer: a text action on the left, quiet icon actions on the right.
	renderFooter(view, msg, { byline, question, isLast, index }) {
		let { doc } = view;
		let footer = this.el(doc, "div", "zs-footer");

		let explain = this.ghostButton(doc, "zs-explain", "sparkle", "Explain better", () => {
			let prompt = this.getExplainPrompt();
			if (!isLast) {
				let excerpt = msg.text.replace(/\s+/g, " ").slice(0, 300);
				prompt = "About your earlier answer that begins \"" + excerpt + "…\": " + prompt;
			}
			view.send(prompt);
		});
		explain.title = "Ask for a clearer, step-by-step explanation";
		footer.append(explain, this.el(doc, "span", "zs-spacer"));

		if (byline) {
			footer.appendChild(this.el(doc, "span", "zs-by", byline));
		}
		if (isLast && question) {
			footer.appendChild(this.iconButton(doc, "zs-small zs-retry", "Retry", "retry", () => this.retry(view, index)));
		}
		let copy = this.iconButton(doc, "zs-small zs-copy", "Copy", "copy", () => {
			Zotero.Utilities.Internal.copyTextToClipboard(msg.text);
			copy.title = "Copied";
			doc.defaultView.setTimeout(() => {
				copy.title = "Copy";
			}, 1500);
		});
		footer.appendChild(copy);

		let more = this.iconButton(doc, "zs-small zs-more", "More actions", "more", () => {
			let root = view.root;
			this.openMenu(root, more, (menu) => {
				this.menuItem(doc, menu, {
					label: "Save as note",
					desc: "Child note on this paper, maths kept",
					onSelect: async () => {
						this.closeMenu(root);
						try {
							await this.saveAsNote(view.ctx, question, msg.text);
							more.title = "Saved as note";
						}
						catch (e) {
							this.logError("saveAsNote", e);
							this.appendError(view, "Could not save the note: " + (e.message || e));
						}
					},
				});
				this.menuItem(doc, menu, {
					label: "Copy",
					desc: "Markdown with LaTeX",
					onSelect: () => {
						Zotero.Utilities.Internal.copyTextToClipboard(msg.text);
						this.closeMenu(root);
					},
				});
			}, { placement: "above", align: "end" });
		});
		more.setAttribute("aria-haspopup", "menu");
		more.setAttribute("aria-expanded", "false");
		footer.appendChild(more);
		return footer;
	},

	renderEmptyState(view) {
		let { doc } = view;
		let empty = this.el(doc, "div", "zs-empty");
		let mascot = this.MASCOTS[this.getAppearance().mascot];
		if (mascot.icon) {
			empty.appendChild(this.svgIcon(doc, mascot.icon, "zs-mascot"));
		}
		empty.appendChild(this.el(doc, "div", "zs-empty-title", "Ask about this paper"));
		let title = view.ctx && view.ctx.paperItem ? this.safeField(view.ctx.paperItem, "title") : "";
		if (title) {
			empty.appendChild(this.el(doc, "div", "zs-empty-paper", title));
		}
		empty.appendChild(this.el(doc, "div", "zs-empty-sub",
			"Answers use the paper's details and your highlights. Select text in the PDF to ask about it, or turn on Drawing and LaTeX below."));
		view.logEl.appendChild(empty);
	},

	describeRun(msg) {
		let backend = this.BACKENDS[msg.backend || "claude"];
		if (!backend) {
			return msg.backend || "";
		}
		let parts = [backend.label];
		if (msg.model) {
			parts.push(this.modelLabel(msg.backend || "claude", msg.model));
		}
		return parts.join(" · ");
	},

	renderMessages(view, history) {
		view.logEl.textContent = "";
		view.backStack = [];
		this.updateBack(view);
		view.root.dataset.chatting = String(history.length > 0);
		let quick = view.root.querySelector(".zs-quick");
		if (quick) {
			this.markOverflow(quick);
		}
		if (!history.length) {
			this.renderEmptyState(view);
			return;
		}
		// Only label answers once more than one assistant or model took part.
		let runs = new Set(history.filter(m => m.role === "assistant").map(m => this.describeRun(m)));
		let labelled = runs.size > 1;
		let lastAssistant = history.map(m => m.role).lastIndexOf("assistant");
		history.forEach((msg, index) => {
			if (msg.role === "user") {
				this.appendUser(view, msg.text, this.imagePaths(view.ctx.dir, msg), msg.modes || []);
				return;
			}
			let turn = this.appendAssistant(view, msg, {
				footer: true,
				index,
				isLast: index === lastAssistant,
				question: index > 0 && history[index - 1].role === "user" ? history[index - 1].text : "",
				byline: labelled ? this.describeRun(msg) : null,
			});
			turn.classList.toggle("zs-last", index === lastAssistant);
		});
		this.linkTheorems(view.logEl);
		this.fitWideContent(view.logEl);
	},

	// A formula slightly wider than the pane is shrunk to fit (not below 72%);
	// anything still too wide, formulas or tables, scrolls behind a soft edge fade
	// instead of showing a permanent scrollbar.
	fitWideContent(container) {
		for (let scroller of container.querySelectorAll(".zs-math-scroll")) {
			scroller.style.fontSize = "";
			// Glyph spacing does not scale exactly, so re-measure a few times.
			let scale = 1;
			for (let pass = 0; pass < 4 && scale > 0.72; pass++) {
				let natural = scroller.scrollWidth;
				let available = scroller.clientWidth;
				if (!available || natural <= available + 1) {
					break;
				}
				scale = Math.max(0.72, Math.floor(scale * (available / natural) * 100 - 1) / 100);
				scroller.style.fontSize = Math.round(scale * 100) + "%";
			}
			this.markOverflow(scroller);
		}
		for (let wrap of container.querySelectorAll(".zs-table-wrap")) {
			this.markOverflow(wrap);
		}
	},

	markOverflow(scroller) {
		let update = () => {
			let overflow = scroller.scrollWidth > scroller.clientWidth + 1;
			scroller.classList.toggle("zs-overflow", overflow);
			scroller.classList.toggle("zs-at-start", scroller.scrollLeft <= 1);
			scroller.classList.toggle("zs-at-end", scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1);
		};
		if (!scroller._csOverflowWatched) {
			scroller._csOverflowWatched = true;
			scroller.addEventListener("scroll", update, { passive: true });
		}
		update();
	},

	setBusy(view, busy) {
		let { root } = view;
		let send = root.querySelector(".zs-send");
		if (send) {
			send.classList.toggle("zs-stop", busy);
			send.replaceChildren(this.svgIcon(view.doc, busy ? "stop" : "send"));
			send.title = busy ? "Stop" : "Send (" + this.sendKeyLabel() + ")";
			send.setAttribute("aria-label", send.title);
			send.disabled = !busy && !this.canSend(view);
		}
		view.input.disabled = false;
		root.querySelectorAll(".zs-pill, .zs-explain, .zs-retry, .zs-new-chat").forEach((button) => {
			button.disabled = busy;
		});
	},

	autoGrow(input) {
		input.style.height = "auto";
		input.style.height = Math.min(input.scrollHeight, 180) + "px";
	},

	sendOrStop(root) {
		let view = this._views.get(root);
		if (!view) {
			return;
		}
		let pending = this._pending.get(view.ctx.dir);
		if (pending) {
			pending.cancel();
		}
		else {
			view.send(view.input.value, this.stagedPaths(view));
		}
	},

	async renderContent(doc, body, item) {
		let root = body.querySelector(".zs-root");
		let logEl = body.querySelector(".zs-log");
		let input = body.querySelector(".zs-input");
		if (!logEl) {
			return;
		}

		let notice = (text) => {
			logEl.textContent = "";
			logEl.appendChild(this.el(doc, "div", "zs-notice", text));
		};

		if (!item) {
			notice("Select a paper to start.");
			return;
		}

		let ctx;
		try {
			ctx = await this.getContext(item);
		}
		catch (e) {
			this.logError("getContext", e);
			notice("Could not read this item: " + (e.message || e));
			return;
		}
		if (!ctx) {
			notice("Select a paper or a PDF to ask about it.");
			return;
		}

		let view = { doc, root, logEl, input, ctx, send: null };
		view.send = (text, images) => this.sendText(view, text, images);

		let history = await this.loadHistory(ctx.dir);
		if (!logEl.isConnected) {
			return;
		}
		// Each render builds a new .zs-root, so the paper shown last is kept per section body.
		let previous = this._shownDirs.get(body);
		if (previous && previous !== ctx.dir) {
			this.leavePaper(previous);
		}
		if (previous !== ctx.dir) {
			this.resumeMemory(ctx.dir).catch(e => this.logError("resuming memory consolidation", e));
		}
		this._shownDirs.set(body, ctx.dir);
		this._views.set(root, view);
		let info = this.paperInfo(ctx);
		view.info = info;
		this.renderPaperChip(root, info);
		this.renderPaperTitle(root, info);
		this.renderAttachments(view);
		this.renderMessages(view, history);
		this.applyJump(view);
		this.updateReading(view).catch(e => this.logError("updateReading", e));

		input.addEventListener("input", () => {
			this.autoGrow(input);
			if (!this._pending.has(ctx.dir)) {
				root.querySelector(".zs-send").disabled = !this.canSend(view);
			}
		});
		// A pasted or dropped image is added to the message.
		input.addEventListener("paste", event => this.onPasteOrDrop(view, event, event.clipboardData));
		let composer = root.querySelector(".zs-composer");
		composer.addEventListener("dragover", (event) => {
			if ([...(event.dataTransfer?.types || [])].includes("Files")) {
				event.preventDefault();
				composer.classList.add("zs-drop");
			}
		});
		composer.addEventListener("dragleave", (event) => {
			if (!composer.contains(event.relatedTarget)) {
				composer.classList.remove("zs-drop");
			}
		});
		composer.addEventListener("drop", (event) => {
			composer.classList.remove("zs-drop");
			this.onPasteOrDrop(view, event, event.dataTransfer);
		});
		input.addEventListener("keydown", (event) => {
			if (this.isSendKey(event)) {
				event.preventDefault();
				if (!this._pending.has(ctx.dir)) {
					view.send(input.value, this.stagedPaths(view));
				}
			}
			else if (event.key === "Escape" && this._pending.has(ctx.dir)) {
				event.preventDefault();
				this._pending.get(ctx.dir).cancel();
			}
			else if (event.key === "ArrowUp" && !input.value) {
				// Recall the last question, as chat apps do.
				let last = [...logEl.querySelectorAll(".zs-user")].pop();
				if (last && (last.dataset.text || last.images.length)) {
					event.preventDefault();
					this.editPrompt(view, last.dataset.text, last.images);
				}
			}
		});

		let pending = this._pending.get(ctx.dir);
		if (pending) {
			// A request started before this re-render is still running: reattach to it.
			await this.showPending(view, pending);
		}
		else {
			this.setBusy(view, false);
			this.applyDraft(view);
		}
	},

	startRequest(view, text, images = [], modes = this.activeModes(), { selection = null } = {}) {
		let question = (text || "").trim();
		if ((!question && !images.length) || this._pending.has(view.ctx.dir)) {
			return;
		}
		if (view.input.value.trim() === question) {
			view.input.value = "";
			this.autoGrow(view.input);
		}
		if (images.length) {
			this._staged.delete(view.ctx.dir);
			this.renderAttachments(view);
		}

		let backend = this.getBackend();
		let pending = {
			question,
			images,
			modes,
			selection,
			backend,
			model: this.getModel(backend),
			effort: this.getEffort(backend),
			startedAt: Date.now(),
			partial: "",
			status: "",
			cancelled: false,
			proc: null,
			listeners: new Set(),
		};
		pending.steps = [];
		pending.thoughtMs = 0;
		pending.thinking = false;
		pending.progress = ({ text, status, step, thinking, thoughtMs }) => {
			if (text !== undefined) {
				pending.partial = text;
			}
			if (status !== undefined) {
				pending.status = status;
			}
			if (step) {
				pending.steps.push(step);
			}
			if (thinking !== undefined) {
				pending.thinking = thinking;
			}
			if (thoughtMs) {
				pending.thoughtMs += thoughtMs;
			}
			for (let listener of pending.listeners) {
				listener();
			}
		};
		pending.cancel = () => {
			pending.cancelled = true;
			pending.status = "stopping";
			try {
				pending.proc?.kill();
			}
			catch (e) {
				this.log("kill failed: " + e);
			}
			pending.progress({});
		};
		pending.promise = this.ask(view.ctx, question, pending);
		this._pending.set(view.ctx.dir, pending);
		this.showPending(view, pending);
	},

	// A memory command returns the promise of its update, so its outcome can be awaited.
	sendText(view, text, images = []) {
		let command = images.length ? null : this.memoryCommand(text);
		if (command) {
			view.input.value = "";
			this.autoGrow(view.input);
			view.root.querySelector(".zs-send").disabled = true;
			return this.runMemoryCommand(view, command).catch((e) => {
				this.logError("memory command", e);
				this.appendError(view, String((e && e.message) || e), { title: "Could not update the notes for this paper" });
			});
		}
		let draft = view.draftSelection;
		view.draftSelection = null;
		let quoteLine = draft && draft.quote.split("\n").find(line => line.startsWith("> "));
		let extra = draft && quoteLine && String(text).includes(quoteLine) ? { selection: draft.selection } : {};
		this.startRequest(view, text, images, undefined, extra);
	},
});
