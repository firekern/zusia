"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Zotero notes
	// ---------------------------------------------------------------------

	// With `drawings` (an array), each drawing becomes an <img data-zs-drawing="i"> placeholder
	// and its SVG source is pushed to the array; without it drawings stay as code.
	noteHTML(question, text, drawings = null) {
		let htmlDoc = Zotero.getMainWindow().document.implementation.createHTMLDocument("");
		let wrapper = htmlDoc.createElement("div");
		wrapper.setAttribute("data-schema-version", "9");
		if (question) {
			let heading = htmlDoc.createElement("h2");
			heading.textContent = question.length > 160 ? question.slice(0, 160) + "…" : question;
			wrapper.appendChild(heading);
		}
		this._noteMode = true;
		this._noteDrawings = drawings;
		try {
			this.renderMarkdown(htmlDoc, wrapper, text);
		}
		finally {
			this._noteMode = false;
			this._noteDrawings = null;
		}
		return wrapper.outerHTML;
	},

	async saveAsNote(ctx, question, text) {
		let note = new Zotero.Item("note");
		note.libraryID = ctx.paperItem.libraryID;
		if (ctx.paperItem.isRegularItem()) {
			note.parentID = ctx.paperItem.id;
		}
		let drawings = [];
		let html = this.noteHTML(question, text, drawings);
		note.setNote(html);
		await note.saveTx();
		if (drawings.length) {
			// Embedded images need the note to exist first; each drawing becomes a PNG
			// attachment of the note, or its source code if it cannot be rendered.
			let replacements = [];
			for (let source of drawings) {
				try {
					let { blob, width, height } = await this.drawingToPNG(source);
					let attachment = await Zotero.Attachments.importEmbeddedImage({ blob, parentItemID: note.id });
					let w = Math.min(600, Math.round(width));
					replacements.push('<p><img data-attachment-key="' + attachment.key + '" width="' + w +
						'" height="' + Math.round(height * w / width) + '"></p>');
				}
				catch (e) {
					this.logError("note drawing", e);
					let pre = Zotero.getMainWindow().document.implementation.createHTMLDocument("").createElement("pre");
					pre.textContent = source;
					replacements.push(pre.outerHTML);
				}
			}
			note.setNote(html.replace(/<p><img data-zs-drawing="(\d+)"><\/p>/g, (m, i) => replacements[Number(i)]));
			await note.saveTx();
		}
		this.log("Saved answer as note " + note.key);
	},
});
