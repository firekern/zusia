"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Theorem links: numbered boxes, \ref{label} links, and a way back
	// ---------------------------------------------------------------------

	renderRef(doc, label, text = null) {
		if (this._noteMode) {
			return doc.createTextNode(text || label);
		}
		let ref = this.el(doc, "span", "zs-ref");
		ref.dataset.ref = label;
		if (text) {
			ref.dataset.text = text;
		}
		ref.setAttribute("role", "link");
		ref.tabIndex = 0;
		ref.appendChild(this.svgIcon(doc, "ref", "zs-ref-icon"));
		ref.appendChild(this.el(doc, "span", "zs-ref-text", text || label));
		return ref;
	},

	// Numbers every statement box in the conversation in reading order (Definition 1,
	// Theorem 2, …), and every labelled equation on its own counter as LaTeX does
	// ((1), (2), …), then points each reference at the box or equation with its label.
	linkTheorems(logEl) {
		let targets = new Map();
		let number = 0;
		for (let box of logEl.querySelectorAll(".zs-env[data-env]")) {
			let num = box.querySelector(":scope > .zs-env-head .zs-env-num");
			if (!num) {
				continue;
			}
			number++;
			num.textContent = " " + number;
			box.dataset.number = String(number);
			if (box.dataset.label && !targets.has(box.dataset.label)) {
				targets.set(box.dataset.label, { el: box, name: this.BOX_ENVS[box.dataset.env] + " " + number });
			}
		}
		let equation = 0;
		for (let block of logEl.querySelectorAll(".zs-math-block[data-eqs]")) {
			// Each labelled row of an align gets its own number; KaTeX's MathML cannot put
			// them on their rows, so the block lists them.
			let eqs = JSON.parse(block.dataset.eqs);
			let names = eqs.map(eq => {
				let name = eq.tag || "(" + ++equation + ")";
				for (let label of eq.labels) {
					if (!targets.has(label)) {
						targets.set(label, { el: block, name });
					}
				}
				return name;
			});
			let num = block.querySelector(":scope > .zs-eq-num");
			if (num) {
				num.textContent = names.length > 1 && !eqs.some(eq => eq.tag) ? names[0] + "–" + names[names.length - 1] : names.join(", ");
			}
		}
		for (let ref of logEl.querySelectorAll(".zs-ref")) {
			let target = targets.get(ref.dataset.ref);
			let text = ref.querySelector(".zs-ref-text");
			ref.classList.toggle("zs-ref-ok", !!target);
			ref.classList.toggle("zs-ref-missing", !target);
			if (target && target.el.dataset.env) {
				let box = target.el;
				let title = box.querySelector(":scope > .zs-env-head .zs-env-title");
				text.textContent = ref.dataset.text || target.name;
				let statement = (box.querySelector(".zs-env-body")?.textContent || "").replace(/\s+/g, " ").trim();
				ref.title = target.name + (title ? title.textContent : "") + "\n" +
					(statement.length > 220 ? statement.slice(0, 220) + "…" : statement) + "\n\nClick to go there";
			}
			else if (target) {
				text.textContent = ref.dataset.text || target.name;
				ref.title = "Equation " + target.name + "\n\nClick to go there";
			}
			else {
				text.textContent = ref.dataset.text || ref.dataset.ref;
				ref.title = "“" + ref.dataset.ref + "” is not defined in this chat";
			}
		}
		// A reference written inside maths cannot be a link; it shows the name as text.
		for (let mtext of logEl.querySelectorAll("mtext[data-ref]")) {
			let target = targets.get(mtext.getAttribute("data-ref"));
			if (target) {
				mtext.textContent = target.name;
			}
		}
	},

	followRef(root, ref) {
		let view = this._views.get(root);
		let log = ref.closest(".zs-log");
		// Same precedence as linkTheorems(): a box wins over an equation with its label.
		let box = log && ([...log.querySelectorAll(".zs-env[data-label]")].find(b => b.dataset.label === ref.dataset.ref) ||
			[...log.querySelectorAll(".zs-math-block[data-eqs]")].find(b => JSON.parse(b.dataset.eqs).some(eq => eq.labels.includes(ref.dataset.ref))));
		if (!view || !box) {
			return;
		}
		view.backStack = view.backStack || [];
		view.backStack.push({ top: view.logEl.scrollTop, ref });
		this.scrollLogTo(view, box);
		box.classList.remove("zs-flash");
		void box.offsetWidth;
		box.classList.add("zs-flash");
		view.doc.defaultView.setTimeout(() => box.classList.remove("zs-flash"), 1800);
		this.updateBack(view);
	},

	goBack(root) {
		let view = this._views.get(root);
		let entry = view && view.backStack && view.backStack.pop();
		if (!entry) {
			return;
		}
		view.logEl.scrollTo({ top: entry.top, behavior: "smooth" });
		if (entry.ref && entry.ref.isConnected) {
			entry.ref.classList.remove("zs-flash");
			void entry.ref.offsetWidth;
			entry.ref.classList.add("zs-flash");
			view.doc.defaultView.setTimeout(() => entry.ref.classList.remove("zs-flash"), 1800);
			entry.ref.focus({ preventScroll: true });
		}
		this.updateBack(view);
	},

	// Scrolls only the conversation (not the whole item pane) so the box sits near the top third.
	scrollLogTo(view, node) {
		let log = view.logEl;
		let offset = node.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop;
		log.scrollTo({ top: Math.max(0, offset - log.clientHeight * 0.25), behavior: "smooth" });
	},

	updateBack(view) {
		let back = view.root && view.root.querySelector(".zs-back");
		if (!back) {
			return;
		}
		let depth = (view.backStack || []).length;
		back.hidden = !depth;
		back.setLabel(depth > 1 ? "Back (" + depth + ")" : "Back");
		back.title = "Return to where you were (" + (Zotero.isMac ? "⌥←" : "Alt+←") + ")";
	},
});
