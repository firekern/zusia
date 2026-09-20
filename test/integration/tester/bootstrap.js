// Runs inside a throwaway Zotero instance started by test/integration/run.sh.
// Exercises Claude Sidebar in real Zotero, saves screenshots and results.json,
// then quits Zotero.

var results = { checks: [], errors: [] };
var outDir;
var repo;

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
	let chipIcon = root.querySelector(".zs-context-chip .icon-item-type");
	check("paper chip uses Zotero's item-type icon", !!chipIcon && win.getComputedStyle(chipIcon).backgroundImage.includes("item-type"),
		chipIcon && win.getComputedStyle(chipIcon).backgroundImage.slice(0, 90));
	let chip = root.querySelector(".zs-context-chip");
	check("paper chip names the item and its text source",
		!!chip && chip.textContent.includes("Integration test paper") && chip.textContent.includes("Metadata"),
		chip && chip.textContent);
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
	check("pdf: paper chip shows authors, year and PDF",
		!!chip && chip.textContent.includes("Dohare et al., 2024") && chip.textContent.includes("PDF"), chip && chip.textContent);
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

async function testPrefs(CS) {
	check("settings pane registered", Zotero.PreferencePanes.pluginPanes.some(p => p.id === CS.PREFS_PANE_ID));
	let prefsWin = Zotero.Utilities.Internal.openPreferences(CS.PREFS_PANE_ID);
	await waitFor(() => prefsWin.document && prefsWin.document.readyState === "complete", 20000, "settings window");
	let prefs = await waitFor(() => prefsWin.document.querySelector(".zs-prefs"), 20000, "settings pane content");
	prefsWin.resizeTo(1000, 1500);
	await waitFor(() => [...prefs.querySelectorAll(".zs-agent-status")].every(s => s.textContent !== "Checking…"), 10000, "backend probes");
	await Zotero.Promise.delay(800);
	check("settings pane renders four cards", prefs.querySelectorAll(".zs-card").length === 4);
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
		let links = [...Zotero.getMainWindow().document.querySelectorAll("#zusia-stylesheet")];
		check("one stylesheet link, versioned so updates never reuse a cached copy",
			links.length === 1 && /zusia\.css\?v=/.test(links[0].href), links.map(l => l.href));
		let win = await waitFor(() => Zotero.getMainWindow() && Zotero.getMainWindow().ZoteroPane && Zotero.getMainWindow(), 30000, "main window");
		await testSidebar(win, CS);
		await testPrefs(CS);
		await testReaderWidth(win, CS);
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
