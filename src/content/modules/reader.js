"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// PDF reader: ask about a selection, capture the current page
	// ---------------------------------------------------------------------

	registerReaderHooks() {
		Zotero.Reader.registerEventListener("renderTextSelectionPopup", (event) => {
			try {
				this.renderSelectionButtons(event);
			}
			catch (e) {
				this.logError("renderSelectionButtons", e);
			}
		}, this.id);
	},

	// Two buttons in the reader's text selection popup, styled like its own "Add to Note".
	renderSelectionButtons({ reader, doc, params, append }) {
		let annotation = params && params.annotation;
		if (!annotation || !String(annotation.text || "").trim()) {
			return;
		}
		let label = this.BACKENDS[this.getBackend()].label;
		let container = doc.createElement("div");
		container.className = "zs-selection-actions";
		container.style.cssText = "display: flex; flex-direction: column; gap: 2px;";
		let button = (text, send) => {
			let el = doc.createElement("button");
			el.className = "toolbar-button wide-button";
			el.setAttribute("data-tabstop", "1");
			el.textContent = text;
			el.addEventListener("click", () => {
				try {
					this.askAboutSelection(reader, annotation, send);
				}
				catch (e) {
					this.logError("askAboutSelection", e);
				}
			});
			return el;
		};
		container.append(button("Ask " + label + " about this", false), button("Explain this", true));
		append(container);
	},

	selectionPrompt(text, pageLabel, explain) {
		// PDF text arrives with hard line breaks and runs of spaces; quote it as one line.
		let quote = "> " + String(text).trim().replace(/\s+/g, " ");
		let where = pageLabel ? " (p. " + pageLabel + ")" : "";
		return explain
			? "Explain this passage" + where + ":\n\n" + quote
			: "About this passage" + where + ":\n\n" + quote + "\n\n";
	},

	contextDirFor(item) {
		let paper = item.isAttachment() && item.parentItem ? item.parentItem : item;
		return OS.Path.join(this.getDataDir(), paper.libraryID + "-" + paper.key);
	},

	askAboutSelection(reader, annotation, send) {
		let item = Zotero.Items.get(reader.itemID);
		if (!item) {
			return;
		}
		let dir = this.contextDirFor(item);
		this._drafts.set(dir, {
			text: this.selectionPrompt(annotation.text, annotation.pageLabel, send),
			send,
			selection: {
				text: String(annotation.text).trim(),
				pageLabel: annotation.pageLabel || "",
				position: annotation.position || null,
				attachmentID: item.id,
			},
		});
		let win = reader._window || Zotero.getMainWindow();
		let pane = win.ZoteroContextPane;
		if (pane && pane.collapsed) {
			pane.togglePane();
		}
		this.revealChat(win);
		for (let root of win.document.querySelectorAll(".zs-root")) {
			let view = this._views.get(root);
			if (view && view.ctx.dir === dir) {
				this.applyDraft(view);
			}
		}
	},

	applyDraft(view) {
		let draft = this._drafts.get(view.ctx.dir);
		if (!draft) {
			return;
		}
		this._drafts.delete(view.ctx.dir);
		if (draft.send && !this._pending.has(view.ctx.dir)) {
			this.startRequest(view, draft.text, [], undefined, { selection: draft.selection });
			return;
		}
		// Ask: the selection is attached when the message is sent with its quote still in it.
		view.draftSelection = draft.selection ? { selection: draft.selection, quote: draft.text.trim() } : null;
		let existing = view.input.value.trim();
		view.input.value = draft.text + (existing ? existing : "");
		this.autoGrow(view.input);
		if (!this._pending.has(view.ctx.dir)) {
			view.root.querySelector(".zs-send").disabled = !this.canSend(view);
		}
		view.input.focus();
		view.input.setSelectionRange(view.input.value.length, view.input.value.length);
	},

	// The open PDF reader showing this paper: the selected tab first, then any other.
	readerFor(ctx, win) {
		if (!ctx || !ctx.paperItem || typeof Zotero.Reader === "undefined") {
			return null;
		}
		let matches = (reader) => {
			if (!reader || reader.type !== "pdf") {
				return false;
			}
			let item = Zotero.Items.get(reader.itemID);
			return !!item && (item.id === ctx.paperItem.id || item.parentItemID === ctx.paperItem.id);
		};
		let tabs = win && win.Zotero_Tabs;
		let selected = tabs && Zotero.Reader.getByTabID(tabs.selectedID);
		if (matches(selected)) {
			return selected;
		}
		return (Zotero.Reader._readers || []).find(matches) || null;
	},

	// Copies the page on screen from pdf.js's own canvas (already rendered at the
	// current zoom), on white, into an attachment.
	async captureReaderPage(view, reader) {
		let internal = reader._internalReader;
		let pdfView = internal && (internal._lastView || internal._primaryView);
		let frame = pdfView && pdfView._iframeWindow;
		frame = frame && (frame.wrappedJSObject || frame);
		let viewer = frame && frame.PDFViewerApplication && frame.PDFViewerApplication.pdfViewer;
		if (!viewer) {
			throw new Error("the PDF view is not ready");
		}
		let pageView = viewer.getPageView(viewer.currentPageNumber - 1);
		let source = pageView && (pageView.canvas || pageView.div?.querySelector("canvas"));
		if (!source || !source.width) {
			throw new Error("the page has not been drawn yet; scroll to it and try again");
		}
		let doc = view.doc;
		let canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
		canvas.width = source.width;
		canvas.height = source.height;
		let context = canvas.getContext("2d");
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(source, 0, 0);
		let blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
		if (!blob) {
			throw new Error("the page could not be copied");
		}
		await Zotero.File.createDirectoryIfMissingAsync(OS.Path.join(view.ctx.dir, "attachments"));
		let path = this.attachmentPath(view.ctx.dir, "png");
		await Zotero.File.putContentsAsync(path, blob);
		this.stagePath(view, path);
		if (!view.input.value.trim()) {
			view.input.value = "Page " + (pageView.pageLabel || viewer.currentPageNumber) + ": ";
			this.autoGrow(view.input);
		}
		view.input.focus();
	},
});
