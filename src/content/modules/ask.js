"use strict";

Object.assign(Zusia, {
	// Replaces the last answer: drop it and its question, then ask again.
	async retry(view, index) {
		if (this._pending.has(view.ctx.dir)) {
			return;
		}
		let history = await this.loadHistory(view.ctx.dir);
		let asked = history[index - 1] && history[index - 1].role === "user" ? history[index - 1] : null;
		if (!asked) {
			return;
		}
		let question = asked.text;
		let images = this.imagePaths(view.ctx.dir, asked);
		let kept = history.slice(0, index - 1);
		await this.saveHistory(view.ctx.dir, kept);
		let sessions = await this.loadSessions(view.ctx.dir);
		for (let session of Object.values(sessions)) {
			session.seen = Math.min(session.seen || 0, kept.length);
		}
		await this.saveSessions(view.ctx.dir, sessions);
		this.renderMessages(view, kept);
		this.startRequest(view, question, images, asked.modes || []);
	},

	async showPending(view, pending) {
		let { doc, logEl } = view;
		let win = doc.defaultView;
		let label = this.BACKENDS[pending.backend].label;

		logEl.querySelector(".zs-empty")?.remove();
		view.root.dataset.chatting = "true";
		logEl.querySelectorAll(".zs-turn.zs-last").forEach(turn => turn.classList.remove("zs-last"));
		this.appendUser(view, pending.question, pending.images, pending.modes);

		// zs-live marks the answer still being written, for the layouts that show it (Visual's buddy).
		let turn = this.el(doc, "div", "zs-turn zs-live");
		let live = this.el(doc, "div", "zs-msg zs-assistant");
		// zs-rich as on a finished answer: its blocks are styled under that class.
		let content = this.el(doc, "div", "zs-live-content zs-rich");
		let typing = this.el(doc, "div", "zs-typing");
		typing.setAttribute("aria-busy", "true");
		let spinner = this.el(doc, "span", "zs-spinner");
		let elapsed = this.el(doc, "span", "zs-elapsed zs-shimmer");
		let seconds = this.el(doc, "span", "zs-seconds");
		typing.append(spinner, elapsed, seconds);
		let steps = this.el(doc, "div", "zs-live-steps");
		live.append(steps, content, typing);
		turn.appendChild(live);
		logEl.appendChild(turn);
		this.scrollToEnd(logEl);
		this.setBusy(view, true);

		let renderedText = null;
		let renderTimer = null;
		let tick = () => {
			let what = pending.status || (pending.partial ? "writing" : "thinking");
			let secs = Math.round((Date.now() - pending.startedAt) / 1000);
			elapsed.textContent = label + " is " + what;
			seconds.textContent = secs >= 8 ? secs + "s" : "";
		};
		let renderPartial = () => {
			renderTimer = null;
			if (!live.isConnected || pending.partial === renderedText) {
				return;
			}
			// Keep following the answer only if the user has not scrolled up to read.
			let atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
			renderedText = pending.partial;
			let next = this.el(doc, "div");
			if (pending.partial) {
				this.renderRich(doc, next, this.withoutIncompleteMath(pending.partial));
			}
			this.patchChildren(content, next);
			this.linkTheorems(logEl);
			if (atBottom && this.getBehaviour().autoScroll) {
				this.scrollToEnd(logEl);
			}
			this.updateJump(view.root);
			this.fitWideContent(content);
		};
		let renderedSteps = 0;
		let renderSteps = () => {
			let list = pending.steps || [];
			while (renderedSteps < list.length) {
				steps.appendChild(this.renderStepRow(doc, list[renderedSteps++]));
			}
			steps.classList.toggle("zs-thinking", !!pending.thinking && !pending.partial);
		};
		let listener = () => {
			tick();
			renderSteps();
			if (!renderTimer) {
				renderTimer = win.setTimeout(renderPartial, 150);
			}
		};
		pending.listeners.add(listener);
		tick();
		renderSteps();
		renderPartial();
		let timer = win.setInterval(tick, 1000);

		let result;
		try {
			result = await pending.promise;
		}
		finally {
			win.clearInterval(timer);
			if (renderTimer) {
				win.clearTimeout(renderTimer);
			}
			pending.listeners.delete(listener);
		}

		if (!logEl.isConnected) {
			// The pane re-rendered meanwhile; the new view shows the saved answer.
			return;
		}

		let history = await this.loadHistory(view.ctx.dir);
		this.renderMessages(view, history);
		if (result.cancelled && !view.input.value.trim()) {
			// Nothing was answered: give the question back so it can be edited and resent.
			this.editPrompt(view, pending.question, pending.images);
		}
		if (result.error) {
			logEl.querySelector(".zs-empty")?.remove();
			this.appendUser(view, pending.question, pending.images, pending.modes);
			this.appendError(view, result.error, {
				title: label + " could not answer",
				retry: () => {
					logEl.querySelectorAll(".zs-error").forEach(n => n.remove());
					this.renderMessages(view, history);
					this.startRequest(view, pending.question, pending.images, pending.modes);
				},
			});
		}
		this.setBusy(view, false);
		view.input.focus();
	},

	async ask(ctx, question, pending) {
		let { backend } = pending;
		let label = this.BACKENDS[backend].label;
		try {
			pending.progress({ status: "reading the paper" });
			let win = Zotero.getMainWindow();
			let reader = this.readerFor(ctx, win);
			let currentPage = this.readerPageIndex(reader);
			let selection = pending.selection;
			let selectedPage = selection && selection.position ? selection.position.pageIndex : null;
			let files = await this.exportContext(this.withOpenAttachment(ctx, reader),
				{ focus: [selectedPage, currentPage].filter(Number.isInteger), reader });
			files.selectedPage = Number.isInteger(selectedPage) ? selectedPage : null;
			// A reader in a background tab still steers which pages are kept, but the user is not looking at it.
			let onScreen = reader && (!reader.tabID || reader.tabID === win?.Zotero_Tabs?.selectedID);
			files.currentPage = onScreen ? currentPage : null;
			files.query = question || "";
			files.selectionText = selection ? selection.text || "" : "";
			if (Number.isInteger(selectedPage) && selection.pageLabel) {
				await this.recordAnchor(ctx.dir, selectedPage, selection.pageLabel);
			}
			if (files.structure && Number.isInteger(files.currentPage)) {
				await this.recordPage(ctx.dir, files.currentPage, files.structure);
			}
			// With tracking off, a position stored earlier is not sent either.
			files.progress = this.trackingReading() ? await this.loadProgress(ctx.dir) : null;
			files.memory = await this.loadMemory(ctx.dir);
			files.gists = this.gisting() ? await this.loadGists(ctx.dir) : null;
			if (files.gists && files.structure && this.isPaged(files)) {
				this.queueMissingGists(ctx.dir, files.structure, files.fullText.pages, files.progress, files.gists);
			}
			let history = await this.loadHistory(ctx.dir);
			let sessions = await this.loadSessions(ctx.dir);
			let session = sessions[backend] || null;
			// An edited prompt, style or language starts a new session and the chat so far is
			// replayed into it: Codex and Antigravity never see the edit otherwise, and a resumed
			// Claude chat keeps answering in the old voice although it gets the new prompt.
			let promptHash = this.promptHash(backend);
			if (session && (session.prompt !== this.PROMPT_VERSION || session.promptHash !== promptHash)) {
				session = null;
			}
			// Every page an Antigravity conversation was sent stays in it; a long one starts
			// afresh, and the reading memory carries what matters across.
			if (session && session.paper && session.paper.chars > this.AGY_SESSION_CHARS) {
				this.log(label + ": the conversation holds " + session.paper.chars + " characters of pages, starting a new one");
				session = null;
			}

			let images = pending.images || [];
			if (images.length && !this.BACKENDS[backend].images) {
				return { error: label + " cannot see images from the sidebar. Switch to Claude or Codex, or remove the image and ask again." };
			}
			let request = {
				ctx, files, history, session, images,
				question: (question || "Look at the attached image.") + this.imageNote(backend, images) +
					this.modeInstructions(pending.modes),
				model: pending.model,
				effort: pending.effort,
				// Antigravity may open with a NEED_PAGES line, which is never shown.
				onProgress: backend === "agy" ? this.holdNeedPages(pending.progress) : pending.progress,
				onSpawn: (proc) => {
					pending.proc = proc;
					if (pending.cancelled) {
						proc.kill();
					}
				},
			};
			let result = await this.runBackend(backend, request);
			let sent = request;

			// A stale or expired session makes the CLI fail; fall back to a fresh
			// session once instead of failing the whole request.
			if (result.resumeFailed && session && !pending.cancelled) {
				this.log(label + ": resume failed (" + result.error + "), retrying as a new session");
				pending.progress({ text: "", status: "starting a new session" });
				sent = Object.assign({}, request, { session: null });
				result = await this.runBackend(backend, sent);
			}
			let paper = this.sessionPaper(backend, files, sent.session);
			let need = backend === "agy" && !pending.cancelled && result.text ? this.parseNeedPages(result.text, files) : null;
			if (need) {
				result = await this.followUpWithPages(sent, result, paper, need, pending);
				if (need.length) {
					paper = this.addSentPages(paper, need, files);
				}
			}

			let meta = { backend, model: pending.model || undefined, effort: pending.effort || undefined };
			if ((pending.steps && pending.steps.length) || pending.thoughtMs) {
				meta.activity = { steps: pending.steps || [], thoughtMs: Math.round(pending.thoughtMs || 0) };
			}
			if (pending.cancelled) {
				if (!pending.partial.trim()) {
					return { cancelled: true };
				}
				result = { text: pending.partial.trim(), sessionId: result.sessionId, stopped: true };
			}
			else if (!result.text) {
				return { error: result.error || label + " returned no text." };
			}
			let turnPage = Number.isInteger(files.currentPage) ? files.currentPage : files.selectedPage;
			// The PDF page the question was asked on, 1-based like the markers, which the
			// memory's items cite.
			await this.appendHistory(ctx.dir, [
				Object.assign({ role: "user", text: question, ts: Date.now() },
					Number.isInteger(turnPage) ? { page: turnPage + 1 } : {},
					images.length ? { images: images.map(p => p.startsWith(ctx.dir) ? p.slice(ctx.dir.length).replace(/^[\/\\]+/, "") : p) } : {},
					pending.modes && pending.modes.length ? { modes: pending.modes } : {}),
				Object.assign({ role: "assistant", text: result.text, ts: Date.now() }, meta, result.stopped ? { stopped: true } : {}),
			]);
			if (pending.selection) {
				try {
					await this.appendClarification(ctx.dir, {
						id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
						ts: Date.now(),
						passage: pending.selection.text,
						pageLabel: pending.selection.pageLabel || "",
						position: pending.selection.position || null,
						attachmentID: pending.selection.attachmentID || null,
						question,
						prompt: request.question,
						instructions: this.sentInstructions(backend, sent.session),
						answer: result.text,
						stopped: !!result.stopped,
						backend,
						model: pending.model || "",
						effort: pending.effort || "",
						messageIndex: history.length,
					});
				}
				catch (e) {
					this.logError("appendClarification", e);
				}
			}
			let outline = files.structure && Number.isInteger(turnPage) ? files.structure.outline : null;
			let memory = await this.recordTurn(ctx.dir, {
				ts: Date.now(),
				page: Number.isInteger(turnPage) ? turnPage + 1 : null,
				section: outline ? ZusiaMap.sectionOf(outline, turnPage)?.id ?? null : null,
				chapter: outline ? ZusiaMap.chapterOf(outline, turnPage)?.id ?? null : null,
				refs: ZusiaMap.findObjectRefs(question || "").map(ref => ref.kind + ":" + (ref.id ?? ref.label)),
				backend,
			});
			let [before, now] = memory.turns.slice(-2);
			let crossed = !!(before && now && before.chapter && now.chapter && before.chapter !== now.chapter);
			// The answer is saved by now; a memory that cannot be scheduled must not fail it.
			await this.scheduleConsolidation(ctx.dir, crossed ? "chapter" : "turn")
				.catch(e => this.logError("scheduling memory consolidation", e));
			if (result.sessionId) {
				// `map` is the section the session last got the whole map for.
				let map = this.mapDue(files, sent.session, backend !== "agy") ? { section: this.mapSection(files) } : (sent.session && sent.session.map) || null;
				sessions[backend] = { id: result.sessionId, seen: history.length + 2, prompt: this.PROMPT_VERSION,
					promptHash, paper, map };
				await this.saveSessions(ctx.dir, sessions);
			}
			this.refreshReadingChips(ctx.dir);
			return {};
		}
		catch (e) {
			this.logError("ask", e);
			return pending.cancelled ? { cancelled: true } : { error: String((e && e.message) || e) };
		}
		finally {
			this._pending.delete(ctx.dir);
			// Memory jobs wait while a question runs.
			this.pumpJobs();
		}
	},
});
