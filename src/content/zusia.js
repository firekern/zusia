"use strict";

var { OS } = ChromeUtils.importESModule("chrome://zotero/content/osfile.mjs");
var { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

Zusia = {
	PREF_PREFIX: "extensions.zusia.",
	PREFS_PANE_ID: "zusia-prefs",
	DEFAULT_PROMPTS: [
		{ label: "Summarize", prompt: "Summarize this paper" },
		{ label: "Key points", prompt: "What are the key contributions?" },
		{ label: "Methodology", prompt: "Explain the method simply" },
		{ label: "Limitations", prompt: "What are the limitations of this paper?" },
	],
	DEFAULT_EXPLAIN_PROMPT:
		"That explanation didn't click for me. Explain it again, better: start from the intuition " +
		"in plain words, then build up step by step, define every symbol before you use it, work " +
		"through one concrete example, and point out the most common confusion. Use LaTeX for all maths.",
	// Agent CLIs the sidebar can drive. Each runs on the user's own subscription login.
	// `models` are the fixed choices; Codex adds the ones listed in Settings and
	// Antigravity adds whatever `agy models` reports.
	BACKENDS: {
		claude: {
			label: "Claude",
			fullName: "Claude Code",
			command: "claude",
			pathPref: "claudePath",
			models: [
				{ id: "", label: "Default", desc: "Your Claude Code default" },
				{ id: "fable", label: "Fable" },
				{ id: "opus", label: "Opus" },
				{ id: "sonnet", label: "Sonnet" },
				{ id: "haiku", label: "Haiku" },
			],
			efforts: ["", "low", "medium", "high", "xhigh", "max"],
			images: true,
		},
		codex: {
			label: "Codex",
			fullName: "OpenAI Codex",
			command: "codex",
			pathPref: "codexPath",
			models: [{ id: "", label: "Default", desc: "Your Codex default" }],
			efforts: ["", "low", "medium", "high", "xhigh"],
			images: true,
		},
		agy: {
			label: "Antigravity",
			fullName: "Google Antigravity",
			command: "agy",
			pathPref: "agyPath",
			models: [{ id: "", label: "Default", desc: "Your Antigravity default" }],
			efforts: ["", "low", "medium", "high"],
		},
	},
	EFFORTS: {
		"": { label: "Auto", desc: "Let the model decide" },
		low: { label: "Low", desc: "Quick answers" },
		medium: { label: "Medium", desc: "Balanced" },
		high: { label: "High", desc: "Careful reasoning" },
		xhigh: { label: "Extra high", desc: "Longer reasoning" },
		max: { label: "Max", desc: "Deepest reasoning, slowest" },
	},
	// Accent presets. An empty colour follows Zotero's own accent. Each preset keeps
	// its text readable (checked by test/colors.test.mjs).
	ACCENTS: [
		{ name: "Zotero", color: "" },
		{ name: "Red", color: "#d42a3c" },
		{ name: "Clay", color: "#b85a38" },
		{ name: "Violet", color: "#6d4fd6" },
		{ name: "Teal", color: "#0d7f78" },
		{ name: "Forest", color: "#2d7d46" },
		{ name: "Rose", color: "#c03a64" },
		{ name: "Graphite", color: "#5a6070" },
	],
	ZOTERO_ACCENT: "#4072e5",
	// Toggle buttons in the message box that shape the answer. Settings → Chat chooses
	// which are shown; each one's on/off state is remembered (pref "mode.<id>").
	MODES: {
		drawing: {
			label: "Drawing",
			icon: "drawing",
			key: "D",
			title: "Ask for a drawing in the answer",
			instruction: "Include at least one drawing that illustrates the answer, as an ```svg block " +
				"following the drawing rules. It renders directly in the sidebar: never save it to a file " +
				"or tell the user to open it elsewhere.",
		},
		latex: {
			label: "LaTeX",
			icon: "latex",
			key: "L",
			title: "Ask for a rigorous answer written in LaTeX",
			instruction: "Write the answer as rigorous mathematics in LaTeX: every formula in $...$ or " +
				"$$...$$, formal statements in \\begin{definition}, theorem, lemma and proof " +
				"environments, and a derivation step by step with numbered displayed equations.",
		},
	},
	// Answer languages offered in Settings → Chat; "" answers in the language of the question.
	LANGUAGES: ["", "English", "Italiano", "Français", "Deutsch", "Español", "Português", "Nederlands",
		"Polski", "Русский", "Türkçe", "中文", "日本語", "한국어"],
	FONT_SIZES: { small: "12px", default: "13px", large: "14.5px" },
	FONTS: { zotero: "Zotero", sans: "Sans", serif: "Serif", mono: "Mono" },
	// How answers are written (Settings → Behaviour). Each choice adds one line to the prompt.
	BEHAVIOUR: {
		length: {
			short: { label: "Short", icon: "lengthShort", prompt: "Keep answers short: the key point in a few sentences, no preamble." },
			balanced: { label: "Balanced", icon: "lengthBalanced", prompt: "Keep answers focused and reasonably concise." },
			detailed: { label: "Detailed", icon: "lengthDetailed", prompt: "Give thorough, detailed answers with full derivations and examples." },
		},
		level: {
			beginner: { label: "Beginner", icon: "levelBeginner", prompt: "Explain for a beginner: plain words first, define every term, assume little background." },
			student: { label: "Student", icon: "levelStudent", prompt: "Explain for a university student: standard background assumed, define anything specialised." },
			expert: { label: "Expert", icon: "levelExpert", prompt: "Write for an expert: skip basics, be precise and dense." },
		},
		tone: {
			friendly: { label: "Friendly", icon: "toneFriendly", prompt: "Use a warm, encouraging tone, like a patient tutor." },
			neutral: { label: "Neutral", icon: "toneNeutral", prompt: "" },
			formal: { label: "Formal", icon: "toneFormal", prompt: "Use a formal, academic tone." },
		},
	},
	WIZARD_STEPS: ["welcome", "assistant", "look", "buddy", "answers", "done"],
	BACKEND_ICONS: { claude: "sparkle", codex: "terminal", agy: "rocket" },
	// Study buddies: original drawings shown in the empty chat, with a matching header icon.
	MASCOTS: {
		cat: { label: "Cat", icon: "mascot-cat", header: "cat" },
		owl: { label: "Owl", icon: "mascot-owl", header: "bird" },
		robot: { label: "Robot", icon: "mascot-robot", header: "robot" },
		none: { label: "None", icon: null, header: "sparkle" },
	},
	// Faint background patterns behind the chat.
	PATTERNS: {
		none: { label: "None", icon: "none" },
		math: { label: "Maths", icon: "patternMath" },
		grid: { label: "Grid", icon: "patternGrid" },
		dots: { label: "Dots", icon: "patternDots" },
		stars: { label: "Stars", icon: "sparkle" },
	},
	// Icons are Phosphor Duotone (MIT, content/icons/PHOSPHOR-LICENSE), bundled and inlined
	// as SVG so they take the text colour; the soft duotone layer is tinted by CSS (.zs-duo).
	// mascot*.svg are the plugin's own drawings.
	ICON_FILES: {
		settings: "gear-six.svg",
		newChat: "chat-circle-dots.svg",
		history: "clock-counter-clockwise.svg",
		send: "arrow-up.svg",
		sparkle: "sparkle.svg",
		copy: "copy.svg",
		retry: "arrows-clockwise.svg",
		more: "dots-three.svg",
		chevron: "caret-down.svg",
		chevronRight: "caret-down.svg",
		check: "check.svg",
		effort: "brain.svg",
		up: "caret-up.svg",
		down: "caret-down.svg",
		jump: "arrow-down.svg",
		remove: "x.svg",
		alert: "warning-circle.svg",
		paper: "file-text.svg",
		search: "magnifying-glass.svg",
		terminal: "terminal-window.svg",
		thought: "lightbulb.svg",
		edit: "pencil-simple.svg",
		attach: "paperclip.svg",
		screenshot: "selection.svg",
		drawing: "scribble.svg",
		latex: "function.svg",
		save: "download-simple.svg",
		back: "arrow-u-up-left.svg",
		ref: "link.svg",
		cat: "cat.svg",
		bird: "bird.svg",
		robot: "robot.svg",
		code: "code.svg",
		patternMath: "function.svg",
		patternGrid: "grid-four.svg",
		patternDots: "dots-nine.svg",
		none: "prohibit.svg",
		lengthShort: "lightning.svg",
		lengthBalanced: "text-align-left.svg",
		lengthDetailed: "article.svg",
		levelBeginner: "baby.svg",
		levelStudent: "student.svg",
		levelExpert: "graduation-cap.svg",
		toneFriendly: "smiley.svg",
		toneNeutral: "chat-circle.svg",
		toneFormal: "briefcase.svg",
		wave: "hand-waving.svg",
		rocket: "rocket-launch.svg",
		palette: "palette.svg",
		language: "translate.svg",
		next: "arrow-right.svg",
		previous: "arrow-left.svg",
		done: "check-circle.svg",
		clarifications: "highlighter.svg",
		quote: "quotes.svg",
		prompt: "chat-centered-text.svg",
		answer: "book-open-text.svg",
		trash: "trash.svg",
		openPdf: "arrow-square-out.svg",
		styleGlass: "drop.svg",
		styleFlat: "squares-four.svg",
		"mascot-cat": "mascot-cat.svg",
		"mascot-owl": "mascot-owl.svg",
		"mascot-robot": "mascot-robot.svg",
	},
	// Set from rootURI in init().
	iconBase: "content/icons/",
	_iconCache: new Map(),
	// LaTeX environments rendered as display maths, and the ones rendered as labelled boxes.
	MATH_ENVS: new Set([
		"equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*",
		"eqnarray", "eqnarray*", "displaymath", "alignat", "alignat*", "flalign", "flalign*",
	]),
	BOX_ENVS: {
		theorem: "Theorem", lemma: "Lemma", proposition: "Proposition", corollary: "Corollary",
		claim: "Claim", conjecture: "Conjecture", definition: "Definition", notation: "Notation",
		remark: "Remark", note: "Note", example: "Example", exercise: "Exercise", proof: "Proof",
	},
	BOX_KIND: {
		theorem: "thm", lemma: "thm", proposition: "thm", corollary: "thm", claim: "thm", conjecture: "thm",
		definition: "def", notation: "def",
		remark: "rem", note: "rem", example: "rem", exercise: "rem",
		proof: "proof",
	},
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	paneID: null,
	prefsPaneID: null,
	_prefObservers: [],
	_katex: undefined,
	_agyModels: null,
	// True while building Zotero note HTML: maths becomes note-editor markup, not MathML.
	_noteMode: false,
	_logLines: [],
	_logFlushScheduled: false,
	// Requests in flight, keyed by the item's context directory. Kept outside the
	// DOM so an answer survives the item pane re-rendering while the agent thinks.
	_pending: new Map(),
	// Images added to the message box but not sent yet, keyed by context directory:
	// [{ path }], files already copied into <dir>/attachments.
	_staged: new Map(),
	// Text to put in (or send from) a paper's message box once its sidebar renders,
	// keyed by context directory: { text, send }.
	_drafts: new Map(),
	IMAGE_TYPES: { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" },
	MAX_IMAGES: 6,
	ATTACH_KEY: "I",
	// The live view behind each rendered .zs-root.
	_views: new WeakMap(),

	init({ id, version, rootURI }) {
		if (this.initialized) {
			return;
		}
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.iconBase = rootURI + "content/icons/";
		// Updating the plugin while Zotero keeps running would otherwise reuse the
		// previous version's cached stylesheet under the same URL.
		this.stylesheetURL = rootURI + "content/zusia.css?v=" + encodeURIComponent(version + "-" + Date.now());
		this.initialized = true;
		this.log("init() version " + version + " with rootURI=" + rootURI);
	},

	// Logs go to Zotero's debug output and to zusia/debug.log in the
	// data directory, so problems can be diagnosed without enabling debug output.
	log(msg) {
		Zotero.debug("[zusia] " + msg);
		this._logLines.push(new Date().toISOString() + " " + msg);
		if (this._logLines.length > 800) {
			this._logLines.splice(0, this._logLines.length - 800);
		}
		if (!this._logFlushScheduled) {
			this._logFlushScheduled = true;
			Zotero.Promise.delay(1000).then(async () => {
				this._logFlushScheduled = false;
				try {
					await Zotero.File.createDirectoryIfMissingAsync(this.getDataDir());
					await Zotero.File.putContentsAsync(this.getLogPath(), this._logLines.join("\n") + "\n");
				}
				catch (e) {
					Zotero.debug("[zusia] could not write debug.log: " + e);
				}
			});
		}
	},

	logError(where, e) {
		this.log("ERROR in " + where + ": " + e + (e && e.stack ? "\n" + e.stack : ""));
	},

	// ---------------------------------------------------------------------
	// Preferences
	// ---------------------------------------------------------------------

	getPref(name) {
		return Zotero.Prefs.get(this.PREF_PREFIX + name, true);
	},

	setPref(name, value) {
		Zotero.Prefs.set(this.PREF_PREFIX + name, value, true);
	},

	getJSONPref(name, fallback) {
		try {
			let value = this.getPref(name);
			return value ? JSON.parse(value) : fallback;
		}
		catch (e) {
			this.log("Ignoring unreadable pref " + name + ": " + e);
			return fallback;
		}
	},

	getBackend() {
		let backend = this.getPref("backend");
		return this.BACKENDS[backend] ? backend : "claude";
	},

	getModel(backend) {
		return this.getPref(backend + ".model") || "";
	},

	getEffort(backend) {
		let effort = this.getPref(backend + ".effort") || "";
		return this.BACKENDS[backend].efforts.includes(effort) ? effort : "";
	},

	// The models offered for a backend: fixed ones, the Codex models listed in
	// Settings, and Antigravity's own catalogue once it has been fetched.
	getModels(backend) {
		let models = this.BACKENDS[backend].models.slice();
		if (backend === "codex") {
			for (let id of (this.getPref("codex.models") || "").split(/[,\n]/).map(m => m.trim()).filter(Boolean)) {
				models.push({ id, label: id, desc: "" });
			}
		}
		if (backend === "agy" && Array.isArray(this._agyModels)) {
			models.push(...this._agyModels);
		}
		let current = this.getModel(backend);
		if (current && !models.some(m => m.id === current)) {
			models.push({ id: current, label: current, desc: "" });
		}
		return models;
	},

	modelLabel(backend, id) {
		let model = this.getModels(backend).find(m => m.id === id);
		return model ? model.label : id;
	},

	// agy keeps its login in the Secret Service keyring. Zotero's Flatpak has no
	// access to it unless the user grants it, so agy reports "please sign in".
	agySignInHelp(output) {
		if (!/sign in/i.test(output || "")) {
			return null;
		}
		if (Subprocess.getEnvironment().FLATPAK_ID) {
			return "Antigravity is signed in, but Zotero's Flatpak sandbox cannot reach the keyring where " +
				"that login is stored. To allow it, run this once in a terminal and restart Zotero:\n" +
				"flatpak override --user --talk-name=org.freedesktop.secrets org.zotero.Zotero";
		}
		return "Antigravity is not signed in. Run `agy` once in a terminal to sign in.";
	},

	async loadAgyModels() {
		if (Array.isArray(this._agyModels)) {
			return this._agyModels;
		}
		if (!this._agyModelsPromise) {
			this._agyModelsPromise = (async () => {
				try {
					let command = await this.findBinary("agy");
					await Zotero.File.createDirectoryIfMissingAsync(this.getDataDir());
					let { stdout, stderr } = await this.runProcess(command, ["models"], this.getDataDir());
					this._agyModelsError = this.agySignInHelp(stderr);
					this._agyModels = stdout.split("\n")
						.map(line => line.match(/^(\S+)\t(.+)$/))
						.filter(Boolean)
						.map(([, id, label]) => ({ id, label: label.trim() }));
				}
				catch (e) {
					this.log("Could not list Antigravity models: " + e);
					this._agyModels = [];
				}
				this._agyModelsPromise = null;
				return this._agyModels;
			})();
		}
		return this._agyModelsPromise;
	},

	getAppearance() {
		let saved = this.getJSONPref("appearance", {}) || {};
		let number = (value, min, max, fallback) => (typeof value === "number" && isFinite(value)
			? Math.min(max, Math.max(min, Math.round(value))) : fallback);
		let oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback);
		return {
			style: saved.style === "flat" ? "flat" : "glass",
			accent: /^#[0-9a-f]{6}$/i.test(saved.accent || "") ? saved.accent : "",
			bubble: saved.bubble === "accent" ? "accent" : "neutral",
			size: this.FONT_SIZES[saved.size] ? saved.size : "default",
			// A file in the data folder, named by pickBackground().
			background: /^background-\d+\.(png|jpe?g|gif|webp|avif)$/i.test(saved.background || "") ? saved.background : "",
			imageVisibility: number(saved.imageVisibility, 0, 100, 55),
			imageBlur: number(saved.imageBlur, 0, 20, 0),
			glassOpacity: number(saved.glassOpacity, 10, 95, 55),
			glassBlur: number(saved.glassBlur, 0, 40, 18),
			glow: saved.glow !== false,
			glowStrength: number(saved.glowStrength, 0, 100, 60),
			// Empty follows the style: round for glass, rounded for flat.
			corners: oneOf(saved.corners, ["square", "rounded", "round"], ""),
			density: oneOf(saved.density, ["compact", "comfortable", "roomy"], "comfortable"),
			font: oneOf(saved.font, Object.keys(this.FONTS), "zotero"),
			mascot: oneOf(saved.mascot, Object.keys(this.MASCOTS), "cat"),
			pattern: oneOf(saved.pattern, Object.keys(this.PATTERNS), "none"),
			labels: oneOf(saved.labels, ["icons", "text"], "icons"),
		};
	},

	backgroundURL(name) {
		try {
			return Zotero.File.pathToFileURI(OS.Path.join(this.getDataDir(), name));
		}
		catch (e) {
			return name;
		}
	},

	// Asks for an image and copies it into the data folder, so the sidebar keeps it
	// even if the original moves. Returns the copy's file name, or null if cancelled.
	async pickBackground(win) {
		let { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
		let picker = new FilePicker();
		picker.init(win, "Choose a background image", picker.modeOpen);
		picker.appendFilter("Images", "*.png; *.jpg; *.jpeg; *.gif; *.webp; *.avif");
		if (await picker.show() !== picker.returnOK) {
			return null;
		}
		let ext = (picker.file.match(/\.(png|jpe?g|gif|webp|avif)$/i) || [])[1];
		if (!ext) {
			throw new Error("Choose a PNG, JPEG, GIF, WebP or AVIF image.");
		}
		let name = "background-" + Date.now() + "." + ext.toLowerCase();
		await Zotero.File.createDirectoryIfMissingAsync(this.getDataDir());
		await OS.File.copy(picker.file, OS.Path.join(this.getDataDir(), name));
		return name;
	},

	async removeBackgroundFile(name) {
		if (name) {
			await OS.File.remove(OS.Path.join(this.getDataDir(), name), { ignoreAbsent: true });
		}
	},

	saveAppearance(appearance) {
		this.setPref("appearance", JSON.stringify(appearance));
	},

	// WCAG relative luminance and contrast ratio, used to pick readable text on the accent.
	luminance(hex) {
		let [r, g, b] = [1, 3, 5].map((i) => {
			let c = parseInt(hex.slice(i, i + 2), 16) / 255;
			return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	},

	contrast(hexA, hexB) {
		let [hi, lo] = [this.luminance(hexA), this.luminance(hexB)].sort((a, b) => b - a);
		return (hi + 0.05) / (lo + 0.05);
	},

	textOn(hex) {
		return this.contrast(hex, "#ffffff") >= this.contrast(hex, "#1a1a1a") ? "#ffffff" : "#1a1a1a";
	},

	applyAppearance(root, appearance = this.getAppearance()) {
		if (appearance.accent) {
			root.style.setProperty("--zs-accent", appearance.accent);
		}
		else {
			root.style.removeProperty("--zs-accent");
		}
		root.style.setProperty("--zs-accent-text", this.textOn(appearance.accent || this.ZOTERO_ACCENT));
		root.style.setProperty("--zs-font-size", this.FONT_SIZES[appearance.size]);
		root.dataset.style = appearance.style;
		root.dataset.bubble = appearance.bubble;
		root.dataset.corners = appearance.corners || (appearance.style === "glass" ? "round" : "rounded");
		root.dataset.density = appearance.density;
		root.dataset.font = appearance.font;
		root.dataset.mascot = appearance.mascot;
		root.dataset.pattern = appearance.pattern;
		root.dataset.labels = appearance.labels;
		this.applyBehaviour(root);
		let headerIcon = root.querySelector(":scope > .zs-header > .zs-header-icon");
		let wanted = this.MASCOTS[appearance.mascot].header;
		if (headerIcon && headerIcon.dataset.icon !== wanted) {
			headerIcon.replaceWith(this.svgIcon(root.ownerDocument, wanted, "zs-header-icon"));
		}
		root.style.setProperty("--zs-glass-pct", appearance.glassOpacity + "%");
		root.style.setProperty("--zs-glass-strong-pct", Math.min(97, appearance.glassOpacity + 30) + "%");
		root.style.setProperty("--zs-blur", appearance.glassBlur + "px");
		// The glow sits on top of the background image, so fade it as the image is
		// turned up; at full visibility only the image shows.
		let glow = appearance.glow ? appearance.glowStrength / 2 : 0;
		if (appearance.background) {
			glow *= 1 - appearance.imageVisibility / 100;
		}
		root.style.setProperty("--zs-glow-strength", Math.round(glow * 10) / 10 + "%");
		// The image is set on the element itself: Zotero will not load a file:// URL
		// referenced from the plugin's stylesheet (jar:), even through a custom property.
		let image = root.querySelector(":scope > .zs-backdrop > .zs-backdrop-image");
		if (appearance.background) {
			root.dataset.bg = "image";
			root.style.setProperty("--zs-bg-veil", (100 - appearance.imageVisibility) + "%");
			root.style.setProperty("--zs-bg-blur", appearance.imageBlur + "px");
			if (image) {
				image.style.backgroundImage = "url(\"" + this.backgroundURL(appearance.background) + "\")";
			}
		}
		else {
			delete root.dataset.bg;
			root.style.removeProperty("--zs-bg-veil");
			root.style.removeProperty("--zs-bg-blur");
			if (image) {
				image.style.backgroundImage = "";
			}
		}
	},

	getPrompts() {
		let saved = this.getJSONPref("prompts", null);
		if (Array.isArray(saved)) {
			return saved.filter(p => p && typeof p.prompt === "string");
		}
		return this.DEFAULT_PROMPTS.map(p => Object.assign({}, p));
	},

	savePrompts(prompts) {
		this.setPref("prompts", JSON.stringify(prompts));
	},

	// Which mode buttons the message box shows (Settings → Chat).
	getModeButtons() {
		let saved = this.getJSONPref("modeButtons", {}) || {};
		let shown = {};
		for (let id of Object.keys(this.MODES)) {
			shown[id] = saved[id] !== false;
		}
		return shown;
	},

	isModeOn(id) {
		return !!this.getPref("mode." + id) && this.getModeButtons()[id];
	},

	activeModes() {
		return Object.keys(this.MODES).filter(id => this.isModeOn(id));
	},

	modeInstructions(modes) {
		let lines = (modes || []).filter(id => this.MODES[id]).map(id => this.MODES[id].instruction);
		return lines.length ? "\n\n[" + lines.join(" ") + "]" : "";
	},

	getBehaviour() {
		let saved = this.getJSONPref("behaviour", {}) || {};
		let pick = (key, fallback) => (this.BEHAVIOUR[key][saved[key]] ? saved[key] : fallback);
		return {
			length: pick("length", "balanced"),
			level: pick("level", "student"),
			tone: pick("tone", "neutral"),
			custom: typeof saved.custom === "string" ? saved.custom.slice(0, 2000) : "",
			sendKey: saved.sendKey === "mod-enter" ? "mod-enter" : "enter",
			autoScroll: saved.autoScroll !== false,
			showSteps: saved.showSteps !== false,
			showQuick: saved.showQuick !== false,
		};
	},

	saveBehaviour(behaviour) {
		this.setPref("behaviour", JSON.stringify(behaviour));
	},

	behaviourInstructions(behaviour = this.getBehaviour()) {
		let lines = ["length", "level", "tone"].map(key => this.BEHAVIOUR[key][behaviour[key]].prompt).filter(Boolean);
		if (behaviour.custom.trim()) {
			lines.push("User's own instructions: " + behaviour.custom.trim());
		}
		return lines.join(" ");
	},

	applyBehaviour(root, behaviour = this.getBehaviour()) {
		root.dataset.steps = behaviour.showSteps ? "shown" : "hidden";
		root.dataset.quick = behaviour.showQuick ? "shown" : "hidden";
		let send = root.querySelector(".zs-send");
		if (send && !send.classList.contains("zs-stop")) {
			send.title = "Send (" + this.sendKeyLabel(behaviour) + ")";
		}
	},

	sendKeyLabel(behaviour = this.getBehaviour()) {
		return behaviour.sendKey === "mod-enter" ? (Zotero.isMac ? "⌘Enter" : "Ctrl+Enter") : "Enter";
	},

	isSendKey(event, behaviour = this.getBehaviour()) {
		if (event.key !== "Enter" || event.isComposing || event.shiftKey) {
			return false;
		}
		return behaviour.sendKey === "mod-enter" ? (event.metaKey || event.ctrlKey) : !event.altKey;
	},

	getLanguage() {
		let language = (this.getPref("language") || "").trim();
		return this.LANGUAGES.includes(language) ? language : "";
	},

	languageInstruction() {
		let language = this.getLanguage();
		return language
			? "Always reply in " + language + ", whatever language the user writes in."
			: "Reply in the language the user writes in.";
	},

	// Alt+<key> on Windows/Linux, ⌥<key> on macOS. Matched on event.code, because
	// Option+letter types a symbol on a Mac keyboard.
	shortcutLabel(key) {
		return (Zotero.isMac ? "⌥" : "Alt+") + key;
	},

	// Keyboard shortcuts anywhere in the sidebar: toggle Drawing/LaTeX, add an image.
	handleShortcut(root, event) {
		if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "ArrowLeft") {
			let view = this._views.get(root);
			if (view && view.backStack && view.backStack.length) {
				event.preventDefault();
				this.goBack(root);
				return true;
			}
			return false;
		}
		if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !/^Key[A-Z]$/.test(event.code || "")) {
			return false;
		}
		let key = event.code.slice(3);
		for (let [id, mode] of Object.entries(this.MODES)) {
			if (mode.key === key && this.getModeButtons()[id]) {
				event.preventDefault();
				this.setPref("mode." + id, !this.isModeOn(id));
				this.updateControls(root);
				return true;
			}
		}
		if (key === this.ATTACH_KEY) {
			let attach = root.querySelector(".zs-attach");
			if (attach) {
				event.preventDefault();
				this.openAttachMenu(root, attach);
				return true;
			}
		}
		return false;
	},

	getExplainPrompt() {
		return (this.getPref("explainPrompt") || "").trim() || this.DEFAULT_EXPLAIN_PROMPT;
	},

	// Settings changed in the Settings window update every open sidebar at once.
	watchPrefs() {
		let names = ["appearance", "prompts", "backend", "codex.models", "modeButtons", "language", "behaviour", "onboarded"];
		for (let id of Object.keys(this.MODES)) {
			names.push("mode." + id);
		}
		for (let backend of Object.keys(this.BACKENDS)) {
			names.push(backend + ".model", backend + ".effort");
		}
		for (let name of names) {
			this._prefObservers.push(
				Zotero.Prefs.registerObserver(this.PREF_PREFIX + name, () => this.refreshAllSidebars(), true)
			);
		}
	},

	unwatchPrefs() {
		for (let id of this._prefObservers) {
			Zotero.Prefs.unregisterObserver(id);
		}
		this._prefObservers = [];
	},

	refreshAllSidebars() {
		for (let win of Zotero.getMainWindows()) {
			for (let root of win.document.querySelectorAll(".zs-root")) {
				this.refreshRoot(root);
			}
		}
	},

	refreshRoot(root) {
		this.applyAppearance(root);
		if (!this.getPref("onboarded") && !root.querySelector(".zs-wizard")) {
			this.showWizard(root);
		}
		this.updateControls(root);
		let quick = root.querySelector(".zs-quick");
		if (quick) {
			this.renderQuickPrompts(root, quick);
		}
	},

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
			onInit: () => {
				this.log("section onInit");
			},
			onItemChange: ({ item, setEnabled }) => {
				let usable = !!item && (item.isRegularItem() || item.isFileAttachment());
				setEnabled(usable);
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

	// ---------------------------------------------------------------------
	// DOM helpers
	// ---------------------------------------------------------------------

	el(doc, tag, className, text) {
		let node = doc.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	},

	svgIcon(doc, name, className) {
		let icon = this.el(doc, "span", "zs-i" + (className ? " " + className : ""));
		icon.dataset.icon = name;
		icon.setAttribute("aria-hidden", "true");
		if (this.ICON_FILES[name]) {
			this.loadIcon(doc, name).then((svg) => {
				if (svg && !icon.firstChild) {
					icon.appendChild(doc.importNode(svg, true));
				}
			});
		}
		return icon;
	},

	// Fetches a Zotero icon once and returns an <svg> that paints with currentColor.
	loadIcon(doc, name) {
		let url = this.iconBase + this.ICON_FILES[name];
		if (!this._iconCache.has(url)) {
			let win = doc.defaultView;
			let promise = (async () => {
				try {
					let text = await (await win.fetch(url)).text();
					let svg = new win.DOMParser().parseFromString(text, "image/svg+xml").documentElement;
					if (svg.localName !== "svg") {
						throw new Error("not an SVG");
					}
					// Zotero paints icons with context-fill/context-stroke, used in either
					// attribute (attachment.svg strokes with context-fill).
					for (let attr of ["fill", "stroke"]) {
						for (let node of svg.querySelectorAll("[" + attr + "^='context-']")) {
							node.setAttribute(attr, "currentColor");
						}
					}
					for (let node of svg.querySelectorAll("[opacity]")) {
						node.removeAttribute("opacity");
						node.setAttribute("class", "zs-duo");
					}
					svg.removeAttribute("width");
					svg.removeAttribute("height");
					return svg;
				}
				catch (e) {
					this.log("Could not load icon " + url + ": " + e);
					return null;
				}
			})();
			this._iconCache.set(url, promise);
		}
		return this._iconCache.get(url);
	},

	iconButton(doc, className, title, icon, onClick) {
		let button = this.el(doc, "button", "zs-icon " + (className || ""));
		button.type = "button";
		button.title = title;
		button.setAttribute("aria-label", title);
		button.appendChild(this.svgIcon(doc, icon));
		button.addEventListener("click", onClick);
		return button;
	},

	ghostButton(doc, className, icon, label, onClick, { chevron = false } = {}) {
		let button = this.el(doc, "button", "zs-ghost " + (className || ""));
		button.type = "button";
		if (icon) {
			button.appendChild(this.svgIcon(doc, icon));
		}
		let text = this.el(doc, "span", "zs-label", label);
		button.appendChild(text);
		if (chevron) {
			button.appendChild(this.svgIcon(doc, "chevron", "zs-chevron"));
			button.setAttribute("aria-haspopup", "menu");
			button.setAttribute("aria-expanded", "false");
		}
		// Labels can be hidden (Appearance → Button labels), so the name also lives in the tooltip.
		if (label) {
			button.title = label;
		}
		button.addEventListener("click", onClick);
		button.setLabel = (value) => {
			text.textContent = value;
		};
		return button;
	},

	// ---------------------------------------------------------------------
	// Menus (one open at a time, anchored to a button inside .zs-root)
	// ---------------------------------------------------------------------

	closeMenu(root) {
		let menu = root.querySelector(".zs-menu");
		if (menu) {
			menu._cleanup?.();
			menu.remove();
		}
		root.querySelectorAll('[aria-expanded="true"]').forEach(b => b.setAttribute("aria-expanded", "false"));
	},

	// `build(menu)` fills the menu; it may be called again to refresh it in place.
	openMenu(root, anchor, build, { placement = "above", align = "start" } = {}) {
		let wasOpen = anchor.getAttribute("aria-expanded") === "true";
		this.closeMenu(root);
		if (wasOpen) {
			return null;
		}
		let doc = root.ownerDocument;
		let win = doc.defaultView;
		let menu = this.el(doc, "div", "zs-menu");
		menu.setAttribute("role", "menu");
		root.appendChild(menu);
		anchor.setAttribute("aria-expanded", "true");

		// Menus opened from the composer sit above the whole card, not over the text being typed.
		let verticalAnchor = anchor.closest(".zs-composer") || anchor;
		let position = () => {
			let rootRect = root.getBoundingClientRect();
			// Client rects are in zoomed pixels, style lengths are not: convert.
			let scale = root.offsetWidth ? rootRect.width / root.offsetWidth : 1;
			let rect = anchor.getBoundingClientRect();
			let vRect = verticalAnchor.getBoundingClientRect();
			let width = menu.offsetWidth;
			let rootWidth = root.offsetWidth;
			let left = align === "end"
				? (rect.right - rootRect.left) / scale - width
				: (rect.left - rootRect.left) / scale;
			left = Math.max(0, Math.min(left, rootWidth - width));
			menu.style.left = left + "px";
			if (placement === "above") {
				menu.style.bottom = ((rootRect.bottom - vRect.top) / scale + 4) + "px";
				menu.style.top = "";
			}
			else {
				menu.style.top = ((vRect.bottom - rootRect.top) / scale + 4) + "px";
				menu.style.bottom = "";
			}
		};
		menu.refresh = () => {
			menu.textContent = "";
			build(menu);
			position();
		};
		menu.refresh();

		let onPointer = (event) => {
			if (!menu.contains(event.target) && !anchor.contains(event.target)) {
				this.closeMenu(root);
			}
		};
		// Roving focus, as in Beaver's menus: arrows move, Home/End jump, Tab closes.
		let onKey = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.closeMenu(root);
				anchor.focus();
				return;
			}
			if (event.key === "Tab") {
				this.closeMenu(root);
				return;
			}
			let items = [...menu.querySelectorAll(".zs-menu-item:not(:disabled)")];
			if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
				return;
			}
			event.preventDefault();
			let current = items.indexOf(doc.activeElement);
			let next = event.key === "Home" ? 0
				: event.key === "End" ? items.length - 1
				: event.key === "ArrowDown" ? (current + 1) % items.length
				: (current <= 0 ? items.length - 1 : current - 1);
			items[next].focus();
		};
		doc.addEventListener("mousedown", onPointer, true);
		doc.addEventListener("keydown", onKey, true);
		menu._cleanup = () => {
			doc.removeEventListener("mousedown", onPointer, true);
			doc.removeEventListener("keydown", onKey, true);
		};
		win.setTimeout(() => (menu.querySelector('.zs-menu-item[aria-checked="true"]:not(:disabled)')
			|| menu.querySelector(".zs-menu-item:not(:disabled)"))?.focus(), 0);
		return menu;
	},

	menuSection(doc, menu, label) {
		menu.appendChild(this.el(doc, "div", "zs-menu-section", label));
	},

	menuItem(doc, menu, { label, desc, checked, disabled, onSelect }) {
		let item = this.el(doc, "button", "zs-menu-item");
		item.type = "button";
		item.setAttribute("role", checked === undefined ? "menuitem" : "menuitemradio");
		if (checked !== undefined) {
			item.setAttribute("aria-checked", String(!!checked));
			item.appendChild(this.svgIcon(doc, "check", "zs-check"));
		}
		let text = this.el(doc, "span", "zs-menu-text");
		text.appendChild(this.el(doc, "span", "zs-menu-label", label));
		if (desc) {
			text.appendChild(this.el(doc, "span", "zs-menu-desc", desc));
		}
		item.appendChild(text);
		item.disabled = !!disabled;
		item.addEventListener("click", onSelect);
		menu.appendChild(item);
		return item;
	},

	// ---------------------------------------------------------------------
	// Sidebar UI
	// ---------------------------------------------------------------------

	renderSkeleton(doc, body) {
		body.textContent = "";

		let root = this.el(doc, "div", "zs-root");
		// Background image, veil and glow, behind everything else (see .zs-backdrop).
		let backdrop = this.el(doc, "div", "zs-backdrop");
		backdrop.setAttribute("aria-hidden", "true");
		backdrop.appendChild(this.el(doc, "div", "zs-backdrop-image"));
		root.appendChild(backdrop);
		this.applyAppearance(root);

		let header = this.el(doc, "div", "zs-header");
		header.append(
			this.svgIcon(doc, this.MASCOTS[this.getAppearance().mascot].header, "zs-header-icon"),
			this.el(doc, "span", "zs-header-title", "Paper chat"),
			this.iconButton(doc, "zs-clarifications", "Clarifications of highlighted text", "clarifications",
				() => this.openClarifications(root).catch(e => this.logError("openClarifications", e))),
			this.iconButton(doc, "zs-search", "Search all chats", "search", () => this.openSearchMenu(root)),
			this.iconButton(doc, "zs-history", "Previous chats", "history", () => this.openHistoryMenu(root)),
			this.iconButton(doc, "zs-new-chat", "New chat", "newChat", () => this.newChat(root)),
			this.iconButton(doc, "zs-open-settings", "Settings", "settings", () => this.openSettings()),
		);

		let log = this.el(doc, "div", "zs-log");
		log.appendChild(this.el(doc, "div", "zs-notice", "Loading…"));
		let logWrap = this.el(doc, "div", "zs-log-wrap");
		let jump = this.iconButton(doc, "zs-jump", "Scroll to latest", "jump", () => {
			log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
		});
		jump.hidden = true;
		log.addEventListener("scroll", () => this.updateJump(root));
		// Refit formulas and tables when the pane is resized or the maths font arrives.
		let win = doc.defaultView;
		if (doc.fonts && doc.fonts.addEventListener) {
			let refit = () => log.isConnected && this.fitWideContent(log);
			doc.fonts.addEventListener("loadingdone", refit);
			doc.fonts.ready.then(refit);
		}
		if (win && win.ResizeObserver) {
			let pendingFit = null;
			let lastWidth = 0;
			new win.ResizeObserver((entries) => {
				let width = Math.round(entries[0].contentRect.width);
				if (width === lastWidth) {
					return;
				}
				lastWidth = width;
				win.cancelAnimationFrame(pendingFit);
				pendingFit = win.requestAnimationFrame(() => this.fitWideContent(log));
			}).observe(log);
		}
		let back = this.ghostButton(doc, "zs-back", "back", "Back", () => this.goBack(root));
		back.hidden = true;
		log.addEventListener("click", (event) => {
			let ref = event.target.closest && event.target.closest(".zs-ref-ok");
			if (ref) {
				event.preventDefault();
				this.followRef(root, ref);
			}
		});
		logWrap.append(log, jump, back);

		let quick = this.el(doc, "div", "zs-quick");

		let composer = this.el(doc, "div", "zs-composer");
		let input = this.el(doc, "textarea", "zs-input");
		input.rows = 2;
		input.disabled = true;
		composer.addEventListener("mousedown", (event) => {
			if (event.target === composer) {
				event.preventDefault();
				input.focus();
			}
		});

		let controls = this.el(doc, "div", "zs-controls");
		let attachButton = this.iconButton(doc, "zs-attach", "Add an image or screenshot (" + this.shortcutLabel(this.ATTACH_KEY) + ")", "attach", () => this.openAttachMenu(root, attachButton));
		let modelButton = this.ghostButton(doc, "zs-model-btn", null, "", () => this.openModelMenu(root, modelButton), { chevron: true });
		modelButton.title = "Assistant and model";
		let effortButton = this.ghostButton(doc, "zs-effort-btn", "effort", "", () => this.openEffortMenu(root, effortButton), { chevron: true });
		effortButton.title = "Reasoning effort";
		let send = this.iconButton(doc, "zs-send", "Send (" + this.sendKeyLabel() + ")", "send", () => this.sendOrStop(root));
		send.className = "zs-send";
		send.disabled = true;
		let modeButtons = Object.entries(this.MODES).map(([id, mode]) => {
			let button = this.ghostButton(doc, "zs-mode zs-mode-" + id, mode.icon, mode.label, () => {
				this.setPref("mode." + id, !this.isModeOn(id));
				this.updateControls(root);
			});
			button.dataset.mode = id;
			button.title = mode.title + " (" + this.shortcutLabel(mode.key) + ")";
			return button;
		});
		controls.append(attachButton, ...modeButtons, modelButton, effortButton, this.el(doc, "span", "zs-spacer"), send);

		let context = this.el(doc, "div", "zs-context");
		context.hidden = true;
		let attachments = this.el(doc, "div", "zs-attachments");
		attachments.hidden = true;
		composer.append(context, attachments, input, controls);
		root.append(header, logWrap, quick, composer);
		root.addEventListener("keydown", event => this.handleShortcut(root, event));
		body.appendChild(root);

		this.updateControls(root);
		this.renderQuickPrompts(root, quick);
		this.checkInstalledBackends(root);
		if (!this.getPref("onboarded")) {
			this.showWizard(root);
		}
	},

	updateControls(root) {
		let backend = this.getBackend();
		let info = this.BACKENDS[backend];
		let model = this.getModel(backend);
		let effort = this.getEffort(backend);
		let modelButton = root.querySelector(".zs-model-btn");
		if (modelButton) {
			let full = model ? info.label + " · " + this.modelLabel(backend, model) : info.label;
			// Long model names drop the assistant prefix, as Beaver drops the vendor name.
			modelButton.setLabel(full.length > 22 && model ? this.modelLabel(backend, model) : full);
			modelButton.title = full + " — choose assistant and model";
		}
		let effortButton = root.querySelector(".zs-effort-btn");
		if (effortButton) {
			effortButton.setLabel(this.EFFORTS[effort].label);
		}
		let shown = this.getModeButtons();
		for (let button of root.querySelectorAll(".zs-mode")) {
			let id = button.dataset.mode;
			button.hidden = !shown[id];
			button.setAttribute("aria-pressed", String(this.isModeOn(id)));
		}
		let input = root.querySelector(".zs-input");
		if (input) {
			input.placeholder = "Ask " + info.label + " about this paper…";
		}
		root.querySelector(".zs-menu")?.refresh?.();
	},

	async checkInstalledBackends(root) {
		root._installed = root._installed || {};
		for (let key of Object.keys(this.BACKENDS)) {
			root._installed[key] = await this.probeBinary(key);
		}
		root.querySelector(".zs-menu")?.refresh?.();
	},

	async probeBinary(key) {
		try {
			return await this.findBinary(key);
		}
		catch (e) {
			return null;
		}
	},

	openModelMenu(root, anchor) {
		let doc = root.ownerDocument;
		let menu = this.openMenu(root, anchor, (menu) => {
			let current = this.getBackend();
			for (let [key, backend] of Object.entries(this.BACKENDS)) {
				let installed = root._installed ? root._installed[key] : undefined;
				this.menuSection(doc, menu, backend.fullName);
				if (installed === null) {
					menu.appendChild(this.el(doc, "div", "zs-menu-note",
						"Not installed. Install the " + backend.command + " CLI or set its path in Settings."));
					continue;
				}
				for (let model of this.getModels(key)) {
					this.menuItem(doc, menu, {
						label: model.label,
						desc: model.id ? "" : model.desc,
						checked: key === current && model.id === this.getModel(key),
						onSelect: () => {
							this.setPref(key + ".model", model.id);
							this.setPref("backend", key);
							this.closeMenu(root);
							this.updateControls(root);
						},
					});
				}
				if (key === "agy" && !Array.isArray(this._agyModels)) {
					menu.appendChild(this.el(doc, "div", "zs-menu-note", "Loading models…"));
				}
				if (key === "agy" && this._agyModelsError) {
					menu.appendChild(this.el(doc, "div", "zs-menu-note", "Sign-in not reachable from Zotero, so only the default model is listed. See Settings."));
				}
			}
		});
		if (menu && !Array.isArray(this._agyModels)) {
			this.loadAgyModels().then(() => menu.isConnected && menu.refresh());
		}
	},

	openEffortMenu(root, anchor) {
		let doc = root.ownerDocument;
		this.openMenu(root, anchor, (menu) => {
			let backend = this.getBackend();
			let current = this.getEffort(backend);
			this.menuSection(doc, menu, "Reasoning effort · " + this.BACKENDS[backend].label);
			for (let effort of this.BACKENDS[backend].efforts) {
				this.menuItem(doc, menu, {
					label: this.EFFORTS[effort].label,
					desc: this.EFFORTS[effort].desc,
					checked: effort === current,
					onSelect: () => {
						this.setPref(backend + ".effort", effort);
						this.closeMenu(root);
						this.updateControls(root);
					},
				});
			}
		});
	},

	renderQuickPrompts(root, quick) {
		let doc = root.ownerDocument;
		quick.textContent = "";
		for (let { label, prompt } of this.getPrompts()) {
			if (!prompt.trim()) {
				continue;
			}
			let pill = this.el(doc, "button", "zs-pill", label.trim() || prompt);
			pill.type = "button";
			pill.title = prompt;
			pill.addEventListener("click", () => this._views.get(root)?.send(prompt));
			quick.appendChild(pill);
		}
		quick.hidden = !quick.childElementCount;
		let view = this._views.get(root);
		if (view) {
			this.setBusy(view, this._pending.has(view.ctx.dir));
		}
	},

	scrollToEnd(logEl) {
		logEl.scrollTop = logEl.scrollHeight;
	},

	updateJump(root) {
		let log = root.querySelector(".zs-log");
		let jump = root.querySelector(".zs-jump");
		if (log && jump) {
			jump.hidden = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
		}
	},

	// Renders Markdown/LaTeX into `node`, falling back to plain text if the
	// renderer throws, so one odd answer cannot blank the whole conversation.
	renderRich(doc, node, text) {
		node.classList.add("zs-rich");
		try {
			this.renderMarkdown(doc, node, text);
		}
		catch (e) {
			this.logError("renderMarkdown", e);
			node.textContent = text;
			node.classList.add("zs-plain");
		}
	},

	// Puts a question back into the composer so it can be changed and sent again.
	editPrompt(view, text, images = []) {
		view.input.value = text;
		this.autoGrow(view.input);
		if (images.length) {
			this._staged.set(view.ctx.dir, images.map(path => ({ path, sent: true })));
			this.renderAttachments(view);
		}
		if (!this._pending.has(view.ctx.dir)) {
			view.root.querySelector(".zs-send").disabled = !this.canSend(view);
		}
		view.input.focus();
		view.input.setSelectionRange(text.length, text.length);
	},

	appendUser(view, text, images = [], modes = []) {
		let card = this.el(view.doc, "div", "zs-msg zs-user");
		card.dataset.text = text;
		card.images = images;
		if (images.length) {
			let strip = this.el(view.doc, "div", "zs-user-images");
			for (let path of images) {
				strip.appendChild(this.imageThumb(view.doc, path, {
					onOpen: () => Zotero.launchFile(path),
				}));
			}
			card.appendChild(strip);
		}
		if (text) {
			let body = this.el(view.doc, "div", "zs-user-text");
			try {
				this.renderInline(view.doc, body, text);
			}
			catch (e) {
				this.logError("renderInline", e);
				body.textContent = text;
			}
			card.appendChild(body);
		}
		let tags = modes.filter(id => this.MODES[id]);
		if (tags.length) {
			let row = this.el(view.doc, "div", "zs-user-modes");
			for (let id of tags) {
				let tag = this.el(view.doc, "span", "zs-user-mode");
				tag.append(this.svgIcon(view.doc, this.MODES[id].icon), this.el(view.doc, "span", null, this.MODES[id].label));
				row.appendChild(tag);
			}
			card.appendChild(row);
		}
		let edit = this.iconButton(view.doc, "zs-small zs-user-edit", "Edit and resend", "edit", (event) => {
			event.stopPropagation();
			this.editPrompt(view, text, images);
		});
		card.appendChild(edit);
		view.logEl.appendChild(card);
		if (card.scrollHeight > 150) {
			card.classList.add("zs-clamped");
			card.title = "Click to show the whole message";
			card.addEventListener("click", () => {
				if (!view.doc.defaultView.getSelection().toString()) {
					card.classList.toggle("zs-clamped");
					card.title = card.classList.contains("zs-clamped") ? "Click to show the whole message" : "";
				}
			});
		}
		this.scrollToEnd(view.logEl);
		return card;
	},

	appendError(view, text, { title, retry } = {}) {
		let { doc } = view;
		let card = this.el(doc, "div", "zs-msg zs-error");
		card.setAttribute("role", "alert");
		let head = this.el(doc, "button", "zs-error-head");
		head.type = "button";
		head.setAttribute("aria-expanded", "false");
		let icon = this.el(doc, "span", "zs-error-icon");
		icon.appendChild(this.svgIcon(doc, "alert"));
		head.append(icon, this.el(doc, "span", "zs-error-title", title || "Something went wrong"),
			this.svgIcon(doc, "chevronRight", "zs-error-chevron"));
		let details = this.el(doc, "div", "zs-error-details");
		details.appendChild(this.el(doc, "div", "zs-error-text", text));
		let actions = this.el(doc, "div", "zs-error-actions");
		if (retry) {
			actions.appendChild(this.ghostButton(doc, "zs-error-retry", "retry", "Try again", retry));
		}
		let copy = this.ghostButton(doc, "", "copy", "Copy details", () => {
			Zotero.Utilities.Internal.copyTextToClipboard(text);
			copy.setLabel("Copied");
		});
		actions.appendChild(copy);
		details.appendChild(actions);
		// Short errors are shown straight away; long ones start collapsed.
		let open = text.length < 240;
		let setOpen = (value) => {
			open = value;
			details.hidden = !open;
			head.setAttribute("aria-expanded", String(open));
			card.classList.toggle("zs-open", open);
		};
		head.addEventListener("click", () => setOpen(!open));
		setOpen(open);
		card.append(head, details);
		view.logEl.appendChild(card);
		this.scrollToEnd(view.logEl);
		return card;
	},

	// "Surname et al., 2022" and whether the PDF text can be read, for the paper chip.
	paperInfo(ctx) {
		let item = ctx && ctx.paperItem;
		if (!item) {
			return null;
		}
		let creators = (item.getCreators && item.getCreators()) || [];
		let first = creators[0] ? (creators[0].lastName || creators[0].name || "") : "";
		let authors = first ? first + (creators.length > 2 ? " et al." : creators.length === 2 ? " & " + (creators[1].lastName || creators[1].name || "") : "") : "";
		let year = (this.safeField(item, "date").match(/\d{4}/) || [""])[0];
		let title = this.safeField(item, "title");
		let label = [authors, year].filter(Boolean).join(", ") || title || "This item";
		let attachment = ctx.attachmentItem;
		let isPDF = !!(attachment && attachment.isPDFAttachment && attachment.isPDFAttachment());
		let itemType = isPDF ? "attachmentPDF" : (item.itemType || "document");
		return { label, title, itemType };
	},

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
		return (msg.images || []).map(p => OS.Path.join(dir, p));
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

	renderPaperChip(root, info) {
		let holder = root.querySelector(".zs-context");
		if (!holder) {
			return;
		}
		holder.textContent = "";
		holder.hidden = !info;
		if (!info) {
			return;
		}
		let doc = root.ownerDocument;
		let chip = this.el(doc, "span", "zs-context-chip");
		chip.title = (info.title ? info.title + "\n" : "") +
			"Answers use the title, authors, abstract and your annotations, not the PDF text";
		chip.append(this.svgIcon(doc, "paper", "zs-context-icon"), this.el(doc, "span", "zs-context-label", info.label));
		holder.appendChild(chip);
	},

	// "Read paper.txt · searched twice · thought for 8s", from the recorded steps.
	summarizeActivity(activity) {
		let steps = (activity && activity.steps) || [];
		let parts = [];
		let reads = steps.filter(s => s.kind === "read");
		let searches = steps.filter(s => s.kind === "search");
		let other = steps.filter(s => s.kind !== "read" && s.kind !== "search");
		if (reads.length) {
			let files = [...new Set(reads.map(s => s.target).filter(Boolean))];
			parts.push(files.length === 1 ? "read " + files[0] : "read " + (files.length || reads.length) + " files");
		}
		if (searches.length) {
			parts.push(searches.length === 1 ? "searched once" : searches.length === 2 ? "searched twice" : "searched " + searches.length + " times");
		}
		if (other.length) {
			parts.push(other.length === 1 ? other[0].label.toLowerCase() : other.length + " other steps");
		}
		let seconds = Math.round(((activity && activity.thoughtMs) || 0) / 1000);
		if (seconds >= 1) {
			parts.push("thought for " + seconds + "s");
		}
		let text = parts.join(" · ");
		return text ? text[0].toUpperCase() + text.slice(1) : "";
	},

	renderStepRow(doc, step) {
		let row = this.el(doc, "div", "zs-step");
		let icon = { read: "paper", search: "search", thought: "thought" }[step.kind] || "terminal";
		row.appendChild(this.svgIcon(doc, icon, "zs-step-icon"));
		let label = this.el(doc, "span", "zs-step-label", step.label);
		label.title = step.label;
		row.appendChild(label);
		return row;
	},

	// Beaver's tool/thinking parts: one muted line that expands to the individual steps.
	renderActivity(doc, activity) {
		let summary = this.summarizeActivity(activity);
		if (!summary) {
			return null;
		}
		let box = this.el(doc, "div", "zs-activity");
		let head = this.el(doc, "button", "zs-activity-head");
		head.type = "button";
		head.setAttribute("aria-expanded", "false");
		head.append(this.svgIcon(doc, "chevronRight", "zs-activity-chevron"), this.el(doc, "span", "zs-activity-summary", summary));
		let list = this.el(doc, "div", "zs-activity-list");
		list.hidden = true;
		for (let step of activity.steps || []) {
			list.appendChild(this.renderStepRow(doc, step));
		}
		if (activity.thoughtMs >= 1000) {
			list.appendChild(this.renderStepRow(doc, { kind: "thought", label: "Thought for " + Math.round(activity.thoughtMs / 1000) + "s" }));
		}
		head.addEventListener("click", () => {
			list.hidden = !list.hidden;
			head.setAttribute("aria-expanded", String(!list.hidden));
			box.classList.toggle("zs-open", !list.hidden);
		});
		box.append(head, list);
		return box;
	},

	appendAssistant(view, msg, options = {}) {
		let turn = this.el(view.doc, "div", "zs-turn");
		let activity = msg.activity ? this.renderActivity(view.doc, msg.activity) : null;
		if (activity) {
			turn.appendChild(activity);
		}
		let bubble = this.el(view.doc, "div", "zs-msg zs-assistant");
		this.renderRich(view.doc, bubble, msg.text);
		if (msg.stopped) {
			bubble.appendChild(this.el(view.doc, "div", "zs-stopped", "Stopped"));
		}
		turn.appendChild(bubble);
		if (options.footer) {
			turn.appendChild(this.renderFooter(view, msg, options));
		}
		view.logEl.appendChild(turn);
		this.scrollToEnd(view.logEl);
		return turn;
	},

	// Beaver's answer footer: a text action on the left, quiet icon actions on the right.
	renderFooter(view, msg, { byline, question, isLast, index }) {
		let { doc } = view;
		let footer = this.el(doc, "div", "zs-footer");

		let explain = this.ghostButton(doc, "zs-explain", "sparkle", "Explain better", () => {
			let prompt = this.getExplainPrompt();
			if (!isLast) {
				let excerpt = msg.text.replace(/\s+/g, " ").slice(0, 300);
				prompt = "About your earlier answer that begins \"" + excerpt + "…\": " + prompt;
			}
			view.send(prompt);
		});
		explain.title = "Ask for a clearer, step-by-step explanation";
		footer.append(explain, this.el(doc, "span", "zs-spacer"));

		if (byline) {
			footer.appendChild(this.el(doc, "span", "zs-by", byline));
		}
		if (isLast && question) {
			footer.appendChild(this.iconButton(doc, "zs-small zs-retry", "Retry", "retry", () => this.retry(view, index)));
		}
		let copy = this.iconButton(doc, "zs-small zs-copy", "Copy", "copy", () => {
			Zotero.Utilities.Internal.copyTextToClipboard(msg.text);
			copy.title = "Copied";
			doc.defaultView.setTimeout(() => {
				copy.title = "Copy";
			}, 1500);
		});
		footer.appendChild(copy);

		let more = this.iconButton(doc, "zs-small zs-more", "More actions", "more", () => {
			let root = view.root;
			this.openMenu(root, more, (menu) => {
				this.menuItem(doc, menu, {
					label: "Save as note",
					desc: "Child note on this paper, maths kept",
					onSelect: async () => {
						this.closeMenu(root);
						try {
							await this.saveAsNote(view.ctx, question, msg.text);
							more.title = "Saved as note";
						}
						catch (e) {
							this.logError("saveAsNote", e);
							this.appendError(view, "Could not save the note: " + (e.message || e));
						}
					},
				});
				this.menuItem(doc, menu, {
					label: "Copy",
					desc: "Markdown with LaTeX",
					onSelect: () => {
						Zotero.Utilities.Internal.copyTextToClipboard(msg.text);
						this.closeMenu(root);
					},
				});
			}, { placement: "above", align: "end" });
		});
		more.setAttribute("aria-haspopup", "menu");
		more.setAttribute("aria-expanded", "false");
		footer.appendChild(more);
		return footer;
	},

	renderEmptyState(view) {
		let { doc } = view;
		let empty = this.el(doc, "div", "zs-empty");
		let mascot = this.MASCOTS[this.getAppearance().mascot];
		if (mascot.icon) {
			empty.appendChild(this.svgIcon(doc, mascot.icon, "zs-mascot"));
		}
		empty.appendChild(this.el(doc, "div", "zs-empty-title", "Ask about this paper"));
		let title = view.ctx && view.ctx.paperItem ? this.safeField(view.ctx.paperItem, "title") : "";
		if (title) {
			empty.appendChild(this.el(doc, "div", "zs-empty-paper", title));
		}
		empty.appendChild(this.el(doc, "div", "zs-empty-sub",
			"Answers use the paper's details and your highlights. Select text in the PDF to ask about it, or turn on Drawing and LaTeX below."));
		view.logEl.appendChild(empty);
	},

	describeRun(msg) {
		let backend = this.BACKENDS[msg.backend || "claude"];
		if (!backend) {
			return msg.backend || "";
		}
		let parts = [backend.label];
		if (msg.model) {
			parts.push(this.modelLabel(msg.backend || "claude", msg.model));
		}
		return parts.join(" · ");
	},

	renderMessages(view, history) {
		view.logEl.textContent = "";
		view.backStack = [];
		this.updateBack(view);
		view.root.dataset.chatting = String(history.length > 0);
		let quick = view.root.querySelector(".zs-quick");
		if (quick) {
			this.markOverflow(quick);
		}
		if (!history.length) {
			this.renderEmptyState(view);
			return;
		}
		// Only label answers once more than one assistant or model took part.
		let runs = new Set(history.filter(m => m.role === "assistant").map(m => this.describeRun(m)));
		let labelled = runs.size > 1;
		let lastAssistant = history.map(m => m.role).lastIndexOf("assistant");
		history.forEach((msg, index) => {
			if (msg.role === "user") {
				this.appendUser(view, msg.text, this.imagePaths(view.ctx.dir, msg), msg.modes || []);
				return;
			}
			let turn = this.appendAssistant(view, msg, {
				footer: true,
				index,
				isLast: index === lastAssistant,
				question: index > 0 && history[index - 1].role === "user" ? history[index - 1].text : "",
				byline: labelled ? this.describeRun(msg) : null,
			});
			turn.classList.toggle("zs-last", index === lastAssistant);
		});
		this.linkTheorems(view.logEl);
		this.fitWideContent(view.logEl);
	},

	// A formula slightly wider than the pane is shrunk to fit (not below 72%);
	// anything still too wide, formulas or tables, scrolls behind a soft edge fade
	// instead of showing a permanent scrollbar.
	fitWideContent(container) {
		for (let scroller of container.querySelectorAll(".zs-math-scroll")) {
			scroller.style.fontSize = "";
			// Glyph spacing does not scale exactly, so re-measure a few times.
			let scale = 1;
			for (let pass = 0; pass < 4 && scale > 0.72; pass++) {
				let natural = scroller.scrollWidth;
				let available = scroller.clientWidth;
				if (!available || natural <= available + 1) {
					break;
				}
				scale = Math.max(0.72, Math.floor(scale * (available / natural) * 100 - 1) / 100);
				scroller.style.fontSize = Math.round(scale * 100) + "%";
			}
			this.markOverflow(scroller);
		}
		for (let wrap of container.querySelectorAll(".zs-table-wrap")) {
			this.markOverflow(wrap);
		}
	},

	markOverflow(scroller) {
		let update = () => {
			let overflow = scroller.scrollWidth > scroller.clientWidth + 1;
			scroller.classList.toggle("zs-overflow", overflow);
			scroller.classList.toggle("zs-at-start", scroller.scrollLeft <= 1);
			scroller.classList.toggle("zs-at-end", scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1);
		};
		if (!scroller._csOverflowWatched) {
			scroller._csOverflowWatched = true;
			scroller.addEventListener("scroll", update, { passive: true });
		}
		update();
	},

	setBusy(view, busy) {
		let { root } = view;
		let send = root.querySelector(".zs-send");
		if (send) {
			send.classList.toggle("zs-stop", busy);
			send.replaceChildren(this.svgIcon(view.doc, busy ? "stop" : "send"));
			send.title = busy ? "Stop" : "Send (" + this.sendKeyLabel() + ")";
			send.setAttribute("aria-label", send.title);
			send.disabled = !busy && !this.canSend(view);
		}
		view.input.disabled = false;
		root.querySelectorAll(".zs-pill, .zs-explain, .zs-retry, .zs-new-chat").forEach((button) => {
			button.disabled = busy;
		});
	},

	autoGrow(input) {
		input.style.height = "auto";
		input.style.height = Math.min(input.scrollHeight, 180) + "px";
	},

	sendOrStop(root) {
		let view = this._views.get(root);
		if (!view) {
			return;
		}
		let pending = this._pending.get(view.ctx.dir);
		if (pending) {
			pending.cancel();
		}
		else {
			view.send(view.input.value, this.stagedPaths(view));
		}
	},

	async renderContent(doc, body, item) {
		let root = body.querySelector(".zs-root");
		let logEl = body.querySelector(".zs-log");
		let input = body.querySelector(".zs-input");
		if (!logEl) {
			return;
		}

		let notice = (text) => {
			logEl.textContent = "";
			logEl.appendChild(this.el(doc, "div", "zs-notice", text));
		};

		if (!item) {
			notice("Select a paper to start.");
			return;
		}

		let ctx;
		try {
			ctx = await this.getContext(item);
		}
		catch (e) {
			this.logError("getContext", e);
			notice("Could not read this item: " + (e.message || e));
			return;
		}
		if (!ctx) {
			notice("Select a paper or a PDF to ask about it.");
			return;
		}

		let view = { doc, root, logEl, input, ctx, send: null };
		view.send = (text, images) => this.sendText(view, text, images);

		let history = await this.loadHistory(ctx.dir);
		if (!logEl.isConnected) {
			return;
		}
		this._views.set(root, view);
		this.renderPaperChip(root, this.paperInfo(ctx));
		this.renderAttachments(view);
		this.renderMessages(view, history);
		this.applyJump(view);

		input.addEventListener("input", () => {
			this.autoGrow(input);
			if (!this._pending.has(ctx.dir)) {
				root.querySelector(".zs-send").disabled = !this.canSend(view);
			}
		});
		// A pasted or dropped image is added to the message.
		input.addEventListener("paste", event => this.onPasteOrDrop(view, event, event.clipboardData));
		let composer = root.querySelector(".zs-composer");
		composer.addEventListener("dragover", (event) => {
			if ([...(event.dataTransfer?.types || [])].includes("Files")) {
				event.preventDefault();
				composer.classList.add("zs-drop");
			}
		});
		composer.addEventListener("dragleave", (event) => {
			if (!composer.contains(event.relatedTarget)) {
				composer.classList.remove("zs-drop");
			}
		});
		composer.addEventListener("drop", (event) => {
			composer.classList.remove("zs-drop");
			this.onPasteOrDrop(view, event, event.dataTransfer);
		});
		input.addEventListener("keydown", (event) => {
			if (this.isSendKey(event)) {
				event.preventDefault();
				if (!this._pending.has(ctx.dir)) {
					view.send(input.value, this.stagedPaths(view));
				}
			}
			else if (event.key === "Escape" && this._pending.has(ctx.dir)) {
				event.preventDefault();
				this._pending.get(ctx.dir).cancel();
			}
			else if (event.key === "ArrowUp" && !input.value) {
				// Recall the last question, as chat apps do.
				let last = [...logEl.querySelectorAll(".zs-user")].pop();
				if (last && (last.dataset.text || last.images.length)) {
					event.preventDefault();
					this.editPrompt(view, last.dataset.text, last.images);
				}
			}
		});

		let pending = this._pending.get(ctx.dir);
		if (pending) {
			// A request started before this re-render is still running: reattach to it.
			await this.showPending(view, pending);
		}
		else {
			this.setBusy(view, false);
			this.applyDraft(view);
		}
	},

	startRequest(view, text, images = [], modes = this.activeModes(), { selection = null } = {}) {
		let question = (text || "").trim();
		if ((!question && !images.length) || this._pending.has(view.ctx.dir)) {
			return;
		}
		if (view.input.value.trim() === question) {
			view.input.value = "";
			this.autoGrow(view.input);
		}
		if (images.length) {
			this._staged.delete(view.ctx.dir);
			this.renderAttachments(view);
		}

		let backend = this.getBackend();
		let pending = {
			question,
			images,
			modes,
			selection,
			backend,
			model: this.getModel(backend),
			effort: this.getEffort(backend),
			startedAt: Date.now(),
			partial: "",
			status: "",
			cancelled: false,
			proc: null,
			listeners: new Set(),
		};
		pending.steps = [];
		pending.thoughtMs = 0;
		pending.thinking = false;
		pending.progress = ({ text, status, step, thinking, thoughtMs }) => {
			if (text !== undefined) {
				pending.partial = text;
			}
			if (status !== undefined) {
				pending.status = status;
			}
			if (step) {
				pending.steps.push(step);
			}
			if (thinking !== undefined) {
				pending.thinking = thinking;
			}
			if (thoughtMs) {
				pending.thoughtMs += thoughtMs;
			}
			for (let listener of pending.listeners) {
				listener();
			}
		};
		pending.cancel = () => {
			pending.cancelled = true;
			pending.status = "stopping";
			try {
				pending.proc?.kill();
			}
			catch (e) {
				this.log("kill failed: " + e);
			}
			pending.progress({});
		};
		pending.promise = this.ask(view.ctx, question, pending);
		this._pending.set(view.ctx.dir, pending);
		this.showPending(view, pending);
	},

	// Keeps a conversation next to the current one (chat-<time>.json) so it can be reopened.
	async archiveHistory(dir, history) {
		if (!history.length) {
			return;
		}
		let stamp = new Date(history[history.length - 1].ts || Date.now()).toISOString().replace(/[:.]/g, "-");
		await Zotero.File.putContentsAsync(OS.Path.join(dir, "chat-" + stamp + ".json"), JSON.stringify(history, null, 2));
	},

	async listArchives(dir) {
		let names = [];
		if (typeof IOUtils !== "undefined") {
			names = (await IOUtils.getChildren(dir)).map(path => OS.Path.basename(path));
		}
		else {
			await Zotero.File.iterateDirectory(dir, (entry) => {
				names.push(entry.name);
			});
		}
		let archives = [];
		for (let name of names.filter(n => /^chat-.+\.json$/.test(n))) {
			let path = OS.Path.join(dir, name);
			try {
				let history = JSON.parse(await Zotero.File.getContentsAsync(path));
				let first = history.find(m => m.role === "user");
				let last = history[history.length - 1] || {};
				archives.push({
					path,
					title: first ? first.text.replace(/\s+/g, " ").trim() : "Empty chat",
					count: history.length,
					ts: last.ts || 0,
				});
			}
			catch (e) {
				this.log("Skipping unreadable archive " + name + ": " + e);
			}
		}
		return archives.sort((a, b) => b.ts - a.ts);
	},

	async newChat(root) {
		let view = this._views.get(root);
		if (!view || this._pending.has(view.ctx.dir)) {
			return;
		}
		await this.archiveHistory(view.ctx.dir, await this.loadHistory(view.ctx.dir));
		await this.saveHistory(view.ctx.dir, []);
		await this.saveSessions(view.ctx.dir, {});
		this.renderMessages(view, []);
		view.input.focus();
	},

	async restoreChat(root, archive) {
		let view = this._views.get(root);
		if (!view || this._pending.has(view.ctx.dir)) {
			return;
		}
		let restored = JSON.parse(await Zotero.File.getContentsAsync(archive.path));
		await this.archiveHistory(view.ctx.dir, await this.loadHistory(view.ctx.dir));
		await this.saveHistory(view.ctx.dir, restored);
		// The agents' own sessions belong to the chat being replaced; the restored
		// chat is replayed to them as a transcript on its next question.
		await this.saveSessions(view.ctx.dir, {});
		await OS.File.remove(archive.path);
		this.renderMessages(view, restored);
		this.setBusy(view, false);
	},

	formatWhen(ts) {
		if (!ts) {
			return "";
		}
		let date = new Date(ts);
		let sameDay = date.toDateString() === new Date().toDateString();
		return sameDay
			? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
			: date.toLocaleDateString([], { day: "numeric", month: "short" }) + ", " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	},

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
		// Open the side pane and bring the chat section into view.
		try {
			let pane = win.ZoteroContextPane;
			if (pane && pane.collapsed) {
				pane.togglePane();
			}
			pane?.sidenav?.container?.scrollToPane(this.paneID, "smooth");
		}
		catch (e) {
			this.log("askAboutSelection: could not reveal the sidebar: " + e);
		}
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
	// Theorem 2, …) and points each reference at the box with its label.
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
				targets.set(box.dataset.label, box);
			}
		}
		for (let ref of logEl.querySelectorAll(".zs-ref")) {
			let box = targets.get(ref.dataset.ref);
			let text = ref.querySelector(".zs-ref-text");
			ref.classList.toggle("zs-ref-ok", !!box);
			ref.classList.toggle("zs-ref-missing", !box);
			if (box) {
				let name = this.BOX_ENVS[box.dataset.env] + " " + box.dataset.number;
				let title = box.querySelector(":scope > .zs-env-head .zs-env-title");
				text.textContent = ref.dataset.text || name;
				let statement = (box.querySelector(".zs-env-body")?.textContent || "").replace(/\s+/g, " ").trim();
				ref.title = name + (title ? title.textContent : "") + "\n" +
					(statement.length > 220 ? statement.slice(0, 220) + "…" : statement) + "\n\nClick to go there";
			}
			else {
				text.textContent = ref.dataset.text || ref.dataset.ref;
				ref.title = "“" + ref.dataset.ref + "” is not defined in this chat";
			}
		}
	},

	followRef(root, ref) {
		let view = this._views.get(root);
		let box = ref.closest(".zs-log") && [...ref.closest(".zs-log").querySelectorAll(".zs-env[data-label]")]
			.find(b => b.dataset.label === ref.dataset.ref);
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

	// ---------------------------------------------------------------------
	// Clarifications: what was asked about highlighted text, and the answer
	// ---------------------------------------------------------------------

	async loadClarifications(dir) {
		let path = OS.Path.join(dir, "clarifications.json");
		try {
			if (!(await OS.File.exists(path))) {
				return [];
			}
			let list = JSON.parse(await Zotero.File.getContentsAsync(path));
			return Array.isArray(list) ? list : [];
		}
		catch (e) {
			this.log("loadClarifications failed: " + e);
			return [];
		}
	},

	async saveClarifications(dir, list) {
		await Zotero.File.putContentsAsync(OS.Path.join(dir, "clarifications.json"), JSON.stringify(list, null, 2));
	},

	async appendClarification(dir, record) {
		let list = await this.loadClarifications(dir);
		list.push(record);
		await this.saveClarifications(dir, list);
	},

	// A panel over the chat: the list of clarifications, or one of them in full.
	async openClarifications(root) {
		let view = this._views.get(root);
		if (!view) {
			return;
		}
		let doc = root.ownerDocument;
		root.querySelector(".zs-panel")?.remove();
		let panel = this.el(doc, "div", "zs-panel");
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "Clarifications");
		let head = this.el(doc, "div", "zs-panel-head");
		let back = this.iconButton(doc, "zs-small zs-panel-back", "All clarifications", "previous", () => showList());
		let title = this.el(doc, "div", "zs-panel-title");
		title.append(this.svgIcon(doc, "clarifications"), this.el(doc, "span", null, "Clarifications"));
		let close = this.iconButton(doc, "zs-small zs-panel-close", "Close", "remove", () => closePanel());
		head.append(back, title, close);
		let body = this.el(doc, "div", "zs-panel-body");
		panel.append(head, body);
		let closePanel = () => panel.remove();
		panel.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closePanel();
			}
		});
		root.appendChild(panel);

		let list = (await this.loadClarifications(view.ctx.dir)).sort((a, b) => (b.ts || 0) - (a.ts || 0));

		let showList = () => {
			back.hidden = true;
			body.textContent = "";
			if (!list.length) {
				let empty = this.el(doc, "div", "zs-clar-empty");
				let mascot = this.MASCOTS[this.getAppearance().mascot].icon;
				empty.append(this.svgIcon(doc, mascot || "clarifications", mascot ? "zs-mascot" : "zs-clar-empty-icon"),
					this.el(doc, "div", "zs-clar-empty-title", "Nothing saved yet"),
					this.el(doc, "div", "zs-clar-empty-sub", "Select text in the PDF, then Ask or Explain."));
				body.appendChild(empty);
				return;
			}
			for (let entry of list) {
				let item = this.el(doc, "button", "zs-clar-item");
				item.type = "button";
				item.title = "Open this clarification";
				let top = this.el(doc, "div", "zs-clar-item-top");
				top.append(this.svgIcon(doc, "quote", "zs-clar-quote-icon"), this.el(doc, "span", "zs-clar-passage", entry.passage || ""));
				let meta = this.el(doc, "div", "zs-clar-meta");
				if (entry.pageLabel) {
					meta.appendChild(this.el(doc, "span", "zs-clar-page", "p. " + entry.pageLabel));
				}
				meta.appendChild(this.el(doc, "span", "zs-clar-when", this.formatWhen(entry.ts)));
				let backendIcon = this.svgIcon(doc, this.BACKEND_ICONS[entry.backend] || "sparkle", "zs-clar-backend");
				backendIcon.title = (this.BACKENDS[entry.backend] || {}).label || "";
				meta.appendChild(backendIcon);
				item.append(top, meta);
				item.addEventListener("click", () => showDetail(entry));
				body.appendChild(item);
			}
		};

		let showDetail = (entry) => {
			back.hidden = false;
			body.textContent = "";
			let detail = this.el(doc, "div", "zs-clar-detail");
			let section = (icon, label, content, className) => {
				let box = this.el(doc, "section", "zs-clar-section " + (className || ""));
				let heading = this.el(doc, "div", "zs-clar-heading");
				heading.append(this.svgIcon(doc, icon), this.el(doc, "span", null, label));
				box.append(heading, content);
				detail.appendChild(box);
				return box;
			};
			let passage = this.el(doc, "blockquote", "zs-clar-passage-full", entry.passage || "");
			let passageBox = section("quote", entry.pageLabel ? "Passage · p. " + entry.pageLabel : "Passage", passage);
			passageBox.classList.add("zs-clar-passage-box");

			let prompt = this.el(doc, "pre", "zs-clar-prompt", entry.prompt || entry.question || "");
			section("prompt", "Prompt sent", prompt);
			if (entry.instructions) {
				let details = doc.createElement("details");
				details.className = "zs-clar-instructions";
				let summary = doc.createElement("summary");
				summary.textContent = "Instructions given to the assistant";
				details.append(summary, this.el(doc, "pre", null, entry.instructions));
				detail.appendChild(details);
			}
			let answer = this.el(doc, "div", "zs-msg zs-rich zs-clar-answer");
			this.renderRich(doc, answer, entry.answer || "");
			let run = [(this.BACKENDS[entry.backend] || {}).label, entry.model && this.modelLabel(entry.backend, entry.model)].filter(Boolean).join(" · ");
			section("answer", run ? "Answer · " + run : "Answer", answer);

			let actions = this.el(doc, "div", "zs-clar-actions");
			let chat = this.iconButton(doc, "zs-clar-chat", "Show in the chat", "newChat", () => {
				closePanel();
				this._jump = { dir: view.ctx.dir, index: entry.messageIndex };
				this.applyJump(view);
			});
			let pdf = this.iconButton(doc, "zs-clar-pdf", "Open the passage in the PDF", "openPdf", () => {
				let location = entry.position ? { position: entry.position } : entry.pageLabel ? { pageLabel: entry.pageLabel } : undefined;
				Promise.resolve(Zotero.Reader.open(entry.attachmentID, location)).catch(e => this.logError("open PDF", e));
			});
			pdf.disabled = !entry.attachmentID;
			let copy = this.iconButton(doc, "zs-clar-copy", "Copy the prompt", "copy", () => {
				Zotero.Utilities.Internal.copyTextToClipboard(entry.prompt || entry.question || "");
				copy.title = "Copied";
			});
			let remove = this.iconButton(doc, "zs-clar-delete", "Delete this clarification", "trash", async () => {
				list = list.filter(e => e !== entry);
				showList();
				await this.saveClarifications(view.ctx.dir, [...list].sort((a, b) => (a.ts || 0) - (b.ts || 0)));
			});
			actions.append(chat, pdf, copy, this.el(doc, "span", "zs-spacer"), remove);
			detail.insertBefore(actions, detail.firstChild);
			body.appendChild(detail);
			this.fitWideContent(answer);
		};

		showList();
		doc.defaultView.setTimeout(() => (body.querySelector(".zs-clar-item") || close).focus(), 0);
		return panel;
	},

	// ---------------------------------------------------------------------
	// First-run setup wizard: a few visual steps over the chat
	// ---------------------------------------------------------------------

	showWizard(root) {
		let doc = root.ownerDocument;
		root.querySelector(".zs-wizard")?.remove();
		let wizard = this.el(doc, "div", "zs-wizard");
		wizard.setAttribute("role", "dialog");
		wizard.setAttribute("aria-label", "Set up the sidebar");
		let panel = this.el(doc, "div", "zs-wizard-panel");
		let skip = this.iconButton(doc, "zs-small zs-wizard-skip", "Skip setup", "remove", () => this.finishWizard(root));
		let stage = this.el(doc, "div", "zs-wizard-stage");
		let nav = this.el(doc, "div", "zs-wizard-nav");
		let prev = this.iconButton(doc, "zs-wizard-prev", "Back", "previous", () => go(index - 1));
		let dots = this.el(doc, "div", "zs-wizard-dots");
		let next = this.iconButton(doc, "zs-wizard-next", "Next", "next", () => {
			if (index === this.WIZARD_STEPS.length - 1) {
				this.finishWizard(root);
			}
			else {
				go(index + 1);
			}
		});
		for (let i = 0; i < this.WIZARD_STEPS.length; i++) {
			dots.appendChild(this.el(doc, "span", "zs-wizard-dot"));
		}
		nav.append(prev, dots, next);
		panel.append(skip, stage, nav);
		wizard.appendChild(panel);
		wizard.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.finishWizard(root);
			}
		});
		let index = 0;
		let go = (to) => {
			index = Math.max(0, Math.min(this.WIZARD_STEPS.length - 1, to));
			let name = this.WIZARD_STEPS[index];
			wizard.dataset.step = name;
			stage.textContent = "";
			stage.appendChild(this.wizardStep(root, name));
			prev.hidden = index === 0;
			let last = index === this.WIZARD_STEPS.length - 1;
			next.replaceChildren(this.svgIcon(doc, last ? "done" : index === 0 ? "rocket" : "next"));
			next.title = last ? "Start chatting" : index === 0 ? "Start" : "Next";
			next.setAttribute("aria-label", next.title);
			[...dots.children].forEach((dot, i) => {
				dot.classList.toggle("zs-wizard-dot-done", i < index);
				if (i === index) {
					dot.setAttribute("aria-current", "step");
				}
				else {
					dot.removeAttribute("aria-current");
				}
			});
			stage.classList.remove("zs-wizard-enter");
			void stage.offsetWidth;
			stage.classList.add("zs-wizard-enter");
		};
		root.appendChild(wizard);
		go(0);
		doc.defaultView.setTimeout(() => next.focus(), 0);
		return wizard;
	},

	finishWizard(root) {
		this.setPref("onboarded", true);
		root.querySelector(".zs-wizard")?.remove();
		root.querySelector(".zs-input")?.focus();
	},

	// One wizard step: a big picture, a one- or two-word title, and visual choices.
	wizardStep(root, name) {
		let doc = root.ownerDocument;
		let step = this.el(doc, "div", "zs-wizard-step");
		let hero = (icon, title) => {
			let big = this.svgIcon(doc, icon, icon.startsWith("mascot-") ? "zs-mascot zs-wizard-hero" : "zs-wizard-hero");
			step.append(big, this.el(doc, "div", "zs-wizard-title", title));
		};
		let section = (icon, label, control) => {
			let row = this.el(doc, "div", "zs-wizard-section");
			let head = this.el(doc, "div", "zs-wizard-section-head");
			head.append(this.svgIcon(doc, icon), this.el(doc, "span", null, label));
			row.append(head, control);
			step.appendChild(row);
		};
		let appearance = () => this.getAppearance();
		let setAppearance = (changes) => {
			let next = Object.assign({}, appearance(), changes);
			this.saveAppearance(next);
			this.applyAppearance(root, next);
		};
		let mascotIcon = () => this.MASCOTS[appearance().mascot].icon || "wave";

		if (name === "welcome") {
			hero(mascotIcon(), "Hi, study buddy!");
			step.appendChild(this.el(doc, "div", "zs-wizard-sub", "Five quick picks and you're set."));
		}
		else if (name === "assistant") {
			hero("sparkle", "Your AI");
			let installed = root._installed || {};
			let tiles = this.tiles(doc, Object.entries(this.BACKENDS).map(([value, b]) => ({ value, label: b.label, icon: this.BACKEND_ICONS[value] })),
				this.getBackend(), (v) => {
					this.setPref("backend", v);
					this.updateControls(root);
				});
			for (let tile of tiles.querySelectorAll(".zs-tile")) {
				if (installed[tile.dataset.value] === null) {
					// Shown as a small badge; the name stays the tooltip.
					tile.dataset.missing = "true";
					tile.setAttribute("aria-description", "not installed");
				}
			}
			step.appendChild(tiles);
		}
		else if (name === "look") {
			hero("palette", "Your look");
			section("palette", "Style", this.tiles(doc, [
				{ value: "glass", label: "Glass", icon: "styleGlass" },
				{ value: "flat", label: "Flat", icon: "styleFlat" },
			], appearance().style, v => setAppearance({ style: v })));
			let swatches = this.el(doc, "div", "zs-swatches");
			swatches.setAttribute("role", "radiogroup");
			let current = appearance().accent;
			for (let accent of this.ACCENTS) {
				let swatch = this.el(doc, "button", "zs-swatch");
				swatch.type = "button";
				swatch.setAttribute("role", "radio");
				swatch.setAttribute("aria-label", accent.name);
				swatch.title = accent.name;
				swatch.setAttribute("aria-checked", String(accent.color === current));
				swatch.style.background = accent.color || "var(--accent-blue, " + this.ZOTERO_ACCENT + ")";
				swatch.addEventListener("click", () => {
					swatches.querySelectorAll(".zs-swatch").forEach(s => s.setAttribute("aria-checked", String(s === swatch)));
					setAppearance({ accent: accent.color });
				});
				swatches.appendChild(swatch);
			}
			section("sparkle", "Colour", swatches);
		}
		else if (name === "buddy") {
			hero(mascotIcon(), "Your buddy");
			let heroEl = step.querySelector(".zs-wizard-hero");
			section("toneFriendly", "Buddy", this.tiles(doc,
				Object.entries(this.MASCOTS).map(([value, m]) => ({ value, label: m.label, icon: m.icon || "none" })),
				appearance().mascot, (v) => {
					setAppearance({ mascot: v });
					let icon = this.MASCOTS[v].icon || "wave";
					heroEl.replaceWith(this.svgIcon(doc, icon, icon.startsWith("mascot-") ? "zs-mascot zs-wizard-hero" : "zs-wizard-hero"));
					heroEl = step.querySelector(".zs-wizard-hero");
				}));
			section("patternMath", "Pattern", this.tiles(doc,
				Object.entries(this.PATTERNS).map(([value, p]) => ({ value, label: p.label, icon: p.icon })),
				appearance().pattern, v => setAppearance({ pattern: v })));
		}
		else if (name === "answers") {
			hero("levelStudent", "Your answers");
			section("levelStudent", "Level", this.tiles(doc,
				Object.entries(this.BEHAVIOUR.level).map(([value, o]) => ({ value, label: o.label, icon: o.icon })),
				this.getBehaviour().level, v => this.saveBehaviour(Object.assign(this.getBehaviour(), { level: v }))));
			let language = this.select(doc, this.LANGUAGES.map(l => [l, l || "Same as my question"]), this.getLanguage(),
				v => this.setPref("language", v));
			language.title = "Answer language";
			section("language", "Language", language);
			let modes = this.el(doc, "div", "zs-tiles");
			for (let [id, mode] of Object.entries(this.MODES)) {
				let tile = this.el(doc, "button", "zs-tile");
				tile.type = "button";
				tile.title = mode.label;
				tile.setAttribute("aria-pressed", String(this.isModeOn(id)));
				tile.append(this.svgIcon(doc, mode.icon, "zs-tile-icon"), this.el(doc, "span", "zs-tile-label", mode.label));
				tile.addEventListener("click", () => {
					let on = !this.isModeOn(id);
					this.setPref("mode." + id, on);
					tile.setAttribute("aria-pressed", String(on));
					this.updateControls(root);
				});
				modes.appendChild(tile);
			}
			section("drawing", "Extras", modes);
		}
		else if (name === "done") {
			hero(mascotIcon(), "Ready!");
			step.appendChild(this.el(doc, "div", "zs-wizard-sub", "Change anything later in Settings."));
		}
		return step;
	},

	// ---------------------------------------------------------------------
	// Search across the chats of every paper
	// ---------------------------------------------------------------------

	async listChildren(dir) {
		let entries = [];
		await Zotero.File.iterateDirectory(dir, (entry) => {
			entries.push({ name: entry.name, path: entry.path, isDir: !!entry.isDir });
		});
		return entries;
	},

	// Every saved conversation: { dir, libraryID, key, path, current, history }.
	async loadAllChats() {
		let chats = [];
		let root = this.getDataDir();
		if (!(await OS.File.exists(root))) {
			return chats;
		}
		for (let folder of await this.listChildren(root)) {
			let match = folder.isDir && folder.name.match(/^(\d+)-([A-Z0-9]{8})$/);
			if (!match) {
				continue;
			}
			for (let file of await this.listChildren(folder.path)) {
				if (!/^chat(-.+)?\.json$/.test(file.name)) {
					continue;
				}
				try {
					let history = JSON.parse(await Zotero.File.getContentsAsync(file.path));
					if (Array.isArray(history) && history.length) {
						chats.push({
							dir: folder.path, libraryID: Number(match[1]), key: match[2],
							path: file.path, current: file.name === "chat.json", history,
						});
					}
				}
				catch (e) {
					this.log("search: skipping " + file.path + ": " + e);
				}
			}
		}
		return chats;
	},

	// Messages containing every word of the query, newest first, with a snippet around the first word.
	searchChats(chats, query, limit = 40) {
		let words = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (!words.length) {
			return [];
		}
		let results = [];
		for (let chat of chats) {
			chat.history.forEach((msg, index) => {
				let text = String(msg.text || "");
				let lower = text.toLowerCase();
				if (!words.every(word => lower.includes(word))) {
					return;
				}
				let at = lower.indexOf(words[0]);
				let start = Math.max(0, at - 50);
				let snippet = (start ? "…" : "") + text.slice(start, at + 110).replace(/\s+/g, " ").trim() +
					(at + 110 < text.length ? "…" : "");
				results.push({ chat, index, role: msg.role, snippet, ts: msg.ts || 0 });
			});
		}
		return results.sort((a, b) => b.ts - a.ts).slice(0, limit);
	},

	chatTitle(chat) {
		try {
			let item = Zotero.Items.getByLibraryAndKey(chat.libraryID, chat.key);
			return (item && this.safeField(item, "title")) || "Deleted item";
		}
		catch (e) {
			return "Unknown item";
		}
	},

	openSearchMenu(root) {
		let anchor = root.querySelector(".zs-search");
		if (!anchor) {
			return;
		}
		let doc = root.ownerDocument;
		let win = doc.defaultView;
		let chats = null;
		let results = [];
		let timer = null;
		let input = doc.createElement("input");
		input.type = "search";
		input.className = "zs-search-input";
		input.placeholder = "Search the chats of all papers…";
		let list = this.el(doc, "div", "zs-search-results");
		let draw = () => {
			list.textContent = "";
			if (chats === null) {
				list.appendChild(this.el(doc, "div", "zs-menu-note", "Loading chats…"));
				return;
			}
			if (!input.value.trim()) {
				list.appendChild(this.el(doc, "div", "zs-menu-note",
					"Searches " + chats.length + " saved chat" + (chats.length === 1 ? "" : "s") + ", current and previous."));
				return;
			}
			if (!results.length) {
				list.appendChild(this.el(doc, "div", "zs-menu-note", "No messages match."));
				return;
			}
			for (let result of results) {
				this.menuItem(doc, list, {
					label: this.chatTitle(result.chat),
					desc: (result.role === "user" ? "You: " : "Answer: ") + result.snippet +
						(result.ts ? " · " + this.formatWhen(result.ts) : ""),
					onSelect: () => {
						this.closeMenu(root);
						this.openSearchResult(root, result).catch(e => this.logError("openSearchResult", e));
					},
				});
			}
		};
		input.addEventListener("input", () => {
			win.clearTimeout(timer);
			timer = win.setTimeout(() => {
				results = chats ? this.searchChats(chats, input.value) : [];
				draw();
			}, 120);
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				list.querySelector(".zs-menu-item")?.focus();
			}
		});
		let menu = this.openMenu(root, anchor, (menu) => {
			menu.classList.add("zs-search-menu");
			menu.append(input, list);
			draw();
		}, { placement: "below", align: "end" });
		if (!menu) {
			return;
		}
		win.setTimeout(() => input.focus(), 0);
		this.loadAllChats()
			.catch((e) => {
				this.logError("loadAllChats", e);
				return [];
			})
			.then((loaded) => {
				chats = loaded;
				results = this.searchChats(chats, input.value);
				if (menu.isConnected) {
					draw();
				}
			});
	},

	// Opens the paper the message belongs to (restoring an earlier chat if needed)
	// and scrolls to the message.
	async openSearchResult(root, result) {
		let { chat, index } = result;
		if (!chat.current) {
			if (this._pending.has(chat.dir)) {
				return;
			}
			await this.archiveHistory(chat.dir, await this.loadHistory(chat.dir));
			await this.saveHistory(chat.dir, chat.history);
			await this.saveSessions(chat.dir, {});
			await OS.File.remove(chat.path);
		}
		this._jump = { dir: chat.dir, index };
		let view = this._views.get(root);
		if (view && view.ctx.dir === chat.dir) {
			this.renderMessages(view, await this.loadHistory(chat.dir));
			this.applyJump(view);
			return;
		}
		let item = Zotero.Items.getByLibraryAndKey(chat.libraryID, chat.key);
		if (!item) {
			return;
		}
		let win = Zotero.getMainWindow();
		win.Zotero_Tabs?.select("zotero-pane");
		await win.ZoteroPane.selectItem(item.id);
		// Bring the sidebar section into view once the item pane has rendered it.
		win.setTimeout(() => {
			try {
				win.document.getElementById("zotero-item-details")?.scrollToPane(this.paneID);
			}
			catch (e) {
				this.log("scrollToPane failed: " + e);
			}
		}, 300);
	},

	applyJump(view) {
		let jump = this._jump;
		if (!jump || jump.dir !== view.ctx.dir) {
			return;
		}
		this._jump = null;
		let target = [...view.logEl.children].filter(n => n.matches(".zs-user, .zs-turn"))[jump.index];
		if (target) {
			target.scrollIntoView({ block: "center" });
			target.classList.add("zs-flash");
			view.doc.defaultView.setTimeout(() => target.classList.remove("zs-flash"), 1800);
		}
	},

	openHistoryMenu(root) {
		let view = this._views.get(root);
		let anchor = root.querySelector(".zs-history");
		if (!view || !anchor) {
			return;
		}
		let doc = root.ownerDocument;
		let archives = null;
		let menu = this.openMenu(root, anchor, (menu) => {
			menu.classList.add("zs-history-menu");
			this.menuSection(doc, menu, "Previous chats");
			if (archives === null) {
				menu.appendChild(this.el(doc, "div", "zs-menu-note", "Loading…"));
				return;
			}
			if (!archives.length) {
				menu.appendChild(this.el(doc, "div", "zs-menu-note",
					"No earlier chats for this paper yet. Starting a new chat keeps the current one here."));
				return;
			}
			for (let archive of archives) {
				this.menuItem(doc, menu, {
					label: archive.title,
					desc: archive.count + " messages · " + this.formatWhen(archive.ts),
					disabled: this._pending.has(view.ctx.dir),
					onSelect: () => {
						this.closeMenu(root);
						this.restoreChat(root, archive).catch(e => this.logError("restoreChat", e));
					},
				});
			}
		}, { placement: "below", align: "end" });
		if (menu) {
			this.listArchives(view.ctx.dir)
				.catch((e) => {
					this.logError("listArchives", e);
					return [];
				})
				.then((list) => {
					archives = list;
					if (menu.isConnected) {
						menu.refresh();
					}
				});
		}
	},

	// Replaces the last answer: drop it and its question, then ask again.
	async retry(view, index) {
		if (this._pending.has(view.ctx.dir)) {
			return;
		}
		let history = await this.loadHistory(view.ctx.dir);
		let asked = history[index - 1] && history[index - 1].role === "user" ? history[index - 1] : null;
		if (!asked) {
			return;
		}
		let question = asked.text;
		let images = this.imagePaths(view.ctx.dir, asked);
		let kept = history.slice(0, index - 1);
		await this.saveHistory(view.ctx.dir, kept);
		let sessions = await this.loadSessions(view.ctx.dir);
		for (let session of Object.values(sessions)) {
			session.seen = Math.min(session.seen || 0, kept.length);
		}
		await this.saveSessions(view.ctx.dir, sessions);
		this.renderMessages(view, kept);
		this.startRequest(view, question, images, asked.modes || []);
	},

	async showPending(view, pending) {
		let { doc, logEl } = view;
		let win = doc.defaultView;
		let label = this.BACKENDS[pending.backend].label;

		logEl.querySelector(".zs-empty")?.remove();
		view.root.dataset.chatting = "true";
		logEl.querySelectorAll(".zs-turn.zs-last").forEach(turn => turn.classList.remove("zs-last"));
		this.appendUser(view, pending.question, pending.images, pending.modes);

		let turn = this.el(doc, "div", "zs-turn");
		let live = this.el(doc, "div", "zs-msg zs-assistant");
		let content = this.el(doc, "div", "zs-live-content");
		let typing = this.el(doc, "div", "zs-typing");
		typing.setAttribute("aria-busy", "true");
		let spinner = this.el(doc, "span", "zs-spinner");
		let elapsed = this.el(doc, "span", "zs-elapsed zs-shimmer");
		let seconds = this.el(doc, "span", "zs-seconds");
		typing.append(spinner, elapsed, seconds);
		let steps = this.el(doc, "div", "zs-live-steps");
		live.append(steps, content, typing);
		turn.appendChild(live);
		logEl.appendChild(turn);
		this.scrollToEnd(logEl);
		this.setBusy(view, true);

		let renderedText = null;
		let renderTimer = null;
		let tick = () => {
			let what = pending.status || (pending.partial ? "writing" : "thinking");
			let secs = Math.round((Date.now() - pending.startedAt) / 1000);
			elapsed.textContent = label + " is " + what;
			seconds.textContent = secs >= 8 ? secs + "s" : "";
		};
		let renderPartial = () => {
			renderTimer = null;
			if (!live.isConnected || pending.partial === renderedText) {
				return;
			}
			// Keep following the answer only if the user has not scrolled up to read.
			let atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
			renderedText = pending.partial;
			let next = this.el(doc, "div");
			if (pending.partial) {
				this.renderRich(doc, next, this.withoutIncompleteMath(pending.partial));
			}
			this.patchChildren(content, next);
			this.linkTheorems(logEl);
			if (atBottom && this.getBehaviour().autoScroll) {
				this.scrollToEnd(logEl);
			}
			this.updateJump(view.root);
			this.fitWideContent(content);
		};
		let renderedSteps = 0;
		let renderSteps = () => {
			let list = pending.steps || [];
			while (renderedSteps < list.length) {
				steps.appendChild(this.renderStepRow(doc, list[renderedSteps++]));
			}
			steps.classList.toggle("zs-thinking", !!pending.thinking && !pending.partial);
		};
		let listener = () => {
			tick();
			renderSteps();
			if (!renderTimer) {
				renderTimer = win.setTimeout(renderPartial, 150);
			}
		};
		pending.listeners.add(listener);
		tick();
		renderSteps();
		renderPartial();
		let timer = win.setInterval(tick, 1000);

		let result;
		try {
			result = await pending.promise;
		}
		finally {
			win.clearInterval(timer);
			if (renderTimer) {
				win.clearTimeout(renderTimer);
			}
			pending.listeners.delete(listener);
		}

		if (!logEl.isConnected) {
			// The pane re-rendered meanwhile; the new view shows the saved answer.
			return;
		}

		let history = await this.loadHistory(view.ctx.dir);
		this.renderMessages(view, history);
		if (result.cancelled && !view.input.value.trim()) {
			// Nothing was answered: give the question back so it can be edited and resent.
			this.editPrompt(view, pending.question, pending.images);
		}
		if (result.error) {
			logEl.querySelector(".zs-empty")?.remove();
			this.appendUser(view, pending.question, pending.images, pending.modes);
			this.appendError(view, result.error, {
				title: label + " could not answer",
				retry: () => {
					logEl.querySelectorAll(".zs-error").forEach(n => n.remove());
					this.renderMessages(view, history);
					this.startRequest(view, pending.question, pending.images, pending.modes);
				},
			});
		}
		this.setBusy(view, false);
		view.input.focus();
	},

	async ask(ctx, question, pending) {
		let { backend } = pending;
		let label = this.BACKENDS[backend].label;
		try {
			let files = await this.exportContext(ctx);
			let history = await this.loadHistory(ctx.dir);
			let sessions = await this.loadSessions(ctx.dir);
			let session = sessions[backend] || null;

			let images = pending.images || [];
			if (images.length && !this.BACKENDS[backend].images) {
				return { error: label + " cannot see images from the sidebar. Switch to Claude or Codex, or remove the image and ask again." };
			}
			let request = {
				ctx, files, history, session, images,
				question: (question || "Look at the attached image.") + this.imageNote(backend, images) +
					this.modeInstructions(pending.modes),
				model: pending.model,
				effort: pending.effort,
				onProgress: pending.progress,
				onSpawn: (proc) => {
					pending.proc = proc;
					if (pending.cancelled) {
						proc.kill();
					}
				},
			};
			let result = await this.runBackend(backend, request);

			// A stale or expired session makes the CLI fail; fall back to a fresh
			// session once instead of failing the whole request.
			if (result.resumeFailed && session && !pending.cancelled) {
				this.log(label + ": resume failed (" + result.error + "), retrying as a new session");
				pending.progress({ text: "", status: "starting a new session" });
				result = await this.runBackend(backend, Object.assign({}, request, { session: null }));
			}

			let meta = { backend, model: pending.model || undefined, effort: pending.effort || undefined };
			if ((pending.steps && pending.steps.length) || pending.thoughtMs) {
				meta.activity = { steps: pending.steps || [], thoughtMs: Math.round(pending.thoughtMs || 0) };
			}
			if (pending.cancelled) {
				if (!pending.partial.trim()) {
					return { cancelled: true };
				}
				result = { text: pending.partial.trim(), sessionId: result.sessionId, stopped: true };
			}
			else if (!result.text) {
				return { error: result.error || label + " returned no text." };
			}
			await this.appendHistory(ctx.dir, [
				Object.assign({ role: "user", text: question, ts: Date.now() },
					images.length ? { images: images.map(p => p.startsWith(ctx.dir) ? p.slice(ctx.dir.length).replace(/^[\/\\]+/, "") : p) } : {},
					pending.modes && pending.modes.length ? { modes: pending.modes } : {}),
				Object.assign({ role: "assistant", text: result.text, ts: Date.now() }, meta, result.stopped ? { stopped: true } : {}),
			]);
			if (pending.selection) {
				try {
					await this.appendClarification(ctx.dir, {
						id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
						ts: Date.now(),
						passage: pending.selection.text,
						pageLabel: pending.selection.pageLabel || "",
						position: pending.selection.position || null,
						attachmentID: pending.selection.attachmentID || null,
						question,
						prompt: request.question,
						instructions: backend === "agy" ? "" : this.systemPrompt(),
						answer: result.text,
						stopped: !!result.stopped,
						backend,
						model: pending.model || "",
						effort: pending.effort || "",
						messageIndex: history.length,
					});
				}
				catch (e) {
					this.logError("appendClarification", e);
				}
			}
			if (result.sessionId) {
				sessions[backend] = { id: result.sessionId, seen: history.length + 2 };
				await this.saveSessions(ctx.dir, sessions);
			}
			return {};
		}
		catch (e) {
			this.logError("ask", e);
			return pending.cancelled ? { cancelled: true } : { error: String((e && e.message) || e) };
		}
		finally {
			this._pending.delete(ctx.dir);
		}
	},

	// ---------------------------------------------------------------------
	// Settings pane (Zotero Settings → Zusia)
	// ---------------------------------------------------------------------

	renderPrefsPane(doc, container) {
		container.textContent = "";
		let prefs = this.el(doc, "div", "zs-prefs");
		this.applyAppearance(prefs);
		prefs.append(
			this.buildAssistantsCard(doc),
			this.buildChatCard(doc),
			this.buildAppearanceCard(doc, prefs),
			this.buildBehaviourCard(doc),
			this.buildTroubleshootingCard(doc),
		);
		container.appendChild(prefs);
	},

	card(doc, title, description) {
		let card = this.el(doc, "section", "zs-card");
		let head = this.el(doc, "div", "zs-card-head");
		head.appendChild(this.el(doc, "h2", "zs-card-title", title));
		if (description) {
			head.appendChild(this.el(doc, "p", "zs-card-desc", description));
		}
		let body = this.el(doc, "div", "zs-card-body");
		card.append(head, body);
		card.body = body;
		return card;
	},

	row(doc, label, control, hint, { stack = false } = {}) {
		let row = this.el(doc, "div", "zs-row" + (stack ? " zs-row-stack" : ""));
		let labelEl = this.el(doc, "label", "zs-row-label", label);
		let controlEl = this.el(doc, "div", "zs-row-control");
		controlEl.append(...[].concat(control));
		let focusable = controlEl.querySelector("input, select, textarea");
		if (focusable) {
			focusable.id = focusable.id || "zs-" + Math.random().toString(36).slice(2, 9);
			labelEl.htmlFor = focusable.id;
		}
		row.append(labelEl, controlEl);
		if (hint) {
			row.appendChild(this.el(doc, "div", "zs-row-hint", hint));
		}
		return row;
	},

	select(doc, options, value, onChange) {
		let select = this.el(doc, "select", "zs-select");
		let fill = (opts, selected) => {
			select.textContent = "";
			for (let [optValue, optLabel] of opts) {
				let option = doc.createElement("option");
				option.value = optValue;
				option.textContent = optLabel;
				option.selected = optValue === selected;
				select.appendChild(option);
			}
		};
		fill(options, value);
		select.refill = fill;
		select.addEventListener("change", () => onChange(select.value));
		return select;
	},

	switchControl(doc, checked, onChange) {
		let button = this.el(doc, "button", "zs-switch");
		button.type = "button";
		button.setAttribute("role", "switch");
		button.setAttribute("aria-checked", String(!!checked));
		button.addEventListener("click", () => {
			let next = button.getAttribute("aria-checked") !== "true";
			button.setAttribute("aria-checked", String(next));
			onChange(next);
		});
		return button;
	},

	// A radio group of icon cards: the visual picker used in Settings and the setup wizard.
	tiles(doc, options, value, onChange) {
		let group = this.el(doc, "div", "zs-tiles");
		group.setAttribute("role", "radiogroup");
		for (let option of options) {
			let tile = this.el(doc, "button", "zs-tile");
			tile.type = "button";
			tile.setAttribute("role", "radio");
			tile.setAttribute("aria-checked", String(option.value === value));
			tile.title = option.label;
			tile.dataset.value = option.value;
			tile.appendChild(this.svgIcon(doc, option.icon, "zs-tile-icon"));
			tile.appendChild(this.el(doc, "span", "zs-tile-label", option.label));
			tile.addEventListener("click", () => {
				group.querySelectorAll(".zs-tile").forEach(t => t.setAttribute("aria-checked", String(t === tile)));
				onChange(option.value);
			});
			group.appendChild(tile);
		}
		return group;
	},

	range(doc, { min, max, step = 1, value, unit = "" }, onChange) {
		let wrap = this.el(doc, "div", "zs-range");
		let input = doc.createElement("input");
		input.type = "range";
		input.min = String(min);
		input.max = String(max);
		input.step = String(step);
		input.value = String(value);
		let output = this.el(doc, "span", "zs-range-value", value + unit);
		input.addEventListener("input", () => {
			output.textContent = input.value + unit;
			onChange(Number(input.value));
		});
		wrap.append(input, output);
		return wrap;
	},

	segmented(doc, options, value, onChange) {
		let group = this.el(doc, "div", "zs-segmented");
		group.setAttribute("role", "radiogroup");
		for (let [optValue, optLabel] of options) {
			let button = this.el(doc, "button", null, optLabel);
			button.type = "button";
			button.setAttribute("role", "radio");
			button.setAttribute("aria-checked", String(optValue === value));
			button.addEventListener("click", () => {
				group.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b === button)));
				onChange(optValue);
			});
			group.appendChild(button);
		}
		return group;
	},

	buildAssistantsCard(doc) {
		let card = this.card(doc, "Assistants",
			"Command-line agents that answer in the sidebar. Each one uses your own subscription login, so no API key is needed. Model and effort can also be changed from the chat box.");

		let backendSelect = this.select(doc,
			Object.entries(this.BACKENDS).map(([key, b]) => [key, b.fullName]),
			this.getBackend(),
			(value) => {
				this.setPref("backend", value);
				card.querySelectorAll(".zs-agent").forEach(a => a.querySelector(".zs-badge").hidden = a.dataset.backend !== value);
			});
		card.body.appendChild(this.row(doc, "Answer with", backendSelect));

		for (let [key, backend] of Object.entries(this.BACKENDS)) {
			let details = this.el(doc, "details", "zs-agent");
			details.dataset.backend = key;
			let summary = this.el(doc, "summary");
			let name = this.el(doc, "span", "zs-agent-name");
			let status = this.el(doc, "span", "zs-agent-status", "Checking…");
			name.append(this.el(doc, "strong", null, backend.fullName), status);
			let badge = this.el(doc, "span", "zs-badge", "In use");
			badge.hidden = key !== this.getBackend();
			summary.append(this.el(doc, "span", "zs-agent-dot"), name, badge, this.svgIcon(doc, "chevron", "zs-agent-chevron"));
			details.appendChild(summary);

			let body = this.el(doc, "div", "zs-agent-body");
			let modelSelect = this.select(doc,
				this.getModels(key).map(m => [m.id, m.label + (m.id && m.id !== m.label.toLowerCase() ? "  (" + m.id + ")" : "")]),
				this.getModel(key),
				value => this.setPref(key + ".model", value));
			body.appendChild(this.row(doc, "Model", modelSelect));
			if (key === "agy") {
				this.loadAgyModels().then(() => modelSelect.refill(this.getModels(key).map(m => [m.id, m.label]), this.getModel(key)));
			}
			body.appendChild(this.row(doc, "Reasoning effort", this.select(doc,
				backend.efforts.map(e => [e, this.EFFORTS[e].label + " — " + this.EFFORTS[e].desc]),
				this.getEffort(key),
				value => this.setPref(key + ".effort", value))));
			if (key === "codex") {
				let models = doc.createElement("input");
				models.type = "text";
				models.className = "zs-field";
				models.placeholder = "e.g. gpt-5.5, gpt-5.5-mini";
				models.value = this.getPref("codex.models") || "";
				models.addEventListener("change", () => {
					this.setPref("codex.models", models.value);
					modelSelect.refill(this.getModels(key).map(m => [m.id, m.label]), this.getModel(key));
				});
				body.appendChild(this.row(doc, "Extra models", models, "Comma-separated model names to offer in the model menu."));
			}
			let path = doc.createElement("input");
			path.type = "text";
			path.className = "zs-field";
			path.placeholder = "Detect “" + backend.command + "” automatically";
			path.value = this.getPref(backend.pathPref) || "";
			path.addEventListener("change", () => {
				this.setPref(backend.pathPref, path.value.trim());
				refreshStatus();
			});
			body.appendChild(this.row(doc, "Command path", path));
			if (key === "claude") {
				body.appendChild(this.row(doc, "Use my Claude Code settings",
					this.switchControl(doc, !!this.getPref("useClaudeUserSettings"), v => this.setPref("useClaudeUserSettings", v)),
					"Loads ~/.claude settings, CLAUDE.md and MCP servers. Off by default: instructions written for the terminal do not fit a sidebar."));
			}
			details.appendChild(body);
			card.body.appendChild(details);

			let refreshStatus = () => this.probeBinary(key).then(async (found) => {
				details.dataset.found = String(!!found);
				status.textContent = found || "Not found — install the " + backend.command + " CLI or set its path";
				if (found && key === "agy") {
					await this.loadAgyModels();
					if (this._agyModelsError) {
						details.dataset.found = "false";
						status.textContent = "Signed-in check failed — open for details";
						body.insertBefore(this.row(doc, "Sign-in", this.el(doc, "div", "zs-row-hint", this._agyModelsError), null, { stack: true }), body.firstChild);
					}
				}
			});
			refreshStatus();
		}
		return card;
	},

	buildChatCard(doc) {
		let card = this.card(doc, "Chat", "Quick prompts appear as buttons above the message box.");

		let languageSelect = this.select(doc,
			this.LANGUAGES.map(language => [language, language || "Same as my question"]),
			this.getLanguage(), value => this.setPref("language", value));
		card.body.appendChild(this.row(doc, "Answer language", languageSelect,
			"The assistants answer in this language whatever language you write in."));

		let prompts = this.getPrompts();
		let list = this.el(doc, "div", "zs-prompt-list");
		let save = () => this.savePrompts(prompts);
		let draw = () => {
			list.textContent = "";
			prompts.forEach((entry, index) => {
				let row = this.el(doc, "div", "zs-prompt-row");
				let label = doc.createElement("input");
				label.type = "text";
				label.className = "zs-field";
				label.placeholder = "Label";
				label.value = entry.label || "";
				label.addEventListener("input", () => {
					entry.label = label.value;
					save();
				});
				let text = this.el(doc, "textarea", "zs-textarea zs-autogrow");
				text.rows = 1;
				text.placeholder = "Prompt sent when the button is clicked";
				text.value = entry.prompt;
				text.addEventListener("input", () => {
					entry.prompt = text.value;
					save();
					this.autoGrow(text);
				});
				doc.defaultView.setTimeout(() => this.autoGrow(text), 0);
				let move = (delta) => {
					let [moved] = prompts.splice(index, 1);
					prompts.splice(index + delta, 0, moved);
					save();
					draw();
				};
				let tools = this.el(doc, "div", "zs-prompt-tools");
				let up = this.iconButton(doc, "", "Move up", "up", () => move(-1));
				up.disabled = index === 0;
				let down = this.iconButton(doc, "", "Move down", "down", () => move(1));
				down.disabled = index === prompts.length - 1;
				let remove = this.iconButton(doc, "", "Remove", "remove", () => {
					prompts.splice(index, 1);
					save();
					draw();
				});
				tools.append(up, down, remove);
				row.append(label, text, tools);
				list.appendChild(row);
			});
		};
		draw();
		let buttons = this.el(doc, "div", "zs-button-row");
		let add = this.el(doc, "button", "zs-button", "Add prompt");
		add.type = "button";
		add.addEventListener("click", () => {
			prompts.push({ label: "", prompt: "" });
			save();
			draw();
			list.lastElementChild?.querySelector("input")?.focus();
		});
		let reset = this.el(doc, "button", "zs-button", "Restore defaults");
		reset.type = "button";
		reset.addEventListener("click", () => {
			prompts = this.DEFAULT_PROMPTS.map(p => Object.assign({}, p));
			save();
			draw();
		});
		buttons.append(add, reset);
		card.body.appendChild(this.row(doc, "Quick prompts", [list, buttons], null, { stack: true }));

		let explain = this.el(doc, "textarea", "zs-textarea");
		explain.rows = 3;
		explain.value = this.getExplainPrompt();
		explain.addEventListener("input", () => this.setPref("explainPrompt", explain.value));
		let restore = this.el(doc, "button", "zs-button", "Restore default");
		restore.type = "button";
		restore.addEventListener("click", () => {
			this.setPref("explainPrompt", "");
			explain.value = this.DEFAULT_EXPLAIN_PROMPT;
		});
		let restoreRow = this.el(doc, "div", "zs-button-row");
		restoreRow.appendChild(restore);
		card.body.appendChild(this.row(doc, "“Explain better” request", [explain, restoreRow],
			"Sent when you click Explain better under an answer.", { stack: true }));

		let shown = this.getModeButtons();
		for (let [id, mode] of Object.entries(this.MODES)) {
			card.body.appendChild(this.row(doc, "“" + mode.label + "” button",
				this.switchControl(doc, shown[id], (on) => {
					shown[id] = on;
					this.setPref("modeButtons", JSON.stringify(shown));
				}),
				(id === "drawing"
					? "Shows a Drawing button in the message box. When it is on, answers include a drawing."
					: "Shows a LaTeX button in the message box. When it is on, answers are rigorous maths with theorem and proof boxes.") +
				" Shortcut: " + this.shortcutLabel(mode.key) + "."));
		}
		return card;
	},

	buildAppearanceCard(doc, prefsRoot) {
		let card = this.card(doc, "Appearance", "Colours follow Zotero's light and dark themes.");
		let appearance = this.getAppearance();
		let glassRows = [];
		let imageRows = [];
		let glowRows = [];
		let update = (changes) => {
			appearance = Object.assign({}, appearance, changes);
			this.saveAppearance(appearance);
			this.applyAppearance(prefsRoot, appearance);
			let isPreset = this.ACCENTS.some(a => a.color === appearance.accent);
			swatches.querySelectorAll(".zs-swatch").forEach((swatch) => {
				let checked = swatch.dataset.color !== undefined
					? swatch.dataset.color === appearance.accent
					: !isPreset;
				swatch.setAttribute("aria-checked", String(checked));
			});
			glassRows.forEach(row => (row.hidden = appearance.style !== "glass"));
			glowRows.forEach(row => (row.hidden = appearance.style !== "glass" || !appearance.glow));
			imageRows.forEach(row => (row.hidden = !appearance.background));
			preview.style.backgroundImage = appearance.background
				? "url(\"" + this.backgroundURL(appearance.background) + "\")" : "";
			preview.hidden = !appearance.background;
			removeImage.disabled = !appearance.background;
			// Corners follow the style until one is picked, so show the effective choice.
			corners.querySelectorAll("button").forEach((button, i) => button.setAttribute("aria-checked",
				String(["square", "rounded", "round"][i] === prefsRoot.dataset.corners)));
		};

		let swatches = this.el(doc, "div", "zs-swatches");
		swatches.setAttribute("role", "radiogroup");
		for (let accent of this.ACCENTS) {
			let swatch = this.el(doc, "button", "zs-swatch");
			swatch.type = "button";
			swatch.setAttribute("role", "radio");
			swatch.dataset.color = accent.color;
			swatch.title = accent.name;
			swatch.setAttribute("aria-label", accent.name);
			swatch.style.background = accent.color || "var(--accent-blue, " + this.ZOTERO_ACCENT + ")";
			swatch.addEventListener("click", () => update({ accent: accent.color }));
			swatches.appendChild(swatch);
		}
		let custom = this.el(doc, "label", "zs-swatch zs-swatch-custom");
		custom.title = "Custom colour";
		let picker = doc.createElement("input");
		picker.type = "color";
		picker.value = appearance.accent || this.ZOTERO_ACCENT;
		picker.setAttribute("aria-label", "Custom colour");
		picker.addEventListener("input", () => update({ accent: picker.value }));
		custom.appendChild(picker);
		swatches.appendChild(custom);

		// Background image: a thumbnail with Choose and Remove.
		let preview = this.el(doc, "span", "zs-bg-preview");
		let chooseImage = this.el(doc, "button", "zs-button", "Choose image…");
		chooseImage.type = "button";
		chooseImage.addEventListener("click", async () => {
			try {
				let name = await this.pickBackground(doc.defaultView);
				if (name) {
					let old = appearance.background;
					update({ background: name });
					await this.removeBackgroundFile(old);
				}
			}
			catch (e) {
				this.logError("pickBackground", e);
				doc.defaultView.alert(String((e && e.message) || e));
			}
		});
		let removeImage = this.el(doc, "button", "zs-button", "Remove");
		removeImage.type = "button";
		removeImage.addEventListener("click", async () => {
			let old = appearance.background;
			update({ background: "" });
			await this.removeBackgroundFile(old);
		});
		let imageControls = this.el(doc, "div", "zs-button-row");
		imageControls.append(preview, chooseImage, removeImage);

		let corners = this.segmented(doc, [["square", "Square"], ["rounded", "Rounded"], ["round", "Round"]],
			"", v => update({ corners: v }));

		let row = (...args) => this.row(doc, ...args);
		let slider = (key, min, max, unit) => this.range(doc, { min, max, value: appearance[key], unit }, v => update({ [key]: v }));
		imageRows.push(
			row("Image visibility", slider("imageVisibility", 0, 100, "%"), "Lower values fade the image into the pane so text stays readable."),
			row("Image blur", slider("imageBlur", 0, 20, "px")),
		);
		glassRows.push(
			row("Glass opacity", slider("glassOpacity", 10, 95, "%"), "How solid messages and the message box are."),
			row("Glass blur", slider("glassBlur", 0, 40, "px"), "How much the message box and menus blur what is behind them."),
			row("Background glow", this.switchControl(doc, appearance.glow, v => update({ glow: v }))),
		);
		glowRows.push(row("Glow intensity", slider("glowStrength", 0, 100, "%")));

		card.body.append(
			row("Style", this.segmented(doc, [["glass", "Glass"], ["flat", "Flat"]], appearance.style, v => update({ style: v }))),
			row("Buddy", this.tiles(doc, Object.entries(this.MASCOTS).map(([value, m]) => ({ value, label: m.label, icon: m.icon || "none" })),
				appearance.mascot, v => update({ mascot: v })), null, { stack: true }),
			row("Pattern", this.tiles(doc, Object.entries(this.PATTERNS).map(([value, p]) => ({ value, label: p.label, icon: p.icon })),
				appearance.pattern, v => update({ pattern: v })), null, { stack: true }),
			row("Button labels", this.segmented(doc, [["icons", "Icons only"], ["text", "Icons + text"]], appearance.labels, v => update({ labels: v }))),
			row("Accent colour", swatches, "Used for the send button, links, theorem boxes and drawings."),
			row("Background image", imageControls, "Shown behind the chat."),
			...imageRows,
			...glassRows,
			...glowRows,
			row("Corners", corners),
			row("Spacing", this.segmented(doc, [["compact", "Compact"], ["comfortable", "Comfortable"], ["roomy", "Roomy"]], appearance.density, v => update({ density: v }))),
			row("Font", this.segmented(doc, Object.entries(this.FONTS), appearance.font, v => update({ font: v }))),
			row("Your messages", this.segmented(doc, [["neutral", "Neutral"], ["accent", "Tinted"]], appearance.bubble, v => update({ bubble: v }))),
			row("Text size", this.segmented(doc, [["small", "Small"], ["default", "Default"], ["large", "Large"]], appearance.size, v => update({ size: v }))),
		);
		update({});
		return card;
	},

	buildBehaviourCard(doc) {
		let card = this.card(doc, "Behaviour", "How answers are written and how the chat behaves.");
		let behaviour = this.getBehaviour();
		let update = (changes) => {
			behaviour = Object.assign({}, behaviour, changes);
			this.saveBehaviour(behaviour);
		};
		let row = (...args) => this.row(doc, ...args);
		let tilesFor = key => this.tiles(doc,
			Object.entries(this.BEHAVIOUR[key]).map(([value, o]) => ({ value, label: o.label, icon: o.icon })),
			behaviour[key], v => update({ [key]: v }));
		let custom = this.el(doc, "textarea", "zs-textarea");
		custom.rows = 3;
		custom.maxLength = 2000;
		custom.placeholder = "e.g. Use SI units. Relate ideas to linear algebra.";
		custom.value = behaviour.custom;
		custom.addEventListener("input", () => update({ custom: custom.value }));
		let toggle = key => this.switchControl(doc, behaviour[key], v => update({ [key]: v }));
		card.body.append(
			row("Answer length", tilesFor("length"), null, { stack: true }),
			row("Level", tilesFor("level"), null, { stack: true }),
			row("Tone", tilesFor("tone"), null, { stack: true }),
			row("Your instructions", custom, "Added to every question.", { stack: true }),
			row("Send with", this.segmented(doc, [["enter", "Enter"], ["mod-enter", "⌘/Ctrl + Enter"]], behaviour.sendKey, v => update({ sendKey: v }))),
			row("Follow the answer", toggle("autoScroll"), "Scroll along while the answer is written."),
			row("Thinking steps", toggle("showSteps"), "Show what the assistant read and searched."),
			row("Quick prompts", toggle("showQuick")),
		);
		return card;
	},

	buildTroubleshootingCard(doc) {
		let card = this.card(doc, "Troubleshooting",
			"Conversations are stored per paper in the data folder. The debug log records what the sidebar ran and any errors.");
		let folder = this.el(doc, "button", "zs-button", "Show data folder");
		folder.type = "button";
		folder.addEventListener("click", async () => {
			await Zotero.File.createDirectoryIfMissingAsync(this.getDataDir());
			Zotero.File.reveal(this.getDataDir());
		});
		let logButton = this.el(doc, "button", "zs-button", "Open debug log");
		logButton.type = "button";
		logButton.addEventListener("click", () => Zotero.launchFile(this.getLogPath()));
		let setup = this.el(doc, "button", "zs-button", "Run setup again");
		setup.type = "button";
		setup.addEventListener("click", () => this.setPref("onboarded", false));
		let buttons = this.el(doc, "div", "zs-button-row");
		buttons.append(folder, logButton, setup);
		card.body.appendChild(this.row(doc, "Files", buttons));
		return card;
	},

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

	sendText(view, text, images = []) {
		let draft = view.draftSelection;
		view.draftSelection = null;
		let quoteLine = draft && draft.quote.split("\n").find(line => line.startsWith("> "));
		let extra = draft && quoteLine && String(text).includes(quoteLine) ? { selection: draft.selection } : {};
		this.startRequest(view, text, images, undefined, extra);
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
		let body = inner.replace(/^\s*\[([^\]]*)\]/, (m, t) => {
			title = t;
			return "";
		}).replace(/\\label\{([^{}]+)\}/g, (m, l) => {
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
		tex = tex.trim();
		if (this._noteMode) {
			// Zotero's note editor stores maths as TeX in these elements and renders it itself.
			let node = doc.createElement(displayMode ? "pre" : "span");
			node.className = "math";
			node.textContent = displayMode ? "$$" + tex + "$$" : "$" + tex + "$";
			return node;
		}

		let math = this.texToMathML(doc, tex, displayMode);
		let fallback = () => {
			let code = this.el(doc, "code", "zs-tex-error", displayMode ? tex : "$" + tex + "$");
			code.title = "Could not render this LaTeX";
			return code;
		};

		if (!displayMode) {
			let span = this.el(doc, "span", "zs-math");
			span.title = tex;
			span.appendChild(math || fallback());
			return span;
		}

		let box = this.el(doc, "div", "zs-math-block");
		let scroller = this.el(doc, "div", "zs-math-scroll");
		scroller.appendChild(math || fallback());
		let copy = this.el(doc, "button", "zs-copy-tex", "Copy TeX");
		copy.title = "Copy LaTeX source";
		copy.addEventListener("click", () => {
			Zotero.Utilities.Internal.copyTextToClipboard(tex);
			copy.textContent = "Copied";
			doc.defaultView.setTimeout(() => {
				copy.textContent = "Copy TeX";
			}, 1200);
		});
		box.append(scroller, copy);
		return box;
	},

	// ---------------------------------------------------------------------
	// Context: resolving the item/attachment and exporting files for the agent
	// ---------------------------------------------------------------------

	getDataDir() {
		return OS.Path.join(Zotero.DataDirectory.dir, "zusia");
	},

	getLogPath() {
		return OS.Path.join(this.getDataDir(), "debug.log");
	},

	async getContext(item) {
		let paperItem;
		let attachmentItem;

		if (item.isRegularItem()) {
			paperItem = item;
			attachmentItem = (await item.getBestAttachment()) || null;
		}
		else if (item.isAttachment()) {
			attachmentItem = item;
			paperItem = item.parentItem || item;
		}
		else {
			return null;
		}

		let dirName = paperItem.libraryID + "-" + paperItem.key;
		let dir = OS.Path.join(this.getDataDir(), dirName);
		// createDirectoryIfMissingAsync() does not create missing parents, so create
		// the shared "zusia" directory before the per-item subdirectory.
		await Zotero.File.createDirectoryIfMissingAsync(this.getDataDir());
		await Zotero.File.createDirectoryIfMissingAsync(dir);

		return { paperItem, attachmentItem, dir };
	},

	safeField(item, field) {
		try {
			return item.getField(field) || "";
		}
		catch (e) {
			return "";
		}
	},

	async exportContext(ctx) {
		let { paperItem, attachmentItem, dir } = ctx;
		this.log("exportContext: writing metadata.md/annotations.md to " + dir);

		let lines = ["# " + (this.safeField(paperItem, "title") || "Untitled")];
		let creators = (paperItem.getCreators() || [])
			.map(c => (c.lastName ? [c.firstName, c.lastName].filter(Boolean).join(" ") : c.name || ""))
			.filter(Boolean);
		if (creators.length) {
			lines.push("Authors: " + creators.join(", "));
		}
		let date = this.safeField(paperItem, "date");
		if (date) {
			lines.push("Date: " + date);
		}
		let pub = this.safeField(paperItem, "publicationTitle");
		if (pub) {
			lines.push("Publication: " + pub);
		}
		let doi = this.safeField(paperItem, "DOI");
		if (doi) {
			lines.push("DOI: " + doi);
		}
		let abstractNote = this.safeField(paperItem, "abstractNote");
		if (abstractNote) {
			lines.push("\n## Abstract\n" + abstractNote);
		}
		let metadata = lines.join("\n") + "\n";
		await Zotero.File.putContentsAsync(OS.Path.join(dir, "metadata.md"), metadata);

		// The PDF text is never given to the assistants. Earlier versions exported it
		// as paper.txt: remove it, and forget the sessions that may have read it.
		let paperPath = OS.Path.join(dir, "paper.txt");
		if (await OS.File.exists(paperPath)) {
			await OS.File.remove(paperPath);
			await this.saveSessions(dir, {});
			this.log("exportContext: removed paper.txt and reset sessions in " + dir);
		}

		let annotations = "";
		if (attachmentItem && attachmentItem.isFileAttachment && attachmentItem.isFileAttachment()) {
			let items = attachmentItem.getAnnotations();
			if (items.length) {
				let parts = items.map((a) => {
					let head = "- [" + (a.annotationType || "note") + "]";
					if (a.annotationPageLabel) {
						head += " p." + a.annotationPageLabel;
					}
					let pieces = [];
					if (a.annotationText) {
						pieces.push(a.annotationText);
					}
					if (a.annotationComment) {
						pieces.push("(" + a.annotationComment + ")");
					}
					return head + " " + pieces.join(" ");
				});
				annotations = "# Annotations\n\n" + parts.join("\n");
			}
		}
		await Zotero.File.putContentsAsync(OS.Path.join(dir, "annotations.md"), annotations);

		return { metadata, annotations };
	},

	// ---------------------------------------------------------------------
	// Conversation persistence
	// ---------------------------------------------------------------------

	async loadHistory(dir) {
		let path = OS.Path.join(dir, "chat.json");
		try {
			if (!(await OS.File.exists(path))) {
				return [];
			}
			let text = await Zotero.File.getContentsAsync(path);
			return JSON.parse(text);
		}
		catch (e) {
			this.log("loadHistory failed: " + e);
			return [];
		}
	},

	async appendHistory(dir, messages) {
		let history = await this.loadHistory(dir);
		history.push(...messages);
		await this.saveHistory(dir, history);
	},

	async saveHistory(dir, history) {
		await Zotero.File.putContentsAsync(
			OS.Path.join(dir, "chat.json"),
			JSON.stringify(history, null, 2)
		);
	},

	// session.json maps each backend to { id, seen }, where `seen` is how many
	// chat.json messages that session already knows about.
	async loadSessions(dir) {
		let path = OS.Path.join(dir, "session.json");
		try {
			if (!(await OS.File.exists(path))) {
				return {};
			}
			let data = JSON.parse(await Zotero.File.getContentsAsync(path));
			if (data.sessions) {
				return data.sessions;
			}
			// Files written before multi-backend support hold a single Claude session.
			if (data.sessionId) {
				let history = await this.loadHistory(dir);
				return { claude: { id: data.sessionId, seen: history.length } };
			}
			return {};
		}
		catch (e) {
			this.log("loadSessions failed: " + e);
			return {};
		}
	},

	async saveSessions(dir, sessions) {
		await Zotero.File.putContentsAsync(
			OS.Path.join(dir, "session.json"),
			JSON.stringify({ sessions })
		);
	},

	// ---------------------------------------------------------------------
	// Running the agent CLIs
	// ---------------------------------------------------------------------

	extraSearchPaths(home) {
		if (Zotero.isWin) {
			return [
				OS.Path.join(home, ".local", "bin"),
				OS.Path.join(home, "AppData", "Roaming", "npm"),
			];
		}
		return [
			"/usr/local/bin",
			"/opt/homebrew/bin",
			"/opt/local/bin",
			OS.Path.join(home, ".local", "bin"),
			OS.Path.join(home, ".claude", "local"),
			OS.Path.join(home, ".npm-global", "bin"),
			OS.Path.join(home, "bin"),
		];
	},

	async findBinary(backend) {
		let { label, command, pathPref } = this.BACKENDS[backend];
		let override = this.getPref(pathPref);
		if (override) {
			return override;
		}

		let env = Subprocess.getEnvironment();
		let home = env.HOME || env.USERPROFILE || "";
		let sep = Zotero.isWin ? ";" : ":";
		let searchEnv = Object.assign({}, env);
		searchEnv.PATH = this.extraSearchPaths(home).join(sep) + (env.PATH ? sep + env.PATH : "");

		try {
			return await Subprocess.pathSearch(command, searchEnv);
		}
		catch (e) {
			throw new Error(
				"Could not find the '" + command + "' command. Make sure the " + label + " CLI is " +
				"installed and on your PATH, or set " + this.PREF_PREFIX + pathPref + " (Zotero " +
				"Settings → Advanced → Config Editor) to its full path."
			);
		}
	},

	buildChildEnvironment() {
		let env = Subprocess.getEnvironment();
		// Force subscription logins instead of pay-per-token API keys.
		delete env.ANTHROPIC_API_KEY;
		delete env.ANTHROPIC_AUTH_TOKEN;
		delete env.OPENAI_API_KEY;

		let home = env.HOME || env.USERPROFILE || "";
		let sep = Zotero.isWin ? ";" : ":";
		env.PATH = this.extraSearchPaths(home).join(sep) + (env.PATH ? sep + env.PATH : "");
		return env;
	},

	formattingGuide() {
		return (
			"Formatting: your answer is shown in a narrow sidebar that renders Markdown and LaTeX. " +
			"Write ALL mathematics in LaTeX: $...$ inline and $$...$$ on their own lines for displayed " +
			"equations (align, cases and matrix environments work). Never write maths with Unicode " +
			"symbols such as ‖, Σ, ≤, subscript digits or superscript letters; use \\|, \\sum, \\le, x_1 " +
			"instead. For formal statements you may use \\begin{definition}, theorem, lemma, " +
			"proposition, corollary, remark, example and proof environments, optionally with a " +
			"[title]; they render as styled boxes, numbered across the whole chat. Give every " +
			"definition, theorem, lemma, proposition and corollary a unique \\label{kind:short-name} " +
			"right after its \\begin{...}[title] (for example \\label{def:metric-space}). When a later " +
			"step uses a statement already given in this conversation, write \\ref{its-label} in running " +
			"text (never inside $...$) instead of restating it: the sidebar turns it into a link. Only " +
			"reference labels that exist. Markdown tables and > quotes also render. Do not " +
			"wrap maths in code fences unless the user asks for LaTeX source.\n\n" +
			this.drawingGuide()
		);
	},

	drawingGuide() {
		return (
			"Drawings: when a picture explains something better than words (a geometric idea, a " +
			"pipeline, an architecture, a plot sketch), draw it as SVG in a ```svg code block; it " +
			"renders as a figure on the sidebar's own background. Make it polished and clear: " +
			"one idea per drawing, few elements, aligned to a grid, generous padding, every node " +
			"and axis labelled. Rules: set viewBox about 360 wide (the sidebar is narrow) and no " +
			"width/height; no background rectangle; no <style>, <script>, <image>, " +
			"<foreignObject>, links or external references. Colour only with these names as " +
			"fill/stroke values, never hex or rgb: ink (text, main strokes), muted (secondary " +
			"text, axes), line (grid lines, borders), surface (neutral box fill), accent, teal, " +
			"violet, orange, red, green (emphasis strokes and marks) and accent-soft, teal-soft, " +
			"violet-soft, orange-soft, red-soft, green-soft (area fills). Use stroke-width 1.5, " +
			"rx=\"8\" on boxes, stroke-linecap/linejoin round, font-size 12 (11 for small labels, " +
			"13 bold for titles), text-anchor middle for centred labels, and arrowheads as a " +
			"<marker> filled with ink. Put the explanation in prose, not inside the drawing."
		);
	},

	// Appended to every question (never stored in the chat), because resumed
	// sessions tend to drift away from formatting rules given only at the start.
	formattingReminder() {
		let language = this.getLanguage();
		return "\n\n(Sidebar formatting: maths in LaTeX with $...$ / $$...$$, no Unicode maths symbols. " +
			"Drawings as ```svg blocks using only the sidebar's colour names. \\label statements and \\ref earlier ones." +
			(language ? " Reply in " + language + "." : "") + ")";
	},

	systemPrompt() {
		return (
			"You are embedded in the Zotero reference manager as a sidebar assistant, helping " +
			"the user understand the paper they are currently viewing. The working directory " +
			"contains metadata.md (title, authors, date, abstract) and annotations.md (the " +
			"user's highlights and notes, may be empty). The paper's full text is deliberately " +
			"not provided: answer from these files and your own knowledge, and say so when a " +
			"question needs details only the full text would have. Do not modify any files. " +
			"Keep answers focused on this paper. " + this.languageInstruction() + " " +
			this.behaviourInstructions() + "\n\n" +
			this.formattingGuide()
		);
	},

	// Messages the backend's session has not seen yet: everything for a new
	// session, or turns answered by another backend since this one last spoke.
	transcriptFor(history, session) {
		let unseen = history.slice(session ? session.seen || 0 : 0).slice(-20);
		if (!unseen.length) {
			return "";
		}
		let lines = unseen.map(m => (m.role === "user" ? "User: " : "Assistant: ") + m.text +
			(m.images && m.images.length ? " [attached " + m.images.length + " image" + (m.images.length > 1 ? "s" : "") + "]" : ""));
		let transcript = lines.join("\n\n");
		if (transcript.length > 30000) {
			transcript = "…" + transcript.slice(-30000);
		}
		return (
			(session
				? "Meanwhile the conversation continued with another assistant:\n\n"
				: "Earlier conversation about this paper (possibly with another assistant):\n\n") +
			transcript + "\n\n---\n\n"
		);
	},

	async runProcess(command, args, workdir, onEvent, onSpawn) {
		this.log("Spawning: " + command + " " + args.map(a => "'" + a.slice(0, 60) + "'").join(" "));
		let proc = await Subprocess.call({
			command,
			arguments: args,
			environment: this.buildChildEnvironment(),
			workdir,
			stderr: "pipe",
		});
		// The prompt travels in argv; close stdin so the CLI never waits for input.
		proc.stdin.close();
		if (onSpawn) {
			onSpawn(proc);
		}

		let emit = (line) => {
			line = line.trim();
			if (!line || !onEvent) {
				return;
			}
			try {
				onEvent(JSON.parse(line));
			}
			catch (e) {
				if (!(e instanceof SyntaxError)) {
					this.logError("stream event handler", e);
				}
			}
		};
		let readStdout = (async () => {
			let out = "";
			let buffer = "";
			let chunk;
			while ((chunk = await proc.stdout.readString())) {
				out += chunk;
				buffer += chunk;
				let lines = buffer.split("\n");
				buffer = lines.pop();
				lines.forEach(emit);
			}
			emit(buffer);
			return out;
		})();
		let readStderr = (async () => {
			let out = "";
			let chunk;
			while ((chunk = await proc.stderr.readString())) {
				out += chunk;
			}
			return out;
		})();

		let [stdout, stderr] = await Promise.all([readStdout, readStderr]);
		let { exitCode } = await proc.wait();
		this.log(command + " exited with code " + exitCode + (stderr ? ("; stderr: " + stderr.slice(0, 2000)) : ""));
		return { stdout, stderr, exitCode };
	},

	parseJsonLines(stdout) {
		let events = [];
		for (let line of stdout.split("\n")) {
			line = line.trim();
			if (!line) {
				continue;
			}
			try {
				events.push(JSON.parse(line));
			}
			catch (e) {
				this.log("Skipping non-JSON output line: " + line.slice(0, 200));
			}
		}
		return events;
	},

	runBackend(backend, request) {
		switch (backend) {
			case "codex":
				return this.runCodex(request);
			case "agy":
				return this.runAntigravity(request);
			default:
				return this.runClaude(request);
		}
	},

	// One activity line for a tool call, in the same words for every backend.
	describeTool(name, input = {}) {
		let file = input.file_path || input.AbsolutePath || input.path || input.TargetFile || "";
		let base = file ? String(file).split(/[\\/]/).pop() : "";
		if (/read|view/i.test(name)) {
			return { kind: "read", target: base || "a file", label: "Read " + (base || "a file") };
		}
		if (/grep|search/i.test(name)) {
			let pattern = input.pattern || input.Query || input.query || "";
			let where = base ? " in " + base : "";
			return { kind: "search", target: pattern, label: pattern ? "Searched for “" + String(pattern).slice(0, 60) + "”" + where : "Searched" + where };
		}
		if (/glob|find|list/i.test(name)) {
			return { kind: "search", target: input.pattern || "", label: "Looked for files" + (input.pattern ? " matching " + input.pattern : "") };
		}
		if (/command|shell|bash|exec/i.test(name)) {
			let command = String(input.command || "").replace(/\s+/g, " ").trim();
			return { kind: "run", target: command, label: command ? "Ran " + command.slice(0, 60) : "Ran a command" };
		}
		return { kind: "tool", target: name, label: "Used " + name };
	},

	toolStatus(name) {
		if (/read|view/i.test(name)) {
			return "reading the paper";
		}
		if (/grep|glob|find|search/i.test(name)) {
			return "searching the paper";
		}
		return "using " + name;
	},

	// Flags shared by every run of a backend: model, effort and anything else
	// chosen in the composer. Kept separate so tests can check them.
	claudeArgs({ question, history, session, model, effort }) {
		let args = [
			"-p", this.transcriptFor(history, session) + question + this.formattingReminder(),
			"--output-format", "stream-json",
			"--verbose",
			"--include-partial-messages",
			"--tools", "Read,Grep,Glob",
			"--allowedTools", "Read,Grep,Glob",
			"--strict-mcp-config",
			"--append-system-prompt", this.systemPrompt(),
		];
		if (model) {
			args.push("--model", model);
		}
		if (effort) {
			args.push("--effort", effort);
		}
		// By default the sidebar ignores ~/.claude settings and CLAUDE.md, whose
		// instructions (artifacts, diagrams, output styles) do not fit a sidebar.
		if (!this.getPref("useClaudeUserSettings")) {
			args.push("--setting-sources", "");
		}
		if (session) {
			args.push("--resume", session.id);
		}
		return args;
	},

	codexArgs({ ctx, question, history, session, model, effort, images = [] }) {
		let prompt = (session ? "" : this.systemPrompt() + "\n\n---\n\n") +
			this.transcriptFor(history, session) + question + this.formattingReminder();
		let args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-C", ctx.dir];
		if (model) {
			args.push("-m", model);
		}
		if (effort) {
			args.push("-c", "model_reasoning_effort=\"" + effort + "\"");
		}
		// "--image=<path>": the flag takes several values, so a bare path could swallow "resume".
		for (let image of images) {
			args.push("--image=" + image);
		}
		if (session) {
			args.push("resume", session.id);
		}
		args.push(prompt);
		return args;
	},

	antigravityArgs(request) {
		let args = ["--output-format", "stream-json", "--sandbox"];
		if (request.model) {
			args.push("--model", request.model);
		}
		if (request.effort) {
			args.push("--effort", request.effort);
		}
		if (request.session) {
			args.push("--conversation", request.session.id);
		}
		// "--print=<prompt>" keeps a prompt that starts with "-" from being read as a flag.
		args.push("--print=" + this.buildAntigravityPrompt(request));
		return args;
	},

	async runClaude(request) {
		let { ctx, onProgress, onSpawn } = request;
		let command = await this.findBinary("claude");
		let args = this.claudeArgs(request);

		let text = "";
		let blocks = new Map();
		let onEvent = (event) => {
			if (event.type !== "stream_event" || !event.event) {
				return;
			}
			let ev = event.event;
			if (ev.type === "content_block_start" && ev.content_block) {
				let block = { type: ev.content_block.type, name: ev.content_block.name, json: "", started: Date.now() };
				blocks.set(ev.index, block);
				if (block.type === "text" && text) {
					text += "\n\n";
				}
				if (block.type === "tool_use") {
					onProgress({ status: this.toolStatus(block.name) });
				}
				if (block.type === "thinking") {
					onProgress({ status: "thinking", thinking: true });
				}
			}
			if (ev.type === "content_block_delta" && ev.delta) {
				if (ev.delta.type === "text_delta") {
					text += ev.delta.text;
					onProgress({ text, status: "writing" });
				}
				else if (ev.delta.type === "input_json_delta" && blocks.has(ev.index)) {
					blocks.get(ev.index).json += ev.delta.partial_json || "";
				}
			}
			if (ev.type === "content_block_stop" && blocks.has(ev.index)) {
				let block = blocks.get(ev.index);
				blocks.delete(ev.index);
				if (block.type === "tool_use") {
					let input = {};
					try {
						input = JSON.parse(block.json || "{}");
					}
					// A tool call cut short by an abort has half a JSON blob; the step
					// line is still worth showing without its arguments.
					catch (e) {}
					onProgress({ step: this.describeTool(block.name, input) });
				}
				if (block.type === "thinking") {
					onProgress({ thinking: false, thoughtMs: Date.now() - block.started });
				}
			}
		};

		let { stdout, stderr, exitCode } = await this.runProcess(command, args, ctx.dir, onEvent, onSpawn);
		if (exitCode !== 0) {
			return {
				text: "",
				error: stderr.trim() || this.parseClaudeEvents(this.parseJsonLines(stdout)).error ||
					("claude exited with code " + exitCode),
				resumeFailed: true,
			};
		}
		return this.parseClaudeEvents(this.parseJsonLines(stdout));
	},

	parseClaudeEvents(events) {
		let sessionId = null;
		let textParts = [];
		let errorText = "";

		for (let event of events) {
			if (event.session_id) {
				sessionId = event.session_id;
			}
			if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
				for (let block of event.message.content) {
					if (block.type === "text" && block.text) {
						textParts.push(block.text);
					}
				}
			}
			if (event.type === "result" && event.is_error) {
				errorText = event.result || (event.errors || []).join("\n") || "Claude reported an error.";
			}
		}

		if (errorText && !textParts.length) {
			return { text: "", error: errorText, sessionId };
		}
		return { text: textParts.join("\n\n").trim(), sessionId };
	},

	async runCodex(request) {
		let { ctx, onProgress, onSpawn } = request;
		let command = await this.findBinary("codex");
		let args = this.codexArgs(request);

		let onEvent = (event) => {
			let item = event.item;
			if (event.type === "item.completed" && item && item.type === "agent_message" && item.text) {
				onProgress({ text: item.text, status: "writing" });
			}
			else if (event.type === "item.started" && item && item.type === "command_execution") {
				onProgress({ status: "reading the paper" });
			}
			else if (event.type === "item.completed" && item && item.type === "command_execution") {
				let command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
				onProgress({ step: this.describeTool("exec", { command }) });
			}
			else if (event.msg && event.msg.type === "agent_message" && event.msg.message) {
				onProgress({ text: event.msg.message, status: "writing" });
			}
		};

		let { stdout, stderr, exitCode } = await this.runProcess(command, args, ctx.dir, onEvent, onSpawn);
		let result = this.parseCodexEvents(this.parseJsonLines(stdout));
		if (exitCode !== 0 && !result.text) {
			return {
				text: "",
				error: result.error || stderr.trim() || ("codex exited with code " + exitCode),
				sessionId: result.sessionId,
				resumeFailed: true,
			};
		}
		return result;
	},

	// Handles both the current `codex exec --json` events (thread.started,
	// item.completed) and the older { msg: { type } } envelope.
	parseCodexEvents(events) {
		let sessionId = null;
		let messages = [];
		let errorText = "";

		for (let event of events) {
			if (event.thread_id) {
				sessionId = event.thread_id;
			}
			if (event.type === "item.completed" && event.item && event.item.type === "agent_message" && event.item.text) {
				messages.push(event.item.text);
			}
			if (event.type === "turn.failed" && event.error) {
				errorText = event.error.message || JSON.stringify(event.error);
			}
			if (event.type === "error" && event.message) {
				errorText = event.message;
			}
			let msg = event.msg;
			if (msg) {
				if (msg.type === "session_configured" && msg.session_id) {
					sessionId = msg.session_id;
				}
				if (msg.type === "agent_message" && msg.message) {
					messages.push(msg.message);
				}
				if (msg.type === "error" && msg.message) {
					errorText = msg.message;
				}
			}
		}

		// Codex narrates progress in intermediate messages; the last one is the answer.
		let text = messages.length ? messages[messages.length - 1].trim() : "";
		return { text, error: text ? "" : errorText, sessionId };
	},

	// Antigravity cannot be granted read-only file access in headless mode, so a
	// new session receives the metadata and annotations inline instead.
	buildAntigravityPrompt({ files, question, history, session }) {
		let tail = this.transcriptFor(history, session) + question + this.formattingReminder();
		if (session) {
			return tail;
		}
		return (
			"You are embedded in the Zotero reference manager as a sidebar assistant, helping the " +
			"user understand one paper. Its metadata and the user's annotations are included " +
			"below, so do not use any tools. The paper's full text is deliberately not provided: " +
			"answer from these and your own knowledge, and say so when a question needs details " +
			"only the full text would have. Keep answers focused on this paper. " +
			this.languageInstruction() + " " + this.behaviourInstructions() + "\n\n" + this.formattingGuide() + "\n\n" +
			"<metadata>\n" + files.metadata + "</metadata>\n\n" +
			(files.annotations ? "<annotations>\n" + files.annotations + "\n</annotations>\n\n" : "") +
			"---\n\n" + tail
		);
	},

	async runAntigravity(request) {
		let { onProgress, onSpawn } = request;
		let command = await this.findBinary("agy");
		let args = this.antigravityArgs(request);

		let onEvent = (event) => {
			let step = event.step_update;
			if (event.event === "step_update" && step && step.state === "ACTIVE") {
				onProgress({ status: step.step_type === "tool" ? this.toolStatus(step.tool_name || "a tool") : "thinking" });
			}
			if (event.event === "step_update" && step && step.state === "DONE" && step.step_type === "tool") {
				onProgress({ step: this.describeTool(step.tool_name || "tool", (step.tool_info && step.tool_info.parameters) || {}) });
			}
		};

		let { stdout, stderr, exitCode } = await this.runProcess(command, args, request.ctx.dir, onEvent, onSpawn);
		let sessionId = null;
		let final = null;
		for (let event of this.parseJsonLines(stdout)) {
			if (event.conversation_id) {
				sessionId = event.conversation_id;
			}
			if (event.event === "result" && event.result) {
				final = event.result;
				sessionId = final.conversation_id || sessionId;
			}
		}

		if (final && final.status === "SUCCESS" && (final.response || "").trim()) {
			return { text: final.response.trim(), sessionId };
		}
		let error = this.agySignInHelp(stderr) || (final && final.error) || stderr.trim() ||
			(final ? "Antigravity finished with status " + final.status + "." : "agy exited with code " + exitCode);
		return { text: "", error, sessionId, resumeFailed: exitCode !== 0 || !final || final.status === "ERROR" };
	},
};
