"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Sidebar UI
	// ---------------------------------------------------------------------

	renderSkeleton(doc, body) {
		body.textContent = "";

		let root = this.el(doc, "div", "zs-root");
		// Background image, veil and glow, behind everything else (see .zs-backdrop).
		let backdrop = this.el(doc, "div", "zs-backdrop");
		backdrop.setAttribute("aria-hidden", "true");
		backdrop.appendChild(this.el(doc, "div", "zs-backdrop-image"));
		root.appendChild(backdrop);
		this.applyAppearance(root);

		let header = this.el(doc, "div", "zs-header");
		let moreButton = this.iconButton(doc, "zs-header-more", "More", "more", () => this.openHeaderMenu(root, moreButton));
		header.append(
			this.svgIcon(doc, this.MASCOTS[this.getAppearance().mascot].header, "zs-header-icon"),
			this.el(doc, "span", "zs-header-title", "Paper chat"),
			// The paper's title stands in for Zotero's title bar, which the chat view hides.
			this.el(doc, "span", "zs-header-paper"),
			this.iconButton(doc, "zs-clarifications", "Clarifications of highlighted text", "clarifications",
				() => this.openClarifications(root).catch(e => this.logError("openClarifications", e))),
			this.iconButton(doc, "zs-search", "Search all chats", "search", () => this.openSearchMenu(root)),
			this.iconButton(doc, "zs-history", "Previous chats", "history", () => this.openHistoryMenu(root)),
			this.iconButton(doc, "zs-new-chat", "New chat", "newChat", () => this.newChat(root)),
			this.iconButton(doc, "zs-open-settings", "Settings", "settings", () => this.openSettings()),
			this.iconButton(doc, "zs-view-chat", "Fill the side pane with the chat", "expand", () => {
				this.setView(doc, "chat");
				root.querySelector(".zs-input")?.focus();
			}),
			this.iconButton(doc, "zs-view-details", "Back to the item details", "collapse", () => {
				this.setView(doc, "details");
				root.closest("item-details")?.scrollToPane?.(this.paneID, "instant");
			}),
			this.iconButton(doc, "zs-dock-hide", "Hide Zusia", "dock", () => this.setDockOpen(false)),
			moreButton,
		);
		// The Rich layout writes these beside the icons.
		for (let [name, label] of Object.entries({ search: "Search", history: "History", "new-chat": "New chat" })) {
			header.querySelector(".zs-" + name).dataset.label = label;
		}

		let paperCard = this.el(doc, "div", "zs-paper-card");
		paperCard.hidden = true;
		paperCard.setAttribute("role", "button");
		paperCard.tabIndex = 0;
		let openMemory = () => this.openMemory(root).catch(e => this.logError("openMemory", e));
		paperCard.addEventListener("click", openMemory);
		paperCard.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				openMemory();
			}
		});

		let log = this.el(doc, "div", "zs-log");
		log.appendChild(this.el(doc, "div", "zs-notice", "Loading…"));
		let logWrap = this.el(doc, "div", "zs-log-wrap");
		let jump = this.iconButton(doc, "zs-jump", "Scroll to latest", "jump", () => {
			log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
		});
		jump.hidden = true;
		log.addEventListener("scroll", () => this.updateJump(root));
		// Refit formulas and tables when the pane is resized or the maths font arrives.
		let win = doc.defaultView;
		if (doc.fonts && doc.fonts.addEventListener) {
			let refit = () => log.isConnected && this.fitWideContent(log);
			doc.fonts.addEventListener("loadingdone", refit);
			doc.fonts.ready.then(refit);
		}
		if (win && win.ResizeObserver) {
			let pendingFit = null;
			let lastWidth = 0;
			new win.ResizeObserver((entries) => {
				let width = Math.round(entries[0].contentRect.width);
				if (width === lastWidth) {
					return;
				}
				lastWidth = width;
				win.cancelAnimationFrame(pendingFit);
				pendingFit = win.requestAnimationFrame(() => this.fitWideContent(log));
			}).observe(log);
		}
		let back = this.ghostButton(doc, "zs-back", "back", "Back", () => this.goBack(root));
		back.hidden = true;
		log.addEventListener("click", (event) => {
			let ref = event.target.closest && event.target.closest(".zs-ref-ok");
			if (ref) {
				event.preventDefault();
				this.followRef(root, ref);
			}
		});
		logWrap.append(log, jump, back);

		let quick = this.el(doc, "div", "zs-quick");

		let composer = this.el(doc, "div", "zs-composer");
		let input = this.el(doc, "textarea", "zs-input");
		input.rows = 2;
		input.disabled = true;
		composer.addEventListener("mousedown", (event) => {
			if (event.target === composer) {
				event.preventDefault();
				input.focus();
			}
		});

		let controls = this.el(doc, "div", "zs-controls");
		let attachButton = this.iconButton(doc, "zs-attach", "Add an image or screenshot (" + this.shortcutLabel(this.ATTACH_KEY) + ")", "attach", () => this.openAttachMenu(root, attachButton));
		let modelButton = this.ghostButton(doc, "zs-model-btn", null, "", () => this.openModelMenu(root, modelButton), { chevron: true });
		modelButton.title = "Assistant and model";
		let effortButton = this.ghostButton(doc, "zs-effort-btn", "effort", "", () => this.openEffortMenu(root, effortButton), { chevron: true });
		effortButton.title = "Reasoning effort";
		let send = this.iconButton(doc, "zs-send", "Send (" + this.sendKeyLabel() + ")", "send", () => this.sendOrStop(root));
		send.className = "zs-send";
		send.disabled = true;
		let modeButtons = Object.entries(this.MODES).map(([id, mode]) => {
			let button = this.ghostButton(doc, "zs-mode zs-mode-" + id, mode.icon, mode.label, () => {
				this.setPref("mode." + id, !this.isModeOn(id));
				this.updateControls(root);
			});
			button.dataset.mode = id;
			button.title = mode.title + " (" + this.shortcutLabel(mode.key) + ")";
			return button;
		});
		controls.append(attachButton, ...modeButtons, modelButton, effortButton, this.el(doc, "span", "zs-spacer"), send);

		let context = this.el(doc, "div", "zs-context");
		context.hidden = true;
		let attachments = this.el(doc, "div", "zs-attachments");
		attachments.hidden = true;
		composer.append(context, attachments, input, controls);
		root.append(header, paperCard, logWrap, quick, composer);
		root.addEventListener("keydown", event => this.handleShortcut(root, event));
		body.appendChild(root);

		this.updateControls(root);
		this.renderQuickPrompts(root, quick);
		this.checkInstalledBackends(root);
		if (!this.getPref("onboarded")) {
			this.showWizard(root);
		}
	},

	updateControls(root) {
		let backend = this.getBackend();
		let info = this.BACKENDS[backend];
		let model = this.getModel(backend);
		let effort = this.getEffort(backend);
		let modelButton = root.querySelector(".zs-model-btn");
		if (modelButton) {
			let full = model ? info.label + " · " + this.modelLabel(backend, model) : info.label;
			// Long model names drop the assistant prefix, as Beaver drops the vendor name.
			modelButton.setLabel(full.length > 22 && model ? this.modelLabel(backend, model) : full);
			modelButton.title = full + " — choose assistant and model";
		}
		let effortButton = root.querySelector(".zs-effort-btn");
		if (effortButton) {
			effortButton.setLabel(this.EFFORTS[effort].label);
		}
		let shown = this.getModeButtons();
		for (let button of root.querySelectorAll(".zs-mode")) {
			let id = button.dataset.mode;
			button.hidden = !shown[id];
			button.setAttribute("aria-pressed", String(this.isModeOn(id)));
		}
		let input = root.querySelector(".zs-input");
		if (input) {
			input.placeholder = "Ask " + info.label + " about this paper…";
		}
		root.querySelector(".zs-menu")?.refresh?.();
	},

	async checkInstalledBackends(root) {
		root._installed = root._installed || {};
		for (let key of Object.keys(this.BACKENDS)) {
			root._installed[key] = await this.probeBinary(key);
		}
		root.querySelector(".zs-menu")?.refresh?.();
	},

	async probeBinary(key) {
		try {
			return await this.findBinary(key);
		}
		catch (e) {
			return null;
		}
	},

	openModelMenu(root, anchor) {
		let doc = root.ownerDocument;
		let menu = this.openMenu(root, anchor, (menu) => {
			let current = this.getBackend();
			for (let [key, backend] of Object.entries(this.BACKENDS)) {
				let installed = root._installed ? root._installed[key] : undefined;
				this.menuSection(doc, menu, backend.fullName);
				if (installed === null) {
					menu.appendChild(this.el(doc, "div", "zs-menu-note",
						"Not installed. Install the " + backend.command + " CLI or set its path in Settings."));
					continue;
				}
				for (let model of this.getModels(key)) {
					this.menuItem(doc, menu, {
						label: model.label,
						desc: model.id ? "" : model.desc,
						checked: key === current && model.id === this.getModel(key),
						onSelect: () => {
							this.setPref(key + ".model", model.id);
							this.setPref("backend", key);
							this.closeMenu(root);
							this.updateControls(root);
						},
					});
				}
				if (key === "agy" && !Array.isArray(this._agyModels)) {
					menu.appendChild(this.el(doc, "div", "zs-menu-note", "Loading models…"));
				}
				if (key === "agy" && this._agyModelsError) {
					menu.appendChild(this.el(doc, "div", "zs-menu-note", "Sign-in not reachable from Zotero, so only the default model is listed. See Settings."));
				}
			}
		});
		if (menu && !Array.isArray(this._agyModels)) {
			this.loadAgyModels().then(() => menu.isConnected && menu.refresh());
		}
	},

	openEffortMenu(root, anchor) {
		let doc = root.ownerDocument;
		this.openMenu(root, anchor, (menu) => {
			let backend = this.getBackend();
			let current = this.getEffort(backend);
			this.menuSection(doc, menu, "Reasoning effort · " + this.BACKENDS[backend].label);
			for (let effort of this.BACKENDS[backend].efforts) {
				this.menuItem(doc, menu, {
					label: this.EFFORTS[effort].label,
					desc: this.EFFORTS[effort].desc,
					checked: effort === current,
					onSelect: () => {
						this.setPref(backend + ".effort", effort);
						this.closeMenu(root);
						this.updateControls(root);
					},
				});
			}
		});
	},

	renderQuickPrompts(root, quick) {
		let doc = root.ownerDocument;
		quick.textContent = "";
		for (let { label, prompt } of this.getPrompts()) {
			if (!prompt.trim()) {
				continue;
			}
			let pill = this.el(doc, "button", "zs-pill", label.trim() || prompt);
			pill.type = "button";
			pill.title = prompt;
			pill.addEventListener("click", () => this._views.get(root)?.send(prompt));
			quick.appendChild(pill);
		}
		quick.hidden = !quick.childElementCount;
		let view = this._views.get(root);
		if (view) {
			this.setBusy(view, this._pending.has(view.ctx.dir));
		}
	},

	scrollToEnd(logEl) {
		logEl.scrollTop = logEl.scrollHeight;
	},

	updateJump(root) {
		let log = root.querySelector(".zs-log");
		let jump = root.querySelector(".zs-jump");
		if (log && jump) {
			jump.hidden = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
		}
	},

	// Renders Markdown/LaTeX into `node`, falling back to plain text if the
	// renderer throws, so one odd answer cannot blank the whole conversation.
	renderRich(doc, node, text) {
		node.classList.add("zs-rich");
		try {
			this.renderMarkdown(doc, node, text);
		}
		catch (e) {
			this.logError("renderMarkdown", e);
			node.textContent = text;
			node.classList.add("zs-plain");
		}
	},

	// Puts a question back into the composer so it can be changed and sent again.
	editPrompt(view, text, images = []) {
		view.input.value = text;
		this.autoGrow(view.input);
		if (images.length) {
			this._staged.set(view.ctx.dir, images.map(path => ({ path, sent: true })));
			this.renderAttachments(view);
		}
		if (!this._pending.has(view.ctx.dir)) {
			view.root.querySelector(".zs-send").disabled = !this.canSend(view);
		}
		view.input.focus();
		view.input.setSelectionRange(text.length, text.length);
	},

	appendUser(view, text, images = [], modes = []) {
		let card = this.el(view.doc, "div", "zs-msg zs-user");
		card.dataset.text = text;
		card.images = images;
		if (images.length) {
			let strip = this.el(view.doc, "div", "zs-user-images");
			for (let path of images) {
				strip.appendChild(this.imageThumb(view.doc, path, {
					onOpen: () => Zotero.launchFile(path),
				}));
			}
			card.appendChild(strip);
		}
		if (text) {
			let body = this.el(view.doc, "div", "zs-user-text");
			try {
				this.renderInline(view.doc, body, text);
			}
			catch (e) {
				this.logError("renderInline", e);
				body.textContent = text;
			}
			card.appendChild(body);
		}
		let tags = modes.filter(id => this.MODES[id]);
		if (tags.length) {
			let row = this.el(view.doc, "div", "zs-user-modes");
			for (let id of tags) {
				let tag = this.el(view.doc, "span", "zs-user-mode");
				tag.append(this.svgIcon(view.doc, this.MODES[id].icon), this.el(view.doc, "span", null, this.MODES[id].label));
				row.appendChild(tag);
			}
			card.appendChild(row);
		}
		let edit = this.iconButton(view.doc, "zs-small zs-user-edit", "Edit and resend", "edit", (event) => {
			event.stopPropagation();
			this.editPrompt(view, text, images);
		});
		card.appendChild(edit);
		view.logEl.appendChild(card);
		if (card.scrollHeight > 150) {
			card.classList.add("zs-clamped");
			card.title = "Click to show the whole message";
			card.addEventListener("click", () => {
				if (!view.doc.defaultView.getSelection().toString()) {
					card.classList.toggle("zs-clamped");
					card.title = card.classList.contains("zs-clamped") ? "Click to show the whole message" : "";
				}
			});
		}
		this.scrollToEnd(view.logEl);
		return card;
	},

	appendError(view, text, { title, retry } = {}) {
		let { doc } = view;
		let card = this.el(doc, "div", "zs-msg zs-error");
		card.setAttribute("role", "alert");
		let head = this.el(doc, "button", "zs-error-head");
		head.type = "button";
		head.setAttribute("aria-expanded", "false");
		let icon = this.el(doc, "span", "zs-error-icon");
		icon.appendChild(this.svgIcon(doc, "alert"));
		head.append(icon, this.el(doc, "span", "zs-error-title", title || "Something went wrong"),
			this.svgIcon(doc, "chevronRight", "zs-error-chevron"));
		let details = this.el(doc, "div", "zs-error-details");
		details.appendChild(this.el(doc, "div", "zs-error-text", text));
		let actions = this.el(doc, "div", "zs-error-actions");
		if (retry) {
			actions.appendChild(this.ghostButton(doc, "zs-error-retry", "retry", "Try again", retry));
		}
		let copy = this.ghostButton(doc, "", "copy", "Copy details", () => {
			Zotero.Utilities.Internal.copyTextToClipboard(text);
			copy.setLabel("Copied");
		});
		actions.appendChild(copy);
		details.appendChild(actions);
		// Short errors are shown straight away; long ones start collapsed.
		let open = text.length < 240;
		let setOpen = (value) => {
			open = value;
			details.hidden = !open;
			head.setAttribute("aria-expanded", String(open));
			card.classList.toggle("zs-open", open);
		};
		head.addEventListener("click", () => setOpen(!open));
		setOpen(open);
		card.append(head, details);
		view.logEl.appendChild(card);
		this.scrollToEnd(view.logEl);
		return card;
	},

	// "Surname et al., 2022" and whether the PDF text can be read, for the paper chip.
	paperInfo(ctx) {
		let item = ctx && ctx.paperItem;
		if (!item) {
			return null;
		}
		let creators = (item.getCreators && item.getCreators()) || [];
		let first = creators[0] ? (creators[0].lastName || creators[0].name || "") : "";
		let authors = first ? first + (creators.length > 2 ? " et al." : creators.length === 2 ? " & " + (creators[1].lastName || creators[1].name || "") : "") : "";
		let year = (this.safeField(item, "date").match(/\d{4}/) || [""])[0];
		let title = this.safeField(item, "title");
		let label = [authors, year].filter(Boolean).join(", ") || title || "This item";
		let attachment = ctx.attachmentItem;
		let isPDF = !!(attachment && attachment.isPDFAttachment && attachment.isPDFAttachment());
		let itemType = isPDF ? "attachmentPDF" : (item.itemType || "document");
		return { label, title, itemType };
	},
});
