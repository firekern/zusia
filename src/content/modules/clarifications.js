"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Clarifications: what was asked about highlighted text, and the answer
	// ---------------------------------------------------------------------

	async loadClarifications(dir) {
		let path = OS.Path.join(dir, "clarifications.json");
		try {
			if (!(await OS.File.exists(path))) {
				return [];
			}
			let list = JSON.parse(await Zotero.File.getContentsAsync(path));
			return Array.isArray(list) ? list : [];
		}
		catch (e) {
			this.log("loadClarifications failed: " + e);
			return [];
		}
	},

	async saveClarifications(dir, list) {
		await Zotero.File.putContentsAsync(OS.Path.join(dir, "clarifications.json"), JSON.stringify(list, null, 2));
	},

	async appendClarification(dir, record) {
		let list = await this.loadClarifications(dir);
		list.push(record);
		await this.saveClarifications(dir, list);
	},

	// A panel over the chat: the list of clarifications, or one of them in full.
	async openClarifications(root) {
		let view = this._views.get(root);
		if (!view) {
			return;
		}
		let doc = root.ownerDocument;
		root.querySelector(".zs-panel")?.remove();
		let panel = this.el(doc, "div", "zs-panel");
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "Clarifications");
		let head = this.el(doc, "div", "zs-panel-head");
		let back = this.iconButton(doc, "zs-small zs-panel-back", "All clarifications", "previous", () => showList());
		let title = this.el(doc, "div", "zs-panel-title");
		title.append(this.svgIcon(doc, "clarifications"), this.el(doc, "span", null, "Clarifications"));
		let close = this.iconButton(doc, "zs-small zs-panel-close", "Close", "remove", () => closePanel());
		head.append(back, title, close);
		let body = this.el(doc, "div", "zs-panel-body");
		panel.append(head, body);
		let closePanel = () => panel.remove();
		panel.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closePanel();
			}
		});
		root.appendChild(panel);

		let list = (await this.loadClarifications(view.ctx.dir)).sort((a, b) => (b.ts || 0) - (a.ts || 0));

		let showList = () => {
			back.hidden = true;
			body.textContent = "";
			if (!list.length) {
				let empty = this.el(doc, "div", "zs-clar-empty");
				let mascot = this.MASCOTS[this.getAppearance().mascot].icon;
				empty.append(this.svgIcon(doc, mascot || "clarifications", mascot ? "zs-mascot" : "zs-clar-empty-icon"),
					this.el(doc, "div", "zs-clar-empty-title", "Nothing saved yet"),
					this.el(doc, "div", "zs-clar-empty-sub", "Select text in the PDF, then Ask or Explain."));
				body.appendChild(empty);
				return;
			}
			for (let entry of list) {
				let item = this.el(doc, "button", "zs-clar-item");
				item.type = "button";
				item.title = "Open this clarification";
				let top = this.el(doc, "div", "zs-clar-item-top");
				top.append(this.svgIcon(doc, "quote", "zs-clar-quote-icon"), this.el(doc, "span", "zs-clar-passage", entry.passage || ""));
				let meta = this.el(doc, "div", "zs-clar-meta");
				if (entry.pageLabel) {
					meta.appendChild(this.el(doc, "span", "zs-clar-page", "p. " + entry.pageLabel));
				}
				meta.appendChild(this.el(doc, "span", "zs-clar-when", this.formatWhen(entry.ts)));
				let backendIcon = this.svgIcon(doc, this.BACKEND_ICONS[entry.backend] || "sparkle", "zs-clar-backend");
				backendIcon.title = (this.BACKENDS[entry.backend] || {}).label || "";
				meta.appendChild(backendIcon);
				item.append(top, meta);
				item.addEventListener("click", () => showDetail(entry));
				body.appendChild(item);
			}
		};

		let showDetail = (entry) => {
			back.hidden = false;
			body.textContent = "";
			let detail = this.el(doc, "div", "zs-clar-detail");
			let section = (icon, label, content, className) => {
				let box = this.el(doc, "section", "zs-clar-section " + (className || ""));
				let heading = this.el(doc, "div", "zs-clar-heading");
				heading.append(this.svgIcon(doc, icon), this.el(doc, "span", null, label));
				box.append(heading, content);
				detail.appendChild(box);
				return box;
			};
			let passage = this.el(doc, "blockquote", "zs-clar-passage-full", entry.passage || "");
			let passageBox = section("quote", entry.pageLabel ? "Passage · p. " + entry.pageLabel : "Passage", passage);
			passageBox.classList.add("zs-clar-passage-box");

			let prompt = this.el(doc, "pre", "zs-clar-prompt", entry.prompt || entry.question || "");
			section("prompt", "Prompt sent", prompt);
			if (entry.instructions) {
				let details = doc.createElement("details");
				details.className = "zs-clar-instructions";
				let summary = doc.createElement("summary");
				summary.textContent = "Instructions given to the assistant";
				details.append(summary, this.el(doc, "pre", null, entry.instructions));
				detail.appendChild(details);
			}
			let answer = this.el(doc, "div", "zs-msg zs-rich zs-clar-answer");
			this.renderRich(doc, answer, entry.answer || "");
			let run = [(this.BACKENDS[entry.backend] || {}).label, entry.model && this.modelLabel(entry.backend, entry.model)].filter(Boolean).join(" · ");
			section("answer", run ? "Answer · " + run : "Answer", answer);

			let actions = this.el(doc, "div", "zs-clar-actions");
			let chat = this.iconButton(doc, "zs-clar-chat", "Show in the chat", "newChat", () => {
				closePanel();
				this._jump = { dir: view.ctx.dir, index: entry.messageIndex };
				this.applyJump(view);
			});
			let pdf = this.iconButton(doc, "zs-clar-pdf", "Open the passage in the PDF", "openPdf", () => {
				let location = entry.position ? { position: entry.position } : entry.pageLabel ? { pageLabel: entry.pageLabel } : undefined;
				Promise.resolve(Zotero.Reader.open(entry.attachmentID, location)).catch(e => this.logError("open PDF", e));
			});
			pdf.disabled = !entry.attachmentID;
			let copy = this.iconButton(doc, "zs-clar-copy", "Copy the prompt", "copy", () => {
				Zotero.Utilities.Internal.copyTextToClipboard(entry.prompt || entry.question || "");
				copy.title = "Copied";
			});
			let remove = this.iconButton(doc, "zs-clar-delete", "Delete this clarification", "trash", async () => {
				list = list.filter(e => e !== entry);
				showList();
				await this.saveClarifications(view.ctx.dir, [...list].sort((a, b) => (a.ts || 0) - (b.ts || 0)));
			});
			actions.append(chat, pdf, copy, this.el(doc, "span", "zs-spacer"), remove);
			detail.insertBefore(actions, detail.firstChild);
			body.appendChild(detail);
			this.fitWideContent(answer);
		};

		showList();
		doc.defaultView.setTimeout(() => (body.querySelector(".zs-clar-item") || close).focus(), 0);
		return panel;
	},
});
