"use strict";

Object.assign(Zusia, {
	// The chat as its own column at one edge of the main window, under the tab bar, so it
	// is the same panel in the library and in every reader tab. The other placement is the
	// section in Zotero's item pane (window.js).
	DOCK_WIDTH: { min: 280, initial: 380 },
	// What Zotero's own panes need beside the dock. In the library that is its items list
	// (370px, $min-width-items-pane) plus the panes Zotero itself counts as fixed, which it
	// publishes on the root element; elsewhere the reader, which shrinks further.
	ZOTERO_NEEDS: { items: 370, fixed: 557, reader: 600 },
	// As a drawer, the dock leaves at least this much of the window uncovered.
	DOCK_DRAWER_GAP: 120,
	// With Alt, like the chat's own shortcuts: shows or hides the dock from anywhere in the window.
	DOCK_KEY: "Z",
	// What addDock gave each main window, taken back by removeDock.
	_docks: new Map(),
	_tabObserver: null,

	// "right" or "left" is the edge the panel is at; "pane" is the item pane section.
	placement() {
		let placement = this.getPref("placement");
		return placement === "pane" || placement === "left" ? placement : "right";
	},

	docked() {
		return this.placement() !== "pane";
	},

	setPlacement(placement) {
		this.setPref("placement", placement);
		this.applyPlacement();
	},

	// At startup and whenever the placement changes: exactly one of the two is in place.
	applyPlacement() {
		let docked = this.docked();
		if (docked) {
			this.unregisterPaneSection();
			this.watchTabs();
		}
		else {
			this.unwatchTabs();
			if (!this.paneID) {
				this.registerPaneSection();
			}
		}
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) {
				continue;
			}
			if (docked) {
				this.addDock(win);
				this.placeDock(win);
			}
			else {
				this.removeDock(win);
			}
		}
	},

	removePlacement() {
		this.unwatchTabs();
		this.unregisterPaneSection();
		for (let win of [...this._docks.keys()]) {
			this.removeDock(win);
		}
	},

	addDock(win) {
		if (this._docks.has(win)) {
			return;
		}
		let doc = win.document;
		let box = this.el(doc, "div", "zs-dock");
		box.id = "zusia-dock";
		let body = this.el(doc, "div", "zs-dock-body");
		let rail = this.el(doc, "div", "zs-dock-rail");
		let resizer = this.el(doc, "div", "zs-dock-resizer");
		resizer.addEventListener("pointerdown", event => this.startDockResize(win, event));
		// A double click puts the width back, as Zotero's own splitters do.
		resizer.addEventListener("dblclick", () => this.setDockWidth(this.DOCK_WIDTH.initial));
		box.append(rail, body, resizer);

		let dock = { box, body, rail, resizer, paperID: null, rendered: false, itemsView: null, treeTimer: null, readerTimer: null, fixed: null, tip: null };
		// Returns nothing: Zotero awaits what a select listener returns before it calls the
		// next one, and a render can last as long as an answer being written.
		dock.onSelect = () => {
			this.syncDock(win).catch(e => this.logError("syncDock", e));
		};
		dock.onKey = (event) => {
			if (event.code !== "Key" + this.DOCK_KEY || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
				return;
			}
			// On a Mac, Option with a letter types a character, and on some layouts one in
			// daily use (ż on the Polish one): a text field keeps the key.
			let target = event.originalTarget || event.target;
			if (Zotero.isMac && (target.isContentEditable || /^(input|textarea)$/.test(target.localName))) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			this.setDockOpen(!this.dockOpen());
			if (this.dockOpen()) {
				this.focusVisibleInput(doc);
			}
		};
		// Capturing, so it works whichever of Zotero's panes has the focus.
		win.addEventListener("keydown", dock.onKey, true);
		// The room beside Zotero's panes changes with the window, and when one of them is
		// collapsed or dragged: Zotero then rewrites what its fixed panes need on the root.
		dock.onResize = () => this.updateDock(win);
		win.addEventListener("resize", dock.onResize);
		dock.needs = new win.MutationObserver(() => {
			let fixed = doc.documentElement.style.getPropertyValue("--width-of-fixed-components");
			if (fixed !== dock.fixed) {
				dock.fixed = fixed;
				this.updateDock(win);
			}
		});
		dock.needs.observe(doc.documentElement, { attributes: true, attributeFilter: ["style"] });
		this._docks.set(win, dock);
		this.placeDock(win);
		// The chat view of the item pane would hide Zotero's sections around a section that is gone.
		doc.documentElement.setAttribute(this.VIEW_ATTR, "details");
		for (let details of doc.querySelectorAll("item-details[zs-chat-ready]")) {
			details.removeAttribute("zs-chat-ready");
		}
		this.watchSelection(win, dock);
		this.updateDock(win);
	},

	// Puts the panel at the edge chosen in Settings. Moving it keeps the chat it holds.
	placeDock(win) {
		let { box } = this._docks.get(win);
		let side = this.placement();
		if (box.dataset.side === side) {
			return;
		}
		box.dataset.side = side;
		win.document.getElementById("appcontent")[side === "left" ? "before" : "after"](box);
	},

	removeDock(win) {
		let dock = this._docks.get(win);
		if (!dock) {
			return;
		}
		win.clearTimeout(dock.treeTimer);
		win.clearTimeout(dock.readerTimer);
		win.removeEventListener("keydown", dock.onKey, true);
		win.removeEventListener("resize", dock.onResize);
		dock.needs.disconnect();
		dock.itemsView?.onSelect.removeListener(dock.onSelect);
		// As when an item pane section goes: what was said about the paper is folded into its memory.
		let dir = this._shownDirs.get(dock.body);
		if (dir) {
			this.leavePaper(dir);
		}
		dock.box.remove();
		win.document.documentElement.removeAttribute("zs-dock");
		this._docks.delete(win);
	},

	// The items tree is built after the window loads, so a new window has none yet. This
	// wait has a timer of its own: the dock renders meanwhile, and that must not end it.
	watchSelection(win, dock, tries = 40) {
		let itemsView = win.ZoteroPane.itemsView;
		if (!itemsView) {
			if (tries) {
				dock.treeTimer = win.setTimeout(() => this.watchSelection(win, dock, tries - 1), 250);
			}
			return;
		}
		dock.itemsView = itemsView;
		itemsView.onSelect.addListener(dock.onSelect);
		dock.onSelect();
	},

	watchTabs() {
		if (this._tabObserver) {
			return;
		}
		this._tabObserver = Zotero.Notifier.registerObserver({
			notify: (event) => {
				if (event === "select" || event === "load") {
					this.updateDocks();
				}
			},
		}, ["tab"], "zusia-dock");
	},

	unwatchTabs() {
		if (this._tabObserver) {
			Zotero.Notifier.unregisterObserver(this._tabObserver);
			this._tabObserver = null;
		}
	},

	dockOpen() {
		return this.getPref("dockOpen") !== false;
	},

	setDockOpen(open) {
		this.setPref("dockOpen", open);
		this.updateDocks();
	},

	// How wide the dock may be in this window. When Zotero's panes would not keep what
	// they need even beside the narrowest dock, it lies over them as a drawer instead of
	// pushing them out of the window.
	dockLimits(win) {
		let needs = this.ZOTERO_NEEDS.reader;
		if (win.Zotero_Tabs.selectedType === "library") {
			let fixed = parseFloat(win.document.documentElement.style.getPropertyValue("--width-of-fixed-components"));
			needs = this.ZOTERO_NEEDS.items + (Number.isFinite(fixed) ? fixed : this.ZOTERO_NEEDS.fixed);
		}
		let room = win.innerWidth - needs;
		let drawer = room < this.DOCK_WIDTH.min;
		return { drawer, max: Math.max(this.DOCK_WIDTH.min, drawer ? win.innerWidth - this.DOCK_DRAWER_GAP : room) };
	},

	dockWidth(win) {
		let wanted = this.getPref("dockWidth") || this.DOCK_WIDTH.initial;
		return Math.round(Math.min(this.dockLimits(win).max, Math.max(this.DOCK_WIDTH.min, wanted)));
	},

	setDockWidth(width) {
		this.setPref("dockWidth", Math.round(width));
		this.updateDocks();
	},

	updateDocks() {
		for (let win of this._docks.keys()) {
			this.updateDock(win);
		}
	},

	updateDock(win) {
		let dock = this._docks.get(win);
		let open = this.dockOpen();
		win.document.documentElement.setAttribute("zs-dock", open ? "open" : "closed");
		// The rail wears the buddy and the accent chosen in Settings, which may have changed.
		let appearance = this.getAppearance();
		let icon = this.MASCOTS[appearance.mascot].header;
		if (dock.rail.firstChild?.firstChild.dataset.icon !== icon) {
			dock.rail.textContent = "";
			dock.rail.appendChild(this.iconButton(win.document, "zs-dock-open",
				"Show Zusia (" + this.shortcutLabel(this.DOCK_KEY) + ")", icon, () => this.setDockOpen(true)));
		}
		dock.box.style.setProperty("--zs-accent", appearance.accent || "var(--accent-blue)");
		dock.box.style.setProperty("--zs-accent-text", this.textOn(appearance.accent || this.ZOTERO_ACCENT));
		dock.rail.hidden = open;
		this.renderDockTip(win, dock);
		dock.body.hidden = !open;
		dock.resizer.hidden = !open;
		dock.box.style.width = open ? this.dockWidth(win) + "px" : "";
		dock.box.classList.toggle("zs-dock-drawer", open && this.dockLimits(win).drawer);
		if (open) {
			this.syncDock(win).catch(e => this.logError("syncDock", e));
		}
	},

	// For someone who updates: the chat used to be a section of Zotero's item pane, and
	// nothing else says where it went or how to put it back. Shown until it is answered;
	// a new user reads the same in the setup wizard instead.
	renderDockTip(win, dock) {
		let wanted = this.dockOpen() && this.getPref("onboarded") === true && this.getPref("dockTipSeen") !== true;
		if (!wanted) {
			dock.tip?.remove();
			dock.tip = null;
			return;
		}
		if (dock.tip) {
			return;
		}
		let doc = win.document;
		let tip = this.el(doc, "div", "zs-dock-tip");
		tip.setAttribute("role", "note");
		tip.appendChild(this.el(doc, "div", "zs-dock-tip-text",
			"Zusia now has its own panel here, beside your library and the PDF. " +
			this.shortcutLabel(this.DOCK_KEY) + " hides it and brings it back."));
		let actions = this.el(doc, "div", "zs-dock-tip-actions");
		let action = (label, run) => {
			let button = this.el(doc, "button", "zs-dock-tip-button", label);
			button.type = "button";
			button.addEventListener("click", () => {
				this.setPref("dockTipSeen", true);
				run();
			});
			actions.appendChild(button);
		};
		action("Got it", () => this.updateDocks());
		action("Back to the item pane", () => this.setPlacement("pane"));
		tip.appendChild(actions);
		dock.box.insertBefore(tip, dock.body);
		dock.tip = tip;
	},

	startDockResize(win, event) {
		if (event.button !== 0) {
			return;
		}
		let { box, resizer } = this._docks.get(win);
		let startX = event.screenX;
		let startWidth = box.getBoundingClientRect().width;
		// The edge that is dragged faces Zotero's panes: a panel on the right grows leftwards.
		let towardsEnd = (win.getComputedStyle(box).direction === "rtl" ? -1 : 1) * (box.dataset.side === "right" ? -1 : 1);
		let width = startWidth;
		let move = (e) => {
			// What is shown is what is saved: the pointer may be far past either limit.
			width = Math.min(this.dockLimits(win).max, Math.max(this.DOCK_WIDTH.min, startWidth + towardsEnd * (e.screenX - startX)));
			// The pref is written once, on release; meanwhile only this window follows the pointer.
			box.style.width = width + "px";
		};
		let ended = false;
		let end = () => {
			if (ended) {
				return;
			}
			ended = true;
			for (let type of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
				resizer.removeEventListener(type, type === "pointermove" ? move : end);
			}
			box.classList.remove("zs-dock-resizing");
			this.setDockWidth(width);
		};
		// Captured, or the reader's own document would swallow the moves once the pointer is over it.
		resizer.setPointerCapture(event.pointerId);
		resizer.addEventListener("pointermove", move);
		resizer.addEventListener("pointerup", end);
		resizer.addEventListener("pointercancel", end);
		// Switching to another app or a dialog mid-drag ends the capture without a pointerup.
		resizer.addEventListener("lostpointercapture", end);
		box.classList.add("zs-dock-resizing");
		event.preventDefault();
	},

	// The paper the dock follows: the open reader's, or the library's single selection.
	dockItem(win) {
		let tabs = win.Zotero_Tabs;
		if (tabs.selectedType === "library") {
			let items = win.ZoteroPane.getSelectedItems();
			return items.length === 1 ? items[0] : null;
		}
		let reader = Zotero.Reader.getByTabID(tabs.selectedID);
		return reader ? Zotero.Items.get(reader.itemID) : null;
	},

	async syncDock(win, tries = 10) {
		let dock = this._docks.get(win);
		if (!dock || !this.dockOpen()) {
			return;
		}
		win.clearTimeout(dock.readerTimer);
		// Zotero builds a new items tree when it reloads its data; the listener goes with it.
		let tree = win.ZoteroPane.itemsView;
		if (dock.itemsView && tree && tree !== dock.itemsView) {
			dock.itemsView.onSelect.removeListener(dock.onSelect);
			tree.onSelect.addListener(dock.onSelect);
			dock.itemsView = tree;
		}
		let item = this.dockItem(win);
		// A reader tab is selected a moment before Zotero has its reader.
		if (!item && win.Zotero_Tabs.selectedType !== "library" && tries) {
			dock.readerTimer = win.setTimeout(() => this.syncDock(win, tries - 1).catch(e => this.logError("syncDock", e)), 200);
		}
		let usable = !!item && (item.isRegularItem() || item.isFileAttachment());
		// The chat stays on its paper while the selection is empty, several items or a note.
		if (!usable && dock.rendered) {
			return;
		}
		let paper = usable ? (item.isRegularItem() ? item : item.parentItem || item) : null;
		let paperID = paper ? paper.id : null;
		if (dock.rendered && dock.paperID === paperID) {
			return;
		}
		dock.rendered = true;
		dock.paperID = paperID;
		let doc = win.document;
		this.renderSkeleton(doc, dock.body);
		await this.renderContent(doc, dock.body, usable ? item : null);
	},
});
