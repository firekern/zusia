"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Window lifecycle (Fluent + stylesheet)
	// ---------------------------------------------------------------------

	addToWindow(window) {
		this.log("addToWindow: inserting FTL and stylesheet");
		window.MozXULElement.insertFTLIfNeeded("zusia.ftl");

		let doc = window.document;
		// Replace a link left by an older version rather than keeping its styles.
		doc.querySelectorAll("#zusia-stylesheet").forEach(old => old.remove());
		let link = doc.createElement("link");
		link.id = "zusia-stylesheet";
		link.type = "text/css";
		link.rel = "stylesheet";
		link.href = this.stylesheetURL;
		doc.documentElement.appendChild(link);

		doc.documentElement.setAttribute(this.VIEW_ATTR, this.getPref("paneView") === "chat" ? "chat" : "details");
		let onClick = event => this.onSidenavClick(event);
		// Capturing, so the view is set before Zotero's own handler scrolls to the section.
		doc.addEventListener("click", onClick, true);
		this._sidenavListeners.set(window, onClick);
	},

	addToAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) {
				continue;
			}
			this.addToWindow(win);
		}
	},

	removeFromWindow(window) {
		let doc = window.document;
		doc.getElementById("zusia-stylesheet")?.remove();
		doc.querySelector('[href="zusia.ftl"]')?.remove();
		doc.documentElement.removeAttribute(this.VIEW_ATTR);
		let onClick = this._sidenavListeners.get(window);
		if (onClick) {
			doc.removeEventListener("click", onClick, true);
			this._sidenavListeners.delete(window);
		}
	},

	removeFromAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) {
				continue;
			}
			this.removeFromWindow(win);
		}
	},

	// ---------------------------------------------------------------------
	// Item pane section and settings pane registration
	// ---------------------------------------------------------------------

	registerPaneSection() {
		this.paneID = Zotero.ItemPaneManager.registerSection({
			paneID: "zusia-section",
			pluginID: this.id,
			header: {
				l10nID: "zusia-item-pane-header",
				icon: this.rootURI + "icons/icon16.svg",
			},
			sidenav: {
				l10nID: "zusia-item-pane-sidenav",
				icon: this.rootURI + "icons/icon20.svg",
			},
			onInit: ({ body }) => {
				// The chat view's CSS finds our section by this class (see "chat view" in zusia.css).
				body.closest("item-pane-custom-section")?.classList.add("zs-pane");
			},
			// The section goes with its window: what was said about the paper is folded into
			// its memory. At shutdown the jobs are stopped first, so nothing new starts.
			onDestroy: ({ body }) => {
				let dir = this._shownDirs.get(body);
				if (dir) {
					this.leavePaper(dir);
				}
			},
			onItemChange: ({ body, item, setEnabled }) => {
				let usable = !!item && (item.isRegularItem() || item.isFileAttachment());
				setEnabled(usable);
				// Without our section the chat view would hide every section and leave the pane empty.
				body.closest("item-details")?.toggleAttribute("zs-chat-ready", usable);
			},
			onRender: ({ doc, body }) => {
				try {
					this.renderSkeleton(doc, body);
				}
				catch (e) {
					this.logError("renderSkeleton", e);
					body.textContent = "Zusia failed to render: " + e;
				}
			},
			onAsyncRender: async ({ doc, body, item }) => {
				try {
					await this.renderContent(doc, body, item);
				}
				catch (e) {
					this.logError("renderContent", e);
					let logEl = body.querySelector(".zs-log");
					if (logEl) {
						logEl.textContent = "";
						logEl.appendChild(this.el(doc, "div", "zs-msg zs-error", "Something went wrong: " + e));
					}
				}
			},
		});
		this.log("registerPaneSection -> paneID=" + this.paneID);
	},

	// -----------------------------------------------------------------
	// Chat view: Zusia fills the side pane
	// -----------------------------------------------------------------

	// The item pane API has no full-height section, so in the chat view zusia.css hides
	// Zotero's title bar and the other sections around ours (llm-for-zotero does the same).
	// The view is one attribute per window, as the side nav works the same in the library
	// and the reader tabs; it only applies where item-details carries zs-chat-ready.
	VIEW_ATTR: "data-zs-view",

	isChatView(doc) {
		return doc.documentElement.getAttribute(this.VIEW_ATTR) === "chat";
	},

	setView(doc, view) {
		doc.documentElement.setAttribute(this.VIEW_ATTR, view);
		this.setPref("paneView", view);
		if (view === "chat") {
			// A collapsed section would leave the pane empty, its header being hidden.
			for (let section of doc.querySelectorAll("item-pane-custom-section.zs-pane")) {
				section.open = true;
			}
		}
	},

	// Our side-nav icon opens the chat view; any other section's icon goes back to the item details.
	onSidenavClick(event) {
		if (event.button !== 0 || !this.paneID) {
			return;
		}
		let button = event.target.closest?.("item-pane-sidenav [data-pane]");
		let pane = button?.dataset.pane;
		// The reader's notes pane replaces the whole item deck, so the view can stay as it is.
		if (!pane || pane === "context-notes") {
			return;
		}
		let doc = button.ownerDocument;
		if (pane !== this.paneID) {
			this.setView(doc, "details");
			return;
		}
		this.setView(doc, "chat");
		this.focusVisibleInput(doc);
	},

	focusVisibleInput(doc) {
		// After Zotero has shown the pane: a hidden or still disabled box cannot take focus.
		doc.defaultView.setTimeout(() => {
			let input = [...doc.querySelectorAll(".zs-root .zs-input")]
				.find(el => !el.disabled && el.getClientRects().length);
			input?.focus();
		}, 200);
	},

	// Opens the chat view from an entry point (the reader's Ask Zusia, a search result) the way
	// a click on our side-nav icon does, so Zotero also expands the pane and leaves its notes view.
	revealChat(win) {
		let doc = win.document;
		let button = [...doc.querySelectorAll("item-pane-sidenav [data-pane]")]
			.find(el => el.dataset.pane === this.paneID && el.getClientRects().length);
		if (button) {
			button.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
			return;
		}
		this.setView(doc, "chat");
		let details = win.Zotero_Tabs?.selectedType === "library"
			? doc.getElementById("zotero-item-details")
			: win.ZoteroContextPane?.sidenav?.container;
		details?.scrollToPane?.(this.paneID, "instant");
		this.focusVisibleInput(doc);
	},

	unregisterPaneSection() {
		if (this.paneID) {
			Zotero.ItemPaneManager.unregisterSection(this.paneID);
			this.paneID = null;
		}
	},

	async registerPrefsPane() {
		try {
			this.prefsPaneID = await Zotero.PreferencePanes.register({
				pluginID: this.id,
				id: this.PREFS_PANE_ID,
				src: this.rootURI + "prefs.xhtml",
				label: "Zusia",
				image: this.rootURI + "icons/icon20.svg",
				stylesheets: [this.stylesheetURL],
			});
			this.log("registered settings pane " + this.prefsPaneID);
		}
		catch (e) {
			this.logError("registerPrefsPane", e);
		}
	},

	openSettings() {
		Zotero.Utilities.Internal.openPreferences(this.prefsPaneID || this.PREFS_PANE_ID);
	},
});
