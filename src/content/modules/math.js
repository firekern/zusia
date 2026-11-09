"use strict";

Object.assign(Zusia, {
	// KaTeX has no numbered/eqnarray/multline environments; map them onto ones it has.
	normalizeMathEnv(env, source, inner) {
		let bare = env.replace(/\*$/, "");
		if (bare === "equation" || bare === "displaymath") {
			return inner;
		}
		if (bare === "eqnarray") {
			return "\\begin{align*}" + inner.replace(/&\s*([=<>]|\\[a-z]+)\s*&/g, "&$1") + "\\end{align*}";
		}
		if (bare === "multline") {
			return "\\begin{gathered}" + inner + "\\end{gathered}";
		}
		if (bare === "flalign") {
			return "\\begin{align*}" + inner + "\\end{align*}";
		}
		return source.trim().replace(/\\(begin|end)\{(align|gather|alignat)\}/g, "\\$1{$2*}");
	},

	renderEnvBox(doc, env, inner) {
		let kind = this.BOX_KIND[env];
		let title = null;
		let label = null;
		// A \label inside maths names that equation, not the box, so maths is skipped over.
		let envs = [...this.MATH_ENVS].filter(e => !e.endsWith("*")).join("|");
		// An escaped \$ or \\ is consumed first, so it never opens inline maths.
		let mathOrLabel = new RegExp("\\\\[$\\\\]|```[\\s\\S]*?```|\\$\\$[\\s\\S]*?\\$\\$|\\\\\\[[\\s\\S]*?\\\\\\]|\\\\\\([\\s\\S]*?\\\\\\)|\\$(?:[^$\\\\]|\\\\.)*\\$" +
			"|\\\\begin\\{(" + envs + ")(\\*?)\\}[\\s\\S]*?\\\\end\\{\\1\\2\\}|\\\\label\\{([^{}]+)\\}", "g");
		let body = inner.replace(/^\s*\[([^\]]*)\]/, (m, t) => {
			title = t;
			return "";
		}).replace(mathOrLabel, (m, env, star, l) => {
			if (l === undefined) {
				return m;
			}
			label = label || l.trim();
			return "";
		});

		let box = this._noteMode ? doc.createElement("blockquote") : this.el(doc, "div", "zs-env zs-env-" + kind);
		let head = this._noteMode ? doc.createElement("p") : this.el(doc, "div", "zs-env-head");
		let labelEl = this.el(doc, this._noteMode ? "strong" : "span", "zs-env-label",
			this.BOX_ENVS[env] + (kind === "proof" ? "." : ""));
		head.appendChild(labelEl);
		if (!this._noteMode) {
			box.dataset.env = env;
			if (label) {
				box.dataset.label = label;
			}
			// Filled in by linkTheorems(), which numbers boxes across the whole chat.
			if (kind !== "proof") {
				labelEl.appendChild(this.el(doc, "span", "zs-env-num"));
			}
		}
		if (title) {
			let titleEl = this.el(doc, "span", "zs-env-title");
			titleEl.appendChild(doc.createTextNode(" — "));
			this.renderInline(doc, titleEl, title);
			head.appendChild(titleEl);
		}
		box.appendChild(head);

		let content = this._noteMode ? box : this.el(doc, "div", "zs-env-body zs-rich");
		this.renderMarkdown(doc, content, body.trim());
		if (content !== box) {
			box.appendChild(content);
		}
		if (kind === "proof") {
			box.appendChild(this.el(doc, this._noteMode ? "p" : "div", "zs-qed", "∎"));
		}
		return box;
	},

	renderLatexList(doc, env, inner) {
		let list = doc.createElement(env === "enumerate" ? "ol" : "ul");
		let items = inner.split(/\\item\b/).slice(1);
		for (let item of items) {
			let li = doc.createElement("li");
			let label = null;
			let body = item.replace(/^\s*\[([^\]]*)\]/, (m, t) => {
				label = t;
				return "";
			});
			if (label) {
				li.appendChild(this.el(doc, "strong", null, label + " "));
			}
			let holder = this.el(doc, "div", "zs-li-body");
			this.renderMarkdown(doc, holder, body.trim());
			li.appendChild(holder);
			list.appendChild(li);
		}
		return list;
	},

	renderInline(doc, parent, text) {
		let pattern = new RegExp([
			"`[^`]+`",
			"\\$\\$[^$]+\\$\\$",
			"\\\\\\(.+?\\\\\\)",
			"\\\\\\[.+?\\\\\\]",
			// $…$ that does not open or close on a space, so prices like "$5 and $10" stay text.
			"\\$(?=[^\\s$])(?:[^$\\\\\\n]|\\\\.)+?(?<=[^\\s\\\\]|\\\\[,;!| ])\\$(?!\\d)",
			"\\*\\*(?:[^*$]|\\$[^$]*\\$)+\\*\\*",
			"__(?:[^_$]|\\$[^$]*\\$)+__",
			"\\\\textbf\\{[^{}]*\\}",
			"\\\\(?:emph|textit)\\{[^{}]*\\}",
			"\\\\texttt\\{[^{}]*\\}",
			"\\\\cite[pt]?\\{[^{}]*\\}",
			"\\\\(?:ref|eqref|cref|Cref|autoref|nameref)\\{[^{}]*\\}",
			"\\\\label\\{[^{}]*\\}",
			"(?<![\\w*])\\*[^*\\s](?:[^*$]|\\$[^$]*\\$)*?(?<!\\s)\\*(?![\\w*])",
			"(?<!\\w)_[^_\\s](?:[^_$]|\\$[^$]*\\$)*?(?<!\\s)_(?!\\w)",
			"\\[[^\\]]+\\]\\([^)\\s]+\\)",
		].join("|"), "g");
		let last = 0;
		let match;
		let braced = token => token.slice(token.indexOf("{") + 1, -1);
		let wrap = (tag, inner) => {
			let node = doc.createElement(tag);
			this.renderInline(doc, node, inner);
			parent.appendChild(node);
		};
		while ((match = pattern.exec(text))) {
			if (match.index > last) {
				parent.appendChild(doc.createTextNode(this.latexText(text.slice(last, match.index))));
			}
			let token = match[0];
			if (token.startsWith("`")) {
				parent.appendChild(this.el(doc, "code", null, token.slice(1, -1)));
			}
			else if (token.startsWith("$$")) {
				parent.appendChild(this.renderMath(doc, token.slice(2, -2), false));
			}
			else if (token.startsWith("\\(") || token.startsWith("\\[")) {
				parent.appendChild(this.renderMath(doc, token.slice(2, -2), false));
			}
			else if (token.startsWith("$")) {
				parent.appendChild(this.renderMath(doc, token.slice(1, -1), false));
			}
			else if (token.startsWith("**") || token.startsWith("__")) {
				wrap("strong", token.slice(2, -2));
			}
			else if (token.startsWith("\\textbf")) {
				wrap("strong", braced(token));
			}
			else if (token.startsWith("\\emph") || token.startsWith("\\textit")) {
				wrap("em", braced(token));
			}
			else if (token.startsWith("\\texttt")) {
				parent.appendChild(this.el(doc, "code", null, braced(token)));
			}
			else if (token.startsWith("\\label{")) {
				// A label outside a statement box has nothing to point at; drop it.
			}
			else if (/^\\(?:ref|eqref|cref|Cref|autoref|nameref)\{/.test(token)) {
				parent.appendChild(this.renderRef(doc, braced(token).trim()));
			}
			else if (token.startsWith("\\cite")) {
				parent.appendChild(doc.createTextNode("[" + braced(token) + "]"));
			}
			else if (token.startsWith("[")) {
				let label = token.slice(1, token.indexOf("]("));
				let url = token.slice(token.indexOf("](") + 2, -1);
				if (/^#[\w:.\-]+$/.test(url)) {
					parent.appendChild(this.renderRef(doc, url.slice(1), label));
				}
				else if (/^https?:\/\//.test(url)) {
					let link = this.el(doc, this._noteMode ? "a" : "span", "zs-link");
					if (this._noteMode) {
						link.setAttribute("href", url);
					}
					else {
						link.title = url;
						link.setAttribute("role", "link");
						link.addEventListener("click", () => Zotero.launchURL(url));
					}
					this.renderInline(doc, link, label);
					parent.appendChild(link);
				}
				else {
					this.renderInline(doc, parent, label);
				}
			}
			else {
				wrap("em", token.slice(1, -1));
			}
			last = match.index + token.length;
		}
		if (last < text.length) {
			parent.appendChild(doc.createTextNode(this.latexText(text.slice(last))));
		}
	},

	// Text-mode LaTeX escapes that show up in prose written by the model.
	latexText(text) {
		return text
			.replace(/\\([%&#_$])/g, "$1")
			.replace(/\\ldots\b|\\dots\b/g, "…");
	},

	getKatex() {
		if (this._katex === undefined) {
			try {
				let scope = { module: { exports: {} }, exports: {} };
				Services.scriptloader.loadSubScript(this.rootURI + "content/lib/katex.min.js", scope);
				this._katex = scope.module.exports;
				if (!this._katex || typeof this._katex.renderToString !== "function") {
					throw new Error("katex.renderToString missing after load");
				}
				this.log("KaTeX " + this._katex.version + " loaded");
			}
			catch (e) {
				this.logError("getKatex", e);
				this._katex = null;
			}
		}
		return this._katex;
	},

	// Returns a <math> element for `tex`, or null when KaTeX cannot parse it.
	texToMathML(doc, tex, displayMode) {
		let katex = this.getKatex();
		if (!katex) {
			return null;
		}
		try {
			let markup = katex.renderToString(tex, {
				output: "mathml",
				displayMode,
				throwOnError: true,
				strict: "ignore",
				trust: false,
			});
			let start = markup.indexOf("<math");
			let end = markup.lastIndexOf("</math>");
			if (start < 0 || end < start) {
				return null;
			}
			let parser = new doc.defaultView.DOMParser();
			let parsed = parser.parseFromString(markup.slice(start, end + 7), "application/xml");
			if (parsed.documentElement.localName !== "math") {
				this.log("MathML did not parse for " + JSON.stringify(tex.slice(0, 80)));
				return null;
			}
			let math = doc.importNode(parsed.documentElement, true);
			this.fixMathSpacing(math);
			return math;
		}
		catch (e) {
			this.log("TeX error in " + JSON.stringify(tex.slice(0, 80)) + ": " + (e.message || e));
			return null;
		}
	},

	// KaTeX's MathML differs from TeX's own spacing in a few common places:
	// - \| and |x| come out as U+2225/U+2223 (relation glyphs with wide side
	//   bearings); TeX's \Vert and | are U+2016 and U+007C.
	// - a sign that opens a group, as in (\pm x) or (-x), gets binary-operator
	//   spacing; in TeX it is unary and tight.
	// - a slash, as in n/2, is spaced like a letter with wide bearings.
	fixMathSpacing(math) {
		for (let node of math.querySelectorAll("mi")) {
			if (node.textContent === "\u2225") {
				node.textContent = "\u2016";
			}
			else if (node.textContent === "\u2223") {
				node.textContent = "|";
			}
			else if (node.textContent === "/") {
				// An <mi> slash picks up the glyph's wide bearings; TeX sets n/2 tight.
				let slash = node.ownerDocument.createElementNS(node.namespaceURI, "mo");
				slash.textContent = "/";
				slash.setAttribute("lspace", "0");
				slash.setAttribute("rspace", "0");
				slash.setAttribute("stretchy", "false");
				node.replaceWith(slash);
			}
		}
		for (let mo of math.querySelectorAll("mo")) {
			if (!/^[+\u2212\u00b1\u2213]$/.test(mo.textContent)) {
				continue;
			}
			let prev = mo.previousElementSibling;
			let closes = prev && /^[)\]}|!'\u2016\u2019\u2032\u27e9\u2309\u230b\u232a]$/.test(prev.textContent);
			if (!prev || (prev.localName === "mo" && !closes)) {
				mo.setAttribute("lspace", "0");
				mo.setAttribute("rspace", "0");
			}
		}
	},

	// Renders TeX as native MathML via KaTeX. KaTeX builds markup from escaped
	// text only, and it is parsed as XML and imported node by node. Unparseable
	// TeX is shown as source, marked as an error, instead of red fragments.
	renderMath(doc, tex, displayMode) {
		let source = tex.trim();
		// KaTeX (here and in Zotero's note editor) rejects \label, \ref and \eqref. Labels
		// move onto the block, where linkTheorems() numbers them; a reference becomes
		// text that linkTheorems() later fills with the number.
		// Each row of an align or gather is an equation with its own \label and \tag; a row
		// break inside a nested cases or matrix is not one.
		let rows = [source];
		let multiRow = source.match(/^\\begin\{(align|gather|alignat)\*\}([\s\S]*)\\end\{\1\*\}$/);
		if (multiRow) {
			rows = [""];
			let depth = 0;
			for (let token of multiRow[2].match(/\\begin\{[^{}]*\}|\\end\{[^{}]*\}|\\\\|\\[\s\S]|[^\\{}]+|[{}]/g) || []) {
				depth += /^(\\begin\{|\{)/.test(token) ? 1 : /^(\\end\{|\})/.test(token) ? -1 : 0;
				if (token === "\\\\" && depth === 0) {
					rows.push("");
				}
				else {
					rows[rows.length - 1] += token;
				}
			}
		}
		let eqs = rows.map(row => {
			let tag = row.match(/\\tag(\*?)\{([^{}]*)\}/);
			return {
				labels: [...row.matchAll(/\\label\{([^{}]*)\}/g)].map(m => m[1].trim()),
				tag: tag ? (tag[1] ? tag[2].trim() : "(" + tag[2].trim() + ")") : null,
			};
		}).filter(eq => eq.labels.length || eq.tag);
		let refs = [];
		tex = source.replace(/\\label\{([^{}]*)\}/g, "").replace(/\\(?:eq)?ref\{([^{}]*)\}/g, (m, label) => {
			// \hbox, unlike \text, is never merged with a neighbouring \text into one <mtext>.
			if (this._noteMode) {
				return "\\hbox{(" + label.trim().replace(/[\\{}^~]/g, "").replace(/[_&#%$]/g, "\\$&") + ")}";
			}
			// KaTeX rewrites some characters of text (' becomes ’), so the <mtext> is found
			// again by a numbered token, not by the label.
			refs.push({ command: m, label: label.trim() });
			return "\\hbox{zsref" + (refs.length - 1) + "}";
		}).trim();
		if (this._noteMode) {
			// Zotero's note editor stores maths as TeX in these elements and renders it itself.
			let node = doc.createElement(displayMode ? "pre" : "span");
			node.className = "math";
			node.textContent = displayMode ? "$$" + tex + "$$" : "$" + tex + "$";
			return node;
		}

		let math = this.texToMathML(doc, tex, displayMode);
		if (math && refs.length) {
			for (let mtext of math.querySelectorAll("mtext")) {
				let token = mtext.textContent.match(/^zsref(\d+)$/);
				if (token) {
					let ref = refs[token[1]];
					mtext.setAttribute("data-ref", ref.label);
					mtext.textContent = "(" + ref.label + ")";
				}
			}
			let annotation = math.querySelector("annotation");
			if (annotation) {
				annotation.textContent = annotation.textContent.replace(/\\hbox\{zsref(\d+)\}/g, (m, k) => refs[k].command);
			}
		}
		let fallback = () => {
			let code = this.el(doc, "code", "zs-tex-error", displayMode ? source : "$" + source + "$");
			code.title = "Could not render this LaTeX";
			return code;
		};

		if (!displayMode) {
			let span = this.el(doc, "span", "zs-math");
			span.title = source;
			span.appendChild(math || fallback());
			return span;
		}

		let box = this.el(doc, "div", "zs-math-block");
		let scroller = this.el(doc, "div", "zs-math-scroll");
		scroller.appendChild(math || fallback());
		if (eqs.length) {
			// JSON, because a LaTeX label may contain any separator, spaces included.
			box.dataset.eqs = JSON.stringify(eqs);
		}
		let copy = this.el(doc, "button", "zs-copy-tex", "Copy TeX");
		copy.title = "Copy LaTeX source";
		copy.addEventListener("click", () => {
			Zotero.Utilities.Internal.copyTextToClipboard(source);
			copy.textContent = "Copied";
			doc.defaultView.setTimeout(() => {
				copy.textContent = "Copy TeX";
			}, 1200);
		});
		box.append(scroller, copy);
		// KaTeX draws the \tag of a single equation itself, but its MathML drops the tags
		// of align and gather rows, so those are shown beside the block with the numbers.
		if (multiRow ? eqs.length : eqs.length && !eqs[0].tag) {
			// Filled in by linkTheorems(), which numbers equations across the whole chat.
			box.classList.add("zs-math-numbered");
			box.appendChild(this.el(doc, "span", "zs-eq-num"));
		}
		return box;
	},
});
