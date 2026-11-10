// Runs inside a throwaway Zotero instance started by test/integration/run.sh.
// Exercises Claude Sidebar in real Zotero, saves screenshots and results.json,
// then quits Zotero.

var results = { checks: [], errors: [] };
var outDir;
var repo;
// Prompts the memory jobs would have sent; see run().
var backgroundCalls = [];

function check(name, ok, detail) {
	results.checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
	Zotero.debug("[zs-tester] " + (ok ? "PASS " : "FAIL ") + name + (detail !== undefined ? " — " + JSON.stringify(detail) : ""));
}

async function waitFor(fn, timeout = 20000, label = "condition") {
	let start = Date.now();
	while (Date.now() - start < timeout) {
		try {
			let value = await fn();
			if (value) {
				return value;
			}
		}
		catch (e) {}
		await Zotero.Promise.delay(150);
	}
	throw new Error("Timed out waiting for " + label);
}

async function snapshot(win, name, rect) {
	let doc = win.document;
	rect = rect || { x: 0, y: 0, width: win.innerWidth, height: win.innerHeight };
	let scale = 2;
	let canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
	canvas.width = Math.ceil(rect.width * scale);
	canvas.height = Math.ceil(rect.height * scale);
	let ctx = canvas.getContext("2d");
	ctx.scale(scale, scale);
	ctx.drawWindow(win, rect.x, rect.y, rect.width, rect.height, "rgb(128,128,128)");
	let blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
	await IOUtils.write(PathUtils.join(outDir, name + ".png"), new Uint8Array(await blob.arrayBuffer()));
}

async function readFixture(name) {
	return IOUtils.readUTF8(PathUtils.join(repo, "test", "fixtures", name));
}

async function testSidebar(win, CS) {
	let item = new Zotero.Item("journalArticle");
	item.setField("title", "Integration test paper");
	await item.saveTx();

	let dir = PathUtils.join(Zotero.DataDirectory.dir, "zusia", item.libraryID + "-" + item.key);
	await IOUtils.makeDirectory(dir, { createAncestors: true });
	let history = [
		{ role: "user", text: "Explain the FFT with $\\LaTeX$" },
		{ role: "assistant", backend: "claude", text: await readFixture("fft-real.md") },
		{ role: "user", text: "And a table?" },
		{ role: "assistant", backend: "claude", text: await readFixture("tables.md") },
	];
	await IOUtils.writeUTF8(PathUtils.join(dir, "chat.json"), JSON.stringify(history));

	win.resizeTo(1500, 1400);
	// The headless items tree does not lay out rows, so feed the item pane directly,
	// as ZoteroPane.itemSelected() does after a click.
	await waitFor(() => win.ZoteroPane.itemPane, 60000, "item pane");
	let itemPane = win.ZoteroPane.itemPane;
	itemPane.collectionTreeRows = win.ZoteroPane.getCollectionTreeRows();
	itemPane.data = [item];
	itemPane.editable = true;
	await itemPane.renderItemPane(item);
	// Sections render lazily once scrolled into view.
	let details = win.document.querySelector("item-details");
	let sectionEl = await waitFor(() => win.document.querySelector('[data-pane$="zusia-section"]'), 20000, "sidebar section element");
	details.scrollToPane?.(sectionEl.dataset.pane, "instant");
	sectionEl.scrollIntoView({ block: "start" });
	sectionEl.open = true;
	sectionEl.render?.();
	await sectionEl.asyncRender?.();
	let root = await waitFor(() => win.document.querySelector(".zs-root .zs-log math") && win.document.querySelector(".zs-root"), 30000, "sidebar with maths");

	let log = root.querySelector(".zs-log");
	check("sidebar renders in the item pane", true);
	check("KaTeX renders MathML in Zotero", log.querySelectorAll("math").length > 80, log.querySelectorAll("math").length);
	check("no LaTeX errors in real answers", log.querySelectorAll(".zs-tex-error").length === 0,
		[...log.querySelectorAll(".zs-tex-error")].map(n => n.textContent));
	check("tables render", log.querySelectorAll("table").length === 4, log.querySelectorAll("table").length);
	await Zotero.Promise.delay(300);
	CS.fitWideContent(log);
	let scrollers = [...log.querySelectorAll(".zs-math-scroll")];
	let stillWide = scrollers.filter(sc => sc.classList.contains("zs-overflow"));
	let visibleBars = scrollers.filter(sc => sc.scrollWidth > sc.clientWidth + 1 && !sc.classList.contains("zs-overflow"));
	check("wide formulas are fitted to the pane (at most one still scrolls)", stillWide.length <= 1 && visibleBars.length === 0,
		{ formulas: scrollers.length, shrunk: scrollers.filter(sc => sc.style.fontSize).length, stillWide: stillWide.length, unmarked: visibleBars.length,
			fontsLoaded: [...win.document.fonts].filter(f => f.family.includes("Latin Modern")).map(f => f.status),
			wide: stillWide.map(sc => ({ natural: sc.scrollWidth, available: sc.clientWidth, size: sc.style.fontSize,
				tex: sc.querySelector("annotation")?.textContent.slice(0, 70) })) });
	let mathFont = win.getComputedStyle(log.querySelector("math")).fontFamily;
	check("maths uses the bundled Latin Modern Math", mathFont.includes("Claude Sidebar Latin Modern Math"), mathFont);
	let fontsReady = await win.document.fonts.ready.then(() =>
		[...win.document.fonts].some(f => f.family.includes("Latin Modern Math") && f.status === "loaded"));
	check("Latin Modern Math font file loads from the plugin", fontsReady);
	check("quick prompts shown", root.querySelectorAll(".zs-quick .zs-pill").length === 4);
	// Icons come from Zotero's own chrome://zotero/skin/ icon set and are inlined as SVG.
	await Zotero.Promise.delay(500);
	let iconSpans = [...root.querySelectorAll(".zs-i")].filter(n => n.dataset.icon !== "stop");
	let missingSvg = iconSpans.filter(n => !n.querySelector("svg")).map(n => n.dataset.icon);
	check("every Zotero icon is inlined and visible", iconSpans.length >= 8 && missingSvg.length === 0,
		{ icons: iconSpans.length, missingSvg: [...new Set(missingSvg)] });
	let header = root.querySelector(".zs-header");
	header.scrollIntoView({ block: "center" });
	await Zotero.Promise.delay(300);
	let hr = header.getBoundingClientRect();
	await snapshot(win, "zotero-header-icons", { x: hr.x, y: hr.y, width: hr.width, height: hr.height });
	let chip = root.querySelector(".zs-context-chip");
	check("paper chip shows its icon", !!chip && !!chip.querySelector(".zs-context-icon"));
	check("paper chip names the item and says what the assistant reads",
		!!chip && chip.textContent.includes("Integration test paper") && /full text/.test(chip.title),
		chip && [chip.textContent, chip.title]);
	chip.click();
	let sheet = await waitFor(() => root.querySelector(".zs-memory-panel .zs-memory-settings .zs-switch"), 5000, "memory sheet")
		.then(() => root.querySelector(".zs-memory-panel"), () => null);
	let sheetRect = sheet && sheet.getBoundingClientRect();
	check("memory sheet: the paper chip opens it over the chat, with its two settings and Reset",
		!!sheet && sheet.querySelectorAll(".zs-memory-settings .zs-switch").length === 2 && !!sheet.querySelector(".zs-memory-reset") &&
		sheetRect.height > 200, sheet && { height: sheetRect.height, text: sheet.textContent.slice(0, 120) });
	if (sheet) {
		// Past its fade-in, or the shot shows the chat through a half-opaque sheet.
		await Zotero.Promise.delay(350);
		await snapshot(win, "zotero-memory-sheet", { x: sheetRect.x, y: sheetRect.y, width: sheetRect.width, height: sheetRect.height });
		sheet.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	}
	check("memory sheet: Escape closes it", !root.querySelector(".zs-memory-panel"));
	// The visible edge of the item pane is where its side navigation starts;
	// section containers themselves grow with their content, so they are no reference.
	let visibleRight = () => {
		let sidenav = win.document.querySelector("item-pane-sidenav, #zotero-view-item-sidenav");
		return sidenav ? sidenav.getBoundingClientRect().left : win.document.getElementById("zotero-item-pane").getBoundingClientRect().right;
	};
	let overflowing = () => {
		let limit = visibleRight() + 1;
		return [...root.querySelectorAll(".zs-header, .zs-icon, .zs-msg, .zs-turn, .zs-composer, .zs-controls, .zs-send, p, .zs-quick")]
			.filter(el => el.getBoundingClientRect().right > limit)
			.map(el => el.className || el.localName);
	};
	check("nothing overflows the item pane horizontally", root.scrollWidth <= root.clientWidth + 1 && !overflowing().length,
		{ scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, overflowing: [...new Set(overflowing())] });
	let gear = root.querySelector(".zs-open-settings").getBoundingClientRect();
	check("settings button is visible", gear.width > 0 && gear.right <= visibleRight() + 1, { right: gear.right, limit: visibleRight() });
	let user = root.querySelector(".zs-user").getBoundingClientRect();
	check("your message bubble is inside the pane", user.right <= visibleRight() + 1, { right: user.right, limit: visibleRight() });
	check("answer footer on the last answer", !!root.querySelector(".zs-turn.zs-last .zs-explain") && !!root.querySelector(".zs-turn.zs-last .zs-retry"));

	// Composer menus open inside the visible pane and change the model.
	root.querySelector(".zs-model-btn").click();
	let menu = await waitFor(() => root.querySelector(".zs-menu"), 5000, "model menu");
	await waitFor(() => root.querySelector(".zs-menu").textContent.includes("Google Antigravity") && !root.querySelector(".zs-menu").textContent.includes("Loading"), 30000, "Antigravity models in menu");
	let menuRect = root.querySelector(".zs-menu").getBoundingClientRect();
	let paneRect0 = win.document.getElementById("zotero-item-pane").getBoundingClientRect();
	check("model menu fits in the pane", menuRect.left >= paneRect0.left - 1 && menuRect.right <= visibleRight() + 1 && menuRect.height > 100,
		{ left: menuRect.left, right: menuRect.right, height: menuRect.height, limit: visibleRight() });
	let agyItems = [...root.querySelectorAll(".zs-menu-item")].filter(i => i.textContent.includes("Gemini"));
	check("Antigravity models are listed from `agy models`", agyItems.length > 0, agyItems.length);
	await snapshot(win, "zotero-model-menu", { x: paneRect0.x, y: paneRect0.bottom - 700, width: paneRect0.width, height: 700 });
	let pick = (label) => {
		let items = [...root.querySelectorAll(".zs-menu-item")];
		let item = items.find(i => i.querySelector(".zs-menu-label")?.textContent === label);
		if (!item) {
			throw new Error("menu item " + label + " not found in " + JSON.stringify(items.map(i => i.textContent)));
		}
		item.click();
	};
	pick("Haiku");
	check("choosing a model updates the composer", root.querySelector(".zs-model-btn").textContent.includes("Claude · Haiku"),
		root.querySelector(".zs-model-btn").textContent);
	root.querySelector(".zs-effort-btn").click();
	await waitFor(() => root.querySelector(".zs-menu"), 5000, "effort menu");
	await waitFor(() => root.querySelector(".zs-menu .zs-menu-section")?.textContent.startsWith("Reasoning effort"), 5000, "effort menu content");
	pick("Low");
	check("choosing an effort updates the composer", root.querySelector(".zs-effort-btn").textContent.includes("Low"));

	// Screenshot the whole section, expanded so the full conversation is visible.
	log.style.maxHeight = "none";
	let section = root.closest("item-pane-custom-section, [data-pane]") || root.parentElement;
	section.scrollIntoView({ block: "start" });
	await Zotero.Promise.delay(600);
	let paneRect = win.document.getElementById("zotero-item-pane").getBoundingClientRect();
	await snapshot(win, "zotero-main-window", { x: 0, y: 0, width: win.innerWidth, height: win.innerHeight });
	await snapshot(win, "zotero-item-pane", { x: paneRect.x, y: paneRect.y, width: paneRect.width, height: paneRect.height });

	// History: New chat archives the conversation; it can be reopened from the menu.
	await CS.newChat(root);
	check("New chat clears the conversation", (await CS.loadHistory(dir)).length === 0 && !!root.querySelector(".zs-empty"));
	await CS.jobsIdle();
	check("memory: New chat queues a consolidation of the chat it puts away, run through the job queue",
		backgroundCalls.length === 1 && backgroundCalls[0].prompt.includes("#0 User: Explain the FFT") &&
		(await CS.loadMemory(dir)).epoch === 1,
		backgroundCalls.map(c => c.prompt.length));
	check("memory: the put-away chat is read back from its file on disk and no longer owed once folded in",
		(await CS.loadMemory(dir)).pendingArchives.length === 0, (await CS.loadMemory(dir)).pendingArchives);
	let archives = await CS.listArchives(dir);
	check("the previous chat is listed in history", archives.length === 1 && archives[0].count === 4 && archives[0].title.startsWith("Explain the FFT"),
		archives.map(a => ({ title: a.title, count: a.count })));
	root.querySelector(".zs-history").click();
	await waitFor(() => root.querySelector(".zs-history-menu .zs-menu-item"), 5000, "history menu item");
	root.querySelector(".zs-history-menu .zs-menu-item").click();
	await waitFor(async () => (await CS.loadHistory(dir)).length === 4, 5000, "restored chat");
	check("reopening a chat restores it and removes it from history",
		(await CS.listArchives(dir)).length === 0 && root.querySelectorAll(".zs-turn").length === 2);
	log.style.maxHeight = "none";

	// Notes: save the first answer and check the stored HTML.
	let noteHTML = CS.noteHTML("Explain the FFT", history[1].text);
	check("note HTML keeps maths as TeX", /<span class="math">\$/.test(noteHTML) && !/<math/.test(noteHTML));
	await CS.saveAsNote({ paperItem: item }, "Explain the FFT", history[1].text);
	let notes = item.getNotes();
	check("Save as note creates a child note", notes.length === 1, notes.length);

	// Appearance changes reach the open sidebar.
	CS.saveAppearance({ accent: "#b85a38", bubble: "accent", size: "large" });
	await Zotero.Promise.delay(300);
	check("appearance pref updates the open sidebar",
		root.style.getPropertyValue("--zs-accent") === "#b85a38" && root.dataset.bubble === "accent",
		{ accent: root.style.getPropertyValue("--zs-accent"), bubble: root.dataset.bubble });
	await Zotero.Promise.delay(300);
	await snapshot(win, "zotero-item-pane-clay", { x: paneRect.x, y: paneRect.y, width: paneRect.width, height: paneRect.height });
	CS.saveAppearance({ accent: "", bubble: "neutral", size: "default" });
}

// The chat view: Zusia's side-nav icon gives it the whole item pane, any other icon gives it back.
async function testChatView(win, CS) {
	let doc = win.document;
	let details = doc.getElementById("zotero-item-details");
	let button = await waitFor(() => [...doc.querySelectorAll("#zotero-item-pane item-pane-sidenav [data-pane]")]
		.find(b => b.dataset.pane === CS.paneID), 10000, "Zusia's side-nav icon");
	button.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
	await Zotero.Promise.delay(600);
	let root = details.querySelector(".zs-root");
	let column = details.querySelector(".zotero-view-item");
	let colRect = column.getBoundingClientRect();
	let rootRect = root.getBoundingClientRect();
	let composer = root.querySelector(".zs-composer").getBoundingClientRect();
	let log = root.querySelector(".zs-log");
	let shown = el => !!el && el.getClientRects().length > 0 && win.getComputedStyle(el).display !== "none";
	check("chat view: set on the window by Zusia's icon", doc.documentElement.getAttribute("data-zs-view") === "chat");
	check("chat view: Zotero's title bar and the other sections step aside",
		!shown(details.querySelector("item-pane-header")) && !shown(details.querySelector('[data-pane="info"]')) && !shown(details.querySelector('[data-pane="tags"]')),
		{ header: shown(details.querySelector("item-pane-header")), info: shown(details.querySelector('[data-pane="info"]')) });
	check("chat view: Zusia fills the pane's height", rootRect.top - colRect.top < 12 && colRect.bottom - rootRect.bottom < 12 && colRect.height > 600,
		{ column: [Math.round(colRect.top), Math.round(colRect.bottom)], root: [Math.round(rootRect.top), Math.round(rootRect.bottom)] });
	check("chat view: the composer sits at the bottom of the pane", colRect.bottom - composer.bottom < 24,
		{ composerBottom: Math.round(composer.bottom), paneBottom: Math.round(colRect.bottom) });
	check("chat view: only the conversation scrolls", column.scrollHeight <= column.clientHeight + 1 && log.scrollHeight > log.clientHeight,
		{ column: [column.scrollHeight, column.clientHeight], log: [log.scrollHeight, log.clientHeight] });
	let paper = root.querySelector(".zs-header-paper");
	check("chat view: the header names the paper", shown(paper) && paper.textContent === "Integration test paper", paper.textContent);
	check("chat view: a visible way back to the item details", shown(root.querySelector(".zs-view-details")) && !shown(root.querySelector(".zs-view-chat")));
	await snapshot(win, "zotero-chat-view", (() => {
		let r = doc.getElementById("zotero-item-pane").getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	})());
	await snapshot(win, "zotero-chat-view-window");

	let info = [...doc.querySelectorAll("#zotero-item-pane item-pane-sidenav [data-pane]")].find(b => b.dataset.pane === "info");
	info.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
	await Zotero.Promise.delay(600);
	check("chat view: another section's icon brings the item details back",
		doc.documentElement.getAttribute("data-zs-view") === "details" && shown(details.querySelector("item-pane-header"))
			&& shown(details.querySelector('[data-pane="info"]')) && !shown(paper));
	root.querySelector(".zs-view-chat").click();
	await Zotero.Promise.delay(300);
	check("chat view: the header button opens it too", doc.documentElement.getAttribute("data-zs-view") === "chat");
	root.querySelector(".zs-view-details").click();
	await Zotero.Promise.delay(300);
}

// A paper with a real PDF attachment. Zotero's reader cannot open headless and the
// pane width cannot be forced here, so reader widths are covered by the harness.
async function testReaderWidth(win, CS) {
	let parent = new Zotero.Item("journalArticle");
	parent.setField("title", "Loss of Plasticity in Deep Continual Learning");
	parent.setField("date", "2024-08-21");
	parent.setCreators([
		{ firstName: "Shibhansh", lastName: "Dohare", creatorType: "author" },
		{ firstName: "J. Fernando", lastName: "Hernandez-Garcia", creatorType: "author" },
		{ firstName: "Richard S.", lastName: "Sutton", creatorType: "author" },
	]);
	await parent.saveTx();
	let pdf = Zotero.File.pathToFile(PathUtils.join(repo, "test", "integration", "assets", "test-paper.pdf"));
	let attachment = await Zotero.Attachments.importFromFile({ file: pdf, parentItemID: parent.id });
	check("pdf: attachment imported", attachment && attachment.isPDFAttachment());

	let dir = PathUtils.join(Zotero.DataDirectory.dir, "zusia", parent.libraryID + "-" + parent.key);
	await IOUtils.makeDirectory(dir, { createAncestors: true });

	// Zotero's own PDF worker, file times and paths, which jsdom only stubs.
	let full = await CS.loadFullText(attachment, dir);
	check("pdf: Zotero extracts the full text", full.status === "ok" && full.paged && full.pages.join("").includes("PELICAN"),
		{ status: full.status, reason: full.reason, pages: full.pages && full.pages.length });
	let files = await CS.exportContext({ paperItem: parent, attachmentItem: attachment, dir }, { focus: [0] });
	let written = await IOUtils.exists(PathUtils.join(dir, "fulltext.md")) ? await IOUtils.readUTF8(PathUtils.join(dir, "fulltext.md")) : "";
	check("pdf: fulltext.md holds the paper with page markers", /--- page 1 ---\n[^]*PELICAN/.test(written),
		{ chars: written.length, note: CS.contextNote(files) });
	await testReadingMap(CS, attachment, dir, full);
	await IOUtils.writeUTF8(PathUtils.join(dir, "chat.json"), JSON.stringify([
		{ role: "user", text: "What does the convolution theorem say?" },
		{ role: "assistant", backend: "claude", model: "opus", text: await readFixture("latex.md"),
			activity: { steps: [{ kind: "read", target: "paper.txt", label: "Read paper.txt" }], thoughtMs: 4200 } },
	]));

	let itemPane = win.ZoteroPane.itemPane;
	let paneEl = win.document.getElementById("zotero-item-pane");
	itemPane.data = [parent];
	await itemPane.renderItemPane(parent);
	let sectionEl = await waitFor(() => win.document.querySelector('#zotero-item-pane [data-pane$="zusia-section"]'), 20000, "section element");
	win.document.querySelector("#zotero-item-pane item-details")?.scrollToPane?.(sectionEl.dataset.pane, "instant");
	sectionEl.scrollIntoView({ block: "start" });
	sectionEl.open = true;
	sectionEl.render?.();
	await sectionEl.asyncRender?.();
	let root = await waitFor(() => {
		let r = [...win.document.querySelectorAll("#zotero-item-pane .zs-root")].find(el => CS._views.get(el)?.ctx.paperItem?.id === parent.id);
		return r;
	}, 30000, "sidebar for the PDF paper").catch(() => null);
	check("pdf: sidebar renders for the paper", !!root);
	if (!root) {
		return;
	}
	root.closest("[data-pane]")?.scrollIntoView({ block: "start" });
	await win.document.fonts.ready;
	await Zotero.Promise.delay(800);

	let chip = root.querySelector(".zs-context-chip");
	check("pdf: paper chip shows authors and year",
		!!chip && chip.textContent.includes("Dohare et al., 2024"), chip && chip.textContent);
	let paneRect = paneEl.getBoundingClientRect();
	let sidenav = win.document.querySelector("#zotero-item-pane item-pane-sidenav");
	let limit = (sidenav && sidenav.getBoundingClientRect().width ? sidenav.getBoundingClientRect().left : paneRect.right) + 1;
	let rootWidth = Math.round(root.getBoundingClientRect().width);
	let overflowing = [...root.querySelectorAll(".zs-header, .zs-icon, .zs-msg, .zs-composer, .zs-controls, .zs-send, .zs-quick, .zs-context-chip, .zs-activity-head, .zs-footer")]
		.filter(el => el.getBoundingClientRect().right > limit)
		.map(el => el.className);
	check("PDF paper: nothing overflows the item pane", !overflowing.length,
		{ paneWidth: Math.round(paneRect.width), rootWidth, overflowing: [...new Set(overflowing)] });
	let controls = root.querySelector(".zs-controls").getBoundingClientRect();
	let send = root.querySelector(".zs-send").getBoundingClientRect();
	check("PDF paper: model, effort and send stay on one row", Math.abs(send.top - controls.top) < controls.height);
	let footer = root.querySelector(".zs-turn.zs-last .zs-footer");
	check("PDF paper: answer footer fits on one line", footer.getBoundingClientRect().height <= 30,
		Math.round(footer.getBoundingClientRect().height));

	await snapshot(win, "zotero-pdf-paper", { x: paneRect.x, y: paneRect.y, width: paneRect.width, height: paneRect.height });
}

// The reading map in real Zotero: readingmap.js loaded by bootstrap.js, the files it
// writes, and the page-turn signal it listens for. The reader cannot open headless, so
// the page change is made the way the reader makes it, with setAttachmentLastPageIndex.
async function testReadingMap(CS, attachment, dir, full) {
	let structurePath = PathUtils.join(dir, "cache", "structure.json");
	let structure = await IOUtils.exists(structurePath) ? JSON.parse(await IOUtils.readUTF8(structurePath)) : null;
	let pages = full.pages ? full.pages.length : 0;
	check("reading map: readingmap.js builds structure.json for the PDF",
		!!structure && structure.pageCount === pages && structure.labels.length === pages && structure.outline.length > 0 &&
			structure.files.length > 0 && typeof structure.key === "string",
		structure && { pages: structure.pageCount, labels: structure.labelMethod, confidence: structure.confidence,
			outline: structure.outlineMethod, entries: structure.outline.length, files: structure.files.length });
	let cached = await IOUtils.exists(PathUtils.join(dir, "cache", "pages.json"))
		? JSON.parse(await IOUtils.readUTF8(PathUtils.join(dir, "cache", "pages.json"))) : null;
	let ignore = PathUtils.join(dir, ".ignore");
	check("reading map: an .ignore keeps cache/ out of the backends' searches",
		await IOUtils.exists(ignore) && /^cache\/$/m.test(await IOUtils.readUTF8(ignore)));
	check("reading map: the page text is kept for the next start, keyed by file time and size",
		!!cached && cached.pages.length === pages && /^\d+:\d+$/.test(cached.stamp), cached && cached.stamp);

	let seen = [];
	let observer = Zotero.Notifier.registerObserver({
		notify: (event, type, ids) => seen.push(...ids.map(id => ({ event, id }))),
	}, ["setting"], "zusia-tester");
	let calls = [];
	let original = CS.onReadingNotify;
	CS.onReadingNotify = function (event, ids) {
		calls.push({ event, ids: [...ids] });
		return original.call(this, event, ids);
	};
	try {
		await attachment.setAttachmentLastPageIndex(pages > 1 ? 1 : 0);
		await waitFor(() => seen.length && calls.length, 5000, "a setting notification").catch(() => null);
	}
	finally {
		Zotero.Notifier.unregisterObserver(observer);
		CS.onReadingNotify = original;
	}
	let parsed = seen.map(s => CS.parseLastPageSetting(s.id)).filter(Boolean);
	check("reading progress: a page change fires a lastPageIndex setting event Zusia parses",
		parsed.some(p => p.key === attachment.key && p.groupID === null), seen);
	check("reading progress: Zusia's own observer receives it", calls.some(c => c.ids.some(id => id.includes(attachment.key))), calls);

	if (Zotero.SDT) {
		// Informational: what Zotero 10's structured text gives for this PDF. The map works
		// without it, so only the reported shape is recorded.
		// Zusia itself never waits for it; the tester may.
		let sdt = await Promise.race([CS.readSDT(attachment.id), Zotero.Promise.delay(5000).then(() => null)]);
		check("reading map (info): Zotero.SDT answered for the test PDF", true,
			sdt ? { labels: sdt.labels && sdt.labels.slice(0, 5), outline: sdt.outline && sdt.outline.length } : "still building after 5 s");
	}
}

// Opt-in (LIVE=1): real Claude Code runs from inside the sandboxed Zotero.
async function testLive(win, CS) {
	let item = new Zotero.Item("journalArticle");
	item.setField("title", "Live test paper");
	item.setField("abstractNote", "The secret word of this paper is PELICAN.");
	await item.saveTx();
	let itemPane = win.ZoteroPane.itemPane;
	itemPane.data = [item];
	await itemPane.renderItemPane(item);
	let root = await waitFor(() => {
		let r = [...win.document.querySelectorAll(".zs-root")].find(el => el.isConnected);
		return r && CS._views.get(r) && CS._views.get(r).ctx.paperItem.id === item.id && r;
	}, 30000, "live sidebar");
	let view = CS._views.get(root);
	CS.setPref("backend", "claude");
	CS.setPref("claude.model", "haiku");
	CS.setPref("claude.effort", "low");

	let type = (text) => {
		view.input.value = text;
		view.input.dispatchEvent(new win.Event("input", { bubbles: true }));
	};
	type("What is the secret word in metadata.md? Reply with only that word.");
	check("live: Send is enabled once text is typed", !root.querySelector(".zs-send").disabled);
	root.querySelector(".zs-send").click();
	check("live: Send turns into Stop while running", root.querySelector(".zs-send").classList.contains("zs-stop"));
	let history = await waitFor(async () => {
		if (CS._pending.has(view.ctx.dir)) return null;
		return CS.loadHistory(view.ctx.dir);
	}, 180000, "live answer");
	let answer = history[history.length - 1] || {};
	check("live: Claude answers through the sidebar with the chosen model and effort",
		/pelican/i.test(answer.text || "") && answer.model === "haiku" && answer.effort === "low",
		{ text: (answer.text || "").slice(0, 80), model: answer.model, effort: answer.effort,
			error: root.querySelector(".zs-error")?.textContent });
	let steps = (answer.activity && answer.activity.steps) || [];
	check("live: Claude's file reads are recorded as activity", steps.some(st => st.kind === "read"),
		{ steps: steps.map(st => st.label), thoughtMs: answer.activity && answer.activity.thoughtMs });
	await waitFor(() => root.querySelector(".zs-turn.zs-last .zs-activity"), 5000, "activity line").catch(() => null);
	check("live: activity line shows above the answer", !!root.querySelector(".zs-turn.zs-last .zs-activity"),
		root.querySelector(".zs-turn.zs-last .zs-activity-summary")?.textContent);
	let logText = await IOUtils.readUTF8(CS.getLogPath()).catch(() => "");
	check("live: CLI was called with --model haiku --effort low", /'--model' 'haiku'.*'--effort' 'low'/.test(logText));

	type("List the secret word 400 times, numbered 1 to 400, one per line, no other text.");
	root.querySelector(".zs-send").click();
	check("live: second run started", CS._pending.has(view.ctx.dir));
	// Stop only once the answer is visibly streaming.
	let streaming = await waitFor(() => {
		let p = CS._pending.get(view.ctx.dir);
		return p && p.partial.length > 60 ? p : null;
	}, 90000, "streamed text").catch(() => null);
	check("live: answer streams into the sidebar before it finishes", !!streaming);
	check("live: streamed text is rendered live", !!root.querySelector(".zs-live-content")?.textContent.trim());
	let started = Date.now();
	root.querySelector(".zs-send").click();
	await waitFor(() => !CS._pending.has(view.ctx.dir), 20000, "stop to finish");
	check("live: Stop ends the run quickly", Date.now() - started < 15000, Date.now() - started);
	await Zotero.Promise.delay(500);
	check("live: stop shows no error", !root.querySelector(".zs-error"), root.querySelector(".zs-error")?.textContent);
	let afterStop = await CS.loadHistory(view.ctx.dir);
	let last = afterStop[afterStop.length - 1] || {};
	check("live: stopped run keeps the partial answer or returns the question",
		(last.stopped === true && last.text.length > 0) || view.input.value.includes("400 times"),
		{ stopped: last.stopped, chars: (last.text || "").length, input: view.input.value.slice(0, 40) });
	await snapshot(win, "zotero-live", (() => {
		let r = win.document.getElementById("zotero-item-pane").getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	})());
}

// The left dock: the chat as its own column beside Zotero's panes, in place of the item pane section.
async function testDock(win, CS) {
	let doc = win.document;
	let shown = el => !!el && el.getClientRects().length > 0 && win.getComputedStyle(el).display !== "none";
	let paper = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID))
		.find(i => i.isRegularItem() && i.getField("title") === "Integration test paper");
	CS.setPlacement("left");
	let dock = await waitFor(() => doc.getElementById("zusia-dock"), 5000, "the dock");
	// The headless items tree lays out no rows and cannot select one, so the selection is
	// given here and the dock told about it, as the tree's select listener does.
	let { getSelectedItems } = win.ZoteroPane;
	win.ZoteroPane.getSelectedItems = () => [paper];
	await CS.syncDock(win).finally(() => {
		win.ZoteroPane.getSelectedItems = getSelectedItems;
	});
	check("dock: listens to the items tree for the selection", CS._docks.get(win).itemsView === win.ZoteroPane.itemsView);
	let root = await waitFor(() => [...dock.querySelectorAll(".zs-root")]
		.find(el => CS._views.get(el)?.ctx.paperItem?.id === paper.id), 20000, "the paper's chat in the dock");
	await doc.fonts.ready;
	await Zotero.Promise.delay(800);

	let dockRect = dock.getBoundingClientRect();
	let browser = doc.getElementById("browser").getBoundingClientRect();
	let content = doc.getElementById("appcontent").getBoundingClientRect();
	check("dock: a column at the left edge, from the tab bar to the bottom of the window",
		dockRect.left <= 1 && Math.abs(dockRect.right - content.left) <= 1 && Math.abs(dockRect.height - browser.height) <= 1 && dockRect.height > 600,
		{ dock: [Math.round(dockRect.left), Math.round(dockRect.right), Math.round(dockRect.height)], content: Math.round(content.left), browser: Math.round(browser.height) });
	check("dock: the item pane has no Zusia section any more",
		!doc.querySelector('#zotero-item-pane [data-pane$="zusia-section"]') && CS.paneID === null);
	let itemPane = doc.getElementById("zotero-item-pane").getBoundingClientRect();
	let items = doc.getElementById("zotero-items-pane").getBoundingClientRect();
	check("dock: Zotero's own panes still fit in the window beside it",
		itemPane.right <= win.innerWidth + 1 && content.right <= win.innerWidth + 1 && items.width > 250 && items.left >= dockRect.right,
		{ window: win.innerWidth, itemPaneRight: Math.round(itemPane.right), items: [Math.round(items.left), Math.round(items.width)] });
	let rootRect = root.getBoundingClientRect();
	let composer = root.querySelector(".zs-composer").getBoundingClientRect();
	let log = root.querySelector(".zs-log");
	check("dock: the chat fills its height with the composer at the bottom",
		rootRect.top - dockRect.top < 12 && dockRect.bottom - composer.bottom < 24,
		{ dock: [Math.round(dockRect.top), Math.round(dockRect.bottom)], root: Math.round(rootRect.top), composer: Math.round(composer.bottom) });
	let body = dock.querySelector(".zs-dock-body");
	check("dock: only the conversation scrolls, and nothing overflows sideways",
		body.scrollHeight <= body.clientHeight + 1 && root.scrollWidth <= root.clientWidth + 1 && log.scrollWidth <= log.clientWidth + 1,
		{ body: [body.scrollHeight, body.clientHeight], root: [root.scrollWidth, root.clientWidth], log: [log.scrollWidth, log.clientWidth] });
	let title = root.querySelector(".zs-header-paper");
	check("dock: the header names the paper and offers Hide, not the item pane's view buttons",
		shown(title) && title.textContent === "Integration test paper" && shown(root.querySelector(".zs-dock-hide"))
			&& !shown(root.querySelector(".zs-view-chat")) && !shown(root.querySelector(".zs-view-details")), title.textContent);
	await snapshot(win, "zotero-dock-window");
	await snapshot(win, "zotero-dock", { x: dockRect.x, y: dockRect.y, width: dockRect.width + 4, height: dockRect.height });

	// A 13-inch laptop: the dock and Zotero's three columns have to share the width.
	win.resizeTo(1180, 800);
	await Zotero.Promise.delay(900);
	let small = {
		window: win.innerWidth,
		dock: Math.round(dock.getBoundingClientRect().width),
		collections: Math.round(doc.getElementById("zotero-collections-pane").getBoundingClientRect().width),
		items: Math.round(doc.getElementById("zotero-items-pane").getBoundingClientRect().width),
		itemPaneRight: Math.round(doc.getElementById("zotero-item-pane").getBoundingClientRect().right),
		itemPane: Math.round(doc.getElementById("zotero-item-pane").getBoundingClientRect().width),
		layout: Zotero.Prefs.get("layout"),
	};
	small.drawer = dock.classList.contains("zs-dock-drawer");
	check("dock: on a window too narrow for it, it lies over the library and Zotero's panes stay inside the window",
		small.drawer && small.itemPaneRight <= small.window + 1 && small.items >= 250, small);
	await snapshot(win, "zotero-dock-laptop");
	win.resizeTo(1300, 800);
	await Zotero.Promise.delay(900);
	let medium = {
		window: win.innerWidth,
		dock: Math.round(dock.getBoundingClientRect().width),
		drawer: dock.classList.contains("zs-dock-drawer"),
		itemPaneRight: Math.round(doc.getElementById("zotero-item-pane").getBoundingClientRect().right),
		items: Math.round(doc.getElementById("zotero-items-pane").getBoundingClientRect().width),
	};
	check("dock: on a 13-inch window it narrows to the room there is, beside Zotero's panes",
		!medium.drawer && medium.dock >= 280 && medium.dock < 380 && medium.itemPaneRight <= medium.window + 1 && medium.items >= 250, medium);
	win.resizeTo(1500, 1400);
	await Zotero.Promise.delay(900);

	CS.setDockWidth(520);
	await Zotero.Promise.delay(300);
	check("dock: takes the width it is given", Math.round(dock.getBoundingClientRect().width) === 520, dock.getBoundingClientRect().width);
	CS.setDockWidth(CS.DOCK_WIDTH.initial);

	root.querySelector(".zs-dock-hide").click();
	await Zotero.Promise.delay(300);
	let rail = dock.querySelector(".zs-dock-rail");
	check("dock: Hide leaves a narrow rail with a button to bring it back",
		dock.getBoundingClientRect().width < 48 && shown(rail.querySelector(".zs-dock-open")) && !shown(dock.querySelector(".zs-root")),
		dock.getBoundingClientRect().width);
	await snapshot(win, "zotero-dock-rail");
	rail.querySelector(".zs-dock-open").click();
	await Zotero.Promise.delay(300);
	check("dock: the rail button opens it again on the same chat",
		Math.round(dock.getBoundingClientRect().width) === CS.DOCK_WIDTH.initial && shown(dock.querySelector(".zs-root .zs-input")));

	let altZ = () => doc.getElementById("zotero-items-tree").dispatchEvent(
		new win.KeyboardEvent("keydown", { code: "KeyZ", key: "z", altKey: true, bubbles: true, cancelable: true }));
	altZ();
	await Zotero.Promise.delay(300);
	let hiddenByKey = dock.getBoundingClientRect().width < 48;
	altZ();
	await Zotero.Promise.delay(500);
	check("dock: Alt+Z, pressed while another pane has the focus, hides it and brings it back with the message box focused",
		hiddenByKey && shown(dock.querySelector(".zs-root .zs-input")) && doc.activeElement === dock.querySelector(".zs-root .zs-input"),
		{ hiddenByKey, active: doc.activeElement?.className });

	CS.setPlacement("pane");
	await Zotero.Promise.delay(300);
	check("dock: choosing the item pane takes the dock away and registers the section again",
		!doc.getElementById("zusia-dock") && !!CS.paneID);
	CS.setPlacement("left");
}

// The four layouts, in the left dock: each shows its own parts, and none of them overflows.
async function testLayouts(win, CS) {
	let doc = win.document;
	let dock = doc.getElementById("zusia-dock");
	let root = dock.querySelector(".zs-root");
	let shown = el => !!el && el.getClientRects().length > 0 && win.getComputedStyle(el).display !== "none";
	let before = CS.getAppearance();
	let parts = {};
	for (let layout of Object.keys(CS.LAYOUTS)) {
		CS.saveAppearance(CS.layoutLook(layout, before));
		await waitFor(() => root.dataset.layout === layout, 5000, "the " + layout + " layout on the open chat");
		await Zotero.Promise.delay(400);
		let rect = dock.getBoundingClientRect();
		let composer = root.querySelector(".zs-composer").getBoundingClientRect();
		parts[layout] = {
			more: shown(root.querySelector(".zs-header-more")),
			search: shown(root.querySelector(".zs-search")),
			card: shown(root.querySelector(".zs-paper-card")),
			chip: shown(root.querySelector(".zs-context-chip")),
			label: win.getComputedStyle(root.querySelector(".zs-new-chat"), "::after").content,
			avatar: win.getComputedStyle(root.querySelector(".zs-turn"), "::after").maskImage !== "none",
			fits: root.scrollWidth <= root.clientWidth + 1 && rect.bottom - composer.bottom < 24 && composer.right <= rect.right,
		};
		await snapshot(win, "zotero-layout-" + layout, { x: rect.x, y: rect.y, width: rect.width + 4, height: rect.height });
	}
	CS.saveAppearance(before);
	let { minimal, standard, rich, visual } = parts;
	check("layouts: Minimal keeps New chat and a menu in the header, and the paper chip",
		minimal.more && !minimal.search && !minimal.card && minimal.chip, minimal);
	check("layouts: Standard shows its tools as icons and no paper card",
		!standard.more && standard.search && !standard.card && standard.chip && standard.label === "none", standard);
	check("layouts: Rich names its tools and shows the paper card in place of the chip",
		rich.search && rich.card && !rich.chip && rich.label !== "none", rich);
	check("layouts: Visual shows the paper card and the buddy beside each answer",
		visual.card && !visual.chip && visual.avatar && !standard.avatar, visual);
	check("layouts: every layout fits the dock, with the composer at its bottom",
		Object.values(parts).every(p => p.fits), Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, p.fits])));
}

// The first-run wizard in the left dock: every step has to fit, with its buttons in reach.
async function testWizard(win, CS) {
	let doc = win.document;
	let dock = doc.getElementById("zusia-dock");
	let root = dock.querySelector(".zs-root");
	let wizard = CS.showWizard(root);
	let misfits = [];
	for (let name of CS.WIZARD_STEPS) {
		await waitFor(() => wizard.dataset.step === name, 5000, "wizard step " + name);
		await Zotero.Promise.delay(450);
		let rootRect = root.getBoundingClientRect();
		let panel = wizard.querySelector(".zs-wizard-panel").getBoundingClientRect();
		let next = wizard.querySelector(".zs-wizard-next").getBoundingClientRect();
		let stage = wizard.querySelector(".zs-wizard-stage");
		let wide = [...stage.querySelectorAll("*")].filter(el => el.getBoundingClientRect().right > panel.right + 1).length;
		if (panel.bottom > rootRect.bottom + 1 || next.bottom > rootRect.bottom || wide || stage.scrollWidth > stage.clientWidth + 1) {
			misfits.push({ name, panelBottom: Math.round(panel.bottom), rootBottom: Math.round(rootRect.bottom), wide });
		}
		let rect = dock.getBoundingClientRect();
		await snapshot(win, "zotero-wizard-" + name, { x: rect.x, y: rect.y, width: rect.width + 4, height: rect.height });
		wizard.querySelector(".zs-wizard-next").click();
	}
	check("wizard: every step fits the dock, with Next in reach and nothing cut off sideways", misfits.length === 0, misfits);
	check("wizard: finishing it closes it and marks setup as done", !root.querySelector(".zs-wizard") && CS.getPref("onboarded") === true);
}

// With a real window only: the dock follows a click in the items tree and the reader tabs.
async function testDockFollows(win, CS) {
	let doc = win.document;
	let all = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
	let first = all.find(i => i.isRegularItem() && i.getField("title") === "Integration test paper");
	let second = all.find(i => i.isRegularItem() && i.getField("title") === "Loss of Plasticity in Deep Continual Learning");
	let attachment = Zotero.Items.get(second.getAttachments()[0]);
	let dock = doc.getElementById("zusia-dock");
	let shownPaper = () => {
		let root = dock.querySelector(".zs-root");
		return CS._views.get(root)?.ctx.paperItem?.id ?? null;
	};
	let follows = async (id, label) => {
		let ok = await waitFor(() => shownPaper() === id, 15000, label).then(() => true, () => false);
		check("dock follows: " + label, ok, { shown: shownPaper(), wanted: id });
	};

	await win.ZoteroPane.selectItem(first.id);
	await follows(first.id, "a paper selected in the items tree");
	await win.ZoteroPane.selectItem(second.id);
	await follows(second.id, "the next paper selected");

	await win.ZoteroPane.selectItem(first.id);
	await follows(first.id, "back on the first paper before opening a reader");
	let reader = await Zotero.Reader.open(attachment.id);
	await follows(second.id, "the paper of the reader tab that opens");
	await reader._initPromise;
	await Zotero.Promise.delay(1500);
	let dockRect = dock.getBoundingClientRect();
	let tab = doc.getElementById(reader.tabID).getBoundingClientRect();
	check("dock follows: the reader sits beside the dock, not under it", tab.left >= dockRect.right - 1 && tab.width > 400,
		{ dockRight: Math.round(dockRect.right), reader: [Math.round(tab.left), Math.round(tab.width)] });
	await snapshot(win, "zotero-dock-reader");

	let closed = win.ZoteroContextPane.collapsed;
	CS.setDockOpen(false);
	CS.askAboutSelection(reader, { text: "PELICAN", pageLabel: "1" }, false);
	let input = await waitFor(() => {
		let el = dock.querySelector(".zs-root .zs-input");
		return el && el.value.includes("PELICAN") && el;
	}, 10000, "the passage in the message box").catch(() => null);
	check("dock follows: Ask Zusia in the reader opens the dock with the passage, and leaves the context pane as it was",
		!!input && CS.dockOpen() && win.ZoteroContextPane.collapsed === closed, { input: input?.value.slice(0, 60) });

	win.Zotero_Tabs.select("zotero-pane");
	await follows(first.id, "the library tab's selection when you go back to it");
	win.Zotero_Tabs.close(reader.tabID);
}

async function testPrefs(CS) {
	check("settings pane registered", Zotero.PreferencePanes.pluginPanes.some(p => p.id === CS.PREFS_PANE_ID));
	let prefsWin = Zotero.Utilities.Internal.openPreferences(CS.PREFS_PANE_ID);
	await waitFor(() => prefsWin.document && prefsWin.document.readyState === "complete", 20000, "settings window");
	let prefs = await waitFor(() => prefsWin.document.querySelector(".zs-prefs"), 20000, "settings pane content");
	prefsWin.resizeTo(1000, 1500);
	await waitFor(() => [...prefs.querySelectorAll(".zs-agent-status")].every(s => s.textContent !== "Checking…"), 10000, "backend probes");
	await Zotero.Promise.delay(800);
	check("settings pane renders its five cards", prefs.querySelectorAll(".zs-card").length === 5);
	check("settings shows the model chosen in the composer",
		prefs.querySelector('[data-backend="claude"] .zs-select').value === "haiku");
	prefs.querySelector('[data-backend="claude"]').open = true;
	await Zotero.Promise.delay(300);
	let statuses = [...prefs.querySelectorAll(".zs-agent")].map(c => c.textContent);
	check("backend detection runs", statuses.length === 3, statuses);
	prefs.scrollIntoView({ block: "start" });
	await Zotero.Promise.delay(400);
	await snapshot(prefsWin, "zotero-settings-pane");
	let bottom = prefs.querySelectorAll(".zs-card")[2];
	bottom.scrollIntoView({ block: "start" });
	await Zotero.Promise.delay(400);
	await snapshot(prefsWin, "zotero-settings-pane-2");
	prefsWin.close();
}

async function run() {
	outDir = Zotero.Prefs.get("extensions.zusia-tester.outDir", true);
	repo = Zotero.Prefs.get("extensions.zusia-tester.repo", true);
	try {
		await Zotero.uiReadyPromise;
		let CS = await waitFor(() => Zotero.Zusia, 30000, "Claude Sidebar startup");
		check("plugin started", true, CS.version);
		// The checks start in the item pane, on every platform's profile; testDock moves
		// the chat to the left dock at the end.
		CS.setPlacement("pane");
		// New chat and page turns start memory jobs, which would call the real CLI: no model
		// runs here, live or not. The real call runs once with a fake process, to check the
		// folder it gets in a real Zotero.
		let realBackgroundCall = CS.runBackgroundCall;
		CS.runBackgroundCall = async (backend, prompt) => {
			backgroundCalls.push({ backend, prompt });
			return { text: "{}", error: "", rateLimited: false };
		};
		let { findBinary, runProcess } = CS;
		let spawned = null;
		CS.findBinary = async () => "/nonexistent/claude";
		CS.runProcess = async (command, args, cwd, onEvent, onSpawn, stdin) => {
			spawned = { cwd, args, stdin, children: (await IOUtils.getChildren(cwd)).length };
			return { stdout: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "{}" }] } }) + "\n", stderr: "", exitCode: 0 };
		};
		let answered = await realBackgroundCall.call(CS, "claude", "PROMPT").finally(() => {
			CS.findBinary = findBinary;
			CS.runProcess = runProcess;
		});
		check("memory: a background call runs in a new empty folder under the system temp folder, removed after",
			answered.text === "{}" && spawned && spawned.cwd.startsWith(PathUtils.tempDir) && spawned.children === 0 &&
			spawned.stdin === "PROMPT" && !(await IOUtils.exists(spawned.cwd)), spawned);
		let links = [...Zotero.getMainWindow().document.querySelectorAll(".zusia-stylesheet")];
		check("one link per stylesheet, versioned so updates never reuse a cached copy",
			links.length === CS.STYLES.length && links.every(l => /styles\/[\w-]+\.css\?v=/.test(l.href)), links.map(l => l.href));
		let win = await waitFor(() => Zotero.getMainWindow() && Zotero.getMainWindow().ZoteroPane && Zotero.getMainWindow(), 30000, "main window");
		// An item saved while Zotero is still loading the library breaks that load, and the
		// items tree then stays on "Loading items…" for the whole run.
		await Zotero.Libraries.userLibrary.waitForDataLoad("item");
		await testSidebar(win, CS);
		await testChatView(win, CS);
		await testPrefs(CS);
		await testReaderWidth(win, CS);
		await testDock(win, CS);
		await testLayouts(win, CS);
		await testWizard(win, CS);
		if (!Services.env.exists("MOZ_HEADLESS")) {
			await testDockFollows(win, CS);
		}
		if (Zotero.Prefs.get("extensions.zusia-tester.live", true)) {
			await testLive(win, CS);
		}
		let logText = await IOUtils.readUTF8(CS.getLogPath()).catch(() => "");
		let errors = logText.split("\n").filter(l => l.includes("ERROR"));
		check("plugin logged no errors", errors.length === 0, errors.slice(0, 5));
	}
	catch (e) {
		results.errors.push(String(e) + "\n" + (e.stack || ""));
		Zotero.debug("[zs-tester] ERROR " + e + "\n" + e.stack);
	}
	await IOUtils.writeUTF8(PathUtils.join(outDir, "results.json"), JSON.stringify(results, null, 2));
	Zotero.Utilities.Internal.quit();
}

function startup() {
	run();
}

function shutdown() {}
function install() {}
function uninstall() {}
