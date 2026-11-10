"use strict";

Object.assign(Zusia, {
	// How much the chat shows around the conversation (Settings → Appearance → Layout).
	// The skeleton is the same for all of them; styles/layouts.css shows, hides and
	// arranges its parts by data-layout. `look` is what choosing a layout also sets,
	// and every part of it stays changeable on its own afterwards.
	LAYOUTS: {
		minimal: {
			label: "Minimal", icon: "toneNeutral", hint: "only the conversation and the message box, the tools in one menu.",
			look: { style: "flat", mascot: "none", pattern: "none", glow: false, labels: "icons", density: "compact", bubble: "neutral" },
		},
		standard: {
			label: "Standard", icon: "prompt", hint: "the chat, with its tools as icons one click away.",
			look: { style: "glass", pattern: "none", glow: true, labels: "icons", density: "comfortable", bubble: "neutral" },
		},
		rich: {
			label: "Rich", icon: "lengthDetailed", hint: "a card for the paper with your reading progress, and the tools by name.",
			look: { style: "glass", pattern: "none", glow: true, labels: "text", density: "comfortable", bubble: "neutral" },
		},
		visual: {
			label: "Visual", icon: "palette", hint: "your buddy beside each answer, bubbles, prompt cards and colour.",
			look: { style: "glass", pattern: "none", glow: true, labels: "icons", density: "roomy", bubble: "accent" },
		},
	},

	// The appearance a layout starts from, on top of what is already chosen.
	layoutLook(layout, appearance = this.getAppearance()) {
		let look = Object.assign({}, appearance, this.LAYOUTS[layout].look, { layout });
		// Only Minimal goes without a buddy; coming back from it brings the cat back.
		if (layout !== "minimal" && look.mascot === "none") {
			look.mascot = "cat";
		}
		return look;
	},

	// Minimal keeps one button in the header; the tools the others show as icons are in its menu.
	openHeaderMenu(root, anchor) {
		let doc = root.ownerDocument;
		this.openMenu(root, anchor, (menu) => {
			let item = (label, desc, run) => this.menuItem(doc, menu, {
				label, desc, onSelect: () => {
					this.closeMenu(root);
					run();
				},
			});
			item("Previous chats", "Reopen an earlier chat about this paper", () => this.openHistoryMenu(root));
			item("Search all chats", "Across every paper", () => this.openSearchMenu(root));
			item("Clarifications", "What you asked about highlighted text", () =>
				this.openClarifications(root).catch(e => this.logError("openClarifications", e)));
			item("Settings", "Assistants, look and behaviour", () => this.openSettings());
			if (root.closest(".zs-dock")) {
				item("Hide Zusia", "Leaves a rail at the edge to bring it back", () => this.setDockOpen(false));
			}
		}, { placement: "below", align: "end" });
	},

	// Rich and Visual show the paper above the conversation: who wrote it, where you
	// are in it and how much of it you have read. It opens the Memory sheet, as the
	// chip in the message box does in the other layouts.
	renderPaperCard(root, info) {
		let card = root.querySelector(".zs-paper-card");
		if (!card) {
			return;
		}
		card.textContent = "";
		card.hidden = !info;
		if (!info) {
			return;
		}
		let doc = root.ownerDocument;
		card.appendChild(this.svgIcon(doc, "paper", "zs-paper-card-icon"));
		let text = this.el(doc, "div", "zs-paper-card-text");
		text.appendChild(this.el(doc, "div", "zs-paper-card-title", info.title || info.label));
		if (info.title && info.label !== info.title) {
			text.appendChild(this.el(doc, "div", "zs-paper-card-byline", info.label));
		}
		if (info.reading) {
			text.appendChild(this.el(doc, "div", "zs-paper-card-reading", info.reading));
		}
		card.appendChild(text);
		if (Number.isFinite(info.readFraction)) {
			let percent = Math.round(info.readFraction * 100);
			let bar = this.el(doc, "div", "zs-paper-card-progress");
			bar.setAttribute("role", "progressbar");
			bar.setAttribute("aria-valuemin", "0");
			bar.setAttribute("aria-valuemax", "100");
			bar.setAttribute("aria-valuenow", String(percent));
			bar.title = percent + "% of the pages read";
			bar.style.setProperty("--zs-read", percent + "%");
			card.appendChild(bar);
		}
		let status = this.memoryStatus(this._views.get(root)?.ctx.dir);
		if (status) {
			let line = this.el(doc, "div", "zs-paper-card-status", status);
			line.setAttribute("role", "status");
			text.appendChild(line);
		}
		card.title = "Click to see the reading map and what Zusia remembers";
	},
});
