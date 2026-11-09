"use strict";

Object.assign(Zusia, {
	// The chat as its own column on the left edge of the main window, under the tab bar, so
	// it is the same panel in the library and in every reader tab. The other placement is
	// the section in Zotero's item pane (window.js).
	DOCK_WIDTH: { min: 280, initial: 380 },
	// Room the dock always leaves to Zotero's own panes when it is resized.
	DOCK_KEEPS_FREE: 600,
	// What addDock gave each main window, taken back by removeDock.
	_docks: new Map(),
	_tabObserver: null,

	placement() {
		return this.getPref("placement") === "pane" ? "pane" : "left";
	},

	setPlacement(placement) {
		this.setPref("placement", placement);
		this.applyPlacement();
	},

	// At startup and whenever the placement changes: exactly one of the two is in place.
	applyPlacement() {
		let left = this.placement() === "left";
		if (left) {
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
			if (left) {
				this.addDock(win);
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
		rail.appendChild(this.iconButton(doc, "zs-dock-open", "Show Zusia", this.MASCOTS[this.getAppearance().mascot].header,
			() => this.setDockOpen(true)));
		let resizer = this.el(doc, "div", "zs-dock-resizer");
		resizer.addEventListener("pointerdown", event => this.startDockResize(win, event));
		// A double click puts the width back, as Zotero's own splitters do.
		resizer.addEventListener("dblclick", () => this.setDockWidth(this.DOCK_WIDTH.initial));
		box.append(rail, body, resizer);
		let content = doc.getElementById("appcontent");
		content.parentNode.insertBefore(box, content);

		let dock = { box, body, rail, resizer, paperID: null, rendered: false, itemsView: null, timer: null };
		dock.onSelect = () => this.syncDock(win).catch(e => this.logError("syncDock", e));
		this._docks.set(win, dock);
		// The chat view of the item pane would hide Zotero's sections around a section that is gone.
		doc.documentElement.setAttribute(this.VIEW_ATTR, "details");
		for (let details of doc.querySelectorAll("item-details[zs-chat-ready]")) {
			details.removeAttribute("zs-chat-ready");
		}
		this.watchSelection(win, dock);
		this.updateDock(win);
	},

	removeDock(win) {
		let dock = this._docks.get(win);
		if (!dock) {
			return;
		}
		win.clearTimeout(dock.timer);
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

	// The items tree is built after the window loads, so a new window has none yet.
	watchSelection(win, dock, tries = 40) {
		let itemsView = win.ZoteroPane.itemsView;
		if (!itemsView) {
			if (tries) {
				dock.timer = win.setTimeout(() => this.watchSelection(win, dock, tries - 1), 250);
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

	dockWidth(win) {
		let most = Math.max(this.DOCK_WIDTH.min, win.innerWidth - this.DOCK_KEEPS_FREE);
		let wanted = this.getPref("dockWidth") || this.DOCK_WIDTH.initial;
		return Math.round(Math.min(most, Math.max(this.DOCK_WIDTH.min, wanted)));
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
		dock.rail.hidden = open;
		dock.body.hidden = !open;
		dock.resizer.hidden = !open;
		dock.box.style.width = open ? this.dockWidth(win) + "px" : "";
		if (open) {
			this.syncDock(win).catch(e => this.logError("syncDock", e));
		}
	},

	startDockResize(win, event) {
		if (event.button !== 0) {
			return;
		}
		let { box, resizer } = this._docks.get(win);
		let startX = event.screenX;
		let startWidth = box.getBoundingClientRect().width;
		let towardsEnd = win.getComputedStyle(box).direction === "rtl" ? -1 : 1;
		let width = startWidth;
		let move = (e) => {
			width = startWidth + towardsEnd * (e.screenX - startX);
			// The pref is written once, on release; meanwhile only this window follows the pointer.
			let most = Math.max(this.DOCK_WIDTH.min, win.innerWidth - this.DOCK_KEEPS_FREE);
			box.style.width = Math.min(most, Math.max(this.DOCK_WIDTH.min, width)) + "px";
		};
		let end = () => {
			resizer.removeEventListener("pointermove", move);
			resizer.removeEventListener("pointerup", end);
			resizer.removeEventListener("pointercancel", end);
			box.classList.remove("zs-dock-resizing");
			this.setDockWidth(width);
		};
		// Captured, or the reader's own document would swallow the moves once the pointer is over it.
		resizer.setPointerCapture(event.pointerId);
		resizer.addEventListener("pointermove", move);
		resizer.addEventListener("pointerup", end);
		resizer.addEventListener("pointercancel", end);
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
		win.clearTimeout(dock.timer);
		let item = this.dockItem(win);
		// A reader tab is selected a moment before Zotero has its reader.
		if (!item && win.Zotero_Tabs.selectedType !== "library" && tries) {
			dock.timer = win.setTimeout(() => this.syncDock(win, tries - 1).catch(e => this.logError("syncDock", e)), 200);
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
