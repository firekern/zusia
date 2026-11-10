"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Images attached to a message: upload, screenshot, paste and drop
	// ---------------------------------------------------------------------

	canSend(view) {
		return !!(view.input.value.trim() || this.stagedPaths(view).length);
	},

	stagedPaths(view) {
		return (this._staged.get(view.ctx.dir) || []).map(a => a.path);
	},

	// Stored messages keep paths relative to the paper's folder.
	imagePaths(dir, msg) {
		// Stored with the separator of the machine that wrote the chat, which may not be this one.
		return (msg.images || []).map(p => OS.Path.join(dir, ...p.split(/[\\/]/)));
	},

	onPasteOrDrop(view, event, transfer) {
		let files = this.imageFiles(transfer);
		if (files.length) {
			event.preventDefault();
			this.stageFiles(view, files).catch(e => this.logError("stageFiles", e));
		}
	},

	imageFiles(transfer) {
		return [...((transfer && transfer.files) || [])].filter(file => this.IMAGE_TYPES[file.type]);
	},

	attachmentPath(dir, ext) {
		this._attachmentSeq = (this._attachmentSeq || 0) + 1;
		return OS.Path.join(dir, "attachments", "image-" + Date.now() + "-" + this._attachmentSeq + "." + ext);
	},

	async stageFiles(view, files) {
		let dir = view.ctx.dir;
		await Zotero.File.createDirectoryIfMissingAsync(OS.Path.join(dir, "attachments"));
		for (let file of files) {
			let path = this.attachmentPath(dir, this.IMAGE_TYPES[file.type]);
			await Zotero.File.putContentsAsync(path, file);
			this.stagePath(view, path);
		}
	},

	stagePath(view, path) {
		let staged = this._staged.get(view.ctx.dir) || [];
		if (staged.length >= this.MAX_IMAGES) {
			this.log("stagePath: at most " + this.MAX_IMAGES + " images per message");
			return;
		}
		staged.push({ path });
		this._staged.set(view.ctx.dir, staged);
		this.renderAttachments(view);
		if (!this._pending.has(view.ctx.dir)) {
			view.root.querySelector(".zs-send").disabled = !this.canSend(view);
		}
	},

	async unstage(view, path) {
		let staged = this._staged.get(view.ctx.dir) || [];
		let entry = staged.find(a => a.path === path);
		this._staged.set(view.ctx.dir, staged.filter(a => a !== entry));
		this.renderAttachments(view);
		if (!this._pending.has(view.ctx.dir)) {
			view.root.querySelector(".zs-send").disabled = !this.canSend(view);
		}
		// Only files never sent are deleted; sent ones belong to the conversation.
		if (entry && !entry.sent) {
			await OS.File.remove(path, { ignoreAbsent: true });
		}
	},

	renderAttachments(view) {
		let tray = view.root.querySelector(".zs-attachments");
		if (!tray) {
			return;
		}
		tray.textContent = "";
		let staged = this._staged.get(view.ctx.dir) || [];
		tray.hidden = !staged.length;
		for (let { path } of staged) {
			tray.appendChild(this.imageThumb(view.doc, path, { onRemove: () => this.unstage(view, path) }));
		}
	},

	imageThumb(doc, path, { onOpen, onRemove } = {}) {
		let thumb = this.el(doc, "span", "zs-thumb");
		let img = doc.createElement("img");
		img.alt = "Attached image";
		img.src = Zotero.File.pathToFileURI(path);
		img.addEventListener("error", () => thumb.classList.add("zs-thumb-missing"));
		thumb.appendChild(img);
		if (onOpen) {
			thumb.classList.add("zs-thumb-open");
			thumb.title = "Open image";
			thumb.addEventListener("click", (event) => {
				event.stopPropagation();
				onOpen();
			});
		}
		if (onRemove) {
			let remove = this.iconButton(doc, "zs-small zs-thumb-remove", "Remove image", "remove", (event) => {
				event.stopPropagation();
				onRemove();
			});
			thumb.appendChild(remove);
		}
		return thumb;
	},

	openAttachMenu(root, anchor) {
		let doc = root.ownerDocument;
		let view = this._views.get(root);
		if (!view) {
			return;
		}
		this.openMenu(root, anchor, (menu) => {
			this.menuItem(doc, menu, {
				label: "Upload image…",
				desc: "PNG, JPEG, GIF or WebP",
				onSelect: () => {
					this.closeMenu(root);
					this.pickImages(view).catch(e => this.logError("pickImages", e));
				},
			});
			let reader = this.readerFor(view.ctx, doc.defaultView);
			this.menuItem(doc, menu, {
				label: "Current PDF page",
				desc: reader ? "The page you are reading" : "Open the PDF to capture a page",
				disabled: !reader,
				onSelect: () => {
					this.closeMenu(root);
					this.captureReaderPage(view, reader).catch((e) => {
						this.logError("captureReaderPage", e);
						this.appendError(view, "Could not capture the page: " + (e.message || e));
					});
				},
			});
			if (Zotero.isMac) {
				this.menuItem(doc, menu, {
					label: "Take screenshot",
					desc: "Drag over the area to capture",
					onSelect: () => {
						this.closeMenu(root);
						this.takeScreenshot(view).catch(e => this.logError("takeScreenshot", e));
					},
				});
			}
			menu.appendChild(this.el(doc, "div", "zs-menu-note", "You can also paste or drop an image into the message box."));
		});
	},

	async pickImages(view) {
		let { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
		let picker = new FilePicker();
		picker.init(view.doc.defaultView, "Add images", picker.modeOpenMultiple);
		picker.appendFilter("Images", "*.png; *.jpg; *.jpeg; *.gif; *.webp");
		if (await picker.show() !== picker.returnOK) {
			return;
		}
		await Zotero.File.createDirectoryIfMissingAsync(OS.Path.join(view.ctx.dir, "attachments"));
		for (let file of picker.files) {
			let ext = (file.match(/\.(png|jpe?g|gif|webp)$/i) || [])[1];
			if (!ext) {
				continue;
			}
			let path = this.attachmentPath(view.ctx.dir, ext.toLowerCase().replace("jpeg", "jpg"));
			await OS.File.copy(file, path);
			this.stagePath(view, path);
		}
	},

	// macOS's own interactive capture: the user drags over an area, Escape cancels.
	async takeScreenshot(view) {
		await Zotero.File.createDirectoryIfMissingAsync(OS.Path.join(view.ctx.dir, "attachments"));
		let path = this.attachmentPath(view.ctx.dir, "png");
		let proc = await Subprocess.call({ command: "/usr/sbin/screencapture", arguments: ["-i", "-x", path] });
		await proc.wait();
		if (await OS.File.exists(path)) {
			this.stagePath(view, path);
			view.input.focus();
		}
	},

	// What the assistant is told about attached images; Claude reads them with its Read tool.
	imageNote(backend, images) {
		if (!images.length) {
			return "";
		}
		let count = images.length === 1 ? "an image" : images.length + " images";
		if (backend === "claude") {
			return "\n\n[The user attached " + count + " to this message. Look at " +
				(images.length === 1 ? "it" : "each") + " with the Read tool before answering: " +
				images.join(", ") + "]";
		}
		return "\n\n[The user attached " + count + " to this message.]";
	},
});
