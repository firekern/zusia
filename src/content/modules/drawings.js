"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Drawings: SVG written by the assistant, sanitised and recoloured to the theme
	// ---------------------------------------------------------------------

	SVG_ELEMENTS: new Set([
		"svg", "g", "defs", "symbol", "use", "title", "desc", "path", "rect", "circle", "ellipse",
		"line", "polyline", "polygon", "text", "tspan", "textPath", "marker", "linearGradient",
		"radialGradient", "stop", "clipPath", "mask", "pattern",
	]),
	// Colour names the assistant draws with; each maps to a theme colour (--zs-d-*).
	DRAWING_COLORS: [
		"ink", "muted", "line", "surface", "accent", "accent-soft", "teal", "teal-soft",
		"violet", "violet-soft", "orange", "orange-soft", "red", "red-soft", "green", "green-soft",
	],
	NAMED_COLORS: {
		black: "#000000", white: "#ffffff", gray: "#808080", grey: "#808080", silver: "#c0c0c0",
		lightgray: "#d3d3d3", lightgrey: "#d3d3d3", darkgray: "#a9a9a9", darkgrey: "#a9a9a9",
		red: "#ff0000", orange: "#ffa500", yellow: "#ffff00", gold: "#ffd700", green: "#008000",
		lime: "#00ff00", teal: "#008080", cyan: "#00ffff", blue: "#0000ff", navy: "#000080",
		purple: "#800080", violet: "#ee82ee", magenta: "#ff00ff", pink: "#ffc0cb", brown: "#a52a2a",
		steelblue: "#4682b4", skyblue: "#87ceeb", lightblue: "#add8e6", salmon: "#fa8072",
	},

	renderDrawing(doc, source) {
		if (this._noteMode) {
			// saveAsNote() swaps the placeholder for the drawing as an embedded image.
			if (this._noteDrawings) {
				let p = doc.createElement("p");
				let img = doc.createElement("img");
				img.setAttribute("data-zs-drawing", String(this._noteDrawings.push(source) - 1));
				p.appendChild(img);
				return p;
			}
			return this.renderCodeBlock(doc, source, "svg");
		}
		let svg = this.sanitizeSvg(doc, source);
		if (!svg) {
			return this.renderCodeBlock(doc, source, "svg");
		}
		let figure = this.el(doc, "div", "zs-figure");
		let canvas = this.el(doc, "div", "zs-figure-canvas");
		canvas.appendChild(svg);
		let head = this.el(doc, "div", "zs-figure-tools");
		let sourceBlock = this.renderCodeBlock(doc, source, "svg");
		sourceBlock.hidden = true;
		let toggle = this.ghostButton(doc, "zs-figure-source", "code", "Source", () => {
			sourceBlock.hidden = !sourceBlock.hidden;
			toggle.setAttribute("aria-expanded", String(!sourceBlock.hidden));
		});
		toggle.setAttribute("aria-expanded", "false");
		let copy = this.ghostButton(doc, "zs-figure-copy", "copy", "Copy", () => {
			Zotero.Utilities.Internal.copyTextToClipboard(source);
			copy.setLabel("Copied");
			doc.defaultView.setTimeout(() => copy.setLabel("Copy"), 1200);
		});
		let save = this.ghostButton(doc, "zs-figure-save", "save", "Save", () => this.openDrawingMenu(save, source), { chevron: true });
		head.append(toggle, copy, save);
		figure.append(canvas, head, sourceBlock);
		return figure;
	},

	renderDrawingPlaceholder(doc) {
		let holder = this.el(doc, "div", "zs-figure zs-figure-pending");
		holder.append(this.el(doc, "span", "zs-spinner"), this.el(doc, "span", "zs-shimmer", "Drawing…"));
		return holder;
	},

	// ---------------------------------------------------------------------
	// Drawing export: PNG and SVG files, and images embedded in Zotero notes
	// ---------------------------------------------------------------------

	// Exported drawings use a light palette on white, whatever the sidebar's theme,
	// so they read well in notes, documents and slides.
	EXPORT_PALETTE: {
		"--zs-text": "#1f2328", "--zs-muted": "#5b6270", "--zs-faint": "#a9b0bb",
		"--accent-teal": "#2a9bb5", "--tag-purple": "#7c62d6", "--accent-orange": "#e8652f",
		"--accent-red": "#d02f3c", "--accent-green": "#2e9e57",
	},

	openDrawingMenu(anchor, source) {
		let root = anchor.closest(".zs-root");
		if (!root) {
			return;
		}
		let doc = root.ownerDocument;
		let view = this._views.get(root);
		let run = (label, task) => () => {
			this.closeMenu(root);
			task().catch((e) => {
				this.logError(label, e);
				if (view) {
					this.appendError(view, "Could not " + label + ": " + (e.message || e));
				}
			});
		};
		this.openMenu(root, anchor, (menu) => {
			this.menuItem(doc, menu, {
				label: "Save as PNG…",
				desc: "Image on a white background",
				onSelect: run("save the drawing", () => this.saveDrawingFile(doc.defaultView, source, "png")),
			});
			this.menuItem(doc, menu, {
				label: "Save as SVG…",
				desc: "Vector file, scales to any size",
				onSelect: run("save the drawing", () => this.saveDrawingFile(doc.defaultView, source, "svg")),
			});
			this.menuItem(doc, menu, {
				label: "Add to a note",
				desc: "New note under this paper",
				disabled: !view,
				onSelect: run("add the drawing to a note", async () => {
					await this.saveAsNote(view.ctx, "Drawing", "```svg\n" + source + "\n```");
					anchor.setLabel("Added to note");
					doc.defaultView.setTimeout(() => anchor.setLabel("Save"), 1600);
				}),
			});
		}, { placement: "below", align: "end" });
	},

	// Renders the drawing off-screen with the export palette and bakes every colour and
	// the font into attributes, so the SVG no longer needs the sidebar's stylesheet.
	exportSvg(source) {
		let win = Zotero.getMainWindow();
		let doc = win.document;
		let svg = this.sanitizeSvg(doc, source);
		if (!svg) {
			throw new Error("the drawing could not be read");
		}
		let XHTML = "http://www.w3.org/1999/xhtml";
		let host = doc.createElementNS(XHTML, "div");
		host.className = "zs-root zs-export";
		host.setAttribute("style", "position: fixed; left: -10000px; top: 0; width: 600px; visibility: hidden;");
		for (let [name, value] of Object.entries(this.EXPORT_PALETTE)) {
			host.style.setProperty(name, value);
		}
		host.style.setProperty("--zs-accent", this.getAppearance().accent || this.ZOTERO_ACCENT);
		let canvas = doc.createElementNS(XHTML, "div");
		canvas.className = "zs-figure-canvas";
		canvas.appendChild(svg);
		host.appendChild(canvas);
		doc.documentElement.appendChild(host);
		try {
			let props = ["fill", "stroke", "stop-color"];
			let computed = [svg, ...svg.querySelectorAll("*")].map((el) => {
				let style = win.getComputedStyle(el);
				return [el, props.map(prop => style.getPropertyValue(prop)), style.fontFamily];
			});
			for (let [el, values, font] of computed) {
				props.forEach((prop, i) => {
					el.style.removeProperty(prop);
					if (values[i] && (prop !== "stop-color" || el.localName === "stop")) {
						el.setAttribute(prop, values[i]);
					}
				});
				if (el === svg || el.localName === "text") {
					el.setAttribute("font-family", font);
				}
				if (!el.getAttribute("style")) {
					el.removeAttribute("style");
				}
			}
			let box = svg.getAttribute("viewBox").split(/[\s,]+/).map(Number);
			svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
			svg.setAttribute("width", String(box[2]));
			svg.setAttribute("height", String(box[3]));
			svg.removeAttribute("role");
			return { text: new win.XMLSerializer().serializeToString(svg), width: box[2], height: box[3] };
		}
		finally {
			host.remove();
		}
	},

	async drawingToPNG(source, minWidth = 1400) {
		let win = Zotero.getMainWindow();
		let { text, width, height } = this.exportSvg(source);
		let scale = Math.max(2, minWidth / width);
		let image = new win.Image();
		await new Promise((resolve, reject) => {
			image.onload = resolve;
			image.onerror = () => reject(new Error("the drawing could not be rasterised"));
			image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
		});
		let canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
		canvas.width = Math.round(width * scale);
		canvas.height = Math.round(height * scale);
		let context = canvas.getContext("2d");
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		let blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
		if (!blob) {
			throw new Error("the drawing could not be rasterised");
		}
		return { blob, width, height };
	},

	async saveDrawingFile(win, source, format) {
		let { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
		let picker = new FilePicker();
		picker.init(win, format === "png" ? "Save drawing as PNG" : "Save drawing as SVG", picker.modeSave);
		picker.appendFilter(format.toUpperCase(), "*." + format);
		picker.defaultString = "drawing." + format;
		let result = await picker.show();
		if (result !== picker.returnOK && result !== picker.returnReplace) {
			return;
		}
		let path = picker.file.endsWith("." + format) ? picker.file : picker.file + "." + format;
		let data = format === "png" ? (await this.drawingToPNG(source)).blob : this.exportSvg(source).text;
		await Zotero.File.putContentsAsync(path, data);
		this.log("Saved drawing to " + path);
	},

	// Parses SVG markup and keeps only inert drawing elements: no scripts, event
	// handlers, external references, embedded HTML or stylesheets.
	sanitizeSvg(doc, source) {
		let win = doc.defaultView;
		let SVG_NS = "http://www.w3.org/2000/svg";
		let src = null;
		// Models often leave out xmlns (or xmlns:xlink); strict XML would then see no SVG at all.
		let xml = source.trim().replace(/^<svg\b(?![^>]*\sxmlns=)/, "<svg xmlns=\"" + SVG_NS + "\"");
		if (/\bxlink:/.test(xml) && !/xmlns:xlink=/.test(xml)) {
			xml = xml.replace(/^<svg\b/, "<svg xmlns:xlink=\"http://www.w3.org/1999/xlink\"");
		}
		try {
			let parsed = new win.DOMParser().parseFromString(xml, "image/svg+xml");
			if (!parsed.getElementsByTagName("parsererror").length) {
				src = parsed.documentElement;
			}
		}
		// A malformed document is expected here: the HTML fallback below handles it.
		catch (e) {}
		// Small XML mistakes (a bare "&", an unclosed tag) still parse as HTML, which
		// puts <svg> in the SVG namespace by itself.
		if (!src || src.localName !== "svg" || src.namespaceURI !== SVG_NS) {
			try {
				src = new win.DOMParser().parseFromString(source, "text/html").querySelector("svg");
			}
			catch (e) {
				src = null;
			}
		}
		if (!src || src.namespaceURI !== SVG_NS || !src.querySelector("*")) {
			return null;
		}
		let copy = (node) => {
			if (node.nodeType === 3) {
				return doc.createTextNode(node.nodeValue);
			}
			if (node.nodeType !== 1 || node.namespaceURI !== SVG_NS || !this.SVG_ELEMENTS.has(node.localName)) {
				return null;
			}
			let out = doc.createElementNS(SVG_NS, node.localName);
			for (let attr of node.attributes) {
				let name = attr.name.toLowerCase();
				let value = attr.value;
				if (name.startsWith("on") || name === "style" && /url\(\s*['"]?(?!#)|expression|@import/i.test(value)) {
					continue;
				}
				if (/(^|:)href$/.test(name)) {
					if (!value.trim().startsWith("#")) {
						continue;
					}
					out.setAttributeNS(null, "href", value);
					continue;
				}
				if (/url\(\s*['"]?(?!#)/i.test(value)) {
					continue;
				}
				if (attr.namespaceURI && name.includes(":")) {
					continue;
				}
				out.setAttribute(attr.name, value);
			}
			for (let child of node.childNodes) {
				let kid = copy(child);
				if (kid) {
					out.appendChild(kid);
				}
			}
			return out;
		};
		let svg = copy(src);
		if (!svg) {
			return null;
		}
		this.fitDrawing(svg);
		this.themeDrawing(svg);
		return svg;
	},

	// Sizes a drawing to the sidebar's width and drops a full-size background rectangle,
	// so the drawing sits directly on the sidebar's own background.
	fitDrawing(svg) {
		let box = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
		if (box.length !== 4 || box.some(n => !isFinite(n)) || box[2] <= 0 || box[3] <= 0) {
			let w = parseFloat(svg.getAttribute("width"));
			let h = parseFloat(svg.getAttribute("height"));
			box = w > 0 && h > 0 ? [0, 0, w, h] : [0, 0, 360, 240];
			svg.setAttribute("viewBox", box.join(" "));
		}
		svg.removeAttribute("width");
		svg.removeAttribute("height");
		svg.removeAttribute("style");
		svg.setAttribute("role", "img");
		for (let rect of svg.querySelectorAll(":scope > rect, :scope > g:first-child > rect:first-child")) {
			let size = (attr, total) => {
				let v = rect.getAttribute(attr) || "";
				return v.endsWith("%") ? parseFloat(v) >= 99 : parseFloat(v) >= total * 0.97;
			};
			let at = attr => Math.abs(parseFloat(rect.getAttribute(attr) || "0") - (attr === "x" ? box[0] : box[1])) <= 2;
			if (size("width", box[2]) && size("height", box[3]) && at("x") && at("y")) {
				rect.remove();
			}
			break;
		}
	},

	// Every colour becomes one of the theme's drawing colours: the named ones directly,
	// literal ones by lightness and hue.
	themeDrawing(svg) {
		let props = ["fill", "stroke", "stop-color", "color", "flood-color"];
		for (let el of [svg, ...svg.querySelectorAll("*")]) {
			for (let prop of props) {
				let value = el.getAttribute(prop);
				if (value !== null) {
					let token = this.drawingColor(value, prop);
					if (token) {
						el.removeAttribute(prop);
						el.style.setProperty(prop, "var(--zs-d-" + token + ")");
					}
				}
				let inline = el.style && el.style.getPropertyValue(prop);
				if (inline) {
					let token = this.drawingColor(inline, prop);
					if (token) {
						el.style.setProperty(prop, "var(--zs-d-" + token + ")");
					}
				}
			}
			if (el.localName === "text" || el.localName === "tspan") {
				el.removeAttribute("font-family");
				el.style.removeProperty("font-family");
			}
		}
	},

	drawingColor(value, prop) {
		let v = value.trim().toLowerCase();
		if (this.DRAWING_COLORS.includes(v)) {
			return v;
		}
		let rgb = this.parseColor(v);
		if (!rgb) {
			return null;
		}
		let [r, g, b] = rgb.map(c => c / 255);
		let max = Math.max(r, g, b);
		let min = Math.min(r, g, b);
		let light = (max + min) / 2;
		let sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
		if (sat < 0.18) {
			if (light > 0.85) {
				return prop === "stroke" ? "line" : "surface";
			}
			if (light < 0.3) {
				return "ink";
			}
			return prop === "fill" && light > 0.7 ? "surface" : light > 0.65 ? "line" : "muted";
		}
		let hue = 0;
		if (max === r) {
			hue = ((g - b) / (max - min) + 6) % 6;
		}
		else if (max === g) {
			hue = (b - r) / (max - min) + 2;
		}
		else {
			hue = (r - g) / (max - min) + 4;
		}
		hue *= 60;
		let name = hue < 15 || hue >= 330 ? "red" : hue < 70 ? "orange" : hue < 165 ? "green"
			: hue < 200 ? "teal" : hue < 255 ? "accent" : "violet";
		return light > 0.75 && prop !== "stroke" ? name + "-soft" : name;
	},

	parseColor(v) {
		v = this.NAMED_COLORS[v] || v;
		let hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
		if (hex) {
			let h = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join("") : hex[1];
			return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
		}
		let fn = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
		return fn ? fn.slice(1, 4).map(Number) : null;
	},
});
