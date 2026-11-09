"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Settings pane (Zotero Settings → Zusia)
	// ---------------------------------------------------------------------

	renderPrefsPane(doc, container) {
		container.textContent = "";
		let prefs = this.el(doc, "div", "zs-prefs");
		this.applyAppearance(prefs);
		prefs.append(
			this.buildAssistantsCard(doc),
			this.buildChatCard(doc),
			this.buildAppearanceCard(doc, prefs),
			this.buildBehaviourCard(doc),
			this.buildTroubleshootingCard(doc),
		);
		container.appendChild(prefs);
	},

	card(doc, title, description) {
		let card = this.el(doc, "section", "zs-card");
		let head = this.el(doc, "div", "zs-card-head");
		head.appendChild(this.el(doc, "h2", "zs-card-title", title));
		if (description) {
			head.appendChild(this.el(doc, "p", "zs-card-desc", description));
		}
		let body = this.el(doc, "div", "zs-card-body");
		card.append(head, body);
		card.body = body;
		return card;
	},

	row(doc, label, control, hint, { stack = false } = {}) {
		let row = this.el(doc, "div", "zs-row" + (stack ? " zs-row-stack" : ""));
		let labelEl = this.el(doc, "label", "zs-row-label", label);
		let controlEl = this.el(doc, "div", "zs-row-control");
		controlEl.append(...[].concat(control));
		let focusable = controlEl.querySelector("input, select, textarea");
		if (focusable) {
			focusable.id = focusable.id || "zs-" + Math.random().toString(36).slice(2, 9);
			labelEl.htmlFor = focusable.id;
		}
		row.append(labelEl, controlEl);
		if (hint) {
			row.appendChild(this.el(doc, "div", "zs-row-hint", hint));
		}
		return row;
	},

	select(doc, options, value, onChange) {
		let select = this.el(doc, "select", "zs-select");
		let fill = (opts, selected) => {
			select.textContent = "";
			for (let [optValue, optLabel] of opts) {
				let option = doc.createElement("option");
				option.value = optValue;
				option.textContent = optLabel;
				option.selected = optValue === selected;
				select.appendChild(option);
			}
		};
		fill(options, value);
		select.refill = fill;
		select.addEventListener("change", () => onChange(select.value));
		return select;
	},

	switchControl(doc, checked, onChange) {
		let button = this.el(doc, "button", "zs-switch");
		button.type = "button";
		button.setAttribute("role", "switch");
		button.setAttribute("aria-checked", String(!!checked));
		button.addEventListener("click", () => {
			let next = button.getAttribute("aria-checked") !== "true";
			button.setAttribute("aria-checked", String(next));
			onChange(next);
		});
		return button;
	},

	// A radio group of icon cards: the visual picker used in Settings and the setup wizard.
	tiles(doc, options, value, onChange) {
		let group = this.el(doc, "div", "zs-tiles");
		group.setAttribute("role", "radiogroup");
		for (let option of options) {
			let tile = this.el(doc, "button", "zs-tile");
			tile.type = "button";
			tile.setAttribute("role", "radio");
			tile.setAttribute("aria-checked", String(option.value === value));
			tile.title = option.label;
			tile.dataset.value = option.value;
			tile.appendChild(this.svgIcon(doc, option.icon, "zs-tile-icon"));
			tile.appendChild(this.el(doc, "span", "zs-tile-label", option.label));
			tile.addEventListener("click", () => {
				group.querySelectorAll(".zs-tile").forEach(t => t.setAttribute("aria-checked", String(t === tile)));
				onChange(option.value);
			});
			group.appendChild(tile);
		}
		return group;
	},

	range(doc, { min, max, step = 1, value, unit = "" }, onChange) {
		let wrap = this.el(doc, "div", "zs-range");
		let input = doc.createElement("input");
		input.type = "range";
		input.min = String(min);
		input.max = String(max);
		input.step = String(step);
		input.value = String(value);
		let output = this.el(doc, "span", "zs-range-value", value + unit);
		input.addEventListener("input", () => {
			output.textContent = input.value + unit;
			onChange(Number(input.value));
		});
		wrap.append(input, output);
		return wrap;
	},

	segmented(doc, options, value, onChange) {
		let group = this.el(doc, "div", "zs-segmented");
		group.setAttribute("role", "radiogroup");
		for (let [optValue, optLabel] of options) {
			let button = this.el(doc, "button", null, optLabel);
			button.type = "button";
			button.setAttribute("role", "radio");
			button.setAttribute("aria-checked", String(optValue === value));
			button.addEventListener("click", () => {
				group.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b === button)));
				onChange(optValue);
			});
			group.appendChild(button);
		}
		return group;
	},

	buildAssistantsCard(doc) {
		let card = this.card(doc, "Assistants",
			"Command-line agents that answer in the sidebar. Each one uses your own subscription login, so no API key is needed. Model and effort can also be changed from the chat box.");

		let backendSelect = this.select(doc,
			Object.entries(this.BACKENDS).map(([key, b]) => [key, b.fullName]),
			this.getBackend(),
			(value) => {
				this.setPref("backend", value);
				card.querySelectorAll(".zs-agent").forEach(a => a.querySelector(".zs-badge").hidden = a.dataset.backend !== value);
			});
		card.body.appendChild(this.row(doc, "Answer with", backendSelect));

		for (let [key, backend] of Object.entries(this.BACKENDS)) {
			let details = this.el(doc, "details", "zs-agent");
			details.dataset.backend = key;
			let summary = this.el(doc, "summary");
			let name = this.el(doc, "span", "zs-agent-name");
			let status = this.el(doc, "span", "zs-agent-status", "Checking…");
			name.append(this.el(doc, "strong", null, backend.fullName), status);
			let badge = this.el(doc, "span", "zs-badge", "In use");
			badge.hidden = key !== this.getBackend();
			summary.append(this.el(doc, "span", "zs-agent-dot"), name, badge, this.svgIcon(doc, "chevron", "zs-agent-chevron"));
			details.appendChild(summary);

			let body = this.el(doc, "div", "zs-agent-body");
			let modelSelect = this.select(doc,
				this.getModels(key).map(m => [m.id, m.label + (m.id && m.id !== m.label.toLowerCase() ? "  (" + m.id + ")" : "")]),
				this.getModel(key),
				value => this.setPref(key + ".model", value));
			body.appendChild(this.row(doc, "Model", modelSelect));
			if (key === "agy") {
				this.loadAgyModels().then(() => modelSelect.refill(this.getModels(key).map(m => [m.id, m.label]), this.getModel(key)));
			}
			body.appendChild(this.row(doc, "Reasoning effort", this.select(doc,
				backend.efforts.map(e => [e, this.EFFORTS[e].label + " — " + this.EFFORTS[e].desc]),
				this.getEffort(key),
				value => this.setPref(key + ".effort", value))));
			if (key === "codex") {
				let models = doc.createElement("input");
				models.type = "text";
				models.className = "zs-field";
				models.placeholder = "e.g. gpt-5.5, gpt-5.5-mini";
				models.value = this.getPref("codex.models") || "";
				models.addEventListener("change", () => {
					this.setPref("codex.models", models.value);
					modelSelect.refill(this.getModels(key).map(m => [m.id, m.label]), this.getModel(key));
				});
				body.appendChild(this.row(doc, "Extra models", models, "Comma-separated model names to offer in the model menu."));
			}
			let path = doc.createElement("input");
			path.type = "text";
			path.className = "zs-field";
			path.placeholder = "Detect “" + backend.command + "” automatically";
			path.value = this.getPref(backend.pathPref) || "";
			path.addEventListener("change", () => {
				this.setPref(backend.pathPref, path.value.trim());
				refreshStatus();
			});
			body.appendChild(this.row(doc, "Command path", path));
			if (key === "claude") {
				body.appendChild(this.row(doc, "Use my Claude Code settings",
					this.switchControl(doc, !!this.getPref("useClaudeUserSettings"), v => this.setPref("useClaudeUserSettings", v)),
					"Loads ~/.claude settings, CLAUDE.md and MCP servers. Off by default: instructions written for the terminal do not fit a sidebar."));
			}
			details.appendChild(body);
			card.body.appendChild(details);

			let refreshStatus = () => this.probeBinary(key).then(async (found) => {
				details.dataset.found = String(!!found);
				status.textContent = found || "Not found — install the " + backend.command + " CLI or set its path";
				if (found && key === "agy") {
					await this.loadAgyModels();
					if (this._agyModelsError) {
						details.dataset.found = "false";
						status.textContent = "Signed-in check failed — open for details";
						body.insertBefore(this.row(doc, "Sign-in", this.el(doc, "div", "zs-row-hint", this._agyModelsError), null, { stack: true }), body.firstChild);
					}
				}
			});
			refreshStatus();
		}
		return card;
	},

	buildChatCard(doc) {
		let card = this.card(doc, "Chat", "Quick prompts appear as buttons above the message box.");

		let languageSelect = this.select(doc,
			this.LANGUAGES.map(language => [language, language || "Same as my question"]),
			this.getLanguage(), value => this.setPref("language", value));
		card.body.appendChild(this.row(doc, "Answer language", languageSelect,
			"The assistants answer in this language whatever language you write in."));
		card.body.appendChild(this.row(doc, "Send the paper's full text",
			this.switchControl(doc, this.getPref("fullText") !== false, v => this.setPref("fullText", v)),
			"The text Zotero extracts from the PDF, EPUB or snapshot goes to the assistant on your computer, " +
			"so answers come from the paper and not just its abstract. Off: only the metadata, abstract and your annotations."));
		card.body.appendChild(this.row(doc, "Track reading progress",
			this.switchControl(doc, this.trackingReading(), v => this.setPref("trackReading", v)),
			"Zusia notes the pages you turn to in Zotero's reader, so the assistant knows where you are and what " +
			"you have read. Kept in the paper's folder on this computer."));

		let prompts = this.getPrompts();
		let list = this.el(doc, "div", "zs-prompt-list");
		let save = () => this.savePrompts(prompts);
		let draw = () => {
			list.textContent = "";
			prompts.forEach((entry, index) => {
				let row = this.el(doc, "div", "zs-prompt-row");
				let label = doc.createElement("input");
				label.type = "text";
				label.className = "zs-field";
				label.placeholder = "Label";
				label.value = entry.label || "";
				label.addEventListener("input", () => {
					entry.label = label.value;
					save();
				});
				let text = this.el(doc, "textarea", "zs-textarea zs-autogrow");
				text.rows = 1;
				text.placeholder = "Prompt sent when the button is clicked";
				text.value = entry.prompt;
				text.addEventListener("input", () => {
					entry.prompt = text.value;
					save();
					this.autoGrow(text);
				});
				doc.defaultView.setTimeout(() => this.autoGrow(text), 0);
				let move = (delta) => {
					let [moved] = prompts.splice(index, 1);
					prompts.splice(index + delta, 0, moved);
					save();
					draw();
				};
				let tools = this.el(doc, "div", "zs-prompt-tools");
				let up = this.iconButton(doc, "", "Move up", "up", () => move(-1));
				up.disabled = index === 0;
				let down = this.iconButton(doc, "", "Move down", "down", () => move(1));
				down.disabled = index === prompts.length - 1;
				let remove = this.iconButton(doc, "", "Remove", "remove", () => {
					prompts.splice(index, 1);
					save();
					draw();
				});
				tools.append(up, down, remove);
				row.append(label, text, tools);
				list.appendChild(row);
			});
		};
		draw();
		let buttons = this.el(doc, "div", "zs-button-row");
		let add = this.el(doc, "button", "zs-button", "Add prompt");
		add.type = "button";
		add.addEventListener("click", () => {
			prompts.push({ label: "", prompt: "" });
			save();
			draw();
			list.lastElementChild?.querySelector("input")?.focus();
		});
		let reset = this.el(doc, "button", "zs-button", "Restore defaults");
		reset.type = "button";
		reset.addEventListener("click", () => {
			prompts = this.DEFAULT_PROMPTS.map(p => Object.assign({}, p));
			save();
			draw();
		});
		buttons.append(add, reset);
		card.body.appendChild(this.row(doc, "Quick prompts", [list, buttons], null, { stack: true }));

		let explain = this.el(doc, "textarea", "zs-textarea");
		explain.rows = 3;
		explain.value = this.getExplainPrompt();
		explain.addEventListener("input", () => this.setPref("explainPrompt", explain.value));
		let restore = this.el(doc, "button", "zs-button", "Restore default");
		restore.type = "button";
		restore.addEventListener("click", () => {
			this.setPref("explainPrompt", "");
			explain.value = this.DEFAULT_EXPLAIN_PROMPT;
		});
		let restoreRow = this.el(doc, "div", "zs-button-row");
		restoreRow.appendChild(restore);
		card.body.appendChild(this.row(doc, "“Explain better” request", [explain, restoreRow],
			"Sent when you click Explain better under an answer.", { stack: true }));

		let shown = this.getModeButtons();
		for (let [id, mode] of Object.entries(this.MODES)) {
			card.body.appendChild(this.row(doc, "“" + mode.label + "” button",
				this.switchControl(doc, shown[id], (on) => {
					shown[id] = on;
					this.setPref("modeButtons", JSON.stringify(shown));
				}),
				(id === "drawing"
					? "Shows a Drawing button in the message box. When it is on, answers include a drawing."
					: "Shows a LaTeX button in the message box. When it is on, answers write the maths out in displayed LaTeX equations.") +
				" Shortcut: " + this.shortcutLabel(mode.key) + "."));
		}
		return card;
	},

	buildAppearanceCard(doc, prefsRoot) {
		let card = this.card(doc, "Appearance", "Colours follow Zotero's light and dark themes.");
		let appearance = this.getAppearance();
		let glassRows = [];
		let imageRows = [];
		let glowRows = [];
		let update = (changes) => {
			appearance = Object.assign({}, appearance, changes);
			this.saveAppearance(appearance);
			this.applyAppearance(prefsRoot, appearance);
			let isPreset = this.ACCENTS.some(a => a.color === appearance.accent);
			swatches.querySelectorAll(".zs-swatch").forEach((swatch) => {
				let checked = swatch.dataset.color !== undefined
					? swatch.dataset.color === appearance.accent
					: !isPreset;
				swatch.setAttribute("aria-checked", String(checked));
			});
			glassRows.forEach(row => (row.hidden = appearance.style !== "glass"));
			glowRows.forEach(row => (row.hidden = appearance.style !== "glass" || !appearance.glow));
			imageRows.forEach(row => (row.hidden = !appearance.background));
			preview.style.backgroundImage = appearance.background
				? "url(\"" + this.backgroundURL(appearance.background) + "\")" : "";
			preview.hidden = !appearance.background;
			removeImage.disabled = !appearance.background;
			// Corners follow the style until one is picked, so show the effective choice.
			corners.querySelectorAll("button").forEach((button, i) => button.setAttribute("aria-checked",
				String(["square", "rounded", "round"][i] === prefsRoot.dataset.corners)));
		};

		let swatches = this.el(doc, "div", "zs-swatches");
		swatches.setAttribute("role", "radiogroup");
		for (let accent of this.ACCENTS) {
			let swatch = this.el(doc, "button", "zs-swatch");
			swatch.type = "button";
			swatch.setAttribute("role", "radio");
			swatch.dataset.color = accent.color;
			swatch.title = accent.name;
			swatch.setAttribute("aria-label", accent.name);
			swatch.style.background = accent.color || "var(--accent-blue, " + this.ZOTERO_ACCENT + ")";
			swatch.addEventListener("click", () => update({ accent: accent.color }));
			swatches.appendChild(swatch);
		}
		let custom = this.el(doc, "label", "zs-swatch zs-swatch-custom");
		custom.title = "Custom colour";
		let picker = doc.createElement("input");
		picker.type = "color";
		picker.value = appearance.accent || this.ZOTERO_ACCENT;
		picker.setAttribute("aria-label", "Custom colour");
		picker.addEventListener("input", () => update({ accent: picker.value }));
		custom.appendChild(picker);
		swatches.appendChild(custom);

		// Background image: a thumbnail with Choose and Remove.
		let preview = this.el(doc, "span", "zs-bg-preview");
		let chooseImage = this.el(doc, "button", "zs-button", "Choose image…");
		chooseImage.type = "button";
		chooseImage.addEventListener("click", async () => {
			try {
				let name = await this.pickBackground(doc.defaultView);
				if (name) {
					let old = appearance.background;
					update({ background: name });
					await this.removeBackgroundFile(old);
				}
			}
			catch (e) {
				this.logError("pickBackground", e);
				doc.defaultView.alert(String((e && e.message) || e));
			}
		});
		let removeImage = this.el(doc, "button", "zs-button", "Remove");
		removeImage.type = "button";
		removeImage.addEventListener("click", async () => {
			let old = appearance.background;
			update({ background: "" });
			await this.removeBackgroundFile(old);
		});
		let imageControls = this.el(doc, "div", "zs-button-row");
		imageControls.append(preview, chooseImage, removeImage);

		let corners = this.segmented(doc, [["square", "Square"], ["rounded", "Rounded"], ["round", "Round"]],
			"", v => update({ corners: v }));

		let row = (...args) => this.row(doc, ...args);
		let slider = (key, min, max, unit) => this.range(doc, { min, max, value: appearance[key], unit }, v => update({ [key]: v }));
		imageRows.push(
			row("Image visibility", slider("imageVisibility", 0, 100, "%"), "Lower values fade the image into the pane so text stays readable."),
			row("Image blur", slider("imageBlur", 0, 20, "px")),
		);
		glassRows.push(
			row("Glass opacity", slider("glassOpacity", 10, 95, "%"), "How solid messages and the message box are."),
			row("Glass blur", slider("glassBlur", 0, 40, "px"), "How much the message box and menus blur what is behind them."),
			row("Background glow", this.switchControl(doc, appearance.glow, v => update({ glow: v }))),
		);
		glowRows.push(row("Glow intensity", slider("glowStrength", 0, 100, "%")));

		card.body.append(
			row("Style", this.segmented(doc, [["glass", "Glass"], ["flat", "Flat"]], appearance.style, v => update({ style: v }))),
			row("Buddy", this.tiles(doc, Object.entries(this.MASCOTS).map(([value, m]) => ({ value, label: m.label, icon: m.icon || "none" })),
				appearance.mascot, v => update({ mascot: v })), null, { stack: true }),
			row("Pattern", this.tiles(doc, Object.entries(this.PATTERNS).map(([value, p]) => ({ value, label: p.label, icon: p.icon })),
				appearance.pattern, v => update({ pattern: v })), null, { stack: true }),
			row("Button labels", this.segmented(doc, [["icons", "Icons only"], ["text", "Icons + text"]], appearance.labels, v => update({ labels: v }))),
			row("Accent colour", swatches, "Used for the send button, links, theorem boxes and drawings."),
			row("Background image", imageControls, "Shown behind the chat."),
			...imageRows,
			...glassRows,
			...glowRows,
			row("Corners", corners),
			row("Spacing", this.segmented(doc, [["compact", "Compact"], ["comfortable", "Comfortable"], ["roomy", "Roomy"]], appearance.density, v => update({ density: v }))),
			row("Font", this.segmented(doc, Object.entries(this.FONTS), appearance.font, v => update({ font: v }))),
			row("Your messages", this.segmented(doc, [["neutral", "Neutral"], ["accent", "Tinted"]], appearance.bubble, v => update({ bubble: v }))),
			row("Text size", this.segmented(doc, [["small", "Small"], ["default", "Default"], ["large", "Large"]], appearance.size, v => update({ size: v }))),
		);
		update({});
		return card;
	},

	buildBehaviourCard(doc) {
		let card = this.card(doc, "Behaviour", "How answers are written and how the chat behaves.");
		let behaviour = this.getBehaviour();
		let update = (changes) => {
			behaviour = Object.assign({}, behaviour, changes);
			this.saveBehaviour(behaviour);
		};
		let row = (...args) => this.row(doc, ...args);
		let tilesFor = key => this.tiles(doc,
			Object.entries(this.BEHAVIOUR[key]).map(([value, o]) => ({ value, label: o.label, icon: o.icon })),
			behaviour[key], v => update({ [key]: v }));
		let custom = this.el(doc, "textarea", "zs-textarea");
		custom.rows = 6;
		custom.maxLength = this.CUSTOM_PROMPT_CHARS;
		custom.placeholder = "e.g. Use SI units. Relate ideas to linear algebra.";
		custom.value = behaviour.custom || this.PERSONAS.colleague.text;
		custom.addEventListener("input", () => update({ custom: this.customFor(custom.value) }));
		custom.addEventListener("blur", () => {
			if (!custom.value.trim()) {
				custom.value = this.PERSONAS.colleague.text;
			}
		});
		let toggle = key => this.switchControl(doc, behaviour[key], v => update({ [key]: v }));
		card.body.append(
			row("Answer length", tilesFor("length"), null, { stack: true }),
			row("Level", tilesFor("level"), null, { stack: true }),
			row("Tone", tilesFor("tone"), null, { stack: true }),
			row("System prompt", custom, "How Zusia talks to you. Your text replaces the default voice and wins over " +
				"the presets above, while page citations and the safety rules stay; empty it to go back to the default. " +
				"A change starts a fresh assistant session, with the chat carried over.", { stack: true }),
			row("Send with", this.segmented(doc, [["enter", "Enter"], ["mod-enter", "⌘/Ctrl + Enter"]], behaviour.sendKey, v => update({ sendKey: v }))),
			row("Follow the answer", toggle("autoScroll"), "Scroll along while the answer is written."),
			row("Thinking steps", toggle("showSteps"), "Show what the assistant read and searched."),
			row("Quick prompts", toggle("showQuick")),
		);
		return card;
	},

	buildTroubleshootingCard(doc) {
		let card = this.card(doc, "Troubleshooting",
			"Conversations are stored per paper in the data folder. The debug log records what the sidebar ran and any errors.");
		let folder = this.el(doc, "button", "zs-button", "Show data folder");
		folder.type = "button";
		folder.addEventListener("click", async () => {
			await Zotero.File.createDirectoryIfMissingAsync(this.getDataDir());
			Zotero.File.reveal(this.getDataDir());
		});
		let logButton = this.el(doc, "button", "zs-button", "Open debug log");
		logButton.type = "button";
		logButton.addEventListener("click", () => Zotero.launchFile(this.getLogPath()));
		let setup = this.el(doc, "button", "zs-button", "Run setup again");
		setup.type = "button";
		setup.addEventListener("click", () => this.setPref("onboarded", false));
		let buttons = this.el(doc, "div", "zs-button-row");
		buttons.append(folder, logButton, setup);
		card.body.appendChild(this.row(doc, "Files", buttons));
		let rebuild = this.el(doc, "button", "zs-button", "Rebuild reading map");
		rebuild.type = "button";
		let rebuildRow = this.row(doc, "Reading map", rebuild,
			"Page numbers, sections and the book's text files are worked out again on each paper's next question.");
		rebuild.addEventListener("click", () => {
			rebuild.disabled = true;
			let hint = rebuildRow.querySelector(".zs-row-hint");
			this.rebuildReadingMaps().then((count) => {
				rebuild.disabled = false;
				hint.textContent = count
					? count + (count > 1 ? " reading maps" : " reading map") + " will be rebuilt on the next question."
					: "No reading map was built yet.";
			}, (e) => {
				this.logError("rebuildReadingMaps", e);
				rebuild.disabled = false;
				hint.textContent = "Could not rebuild: " + ((e && e.message) || e);
			});
		});
		card.body.appendChild(rebuildRow);
		return card;
	},
});
