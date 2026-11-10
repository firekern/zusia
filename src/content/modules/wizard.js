"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// First-run setup wizard: a few visual steps over the chat
	// ---------------------------------------------------------------------

	showWizard(root) {
		let doc = root.ownerDocument;
		root.querySelector(".zs-wizard")?.remove();
		let wizard = this.el(doc, "div", "zs-wizard");
		wizard.setAttribute("role", "dialog");
		wizard.setAttribute("aria-label", "Set up the sidebar");
		let panel = this.el(doc, "div", "zs-wizard-panel");
		let skip = this.iconButton(doc, "zs-small zs-wizard-skip", "Skip setup", "remove", () => this.finishWizard(root));
		let stage = this.el(doc, "div", "zs-wizard-stage");
		let nav = this.el(doc, "div", "zs-wizard-nav");
		let prev = this.iconButton(doc, "zs-wizard-prev", "Back", "previous", () => go(index - 1));
		let dots = this.el(doc, "div", "zs-wizard-dots");
		let next = this.iconButton(doc, "zs-wizard-next", "Next", "next", () => {
			if (index === this.WIZARD_STEPS.length - 1) {
				this.finishWizard(root);
			}
			else {
				go(index + 1);
			}
		});
		for (let i = 0; i < this.WIZARD_STEPS.length; i++) {
			dots.appendChild(this.el(doc, "span", "zs-wizard-dot"));
		}
		nav.append(prev, dots, next);
		panel.append(skip, stage, nav);
		wizard.appendChild(panel);
		wizard.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.finishWizard(root);
			}
		});
		let index = 0;
		let go = (to) => {
			index = Math.max(0, Math.min(this.WIZARD_STEPS.length - 1, to));
			let name = this.WIZARD_STEPS[index];
			wizard.dataset.step = name;
			stage.textContent = "";
			stage.appendChild(this.wizardStep(root, name));
			prev.hidden = index === 0;
			let last = index === this.WIZARD_STEPS.length - 1;
			next.replaceChildren(this.svgIcon(doc, last ? "done" : index === 0 ? "rocket" : "next"));
			next.title = last ? "Start chatting" : index === 0 ? "Start" : "Next";
			next.setAttribute("aria-label", next.title);
			[...dots.children].forEach((dot, i) => {
				dot.classList.toggle("zs-wizard-dot-done", i < index);
				if (i === index) {
					dot.setAttribute("aria-current", "step");
				}
				else {
					dot.removeAttribute("aria-current");
				}
			});
			stage.classList.remove("zs-wizard-enter");
			void stage.offsetWidth;
			stage.classList.add("zs-wizard-enter");
		};
		root.appendChild(wizard);
		go(0);
		doc.defaultView.setTimeout(() => next.focus(), 0);
		return wizard;
	},

	finishWizard(root) {
		this.setPref("onboarded", true);
		// Its last step said what the dock's note for people who update says.
		this.setPref("dockTipSeen", true);
		root.querySelector(".zs-wizard")?.remove();
		root.querySelector(".zs-input")?.focus();
	},

	// One wizard step: a big picture, a one- or two-word title, and visual choices.
	wizardStep(root, name) {
		let doc = root.ownerDocument;
		let step = this.el(doc, "div", "zs-wizard-step");
		let hero = (icon, title) => {
			let big = this.svgIcon(doc, icon, icon.startsWith("mascot-") ? "zs-mascot zs-wizard-hero" : "zs-wizard-hero");
			step.append(big, this.el(doc, "div", "zs-wizard-title", title));
		};
		let section = (icon, label, control) => {
			let row = this.el(doc, "div", "zs-wizard-section");
			let head = this.el(doc, "div", "zs-wizard-section-head");
			head.append(this.svgIcon(doc, icon), this.el(doc, "span", null, label));
			row.append(head, control);
			step.appendChild(row);
		};
		let appearance = () => this.getAppearance();
		let setAppearance = (changes) => {
			let next = Object.assign({}, appearance(), changes);
			this.saveAppearance(next);
			this.applyAppearance(root, next);
		};
		let mascotIcon = () => this.MASCOTS[appearance().mascot].icon || "wave";

		if (name === "welcome") {
			hero(mascotIcon(), "Hi, study buddy!");
			step.appendChild(this.el(doc, "div", "zs-wizard-sub", "A few quick picks and you're set."));
		}
		else if (name === "assistant") {
			hero("sparkle", "Your AI");
			let installed = root._installed || {};
			let tiles = this.tiles(doc, Object.entries(this.BACKENDS).map(([value, b]) => ({ value, label: b.label, icon: this.BACKEND_ICONS[value] })),
				this.getBackend(), (v) => {
					this.setPref("backend", v);
					this.updateControls(root);
				});
			for (let tile of tiles.querySelectorAll(".zs-tile")) {
				if (installed[tile.dataset.value] === null) {
					// Shown as a small badge; the name stays the tooltip.
					tile.dataset.missing = "true";
					tile.setAttribute("aria-description", "not installed");
				}
			}
			step.appendChild(tiles);
		}
		else if (name === "look") {
			hero("palette", "Your look");
			let styles = this.tiles(doc, [
				{ value: "glass", label: "Glass", icon: "styleGlass" },
				{ value: "flat", label: "Flat", icon: "styleFlat" },
			], appearance().style, v => setAppearance({ style: v }));
			section("prompt", "Layout", this.tiles(doc,
				Object.entries(this.LAYOUTS).map(([value, l]) => ({ value, label: l.label, icon: l.icon })),
				appearance().layout, (v) => {
					setAppearance(this.layoutLook(v));
					// A layout brings its own style, which the tiles below must show.
					for (let tile of styles.querySelectorAll(".zs-tile")) {
						tile.setAttribute("aria-checked", String(tile.dataset.value === appearance().style));
					}
				}));
			section("palette", "Style", styles);
			let swatches = this.accentSwatches(doc, (accent) => {
				setAppearance({ accent });
				this.markAccent(swatches, accent);
			});
			this.markAccent(swatches, appearance().accent);
			section("sparkle", "Colour", swatches);
		}
		else if (name === "buddy") {
			hero(mascotIcon(), "Your buddy");
			let heroEl = step.querySelector(".zs-wizard-hero");
			section("toneFriendly", "Buddy", this.tiles(doc,
				Object.entries(this.MASCOTS).map(([value, m]) => ({ value, label: m.label, icon: m.icon || "none" })),
				appearance().mascot, (v) => {
					setAppearance({ mascot: v });
					let icon = this.MASCOTS[v].icon || "wave";
					heroEl.replaceWith(this.svgIcon(doc, icon, icon.startsWith("mascot-") ? "zs-mascot zs-wizard-hero" : "zs-wizard-hero"));
					heroEl = step.querySelector(".zs-wizard-hero");
				}));
			section("patternMath", "Pattern", this.tiles(doc,
				Object.entries(this.PATTERNS).map(([value, p]) => ({ value, label: p.label, icon: p.icon })),
				appearance().pattern, v => setAppearance({ pattern: v })));
		}
		else if (name === "answers") {
			hero("levelStudent", "Your answers");
			section("levelStudent", "Level", this.tiles(doc,
				Object.entries(this.BEHAVIOUR.level).map(([value, o]) => ({ value, label: o.label, icon: o.icon })),
				this.getBehaviour().level, v => this.saveBehaviour(Object.assign(this.getBehaviour(), { level: v }))));
			let language = this.select(doc, this.LANGUAGES.map(l => [l, l || "Same as my question"]), this.getLanguage(),
				v => this.setPref("language", v));
			language.title = "Answer language";
			section("language", "Language", language);
			let modes = this.el(doc, "div", "zs-tiles");
			for (let [id, mode] of Object.entries(this.MODES)) {
				let tile = this.el(doc, "button", "zs-tile");
				tile.type = "button";
				tile.title = mode.label;
				tile.setAttribute("aria-pressed", String(this.isModeOn(id)));
				tile.append(this.svgIcon(doc, mode.icon, "zs-tile-icon"), this.el(doc, "span", "zs-tile-label", mode.label));
				tile.addEventListener("click", () => {
					let on = !this.isModeOn(id);
					this.setPref("mode." + id, on);
					tile.setAttribute("aria-pressed", String(on));
					this.updateControls(root);
				});
				modes.appendChild(tile);
			}
			section("drawing", "Extras", modes);
		}
		else if (name === "voice") {
			hero("prompt", "Your voice");
			step.appendChild(this.el(doc, "div", "zs-wizard-sub", "How Zusia talks to you. Pick a start, then make it yours."));
			let presetFor = text => Object.keys(this.PERSONAS).find(id => this.PERSONAS[id].text === text.trim()) || "";
			let text = this.el(doc, "textarea", "zs-textarea");
			text.rows = 8;
			text.maxLength = this.CUSTOM_PROMPT_CHARS;
			text.setAttribute("aria-label", "System prompt");
			text.value = this.getBehaviour().custom || this.PERSONAS.colleague.text;
			let count = this.el(doc, "span", "zs-wizard-count");
			let assembled = this.el(doc, "pre", "zs-wizard-sent-text");
			let save = () => {
				this.saveBehaviour(Object.assign(this.getBehaviour(), { custom: this.customFor(text.value) }));
				refresh();
			};
			let presets = this.tiles(doc, Object.entries(this.PERSONAS).map(([value, p]) => ({ value, label: p.label, icon: p.icon })),
				presetFor(text.value), (v) => {
					text.value = this.PERSONAS[v].text;
					save();
				});
			let refresh = () => {
				count.textContent = text.value.length + " / " + this.CUSTOM_PROMPT_CHARS;
				let preset = presetFor(text.value);
				presets.querySelectorAll(".zs-tile").forEach(t => t.setAttribute("aria-checked", String(t.dataset.value === preset)));
				assembled.textContent = this.systemPrompt({ inline: this.getBackend() === "agy" });
			};
			text.addEventListener("input", save);
			text.addEventListener("blur", () => {
				if (!text.value.trim()) {
					text.value = this.PERSONAS.colleague.text;
					refresh();
				}
			});
			let reset = this.el(doc, "button", "zs-button", "Reset to default");
			reset.type = "button";
			reset.title = "Reset to default";
			reset.addEventListener("click", () => {
				text.value = this.PERSONAS.colleague.text;
				save();
			});
			let foot = this.el(doc, "div", "zs-wizard-voice-foot");
			foot.append(count, reset);
			let editor = this.el(doc, "div", "zs-wizard-voice");
			editor.append(text, foot);
			section("toneNeutral", "Start from", presets);
			section("edit", "System prompt", editor);
			// Read-only: the whole prompt, so a surprising tone can be traced to the layer that set it.
			let sent = this.el(doc, "details", "zs-wizard-sent");
			sent.append(this.el(doc, "summary", null, "Show what gets sent"), assembled);
			step.appendChild(sent);
			refresh();
		}
		else if (name === "done") {
			hero(mascotIcon(), "Ready!");
			step.appendChild(this.el(doc, "div", "zs-wizard-sub", "Change anything later in Settings."));
			// The one thing about the panel nothing on screen says.
			if (root.closest(".zs-dock")) {
				step.appendChild(this.el(doc, "div", "zs-wizard-sub zs-wizard-tip",
					this.shortcutLabel(this.DOCK_KEY) + " shows and hides this panel."));
			}
		}
		return step;
	},
});
