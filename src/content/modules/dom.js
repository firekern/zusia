"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// DOM helpers
	// ---------------------------------------------------------------------

	el(doc, tag, className, text) {
		let node = doc.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	},

	svgIcon(doc, name, className) {
		let icon = this.el(doc, "span", "zs-i" + (className ? " " + className : ""));
		icon.dataset.icon = name;
		icon.setAttribute("aria-hidden", "true");
		if (this.ICON_FILES[name]) {
			this.loadIcon(doc, name).then((svg) => {
				if (svg && !icon.firstChild) {
					icon.appendChild(doc.importNode(svg, true));
				}
			});
		}
		return icon;
	},

	// Fetches a Zotero icon once and returns an <svg> that paints with currentColor.
	loadIcon(doc, name) {
		let url = this.iconBase + this.ICON_FILES[name];
		if (!this._iconCache.has(url)) {
			let win = doc.defaultView;
			let promise = (async () => {
				try {
					let text = await (await win.fetch(url)).text();
					let svg = new win.DOMParser().parseFromString(text, "image/svg+xml").documentElement;
					if (svg.localName !== "svg") {
						throw new Error("not an SVG");
					}
					// Zotero paints icons with context-fill/context-stroke, used in either
					// attribute (attachment.svg strokes with context-fill).
					for (let attr of ["fill", "stroke"]) {
						for (let node of svg.querySelectorAll("[" + attr + "^='context-']")) {
							node.setAttribute(attr, "currentColor");
						}
					}
					for (let node of svg.querySelectorAll("[opacity]")) {
						node.removeAttribute("opacity");
						node.setAttribute("class", "zs-duo");
					}
					svg.removeAttribute("width");
					svg.removeAttribute("height");
					return svg;
				}
				catch (e) {
					this.log("Could not load icon " + url + ": " + e);
					return null;
				}
			})();
			this._iconCache.set(url, promise);
		}
		return this._iconCache.get(url);
	},

	// Every chat on screen, in every main window.
	*allRoots() {
		for (let win of Zotero.getMainWindows()) {
			yield* win.document.querySelectorAll(".zs-root");
		}
	},

	// For an element that is not a <button> but acts as one: a click, Enter and Space run it.
	asButton(node, run) {
		node.setAttribute("role", "button");
		node.tabIndex = 0;
		node.addEventListener("click", run);
		node.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				run();
			}
		});
	},

	// A sheet over the chat (Clarifications, Reading memory): one at a time, closed by its
	// button or Escape. The caller fills `body` and may add to `head`.
	openPanel(root, { label, icon, className = "" }) {
		let doc = root.ownerDocument;
		root.querySelector(".zs-panel")?.remove();
		let panel = this.el(doc, "div", ("zs-panel " + className).trim());
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", label);
		let head = this.el(doc, "div", "zs-panel-head");
		let title = this.el(doc, "div", "zs-panel-title");
		title.append(this.svgIcon(doc, icon), this.el(doc, "span", null, label));
		head.append(title, this.iconButton(doc, "zs-small zs-panel-close", "Close", "remove", () => panel.remove()));
		let body = this.el(doc, "div", "zs-panel-body");
		panel.append(head, body);
		panel.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				panel.remove();
			}
		});
		root.appendChild(panel);
		return { panel, head, body };
	},

	// The accent colours as radio swatches; markAccent() says which one is chosen.
	accentSwatches(doc, onPick) {
		let group = this.el(doc, "div", "zs-swatches");
		group.setAttribute("role", "radiogroup");
		for (let accent of this.ACCENTS) {
			let swatch = this.el(doc, "button", "zs-swatch");
			swatch.type = "button";
			swatch.setAttribute("role", "radio");
			swatch.dataset.color = accent.color;
			swatch.title = accent.name;
			swatch.setAttribute("aria-label", accent.name);
			swatch.style.background = accent.color || "var(--accent-blue, " + this.ZOTERO_ACCENT + ")";
			swatch.addEventListener("click", () => onPick(accent.color));
			group.appendChild(swatch);
		}
		return group;
	},

	// A swatch with no colour of its own (the custom one in Settings) stands for every other colour.
	markAccent(group, accent) {
		let preset = this.ACCENTS.some(a => a.color === accent);
		for (let swatch of group.querySelectorAll(".zs-swatch")) {
			swatch.setAttribute("aria-checked", String(swatch.dataset.color !== undefined ? swatch.dataset.color === accent : !preset));
		}
	},

	iconButton(doc, className, title, icon, onClick) {
		let button = this.el(doc, "button", "zs-icon " + (className || ""));
		button.type = "button";
		button.title = title;
		button.setAttribute("aria-label", title);
		button.appendChild(this.svgIcon(doc, icon));
		button.addEventListener("click", onClick);
		return button;
	},

	ghostButton(doc, className, icon, label, onClick, { chevron = false } = {}) {
		let button = this.el(doc, "button", "zs-ghost " + (className || ""));
		button.type = "button";
		if (icon) {
			button.appendChild(this.svgIcon(doc, icon));
		}
		let text = this.el(doc, "span", "zs-label", label);
		button.appendChild(text);
		if (chevron) {
			button.appendChild(this.svgIcon(doc, "chevron", "zs-chevron"));
			button.setAttribute("aria-haspopup", "menu");
			button.setAttribute("aria-expanded", "false");
		}
		// Labels can be hidden (Appearance → Button labels), so the name also lives in the tooltip.
		if (label) {
			button.title = label;
		}
		button.addEventListener("click", onClick);
		button.setLabel = (value) => {
			text.textContent = value;
		};
		return button;
	},

	// ---------------------------------------------------------------------
	// Menus (one open at a time, anchored to a button inside .zs-root)
	// ---------------------------------------------------------------------

	closeMenu(root) {
		let menu = root.querySelector(".zs-menu");
		if (menu) {
			menu._cleanup?.();
			menu.remove();
		}
		root.querySelectorAll('[aria-expanded="true"]').forEach(b => b.setAttribute("aria-expanded", "false"));
	},

	// `build(menu)` fills the menu; it may be called again to refresh it in place.
	openMenu(root, anchor, build, { placement = "above", align = "start" } = {}) {
		let wasOpen = anchor.getAttribute("aria-expanded") === "true";
		this.closeMenu(root);
		if (wasOpen) {
			return null;
		}
		let doc = root.ownerDocument;
		let win = doc.defaultView;
		let menu = this.el(doc, "div", "zs-menu");
		menu.setAttribute("role", "menu");
		root.appendChild(menu);
		anchor.setAttribute("aria-expanded", "true");

		// Menus opened from the composer sit above the whole card, not over the text being typed.
		let verticalAnchor = anchor.closest(".zs-composer") || anchor;
		let position = () => {
			let rootRect = root.getBoundingClientRect();
			// Client rects are in zoomed pixels, style lengths are not: convert.
			let scale = root.offsetWidth ? rootRect.width / root.offsetWidth : 1;
			let rect = anchor.getBoundingClientRect();
			let vRect = verticalAnchor.getBoundingClientRect();
			let width = menu.offsetWidth;
			let rootWidth = root.offsetWidth;
			let left = align === "end"
				? (rect.right - rootRect.left) / scale - width
				: (rect.left - rootRect.left) / scale;
			left = Math.max(0, Math.min(left, rootWidth - width));
			menu.style.left = left + "px";
			if (placement === "above") {
				menu.style.bottom = ((rootRect.bottom - vRect.top) / scale + 4) + "px";
				menu.style.top = "";
			}
			else {
				menu.style.top = ((vRect.bottom - rootRect.top) / scale + 4) + "px";
				menu.style.bottom = "";
			}
		};
		menu.refresh = () => {
			menu.textContent = "";
			build(menu);
			position();
		};
		menu.refresh();

		let onPointer = (event) => {
			if (!menu.contains(event.target) && !anchor.contains(event.target)) {
				this.closeMenu(root);
			}
		};
		// Roving focus, as in Beaver's menus: arrows move, Home/End jump, Tab closes.
		let onKey = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.closeMenu(root);
				anchor.focus();
				return;
			}
			if (event.key === "Tab") {
				this.closeMenu(root);
				return;
			}
			let items = [...menu.querySelectorAll(".zs-menu-item:not(:disabled)")];
			if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
				return;
			}
			event.preventDefault();
			let current = items.indexOf(doc.activeElement);
			let next = event.key === "Home" ? 0
				: event.key === "End" ? items.length - 1
				: event.key === "ArrowDown" ? (current + 1) % items.length
				: (current <= 0 ? items.length - 1 : current - 1);
			items[next].focus();
		};
		doc.addEventListener("mousedown", onPointer, true);
		doc.addEventListener("keydown", onKey, true);
		menu._cleanup = () => {
			doc.removeEventListener("mousedown", onPointer, true);
			doc.removeEventListener("keydown", onKey, true);
		};
		win.setTimeout(() => (menu.querySelector('.zs-menu-item[aria-checked="true"]:not(:disabled)')
			|| menu.querySelector(".zs-menu-item:not(:disabled)"))?.focus(), 0);
		return menu;
	},

	menuSection(doc, menu, label) {
		menu.appendChild(this.el(doc, "div", "zs-menu-section", label));
	},

	menuItem(doc, menu, { label, desc, checked, disabled, onSelect }) {
		let item = this.el(doc, "button", "zs-menu-item");
		item.type = "button";
		item.setAttribute("role", checked === undefined ? "menuitem" : "menuitemradio");
		if (checked !== undefined) {
			item.setAttribute("aria-checked", String(!!checked));
			item.appendChild(this.svgIcon(doc, "check", "zs-check"));
		}
		let text = this.el(doc, "span", "zs-menu-text");
		text.appendChild(this.el(doc, "span", "zs-menu-label", label));
		if (desc) {
			text.appendChild(this.el(doc, "span", "zs-menu-desc", desc));
		}
		item.appendChild(text);
		item.disabled = !!disabled;
		item.addEventListener("click", onSelect);
		menu.appendChild(item);
		return item;
	},
});
