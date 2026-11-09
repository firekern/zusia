"use strict";

var { OS } = ChromeUtils.importESModule("chrome://zotero/content/osfile.mjs");
var { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

Zusia = {
	// Loaded after this file by bootstrap.js, the tests and the harness; each adds its
	// members to Zusia, so a file missing here never runs.
	MODULES: [
		"settings", "window", "dom", "sidebar", "attachments", "chat", "history", "reader",
		"theorems", "clarifications", "memory-sheet", "wizard", "search", "ask", "prefs-pane",
		"notes", "markdown", "drawings", "math", "context", "reading", "progress", "memory",
		"jobs", "consolidation", "backends",
	],
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
	// Claude and Codex read the text from files, so a whole book is written out.
	// Antigravity gets the text inside its prompt. Prompts go on stdin now, so the
	// smaller Windows budget only waits for agy's stdin to be checked on Windows.
	FULLTEXT_INLINE_CHARS: 60000,
	FULLTEXT_INLINE_CHARS_WINDOWS: 12000,
	// Extracted page text kept in memory across papers: a 1132-page book is about 2M.
	TEXT_CACHE_CHARS: 20e6,
	// Raise when structure.json, the text files or their markers change shape: every
	// text file's stamp carries it, so all of them are written again.
	MAP_VERSION: 1,
	// Raise when cache/pages.json changes shape; an older one is extracted again.
	PAGES_VERSION: 1,
	// From this many PDF pages on, the text goes into section files under text/, so no
	// Read call truncates it, and Antigravity gets chosen pages instead of the start.
	BOOK_MIN_PAGES: 150,
	// An Antigravity conversation keeps every page it was sent; past this the next question
	// starts a new one, and the reading memory carries the continuity.
	AGY_SESSION_CHARS: 200000,
	// Pages the answering model may ask for at once with a NEED_PAGES line, and how much
	// streamed text is held back so that line never flashes on screen.
	NEED_PAGES_MAX: 3,
	NEED_PAGES_HOLD: 40,
	// progress.json is written at most this often while pages turn, at once on a new section.
	PROGRESS_SAVE_MS: 20000,
	// Turns kept in memory.json's log; the chat itself stays in chat.json.
	MEMORY_TURNS: 200,
	// Background memory: a consolidation after this many questions, or once the turns not
	// yet folded into the memory pass this many characters. One call reads at most
	// CONSOLIDATE_INPUT_CHARS of turns, each cut to CONSOLIDATE_MESSAGE_CHARS; the rest
	// goes in the next call.
	CONSOLIDATE_TURNS: 5,
	CONSOLIDATE_CHARS: 12000,
	CONSOLIDATE_INPUT_CHARS: 16000,
	CONSOLIDATE_MESSAGE_CHARS: 3000,
	// A new session always gets at least this many recent questions and their answers
	// verbatim, even when the memory already covers them: the last exchanges are what a
	// follow-up refers to. A turn is a question, as in CONSOLIDATE_TURNS.
	RECENT_TURNS: 6,
	// The transcript a new session gets while the memory is kept in the background, at
	// most: the jobs normally keep it far below this, but they can fail or be paused for
	// hours, and a restored chat starts with nothing covered.
	MEMORY_TRANSCRIPT_CHARS: 60000,
	// A gist reads at most this much of its section; agy's inline budget is 60k.
	GIST_INPUT_CHARS: 40000,
	// What a background prompt to agy leaves for its turns or section text when its
	// instructions and memory already fill most of the inline budget (Windows: 12k).
	JOB_MIN_INPUT_CHARS: 2000,
	// Room for one turn's "#N Assistant (on PDF page …): " marker in a consolidation.
	TURN_MARKER_CHARS: 60,
	// A background call runs alone and in an empty folder; one that hangs is stopped so
	// the queue moves on. A rate limit pauses every job, 15 minutes doubling up to 2 hours.
	JOB_TIMEOUT_MS: 300000,
	JOB_BACKOFF_MS: 900000,
	JOB_BACKOFF_MAX_MS: 7200000,
	// Stored with each session next to a hash of the system prompt it started with. The hash
	// catches edits to the prompt itself; raise this when what a session stores changes.
	PROMPT_VERSION: 4,
	// Toggle buttons in the message box that shape the answer. Settings → Chat chooses
	// which are shown; each one's on/off state is remembered (pref "mode.<id>").
	MODES: {
		drawing: {
			label: "Drawing",
			icon: "drawing",
			key: "D",
			title: "Ask for a drawing in the answer",
			instruction: "Drawing mode: include at least one drawing that helps with this answer, as an " +
				"```svg block following the drawing notes, even in a short answer. It shows up right in the " +
				"sidebar, so there's nothing to save or open.",
		},
		latex: {
			label: "LaTeX",
			icon: "latex",
			key: "L",
			title: "Ask for the maths written out in LaTeX",
			// Earlier wording asked for "rigorous mathematics" with theorem boxes and turned
			// every answer into a treatise; this one sets the notation and leaves the voice alone.
			instruction: "LaTeX mode: the user wants the maths written out properly this time. Put the " +
				"key steps in displayed equations, rendered in the sidebar rather than as source in a code " +
				"block, and label the ones you refer back to. Keep talking in normal sentences between the " +
				"equations: this changes the notation, not the genre, so leave out theorem and proof " +
				"scaffolding unless the question asks for a proof.",
		},
	},
	// Answer languages offered in Settings → Chat; "" answers in the language of the question.
	LANGUAGES: ["", "English", "Italiano", "Français", "Deutsch", "Español", "Português", "Nederlands",
		"Polski", "Русский", "Türkçe", "中文", "日本語", "한국어"],
	FONT_SIZES: { small: "12px", default: "13px", large: "14.5px" },
	FONTS: { zotero: "Zotero", sans: "Sans", serif: "Serif", mono: "Mono" },
	// How answers are written (Settings → Behaviour). Each choice adds one sentence to the
	// system prompt, and its `cue` to the short style line repeated with every question.
	BEHAVIOUR: {
		length: {
			short: { label: "Short", icon: "lengthShort", cue: "short", prompt: "Keep it short: the key point in a few sentences." },
			balanced: { label: "Balanced", icon: "lengthBalanced", cue: "focused length", prompt: "Keep it focused: as long as the question needs, no longer." },
			detailed: { label: "Detailed", icon: "lengthDetailed", cue: "in depth", prompt: "Go into depth when it helps: full derivations and worked examples are welcome." },
		},
		level: {
			beginner: { label: "Beginner", icon: "levelBeginner", cue: "beginner level", prompt: "Assume little background: plain words first, and define terms as they come up." },
			student: { label: "Student", icon: "levelStudent", cue: "student level", prompt: "Assume a solid undergraduate background, and explain anything specialised in a line." },
			expert: { label: "Expert", icon: "levelExpert", cue: "expert level", prompt: "Assume expertise: skip the basics and get to the substance." },
		},
		tone: {
			friendly: { label: "Friendly", icon: "toneFriendly", cue: "warm and encouraging", prompt: "Be warm and encouraging, like a patient tutor." },
			// The default tone used to add nothing, and Gemini answers tersely unless asked otherwise.
			neutral: { label: "Neutral", icon: "toneNeutral", cue: "relaxed and direct", prompt: "Be relaxed and direct, like a colleague." },
			formal: { label: "Formal", icon: "toneFormal", cue: "formal register", prompt: "Keep a formal, academic register." },
		},
	},
	// Starting points for the system prompt (setup wizard → Your voice). The colleague is the
	// default and is stored as an empty `behaviour.custom`, so a better default reaches everyone
	// who never edited it. Quiz mode is opt-in: Socratic tutoring helps practice but costs a
	// reader who just wants the answer (Bastani et al., PNAS 2025).
	PERSONAS: {
		colleague: {
			label: "Colleague",
			icon: "toneNeutral",
			text: "Talk to me like a sharp colleague sitting next to me, not like a textbook. Start with " +
				"the answer in plain words, then the intuition, then the details and the maths the question " +
				"actually needs. Short paragraphs, everyday sentences; a concrete example or a quick sanity " +
				"check usually helps more than a formal definition. Match the size of the answer to the size " +
				"of the question: a quick question gets a few sentences.\n\n" +
				"I'm reading this in order, so connect things to what I've already seen and don't spoil later " +
				"chapters unless I ask. If I seem stuck on a step, help with that step rather than re-deriving " +
				"everything. If you think I've misread something, tell me plainly. When it's genuinely useful, " +
				"end with one short suggestion for what to look at next or one question to check I've got it; " +
				"skip it otherwise.",
		},
		tutor: {
			label: "Patient tutor",
			icon: "toneFriendly",
			text: "Be a patient tutor. I may be missing some background, so start from the intuition in plain " +
				"words, define each symbol before you use it, and go one step at a time with a small worked " +
				"example. When I get something wrong, show me where the usual confusion is instead of only " +
				"giving the right answer, and keep it encouraging. After a longer explanation, check in with " +
				"one short question.",
		},
		quiz: {
			label: "Quiz me",
			icon: "thought",
			text: "Quiz me before you tell me. When I ask about something, first ask me one short question that " +
				"leads to the key idea and wait for my answer. Give a hint if I'm stuck, then confirm or correct " +
				"what I said and fill in the rest. If I say \"just tell me\" or ask for the answer outright, give " +
				"it straight away. Keep the questions about the document I'm reading.",
		},
		facts: {
			label: "Just the facts",
			icon: "lengthShort",
			text: "Just the facts. Answer in as few words as the question allows: the result, the definition or " +
				"the place in the document, with the formula when there is one. Leave out intuition, analogies " +
				"and follow-up suggestions unless I ask for them.",
		},
	},
	// Room for a real system prompt. Antigravity carries it next to the paper inside the
	// inline budget, so it stays a fraction of the smallest one (12,000 on Windows).
	CUSTOM_PROMPT_CHARS: 4000,
	WIZARD_STEPS: ["welcome", "assistant", "look", "buddy", "answers", "voice", "done"],
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
		expand: "arrows-out-simple.svg",
		collapse: "arrows-in-simple.svg",
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
		memory: "brain.svg",
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
	// attachmentID → { stamp, result, chars }, oldest first, at most TEXT_CACHE_CHARS in all.
	_fullTexts: new Map(),
	// "attachmentID@stamp" → the extraction in flight.
	_textLoads: new Map(),
	// Per paper directory: the reading map in use { key, structure }, the labels and outline
	// Zotero gave for a file version, builds in flight, and the BM25 index per file version.
	_structures: new Map(),
	_natives: new Map(),
	_mapBuilds: new Map(),
	// "attachmentID@stamp" → { promise, done, result }: Zotero 10's structured text, read
	// in the background.
	_sdt: new Map(),
	_bm25: new WeakMap(),
	// Per paper directory: { progress, dirty, scheduled }, saved by flushProgress.
	_progress: new Map(),
	// Per paper directory: the tail of the queue that serialises its file writes.
	_dirQueue: new Map(),
	_readingObserver: null,
	// Background memory jobs: the queue, the one running ({key, dir, proc, cancelled,
	// promise}), the rate-limit pause, and whether shutdown stopped them.
	_jobs: [],
	_job: null,
	_jobBackoff: { delay: 0, until: 0, wake: false },
	_jobsStopped: false,
	// Per paper directory: the chat index after the turns of a consolidation that failed.
	_memoryFailed: new Map(),
	// Folds of a put-away chat ("dir\nfile") and gists ("dir\nid\nhash") that failed in
	// this session: tried again only alongside a consolidation the chat earns, or not at all.
	_archiveFailed: new Set(),
	_gistFailed: new Set(),
	IMAGE_TYPES: { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" },
	MAX_IMAGES: 6,
	ATTACH_KEY: "I",
	// The live view behind each rendered .zs-root.
	_views: new WeakMap(),
	// The paper folder each item pane section body showed last.
	_shownDirs: new WeakMap(),
	// The capturing side-nav click listener added to each main window.
	_sidenavListeners: new WeakMap(),

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
};
