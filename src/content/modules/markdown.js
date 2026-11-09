"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Markdown + LaTeX rendering (DOM nodes only, never innerHTML)
	// ---------------------------------------------------------------------

	// Collects lines from `start` until `isEnd(line)` is true, returning the
	// collected lines and the index of the closing line.
	collectUntil(lines, start, isEnd) {
		let collected = [];
		let i = start;
		while (i < lines.length && !isEnd(lines[i])) {
			collected.push(lines[i]);
			i++;
		}
		return { collected, end: i };
	},

	// Collects a \begin{env} … \end{env} block, honouring nested blocks of the same env.
	collectEnvironment(lines, start, env) {
		let escaped = env.replace(/[*]/g, "\\*");
		let beginRe = new RegExp("\\\\begin\\{" + escaped + "\\}", "g");
		let endRe = new RegExp("\\\\end\\{" + escaped + "\\}", "g");
		let depth = 0;
		let collected = [];
		let i = start;
		for (; i < lines.length; i++) {
			collected.push(lines[i]);
			depth += (lines[i].match(beginRe) || []).length;
			depth -= (lines[i].match(endRe) || []).length;
			if (depth <= 0) {
				break;
			}
		}
		let source = collected.join("\n");
		let inner = source
			.replace(new RegExp("^\\s*\\\\begin\\{" + escaped + "\\}"), "")
			.replace(new RegExp("\\\\end\\{" + escaped + "\\}[^]*$"), "");
		return { source, inner, end: Math.min(i, lines.length - 1) };
	},

	// Splits a Markdown table row on "|", ignoring pipes inside `code` and $maths$
	// (where \| is a norm), and turning an escaped \| in plain text into a literal pipe.
	splitTableRow(line) {
		let text = line.trim();
		let cells = [];
		let cell = "";
		let inMath = false;
		let inCode = false;
		for (let i = 0; i < text.length; i++) {
			let ch = text[i];
			if (ch === "\\" && i + 1 < text.length) {
				if (text[i + 1] === "|" && !inMath && !inCode) {
					cell += "|";
				}
				else {
					cell += ch + text[i + 1];
				}
				i++;
				continue;
			}
			if (ch === "`" && !inMath) {
				inCode = !inCode;
			}
			else if (ch === "$" && !inCode) {
				inMath = !inMath;
			}
			if (ch === "|" && !inMath && !inCode) {
				cells.push(cell.trim());
				cell = "";
				continue;
			}
			cell += ch;
		}
		cells.push(cell.trim());
		// Drop the empty cells produced by leading and trailing pipes.
		if (text.startsWith("|")) {
			cells.shift();
		}
		if (/[^\\]\|$/.test(text) || text === "|") {
			cells.pop();
		}
		return cells;
	},

	tableAlignments(separator) {
		if (!/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(separator || "") || !separator.includes("-")) {
			return null;
		}
		return this.splitTableRow(separator).map((cell) => {
			let left = cell.startsWith(":");
			let right = cell.endsWith(":");
			return left && right ? "center" : right ? "right" : "left";
		});
	},

	isTableStart(lines, i) {
		let line = lines[i];
		if (!line.includes("|")) {
			return null;
		}
		let aligns = this.tableAlignments(lines[i + 1]);
		if (!aligns || (!lines[i + 1].includes("|") && aligns.length < 2)) {
			return null;
		}
		let header = this.splitTableRow(line);
		if (header.length < 2 && !line.trim().startsWith("|")) {
			return null;
		}
		return { header, aligns };
	},

	renderMarkdown(doc, container, text) {
		let lines = text.replace(/\r\n/g, "\n").split("\n");
		let paragraph = [];
		// Open lists, outermost first: { indent, el }.
		let lists = [];
		let lastLineWasListItem = false;

		let flushParagraph = () => {
			if (!paragraph.length) {
				return;
			}
			let p = doc.createElement("p");
			paragraph.forEach((line, i) => {
				if (i > 0) {
					p.appendChild(doc.createElement("br"));
				}
				this.renderInline(doc, p, line.trim());
			});
			container.appendChild(p);
			paragraph = [];
		};
		let closeLists = () => {
			lists = [];
		};
		let block = (node) => {
			flushParagraph();
			closeLists();
			container.appendChild(node);
		};
		let currentItem = () => (lists.length ? lists[lists.length - 1].el.lastElementChild : null);
		// A block that belongs to the list item above it (indented, or directly after it).
		let blockInList = (node) => {
			let item = currentItem();
			if (item) {
				item.appendChild(node);
				return true;
			}
			return false;
		};

		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];
			let trimmed = line.trim();
			let indent = line.length - line.trimStart().length;
			let continuesList = lists.length && (indent >= 2 || lastLineWasListItem);
			let wasListItem = lastLineWasListItem;
			lastLineWasListItem = false;

			let fence = trimmed.match(/^```\s*([\w-]*)/);
			if (fence) {
				let { collected, end } = this.collectUntil(lines, i + 1, l => /^\s*```/.test(l));
				i = end;
				let body = collected.map(l => l.slice(Math.min(indent, l.length - l.trimStart().length))).join("\n");
				let node;
				if (/^(math|katex|latex-display)$/i.test(fence[1])) {
					node = this.renderMath(doc, body, true);
				}
				else if (/^svg-pending$/i.test(fence[1])) {
					node = this.renderDrawingPlaceholder(doc);
				}
				else if (end < lines.length && (/^svg$/i.test(fence[1]) || (!fence[1] && /^\s*<svg[\s>]/.test(body)))) {
					node = this.renderDrawing(doc, body);
				}
				else {
					node = this.renderCodeBlock(doc, body, fence[1]);
				}
				if (!(indent >= 2 && lists.length && blockInList(node))) {
					block(node);
				}
				continue;
			}

			// A drawing written as bare <svg> markup instead of a fenced block.
			if (/^<svg[\s>]/.test(trimmed)) {
				let { collected, end } = this.collectUntil(lines, i, l => /<\/svg>/.test(l));
				if (end < lines.length) {
					collected.push(lines[end]);
					i = end;
					block(this.renderDrawing(doc, collected.join("\n")));
					continue;
				}
			}

			// $$ … $$ and \[ … \] display maths, on one line or spanning several.
			let displayOpen = trimmed.startsWith("$$") ? "$$" : trimmed.startsWith("\\[") ? "\\[" : null;
			if (displayOpen) {
				let close = displayOpen === "$$" ? "$$" : "\\]";
				let rest = trimmed.slice(2);
				let closeAt = rest.indexOf(close);
				let tex;
				let after = "";
				if (closeAt >= 0) {
					tex = rest.slice(0, closeAt);
					after = rest.slice(closeAt + 2).trim();
				}
				else {
					let { collected, end } = this.collectUntil(lines, i + 1, l => l.includes(close));
					let last = end < lines.length ? lines[end] : "";
					let lastCut = last.indexOf(close);
					tex = [rest, ...collected, lastCut >= 0 ? last.slice(0, lastCut) : last].join("\n");
					after = lastCut >= 0 ? last.slice(lastCut + 2).trim() : "";
					i = end;
				}
				let node = this.renderMath(doc, tex, true);
				flushParagraph();
				if (!(continuesList && blockInList(node))) {
					block(node);
				}
				if (after && !/^[.,;:]$/.test(after)) {
					let p = doc.createElement("p");
					this.renderInline(doc, p, after);
					container.appendChild(p);
				}
				lastLineWasListItem = wasListItem && !!continuesList;
				continue;
			}

			let begin = trimmed.match(/^\\begin\{([a-zA-Z]+\*?)\}/);
			if (begin) {
				let env = begin[1];
				let bare = env.replace(/\*$/, "");
				if (this.MATH_ENVS.has(env) || this.BOX_ENVS[bare] || bare === "itemize" || bare === "enumerate") {
					let { source, inner, end } = this.collectEnvironment(lines, i, env);
					i = end;
					let node;
					if (this.MATH_ENVS.has(env)) {
						node = this.renderMath(doc, this.normalizeMathEnv(env, source, inner), true);
					}
					else if (this.BOX_ENVS[bare]) {
						node = this.renderEnvBox(doc, bare, inner);
					}
					else {
						node = this.renderLatexList(doc, bare, inner);
					}
					flushParagraph();
					if (!(continuesList && this.MATH_ENVS.has(env) && blockInList(node))) {
						block(node);
					}
					continue;
				}
			}

			let table = this.isTableStart(lines, i);
			if (table) {
				let rows = [];
				i += 2;
				while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
					rows.push(this.splitTableRow(lines[i]));
					i++;
				}
				i--;
				block(this.renderTable(doc, table.header, rows, table.aligns));
				continue;
			}

			if (/^\s*>/.test(line)) {
				let { collected, end } = this.collectUntil(lines, i, l => !/^\s*>/.test(l));
				i = end - 1;
				let quote = this.el(doc, "blockquote", "zs-quote");
				this.renderMarkdown(doc, quote, collected.map(l => l.replace(/^\s*>\s?/, "")).join("\n"));
				block(quote);
				continue;
			}

			let section = trimmed.match(/^\\(sub)*section\*?\{(.*)\}\s*$/);
			let heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
			if (section || heading) {
				let level = section ? 2 + (section[0].match(/sub/g) || []).length : heading[1].length;
				let content = (section ? section[2] : heading[2]).replace(/\s*#+\s*$/, "");
				let h = this._noteMode
					? doc.createElement("h" + Math.min(level + 1, 6))
					: this.el(doc, "div", "zs-h zs-h" + Math.min(level, 3));
				this.renderInline(doc, h, content);
				block(h);
				continue;
			}

			let item = line.match(/^(\s*)(?:([-*•+])|(\d+)[.)])\s+(.*)$/);
			if (item && !/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
				flushParagraph();
				let tag = item[2] ? "ul" : "ol";
				while (lists.length && indent < lists[lists.length - 1].indent) {
					lists.pop();
				}
				let top = lists[lists.length - 1];
				if (top && indent > top.indent && top.el.lastElementChild) {
					let nested = doc.createElement(tag);
					top.el.lastElementChild.appendChild(nested);
					lists.push({ indent, el: nested });
				}
				else if (!top || top.el.localName !== tag) {
					if (top) {
						lists.pop();
					}
					let list = doc.createElement(tag);
					if (tag === "ol" && Number(item[3]) > 1) {
						list.setAttribute("start", item[3]);
					}
					let parent = lists.length ? lists[lists.length - 1].el.lastElementChild : container;
					parent.appendChild(list);
					lists.push({ indent, el: list });
				}
				let li = doc.createElement("li");
				this.renderInline(doc, li, item[4]);
				lists[lists.length - 1].el.appendChild(li);
				lastLineWasListItem = true;
				continue;
			}

			if (!trimmed) {
				flushParagraph();
				// A blank line only ends a list if the next content is not indented under it.
				let next = lines.slice(i + 1).find(l => l.trim());
				if (!next || next.length - next.trimStart().length < 2) {
					closeLists();
				}
				continue;
			}

			if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
				block(doc.createElement("hr"));
				continue;
			}

			// An indented line (or one directly under an item) continues that list item.
			if (continuesList && currentItem()) {
				let li = currentItem();
				li.appendChild(doc.createElement("br"));
				this.renderInline(doc, li, trimmed);
				lastLineWasListItem = true;
				continue;
			}

			closeLists();
			paragraph.push(line);
		}
		flushParagraph();
	},

	// Streaming updates: keep the blocks that did not change (so formulas, drawings and
	// images are not rebuilt and nothing flickers) and replace from the first difference.
	// Only blocks past the previous end fade in.
	patchChildren(container, next) {
		let old = [...container.children];
		let fresh = [...next.children];
		let same = 0;
		while (same < old.length && same < fresh.length && old[same]._csHTML === fresh[same].outerHTML) {
			same++;
		}
		for (let node of old.slice(same)) {
			node.remove();
		}
		fresh.slice(same).forEach((node, i) => {
			node._csHTML = node.outerHTML;
			if (same + i >= old.length) {
				node.classList.add("zs-enter");
			}
			container.appendChild(node);
		});
	},

	// While an answer streams in, hide a formula whose closing delimiter has not
	// arrived yet, so half-written TeX never flashes on screen.
	withoutIncompleteMath(text) {
		// A drawing still streaming in shows a placeholder instead of half-written SVG.
		let fences = [...text.matchAll(/^[ \t]*```\s*([\w-]*)/gm)];
		if (fences.length % 2 === 1) {
			let open = fences[fences.length - 1];
			let rest = text.slice(open.index + open[0].length);
			if (/^svg$/i.test(open[1]) || (!open[1] && /^\s*<svg/.test(rest))) {
				return text.slice(0, open.index) + "```svg-pending\n```";
			}
		}
		let rawSvg = text.lastIndexOf("<svg");
		if (rawSvg >= 0 && text.indexOf("</svg>", rawSvg) < 0 && /(^|\n)[ \t]*$/.test(text.slice(0, rawSvg))) {
			return text.slice(0, rawSvg) + "```svg-pending\n```";
		}
		let openDisplay = (text.match(/\$\$/g) || []).length % 2 === 1;
		if (openDisplay) {
			return text.slice(0, text.lastIndexOf("$$"));
		}
		let lastLine = text.slice(text.lastIndexOf("\n") + 1);
		let dollars = (lastLine.replace(/\\\$/g, "").match(/\$/g) || []).length;
		if (dollars % 2 === 1) {
			return text.slice(0, text.length - lastLine.length + lastLine.lastIndexOf("$"));
		}
		let openBracket = text.lastIndexOf("\\[") > text.lastIndexOf("\\]");
		return openBracket ? text.slice(0, text.lastIndexOf("\\[")) : text;
	},

	renderCodeBlock(doc, code, language) {
		let pre = doc.createElement("pre");
		pre.appendChild(this.el(doc, "code", null, code));
		if (this._noteMode) {
			return pre;
		}
		let block = this.el(doc, "div", "zs-code");
		let head = this.el(doc, "div", "zs-code-head");
		head.appendChild(this.el(doc, "span", "zs-code-lang", language || "text"));
		let copy = this.ghostButton(doc, "zs-code-copy", "copy", "Copy", () => {
			Zotero.Utilities.Internal.copyTextToClipboard(code);
			copy.setLabel("Copied");
			doc.defaultView.setTimeout(() => copy.setLabel("Copy"), 1200);
		});
		head.appendChild(copy);
		block.append(head, pre);
		return block;
	},

	renderTable(doc, header, rows, aligns = []) {
		let width = Math.max(header.length, ...rows.map(r => r.length));
		let table = doc.createElement("table");
		let cellFor = (tag, text, column) => {
			let cell = doc.createElement(tag);
			if (aligns[column] && aligns[column] !== "left") {
				cell.dataset.align = aligns[column];
			}
			this.renderInline(doc, cell, text || "");
			return cell;
		};
		let thead = doc.createElement("thead");
		let headRow = doc.createElement("tr");
		for (let c = 0; c < width; c++) {
			headRow.appendChild(cellFor("th", header[c], c));
		}
		thead.appendChild(headRow);
		table.appendChild(thead);
		let tbody = doc.createElement("tbody");
		for (let row of rows) {
			let tr = doc.createElement("tr");
			for (let c = 0; c < width; c++) {
				tr.appendChild(cellFor("td", row[c], c));
			}
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
		if (this._noteMode) {
			return table;
		}
		let wrap = this.el(doc, "div", "zs-table-wrap");
		wrap.appendChild(table);
		return wrap;
	},
});
