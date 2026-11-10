"use strict";

Object.assign(Zusia, {
	MEMORY_KIND_LABELS: { preference: "Preference", open: "Open question", shaky: "Still shaky", understood: "Understood", note: "Your note" },

	// A panel over the chat with what Zusia keeps about the paper: where the reader is, the
	// reading map with what was read, the memory items (each editable and deletable),
	// Reset, and the two background memory settings.
	async openMemory(root) {
		let view = this._views.get(root);
		if (!view) {
			return null;
		}
		let doc = root.ownerDocument;
		let dir = view.ctx.dir;
		let { panel, body } = this.openPanel(root, { label: "Reading memory", icon: "memory", className: "zs-memory-panel" });

		let structure = await this.cachedStructure(dir);
		let progress = this.trackingReading() ? await this.loadProgress(dir) : null;
		let section = (label, className) => {
			let box = this.el(doc, "section", "zs-memory-section " + className);
			box.appendChild(this.el(doc, "div", "zs-memory-heading", label));
			body.appendChild(box);
			return box;
		};
		let printed = i => ZusiaMap.printedLabel(i, structure) || String(i + 1);

		// The heading already says "Where we are"; the line under it starts a sentence.
		let where = ZusiaMap.whereWeAre(progress, structure).replace(/^Where we are: /, "");
		section("Where we are", "zs-memory-where").appendChild(
			this.el(doc, "div", "zs-memory-line", where.charAt(0).toUpperCase() + where.slice(1)));

		if (structure && structure.outline.length && structure.outlineMethod !== "chunks") {
			let states = (progress && progress.sections) || {};
			let here = progress && Number.isInteger(progress.current) ? progress.current : null;
			let list = this.el(doc, "ul", "zs-memory-outline");
			for (let e of structure.outline.filter(entry => entry.level <= 2)) {
				let state = states[e.id] || "unread";
				let li = this.el(doc, "li", "zs-memory-entry");
				li.dataset.level = String(e.level);
				li.dataset.state = state;
				li.classList.toggle("zs-here", here !== null && ZusiaMap.sectionOf(structure.outline, here)?.id === e.id);
				let mark = this.el(doc, "span", "zs-memory-mark", state === "read" ? "✓" : state === "reading" ? "▶" : "");
				mark.title = state === "read" ? "Read" : state === "reading" ? "Reading" : "Not read yet";
				li.append(mark, this.el(doc, "span", "zs-memory-entry-title", ZusiaMap.entryTitle(e)),
					this.el(doc, "span", "zs-memory-entry-pages", "p. " + printed(e.start) + (e.end > e.start ? "–" + printed(e.end) : "")));
				list.appendChild(li);
			}
			section("Reading map", "zs-memory-map").appendChild(list);
		}

		let itemsBox = section("What Zusia remembers", "zs-memory-items");
		let list = this.el(doc, "div", "zs-memory-list");
		itemsBox.appendChild(list);
		let change = async (fn) => {
			let rejected = [];
			await this.updateMemory(dir, (memory) => {
				let result = fn(memory);
				rejected = result.rejected;
				return result.memory;
			});
			await draw();
			return rejected;
		};
		let edit = (row, item) => {
			let input = this.el(doc, "textarea", "zs-memory-edit");
			input.value = item.text;
			input.rows = 2;
			input.setAttribute("aria-label", "Edit this memory");
			let save = this.iconButton(doc, "zs-small zs-memory-save", "Save", "check", async () => {
				let rejected = await change(memory => ZusiaMap.editMemoryItem(memory, item.id, input.value));
				if (rejected.length) {
					this.log("Memory edit not kept: " + rejected[0].reason);
				}
			});
			let cancel = this.iconButton(doc, "zs-small zs-memory-cancel", "Cancel", "remove", () => draw());
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter" && !event.shiftKey) {
					event.preventDefault();
					save.click();
				}
				else if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					draw();
				}
			});
			row.querySelector(".zs-memory-text").replaceWith(input);
			row.querySelector(".zs-memory-actions").replaceChildren(save, cancel);
			input.focus();
		};
		let draw = async () => {
			let memory = await this.loadMemory(dir);
			list.textContent = "";
			if (memory.summary) {
				let summary = this.el(doc, "div", "zs-memory-summary");
				summary.append(this.el(doc, "span", "zs-memory-kind", "So far"), this.el(doc, "span", "zs-memory-text", memory.summary));
				list.appendChild(summary);
			}
			for (let kind of ["preference", "open", "shaky", "understood", "note"]) {
				for (let item of memory.items.filter(it => it.kind === kind)) {
					let row = this.el(doc, "div", "zs-memory-item");
					row.dataset.id = item.id;
					row.dataset.kind = kind;
					let text = this.el(doc, "span", "zs-memory-text", item.text);
					let meta = this.el(doc, "div", "zs-memory-meta");
					meta.appendChild(this.el(doc, "span", "zs-memory-kind", this.MEMORY_KIND_LABELS[kind]));
					if (item.page) {
						meta.appendChild(this.el(doc, "span", "zs-memory-page", "p. " + printed(item.page - 1)));
					}
					let actions = this.el(doc, "span", "zs-memory-actions");
					actions.append(
						this.iconButton(doc, "zs-small zs-memory-edit-btn", "Edit", "edit", () => edit(row, item)),
						this.iconButton(doc, "zs-small zs-memory-delete", "Forget this", "trash",
							() => change(current => ZusiaMap.applyMemoryPatch(current, { remove: [item.id] }))),
					);
					meta.appendChild(actions);
					row.append(meta, text);
					list.appendChild(row);
				}
			}
			if (!list.childElementCount) {
				list.appendChild(this.el(doc, "div", "zs-memory-empty",
					"Nothing yet. As you talk, Zusia notes what you understood, what is still unclear and how you like " +
					"answers; /remember in the chat adds a note of your own."));
			}
		};
		await draw();

		let reset = this.el(doc, "button", "zs-button zs-memory-reset", "Reset memory");
		reset.type = "button";
		reset.addEventListener("click", async () => {
			if (!reset.classList.contains("zs-confirm")) {
				reset.classList.add("zs-confirm");
				reset.textContent = "Click again to forget everything";
				return;
			}
			reset.classList.remove("zs-confirm");
			reset.textContent = "Reset memory";
			// The chat so far counts as covered and put-away chats are no longer owed, or the
			// next update would learn it all again; a new generation drops what a job still
			// running computed from the memory before.
			let history = await this.loadHistory(dir);
			this.forgetMemoryJobs(dir);
			await change(memory => ({
				memory: Object.assign({}, memory, {
					summary: "", items: [], coveredThrough: history.length - 1, pendingArchives: [], generation: memory.generation + 1,
				}),
				rejected: [],
			}));
		});
		itemsBox.appendChild(this.el(doc, "div", "zs-memory-reset-row")).appendChild(reset);

		let settings = section("In the background", "zs-memory-settings");
		let runner = this.jobBackend() ? "" : " Needs Claude or Antigravity as the assistant: Codex is never used for it.";
		// A switch is a button, which the row's <label> does not name.
		let toggle = (label, checked, pref, hint) => {
			let control = this.switchControl(doc, checked, v => this.setPref(pref, v));
			control.setAttribute("aria-label", label);
			return this.row(doc, label, control, hint);
		};
		settings.append(
			toggle("Update the memory as we talk", this.consolidating(), "memory.consolidate",
				"Every few questions, and when you move on to another chapter or close the chat, a short call to your " +
				"assistant's cheapest model folds the conversation into this memory." + runner),
			toggle("Summarise sections I finish", this.gisting(), "memory.gists",
				"When a section is read, one call writes a short summary of it, which later questions get for " +
				"orientation. Costs about one call per section." + runner),
		);
		doc.defaultView.setTimeout(() => close.focus(), 0);
		return panel;
	},
});
