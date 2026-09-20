import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const PREFIX = "extensions.zusia.";

function sidebar(prefs = {}) {
	// The setup wizard is tested on its own; everywhere else setup is already done.
	prefs = { [PREFIX + "onboarded"]: true, ...prefs };
	const env = loadPlugin({ prefs });
	const { plugin, document, window } = env;
	const removed = [];
	const body = document.createElement("div");
	document.body.appendChild(body);
	plugin.renderSkeleton(document, body);
	const root = body.querySelector(".zs-root");
	root._installed = { claude: "/bin/claude", codex: null, agy: "/bin/agy" };
	const sent = [];
	const view = {
		doc: document, root, ctx: { dir: "/tmp/x" },
		logEl: root.querySelector(".zs-log"),
		input: root.querySelector(".zs-input"),
		send: (text, images) => sent.push(images && images.length ? { text, images } : text),
	};
	window.Zotero.File = { pathToFileURI: path => "file://" + path, putContentsAsync: async () => {}, createDirectoryIfMissingAsync: async () => {} };
	window.OS = { Path: { join: (...p) => p.join("/") }, File: { remove: async (path) => removed.push(path) } };
	plugin._views.set(root, view);
	return { ...env, root, view, sent, removed };
}
const menuLabels = root => [...root.querySelectorAll(".zs-menu .zs-menu-label")].map(n => n.textContent);

test("composer shows the assistant, model and effort from prefs", () => {
	const { root } = sidebar({ [PREFIX + "claude.model"]: "opus", [PREFIX + "claude.effort"]: "high" });
	assert.equal(root.querySelector(".zs-model-btn .zs-label").textContent, "Claude · Opus");
	assert.equal(root.querySelector(".zs-effort-btn .zs-label").textContent, "High");
	assert.equal(root.querySelector(".zs-input").placeholder, "Ask Claude about this paper…");
});

test("model menu lists every assistant and switches backend and model together", () => {
	const { root, prefs, plugin } = sidebar();
	plugin._agyModels = [{ id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" }];
	root.querySelector(".zs-model-btn").click();
	assert.deepEqual([...root.querySelectorAll(".zs-menu-section")].map(n => n.textContent),
		["Claude Code", "OpenAI Codex", "Google Antigravity"]);
	assert.ok(root.querySelector(".zs-menu").textContent.includes("Not installed"), "missing CLI is explained");
	const gemini = [...root.querySelectorAll(".zs-menu-item")].find(i => i.textContent.includes("Gemini 3.1 Pro"));
	gemini.click();
	assert.equal(prefs[PREFIX + "backend"], "agy");
	assert.equal(prefs[PREFIX + "agy.model"], "gemini-3.1-pro-high");
	assert.equal(root.querySelector(".zs-menu"), null, "menu closes after choosing");
	assert.equal(root.querySelector(".zs-model-btn .zs-label").textContent, "Gemini 3.1 Pro (High)");
	assert.equal(root.querySelector(".zs-effort-btn .zs-label").textContent, "Auto");
});

test("effort menu offers the levels the current backend supports", () => {
	const { root, prefs } = sidebar({ [PREFIX + "backend"]: "agy" });
	root.querySelector(".zs-effort-btn").click();
	assert.deepEqual(menuLabels(root), ["Auto", "Low", "Medium", "High"]);
	[...root.querySelectorAll(".zs-menu-item")][3].click();
	assert.equal(prefs[PREFIX + "agy.effort"], "high");
	assert.equal(root.querySelector(".zs-effort-btn .zs-label").textContent, "High");
});

test("a second click on the same button closes its menu", () => {
	const { root } = sidebar();
	root.querySelector(".zs-effort-btn").click();
	assert.ok(root.querySelector(".zs-menu"));
	root.querySelector(".zs-effort-btn").click();
	assert.equal(root.querySelector(".zs-menu"), null);
});

test("answers get Explain better, Retry, Copy and a More menu; only the last is retryable", () => {
	const { root, view, plugin, sent } = sidebar();
	plugin.renderMessages(view, [
		{ role: "user", text: "q1" }, { role: "assistant", text: "a1", backend: "claude" },
		{ role: "user", text: "q2" }, { role: "assistant", text: "a2", backend: "claude" },
	]);
	const turns = root.querySelectorAll(".zs-turn");
	assert.equal(turns[0].querySelector(".zs-retry"), null);
	assert.ok(turns[1].querySelector(".zs-retry"));
	assert.ok(turns[1].classList.contains("zs-last"));
	turns[1].querySelector(".zs-explain").click();
	assert.equal(sent[0], plugin.getExplainPrompt());
	turns[0].querySelector(".zs-explain").click();
	assert.match(sent[1], /^About your earlier answer that begins "a1/);
	turns[1].querySelector(".zs-more").click();
	assert.deepEqual(menuLabels(root), ["Save as note", "Copy"]);
});

test("answers from different assistants or models are labelled", () => {
	const { root, view, plugin } = sidebar();
	plugin.renderMessages(view, [
		{ role: "user", text: "q1" }, { role: "assistant", text: "a1", backend: "claude", model: "opus" },
		{ role: "user", text: "q2" }, { role: "assistant", text: "a2", backend: "agy" },
	]);
	assert.deepEqual([...root.querySelectorAll(".zs-by")].map(n => n.textContent), ["Claude · Opus", "Antigravity"]);
});

test("busy state turns Send into Stop and disables prompts", () => {
	const { root, view, plugin } = sidebar();
	plugin.setBusy(view, true);
	const send = root.querySelector(".zs-send");
	assert.ok(send.classList.contains("zs-stop"));
	assert.equal(send.disabled, false);
	assert.equal(send.title, "Stop");
	assert.ok([...root.querySelectorAll(".zs-pill")].every(p => p.disabled));
	plugin.setBusy(view, false);
	assert.equal(send.title, "Send (Enter)");
	assert.equal(send.disabled, true, "empty input cannot be sent");
});

test("stop kills the running process", () => {
	const { root, view, plugin } = sidebar();
	let killed = false;
	const pending = { cancel: () => { killed = true; } };
	plugin._pending.set(view.ctx.dir, pending);
	plugin.sendOrStop(root);
	assert.ok(killed);
	plugin._pending.delete(view.ctx.dir);
});

const fakeItem = (creators, date, title) => ({
	getCreators: () => creators,
	getField: f => ({ date, title })[f] || "",
});

test("paper chip label: first author, et al. and year", () => {
	const { plugin } = sidebar();
	const three = [{ lastName: "Dohare" }, { lastName: "Hernandez-Garcia" }, { lastName: "Sutton" }];
	assert.deepEqual({ ...plugin.paperInfo({ paperItem: fakeItem(three, "2024-08-21", "Loss of plasticity"), attachmentItem: { isPDFAttachment: () => true } }) },
		{ label: "Dohare et al., 2024", title: "Loss of plasticity", itemType: "attachmentPDF" });
	const two = [{ lastName: "Rahimi" }, { lastName: "Recht" }];
	assert.equal(plugin.paperInfo({ paperItem: fakeItem(two, "December 2007", "Random features") }).label, "Rahimi & Recht, 2007");
	assert.equal(plugin.paperInfo({ paperItem: fakeItem([], "", "Untitled draft") }).label, "Untitled draft");
});

test("paper chip renders into the composer and hides without a paper", () => {
	const { root, plugin } = sidebar();
	plugin.renderPaperChip(root, { label: "Dohare et al., 2024", title: "Loss of plasticity" });
	const chip = root.querySelector(".zs-composer .zs-context-chip");
	assert.equal(chip.querySelector(".zs-context-label").textContent, "Dohare et al., 2024");
	assert.equal(chip.querySelector(".zs-context-badge"), null);
	assert.match(chip.title, /not the PDF text/);
	assert.equal(root.querySelector(".zs-context").hidden, false);
	plugin.renderPaperChip(root, null);
	assert.equal(root.querySelector(".zs-context").hidden, true);
});

test("error card: short errors open, long ones collapse, retry runs the callback", () => {
	const { view, plugin } = sidebar();
	let retried = 0;
	const short = plugin.appendError(view, "claude exited with code 1", { title: "Claude could not answer", retry: () => retried++ });
	assert.equal(short.querySelector(".zs-error-title").textContent, "Claude could not answer");
	assert.equal(short.querySelector(".zs-error-details").hidden, false);
	short.querySelector(".zs-error-retry").click();
	assert.equal(retried, 1);
	const long = plugin.appendError(view, "x".repeat(500));
	assert.equal(long.querySelector(".zs-error-details").hidden, true);
	long.querySelector(".zs-error-head").click();
	assert.equal(long.querySelector(".zs-error-details").hidden, false);
	assert.equal(long.querySelector(".zs-error-head").getAttribute("aria-expanded"), "true");
});

test("history menu lists earlier chats and restores the chosen one", async () => {
	const { root, plugin } = sidebar();
	let restored = null;
	plugin.listArchives = async () => [
		{ path: "/tmp/x/chat-2.json", title: "What is the DFT?", count: 4, ts: Date.now() },
		{ path: "/tmp/x/chat-1.json", title: "Summarize this paper", count: 2, ts: Date.parse("2026-09-01T10:00:00Z") },
	];
	plugin.restoreChat = async (r, archive) => { restored = archive.path; };
	root.querySelector(".zs-history").click();
	assert.ok(root.querySelector(".zs-menu").textContent.includes("Loading"));
	await new Promise(r => setTimeout(r, 0));
	assert.deepEqual(menuLabels(root), ["What is the DFT?", "Summarize this paper"]);
	assert.match(root.querySelector(".zs-menu .zs-menu-desc").textContent, /^4 messages · /);
	root.querySelectorAll(".zs-menu-item")[1].click();
	assert.equal(root.querySelector(".zs-menu"), null);
	await new Promise(r => setTimeout(r, 0));
	assert.equal(restored, "/tmp/x/chat-1.json");
});

test("history menu explains when there is nothing to reopen", async () => {
	const { root, plugin } = sidebar();
	plugin.listArchives = async () => [];
	root.querySelector(".zs-history").click();
	await new Promise(r => setTimeout(r, 0));
	assert.match(root.querySelector(".zs-menu").textContent, /No earlier chats/);
});

test("edit icon puts a question back in the composer", () => {
	const { root, view, plugin, window } = sidebar();
	plugin.renderMessages(view, [{ role: "user", text: "First $x$" }, { role: "assistant", text: "a", backend: "claude" }, { role: "user", text: "Second question" }, { role: "assistant", text: "b", backend: "claude" }]);
	root.querySelector(".zs-user .zs-user-edit").click();
	assert.equal(view.input.value, "First $x$");
	assert.equal(root.querySelector(".zs-send").disabled, false);
});

test("keyboard: ArrowUp recalls the last question, Escape stops a running answer", async () => {
	const env = loadPlugin();
	const { plugin, document, window } = env;
	const body = document.createElement("div");
	document.body.appendChild(body);
	plugin.renderSkeleton(document, body);
	const dir = "/tmp/keys";
	plugin.getContext = async () => ({ dir, paperItem: null });
	plugin.loadHistory = async () => [{ role: "user", text: "Last question?" }, { role: "assistant", text: "a", backend: "claude" }];
	await plugin.renderContent(document, body, { key: "X" });
	const input = body.querySelector(".zs-input");
	input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp" }));
	assert.equal(input.value, "Last question?");
	let cancelled = false;
	plugin._pending.set(dir, { cancel: () => { cancelled = true; } });
	input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
	assert.ok(cancelled);
	plugin._pending.delete(dir);
});

test("answers show a collapsed activity line that expands to the steps", () => {
	const { root, view, plugin } = sidebar();
	plugin.renderMessages(view, [
		{ role: "user", text: "q" },
		{ role: "assistant", text: "a", backend: "claude", activity: {
			steps: [{ kind: "read", target: "paper.txt", label: "Read paper.txt" }, { kind: "search", target: "FFT", label: "Searched for “FFT”" }],
			thoughtMs: 5200,
		} },
	]);
	const activity = root.querySelector(".zs-turn .zs-activity");
	assert.equal(activity.querySelector(".zs-activity-summary").textContent, "Read paper.txt · searched once · thought for 5s");
	const list = activity.querySelector(".zs-activity-list");
	assert.equal(list.hidden, true);
	activity.querySelector(".zs-activity-head").click();
	assert.equal(list.hidden, false);
	assert.deepEqual([...list.querySelectorAll(".zs-step-label")].map(n => n.textContent),
		["Read paper.txt", "Searched for “FFT”", "Thought for 5s"]);
});

test("menus: arrow keys move focus, Home/End jump, Escape closes back to the button", async () => {
	const { root, window } = sidebar({ "extensions.zusia.claude.effort": "high" });
	const button = root.querySelector(".zs-effort-btn");
	button.click();
	await new Promise(r => setTimeout(r, 0));
	const items = [...root.querySelectorAll(".zs-menu-item")];
	const doc = root.ownerDocument;
	assert.equal(doc.activeElement, items[3], "opens on the checked item (High)");
	const key = k => doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
	key("ArrowDown");
	assert.equal(doc.activeElement, items[4]);
	key("End");
	assert.equal(doc.activeElement, items[items.length - 1]);
	key("ArrowDown");
	assert.equal(doc.activeElement, items[0], "wraps around");
	key("ArrowUp");
	assert.equal(doc.activeElement, items[items.length - 1]);
	key("Home");
	assert.equal(doc.activeElement, items[0]);
	key("Escape");
	assert.equal(root.querySelector(".zs-menu"), null);
	assert.equal(doc.activeElement, button);
});

test("long model names drop the assistant prefix; the tooltip keeps both", () => {
	const { root, plugin } = sidebar({ "extensions.zusia.backend": "agy", "extensions.zusia.agy.model": "gemini-3.8-flash-high" });
	plugin._agyModels = [{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" }];
	plugin.updateControls(root);
	const button = root.querySelector(".zs-model-btn");
	assert.equal(button.querySelector(".zs-label").textContent, "Gemini 3.8 Flash (High)");
	assert.match(button.title, /^Antigravity · Gemini 3\.8 Flash \(High\)/);
	const short = sidebar({ "extensions.zusia.claude.model": "opus" });
	assert.equal(short.root.querySelector(".zs-model-btn .zs-label").textContent, "Claude · Opus");
});

test("every icon shown anywhere maps to a bundled icon file", async () => {
	// Render every part of the UI that shows icons, then collect what was used.
	const { root, view, plugin, document } = sidebar();
	plugin.renderMessages(view, [
		{ role: "user", text: "q", images: ["attachments/a.png"], modes: ["drawing", "latex"] },
		{ role: "assistant", text: "a\n\n```svg\n<svg viewBox=\"0 0 9 9\"><rect width=\"2\" height=\"2\"/></svg>\n```", backend: "claude", activity: { steps: [
			{ kind: "read", label: "Read metadata.md" }, { kind: "search", label: "Searched" }, { kind: "run", label: "Ran x" },
		], thoughtMs: 3000 } },
	]);
	plugin.renderMessages(view, []);
	plugin.renderMessages(view, [{ role: "user", text: "q" }, { role: "assistant", text: "a", backend: "claude", activity: { steps: [{ kind: "read", label: "Read x" }], thoughtMs: 1 } }]);
	root.querySelector(".zs-activity-head").click();
	plugin.appendError(view, "boom", { retry() {} });
	plugin.renderPaperChip(root, { label: "A, 2024", title: "T" });
	root.querySelector(".zs-effort-btn").click();
	const prefsBox = document.createElement("div");
	document.body.appendChild(prefsBox);
	plugin.renderPrefsPane(document, prefsBox);
	const busy = sidebar();
	busy.plugin.setBusy(busy.view, true);

	const used = new Set([...document.querySelectorAll(".zs-i"), ...busy.document.querySelectorAll(".zs-i")].map(n => n.dataset.icon));
	assert.ok(used.size >= 15, "icons found: " + [...used].join(", "));
	const unmapped = [...used].filter(name => name !== "stop" && !plugin.ICON_FILES[name]);
	assert.deepEqual(unmapped, [], "icons without an icon file");
	const { existsSync, readFileSync } = await import("node:fs");
	for (const file of Object.values(plugin.ICON_FILES)) {
		const url = new URL("../src/content/icons/" + file, import.meta.url);
		assert.ok(existsSync(url), "missing " + file);
		// Phosphor Duotone (MIT) at 256×256, or the plugin's own 64×64 mascots.
		assert.match(readFileSync(url, "utf8"), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (256 256|64 64)"/);
	}
});

test("icons are fetched once, recoloured to currentColor and inlined", async () => {
	const { plugin, document, window } = sidebar();
	let fetches = 0;
	window.fetch = async (url) => {
		fetches++;
		assert.equal(url, plugin.iconBase + "chat-circle-dots.svg");
		return { text: async () => '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M1 1" fill="context-fill"/><path d="M2 2" stroke="context-fill"/><path d="M3 3" stroke="context-stroke" fill="none"/></svg>' };
	};
	plugin._iconCache.clear();
	const a = plugin.svgIcon(document, "newChat");
	const b = plugin.svgIcon(document, "newChat");
	await new Promise(r => setTimeout(r, 0));
	await new Promise(r => setTimeout(r, 0));
	assert.equal(fetches, 1);
	for (const icon of [a, b]) {
		const svg = icon.querySelector("svg");
		assert.ok(svg, "svg inlined");
		const [fill, strokeAsFill, stroke] = svg.querySelectorAll("path");
		assert.equal(fill.getAttribute("fill"), "currentColor");
		assert.equal(strokeAsFill.getAttribute("stroke"), "currentColor", "attachment.svg strokes with context-fill");
		assert.equal(stroke.getAttribute("stroke"), "currentColor");
		assert.equal(stroke.getAttribute("fill"), "none");
		assert.equal(svg.getAttribute("width"), null);
	}
});

test("images: staged thumbnails enable Send, can be removed, and go out with the message", async () => {
	const { root, view, plugin, sent, removed } = sidebar();
	const send = root.querySelector(".zs-send");
	assert.equal(root.querySelector(".zs-attachments").hidden, true);
	plugin.stagePath(view, "/tmp/x/attachments/image-1.png");
	plugin.stagePath(view, "/tmp/x/attachments/image-2.png");
	assert.equal(root.querySelector(".zs-attachments").hidden, false);
	assert.equal(root.querySelectorAll(".zs-attachments .zs-thumb img").length, 2);
	assert.equal(root.querySelector(".zs-attachments img").getAttribute("src"), "file:///tmp/x/attachments/image-1.png");
	assert.equal(send.disabled, false, "an image alone can be sent");
	root.querySelector(".zs-attachments .zs-thumb-remove").click();
	await new Promise(r => setTimeout(r, 0));
	assert.deepEqual(removed, ["/tmp/x/attachments/image-1.png"], "an unsent image's file is deleted");
	plugin.sendOrStop(root);
	assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ text: "", images: ["/tmp/x/attachments/image-2.png"] }]);
});

test("images: pasted image files are staged; text pastes are left alone", async () => {
	const { root, view, plugin, window } = sidebar();
	let staged;
	plugin.stageFiles = async (v, files) => { staged = [...files].map(f => f.type); };
	const paste = (files) => {
		const event = new window.Event("paste", { cancelable: true });
		plugin.onPasteOrDrop(view, event, { files });
		return event;
	};
	const png = new window.File(["x"], "shot.png", { type: "image/png" });
	const txt = new window.File(["x"], "a.txt", { type: "text/plain" });
	assert.equal(paste([png, txt]).defaultPrevented, true);
	assert.deepEqual(staged, ["image/png"]);
	staged = null;
	assert.equal(paste([txt]).defaultPrevented, false);
	assert.equal(staged, null);
	assert.equal(root.querySelector(".zs-attach").title, "Add an image or screenshot (Alt+I)");
});

test("images: sent messages show thumbnails; edit puts text and images back", () => {
	const { root, view, plugin } = sidebar();
	plugin.renderMessages(view, [
		{ role: "user", text: "What is this plot?", images: ["attachments/image-9.png"] },
		{ role: "assistant", text: "A histogram.", backend: "claude" },
	]);
	const card = root.querySelector(".zs-user");
	assert.equal(card.querySelector(".zs-user-images img").getAttribute("src"), "file:///tmp/x/attachments/image-9.png");
	assert.equal(card.querySelector(".zs-user-text").textContent, "What is this plot?");
	card.querySelector(".zs-user-edit").click();
	assert.equal(view.input.value, "What is this plot?");
	assert.deepEqual([...plugin.stagedPaths(view)], ["/tmp/x/attachments/image-9.png"]);
});

test("mode buttons: toggle Drawing/LaTeX, hide per Settings, and tag the sent message", () => {
	const { root, view, plugin, prefs } = sidebar();
	const drawing = root.querySelector('.zs-mode[data-mode="drawing"]');
	const latex = root.querySelector('.zs-mode[data-mode="latex"]');
	assert.equal(drawing.getAttribute("aria-pressed"), "false");
	drawing.click();
	assert.equal(prefs[PREFIX + "mode.drawing"], true);
	assert.equal(drawing.getAttribute("aria-pressed"), "true");
	assert.deepEqual([...plugin.activeModes()], ["drawing"]);
	latex.click();
	assert.deepEqual([...plugin.activeModes()], ["drawing", "latex"]);
	const note = plugin.modeInstructions(plugin.activeModes());
	assert.match(note, /```svg block/);
	assert.match(note, /\\begin\{definition\}/);
	// Hidden in Settings: the button disappears and its mode stops applying.
	prefs[PREFIX + "modeButtons"] = JSON.stringify({ latex: false });
	plugin.updateControls(root);
	assert.equal(latex.hidden, true);
	assert.equal(drawing.hidden, false);
	assert.deepEqual([...plugin.activeModes()], ["drawing"]);
	plugin.renderMessages(view, [{ role: "user", text: "Draw it", modes: ["drawing"] }]);
	assert.equal(root.querySelector(".zs-user .zs-user-mode").textContent, "Drawing");
});

test("shortcuts: Alt+D and Alt+L toggle the modes by key position; hidden buttons and other keys are ignored", () => {
	const { root, plugin, prefs, window } = sidebar();
	const press = (code, extra = {}) => {
		const event = new window.KeyboardEvent("keydown", { code, altKey: true, bubbles: true, cancelable: true, ...extra });
		root.querySelector(".zs-input").dispatchEvent(event);
		return event;
	};
	assert.equal(press("KeyD").defaultPrevented, true);
	assert.equal(prefs[PREFIX + "mode.drawing"], true);
	assert.equal(root.querySelector('.zs-mode[data-mode="drawing"]').getAttribute("aria-pressed"), "true");
	press("KeyL");
	assert.equal(prefs[PREFIX + "mode.latex"], true);
	press("KeyD");
	assert.equal(prefs[PREFIX + "mode.drawing"], false);
	assert.equal(press("KeyD", { ctrlKey: true }).defaultPrevented, false);
	assert.equal(press("KeyQ").defaultPrevented, false);
	prefs[PREFIX + "modeButtons"] = JSON.stringify({ latex: false });
	assert.equal(press("KeyL").defaultPrevented, false);
	assert.equal(press("KeyI").defaultPrevented, true, "Alt+I opens the image menu");
	assert.ok(root.querySelector(".zs-menu"));
	assert.match(root.querySelector('.zs-mode[data-mode="drawing"]').title, /\(Alt\+D\)$/);
});

test("streaming: unchanged blocks are kept, only new blocks fade in", () => {
	const { plugin, document } = sidebar();
	const container = document.createElement("div");
	const step = (text) => {
		const next = document.createElement("div");
		plugin.renderRich(document, next, text);
		plugin.patchChildren(container, next);
		return [...container.children];
	};
	const first = step("Para one with $x^2$.\n\nPara tw");
	assert.equal(first.length, 2);
	assert.ok(first.every(n => n.classList.contains("zs-enter")));
	const second = step("Para one with $x^2$.\n\nPara two, longer.\n\nThird");
	assert.equal(second[0], first[0], "unchanged paragraph is the same node");
	assert.notEqual(second[1], first[1], "the growing paragraph is replaced");
	assert.equal(second[1].classList.contains("zs-enter"), false, "a replaced block does not animate again");
	assert.equal(second[2].classList.contains("zs-enter"), true);
	const third = step("Para one with $x^2$.\n\nPara two, longer.\n\nThird");
	assert.ok(third.length === second.length && third.every((n, i) => n === second[i]), "no change keeps every node");
});

test("search: every word must match; snippets and newest first", () => {
	const { plugin } = sidebar();
	const chats = [
		{ dir: "/d/1-AAAAAAAA", libraryID: 1, key: "AAAAAAAA", current: true, history: [
			{ role: "user", text: "What is a Fourier transform?", ts: 10 },
			{ role: "assistant", text: "The Fourier transform decomposes a signal into frequencies.", ts: 11 },
		] },
		{ dir: "/d/1-BBBBBBBB", libraryID: 1, key: "BBBBBBBB", current: false, history: [
			{ role: "user", text: "fourier SERIES vs transform", ts: 30 },
		] },
	];
	const results = plugin.searchChats(chats, "fourier transform");
	assert.deepEqual(JSON.parse(JSON.stringify(results.map(r => [r.chat.key, r.index, r.role]))), [["BBBBBBBB", 0, "user"], ["AAAAAAAA", 1, "assistant"], ["AAAAAAAA", 0, "user"]]);
	assert.match(results[1].snippet, /^The Fourier transform/);
	assert.equal(plugin.searchChats(chats, "fourier banana").length, 0);
	assert.equal(plugin.searchChats(chats, "   ").length, 0);
});

test("search result jump scrolls to the message and flashes it", () => {
	const { view, plugin } = sidebar();
	plugin.renderMessages(view, [
		{ role: "user", text: "q1" }, { role: "assistant", text: "a1", backend: "claude" },
		{ role: "user", text: "q2" }, { role: "assistant", text: "a2", backend: "claude" },
	]);
	let scrolled = null;
	view.logEl.children[2].scrollIntoView = () => { scrolled = "q2"; };
	plugin._jump = { dir: "/tmp/x", index: 2 };
	plugin.applyJump(view);
	assert.equal(scrolled, "q2");
	assert.ok(view.logEl.children[2].classList.contains("zs-flash"));
	assert.equal(plugin._jump, null);
});

test("reader selection: prompt quotes the passage with its page; Explain sends, Ask fills the box", () => {
	const { root, view, plugin, sent } = sidebar();
	assert.equal(plugin.selectionPrompt("A  metric\nspace", "12", true), "Explain this passage (p. 12):\n\n> A metric space");
	assert.equal(plugin.selectionPrompt("x", "", false), "About this passage:\n\n> x\n\n");
	plugin._drafts.set("/tmp/x", { text: "About this passage:\n\n> x\n\n", send: false });
	view.input.value = "why?";
	plugin.applyDraft(view);
	assert.equal(view.input.value, "About this passage:\n\n> x\n\nwhy?");
	assert.equal(root.querySelector(".zs-send").disabled, false);
	let started = null;
	plugin.startRequest = (v, text) => { started = text; };
	plugin._drafts.set("/tmp/x", { text: "Explain this passage:\n\n> y", send: true });
	plugin.applyDraft(view);
	assert.equal(started, "Explain this passage:\n\n> y");
	assert.equal(plugin._drafts.size, 0);
});

test("reader selection popup gets two buttons; empty selections get none", () => {
	const { plugin, document } = sidebar();
	const appended = [];
	const event = { reader: { itemID: 1 }, doc: document, params: { annotation: { text: "Lemma 3", pageLabel: "4" } }, append: n => appended.push(n) };
	plugin.renderSelectionButtons(event);
	assert.deepEqual([...appended[0].querySelectorAll("button")].map(b => b.textContent), ["Ask Claude about this", "Explain this"]);
	plugin.renderSelectionButtons({ ...event, params: { annotation: { text: "  " } } });
	assert.equal(appended.length, 1);
});

test("theorem links: clicking jumps to the box, Back (button or Alt+←) returns, stack resets on a new render", () => {
	const { root, view, plugin, window } = sidebar();
	plugin.renderMessages(view, [
		{ role: "user", text: "Define it" },
		{ role: "assistant", text: "\\begin{theorem}[Key]\\label{thm:key}\nImportant.\n\\end{theorem}", backend: "claude" },
		{ role: "user", text: "Use it" },
		{ role: "assistant", text: "Apply \\ref{thm:key} here.", backend: "claude" },
	]);
	const back = root.querySelector(".zs-back");
	assert.equal(back.hidden, true);
	const scrolls = [];
	view.logEl.scrollTo = (opts) => scrolls.push(opts.top);
	view.logEl.scrollTop = 500;
	const ref = root.querySelector(".zs-ref-ok");
	assert.equal(ref.textContent, "Theorem 1");
	ref.click();
	assert.equal(scrolls.length, 1, "scrolled to the theorem");
	assert.ok(root.querySelector('.zs-env[data-label="thm:key"]').classList.contains("zs-flash"));
	assert.equal(back.hidden, false);
	ref.click();
	assert.equal(back.querySelector(".zs-label").textContent, "Back (2)");
	back.click();
	assert.deepEqual(scrolls.slice(-1), [500]);
	assert.equal(back.querySelector(".zs-label").textContent, "Back");
	const event = new window.KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
	view.input.dispatchEvent(event);
	assert.equal(event.defaultPrevented, true);
	assert.equal(back.hidden, true);
	ref.click();
	plugin.renderMessages(view, []);
	assert.equal(back.hidden, true);
});

test("the empty chat shows the mascot", () => {
	const { root, view, plugin } = sidebar();
	plugin.renderMessages(view, []);
	assert.ok(root.querySelector(".zs-empty .zs-mascot[data-icon='mascot-cat']"));
	assert.ok(root.querySelector(".zs-header .zs-header-icon[data-icon='cat']"));
});

test("icons: Phosphor's duotone layer is tagged so CSS can tint it; licence ships with the icons", async () => {
	const { plugin, document, window } = sidebar();
	window.fetch = async () => ({ text: async () =>
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M1 1" opacity="0.2"/><path d="M2 2"/></svg>' });
	plugin._iconCache.clear();
	const icon = plugin.svgIcon(document, "cat");
	await new Promise(r => setTimeout(r, 0));
	await new Promise(r => setTimeout(r, 0));
	const [duo, main] = icon.querySelectorAll("path");
	assert.equal(duo.getAttribute("class"), "zs-duo");
	assert.equal(duo.getAttribute("opacity"), null, "opacity comes from CSS");
	assert.equal(main.getAttribute("class"), null);
	const { existsSync } = await import("node:fs");
	assert.ok(existsSync(new URL("../src/content/icons/PHOSPHOR-LICENSE", import.meta.url)));
	assert.ok(!existsSync(new URL("../src/content/icons/TABLER-LICENSE", import.meta.url)), "no unused icon set is shipped");
});

test("icon-first: labels are hidden by default and every labelled button keeps a tooltip", () => {
	const { root, view, plugin } = sidebar();
	plugin.renderMessages(view, [
		{ role: "user", text: "q" },
		{ role: "assistant", text: "a\n\n```js\nx\n```\n\n```svg\n<svg viewBox=\"0 0 9 9\"><rect width=\"2\" height=\"2\"/></svg>\n```", backend: "claude" },
	]);
	plugin.appendError(view, "boom", { retry() {} });
	assert.equal(root.dataset.labels, "icons");
	const unnamed = [...root.querySelectorAll(".zs-ghost")]
		.filter(b => b.querySelector(".zs-label")?.textContent.trim() && !b.title)
		.map(b => b.className);
	assert.deepEqual(unnamed, [], "buttons that would be unnamed without their label");
	assert.ok(root.querySelector(".zs-figure-source .zs-i"), "Source has an icon");
	plugin.applyAppearance(root, { ...plugin.getAppearance(), labels: "text" });
	assert.equal(root.dataset.labels, "text");
});

test("buddy: the chosen mascot shows in the empty chat and the header; none hides it", () => {
	for (const [mascot, file, header] of [["cat", "mascot-cat", "cat"], ["owl", "mascot-owl", "bird"], ["robot", "mascot-robot", "robot"]]) {
		const { root, view, plugin } = sidebar({ [PREFIX + "appearance"]: JSON.stringify({ mascot }) });
		plugin.renderMessages(view, []);
		assert.equal(root.querySelector(".zs-empty .zs-mascot").dataset.icon, file);
		assert.equal(root.querySelector(".zs-header-icon").dataset.icon, header);
		assert.ok(plugin.ICON_FILES[file] && plugin.ICON_FILES[header]);
	}
	const none = sidebar({ [PREFIX + "appearance"]: JSON.stringify({ mascot: "none" }) });
	none.plugin.renderMessages(none.view, []);
	assert.equal(none.root.querySelector(".zs-mascot"), null);
	assert.equal(none.root.querySelector(".zs-header-icon").dataset.icon, "sparkle");
	const bad = sidebar({ [PREFIX + "appearance"]: JSON.stringify({ mascot: "dragon", pattern: "lasers" }) });
	assert.equal(bad.plugin.getAppearance().mascot, "cat");
	assert.equal(bad.plugin.getAppearance().pattern, "none");
});

test("pattern: the nerdy background pattern is applied to the root", () => {
	const { root, plugin } = sidebar({ [PREFIX + "appearance"]: JSON.stringify({ pattern: "math" }) });
	assert.equal(root.dataset.pattern, "math");
	plugin.applyAppearance(root, { ...plugin.getAppearance(), pattern: "none" });
	assert.equal(root.dataset.pattern, "none");
});

test("behaviour: send key, hidden steps and quick prompts apply to the sidebar", () => {
	const { root, plugin, window } = sidebar({ [PREFIX + "behaviour"]: JSON.stringify({ sendKey: "mod-enter", showSteps: false, showQuick: false }) });
	assert.equal(root.dataset.steps, "hidden");
	assert.equal(root.dataset.quick, "hidden");
	const key = (opts) => plugin.isSendKey(new window.KeyboardEvent("keydown", { key: "Enter", ...opts }));
	assert.equal(key({}), false, "plain Enter makes a new line");
	assert.equal(key({ metaKey: true }), true);
	assert.equal(key({ ctrlKey: true }), true);
	assert.match(root.querySelector(".zs-send").title, /(⌘|Ctrl)\+?Enter/);
	const normal = sidebar();
	assert.equal(normal.root.dataset.steps, "shown");
	const k2 = (opts) => normal.plugin.isSendKey(new normal.window.KeyboardEvent("keydown", { key: "Enter", ...opts }));
	assert.equal(k2({}), true);
	assert.equal(k2({ shiftKey: true }), false);
	assert.equal(k2({ isComposing: true }), false);
});

test("wizard: shown on first use, steps move forward and back, Escape skips", () => {
	const { root, plugin, prefs, window } = sidebar({ [PREFIX + "onboarded"]: undefined });
	const wizard = root.querySelector(".zs-wizard");
	assert.ok(wizard, "wizard shown");
	assert.equal(wizard.getAttribute("role"), "dialog");
	const step = () => wizard.dataset.step;
	assert.equal(step(), "welcome");
	assert.equal(wizard.querySelectorAll(".zs-wizard-dot").length, plugin.WIZARD_STEPS.length);
	assert.equal(wizard.querySelector(".zs-wizard-prev").hidden, true);
	wizard.querySelector(".zs-wizard-next").click();
	assert.equal(step(), "assistant");
	assert.equal(wizard.querySelector('.zs-wizard-dot[aria-current="step"]'), wizard.querySelectorAll(".zs-wizard-dot")[1]);
	wizard.querySelector(".zs-wizard-prev").click();
	assert.equal(step(), "welcome");
	wizard.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.equal(root.querySelector(".zs-wizard"), null);
	assert.equal(prefs[PREFIX + "onboarded"], true);
});

test("wizard: every step's choices are saved, finishing closes it for good", () => {
	const { root, plugin, prefs } = sidebar({ [PREFIX + "onboarded"]: false });
	const wizard = root.querySelector(".zs-wizard");
	const next = () => wizard.querySelector(".zs-wizard-next").click();
	const tile = title => [...wizard.querySelectorAll(".zs-tile")].find(t => t.title === title);
	next();
	assert.equal(wizard.dataset.step, "assistant");
	tile("Codex").click();
	assert.equal(prefs[PREFIX + "backend"], "codex");
	next();
	assert.equal(wizard.dataset.step, "look");
	tile("Flat").click();
	wizard.querySelector('.zs-swatch[aria-label="Violet"]').click();
	assert.equal(plugin.getAppearance().style, "flat");
	assert.equal(plugin.getAppearance().accent, "#6d4fd6");
	assert.equal(root.dataset.style, "flat", "the sidebar previews the choice at once");
	next();
	assert.equal(wizard.dataset.step, "buddy");
	tile("Robot").click();
	tile("Stars").click();
	assert.equal(plugin.getAppearance().mascot, "robot");
	assert.equal(plugin.getAppearance().pattern, "stars");
	next();
	assert.equal(wizard.dataset.step, "answers");
	tile("Expert").click();
	const language = wizard.querySelector("select");
	language.value = "Italiano";
	language.dispatchEvent(new root.ownerDocument.defaultView.Event("change"));
	tile("Drawing").click();
	assert.equal(plugin.getBehaviour().level, "expert");
	assert.equal(prefs[PREFIX + "language"], "Italiano");
	assert.equal(prefs[PREFIX + "mode.drawing"], true);
	assert.equal(tile("Drawing").getAttribute("aria-pressed"), "true");
	next();
	assert.equal(wizard.dataset.step, "done");
	assert.ok(wizard.querySelector(".zs-mascot[data-icon='mascot-robot']"));
	wizard.querySelector(".zs-wizard-next").click();
	assert.equal(root.querySelector(".zs-wizard"), null);
	assert.equal(prefs[PREFIX + "onboarded"], true);
	const again = sidebar({ [PREFIX + "onboarded"]: true });
	assert.equal(again.root.querySelector(".zs-wizard"), null);
});

test("wizard: every button is named for icon-only display", () => {
	const { root, plugin } = sidebar({ [PREFIX + "onboarded"]: false });
	const wizard = root.querySelector(".zs-wizard");
	for (let i = 0; i < plugin.WIZARD_STEPS.length; i++) {
		const unnamed = [...wizard.querySelectorAll("button")].filter(b => !b.hidden && !b.title && !b.getAttribute("aria-label"));
		assert.deepEqual(unnamed.map(b => b.className), [], "step " + wizard.dataset.step);
		if (i < plugin.WIZARD_STEPS.length - 1) {
			wizard.querySelector(".zs-wizard-next").click();
		}
	}
});

test("clarifications: the selection travels with Explain, and with Ask while its quote stays in the message", () => {
	const { view, plugin } = sidebar();
	const started = [];
	plugin.startRequest = (v, text, images, modes, extra) => started.push({ text, selection: extra && extra.selection });
	const selection = { text: "a lemma", pageLabel: "3", attachmentID: 7 };
	plugin._drafts.set("/tmp/x", { text: "Explain this passage (p. 3):\n\n> a lemma", send: true, selection });
	plugin.applyDraft(view);
	assert.equal(started[0].selection, selection);
	plugin._drafts.set("/tmp/x", { text: "About this passage (p. 3):\n\n> a lemma\n\n", send: false, selection });
	plugin.applyDraft(view);
	plugin.sendText(view, view.input.value + "why is it true?", []);
	assert.equal(started[1].selection, selection);
	plugin.sendText(view, "unrelated follow-up", []);
	assert.equal(started[2].selection, undefined, "used once");
	plugin._drafts.set("/tmp/x", { text: "About this passage:\n\n> a lemma\n\n", send: false, selection });
	plugin.applyDraft(view);
	plugin.sendText(view, "I deleted the quote", []);
	assert.equal(started[3].selection, undefined, "no quote, no clarification");
});

function clarificationPanel(records) {
	const env = sidebar();
	const { plugin, root, window } = env;
	let stored = JSON.parse(JSON.stringify(records));
	plugin.loadClarifications = async () => JSON.parse(JSON.stringify(stored));
	plugin.saveClarifications = async (dir, list) => { stored = JSON.parse(JSON.stringify(list)); };
	env.stored = () => stored;
	env.copied = [];
	window.Zotero.Utilities.Internal.copyTextToClipboard = text => env.copied.push(text);
	env.opened = [];
	window.Zotero.Reader = { open: (id, location) => env.opened.push({ id, location }) };
	env.tick = () => new Promise(r => setTimeout(r, 0));
	return env;
}
const record = (over = {}) => ({
	id: "c1", ts: Date.parse("2026-09-17T10:00:00Z"), passage: "Every Cauchy sequence converges", pageLabel: "65",
	position: { pageIndex: 64, rects: [[1, 1, 2, 2]] }, attachmentID: 99, question: "Explain this passage (p. 65):\n\n> Every Cauchy sequence converges",
	prompt: "Explain this passage (p. 65):\n\n> Every Cauchy sequence converges\n\n(Sidebar formatting…)", instructions: "You are embedded in Zotero…",
	answer: "Because $\\mathbb{R}$ is **complete**.", backend: "claude", model: "opus", messageIndex: 4, ...over,
});

test("clarifications panel: lists saved clarifications newest first, opens a detail with passage, prompt and answer", async () => {
	const env = clarificationPanel([record(), record({ id: "c2", ts: Date.parse("2026-09-18T10:00:00Z"), passage: "Newer passage", pageLabel: "70" })]);
	const { root, plugin } = env;
	assert.ok(root.querySelector(".zs-header .zs-clarifications"), "header button");
	await plugin.openClarifications(root);
	const panel = root.querySelector(".zs-panel");
	assert.ok(panel);
	const items = [...panel.querySelectorAll(".zs-clar-item")];
	assert.deepEqual(items.map(i => i.querySelector(".zs-clar-passage").textContent), ["Newer passage", "Every Cauchy sequence converges"]);
	assert.equal(items[1].querySelector(".zs-clar-page").textContent, "p. 65");
	items[1].click();
	const detail = panel.querySelector(".zs-clar-detail");
	assert.ok(detail);
	assert.equal(detail.querySelector(".zs-clar-passage-full").textContent, "Every Cauchy sequence converges");
	assert.equal(detail.querySelector(".zs-clar-prompt").textContent, record().prompt);
	assert.equal(detail.querySelector(".zs-clar-instructions pre").textContent, record().instructions);
	assert.ok(detail.querySelector(".zs-clar-answer strong"), "answer rendered as rich text");
	assert.ok(detail.querySelector(".zs-clar-answer math"), "maths rendered");
	detail.querySelector(".zs-clar-copy").click();
	assert.deepEqual(env.copied, [record().prompt]);
	detail.querySelector(".zs-clar-pdf").click();
	assert.deepEqual(JSON.parse(JSON.stringify(env.opened)), [{ id: 99, location: { position: record().position } }]);
	panel.querySelector(".zs-panel-back").click();
	assert.ok(panel.querySelector(".zs-clar-item"), "back to the list");
});

test("clarifications panel: go to the chat message, delete, empty state and Escape", async () => {
	const env = clarificationPanel([record()]);
	const { root, plugin, view, window } = env;
	plugin.renderMessages(view, [
		{ role: "user", text: "q0" }, { role: "assistant", text: "a1", backend: "claude" },
		{ role: "user", text: "q2" }, { role: "assistant", text: "a3", backend: "claude" },
		{ role: "user", text: record().question }, { role: "assistant", text: record().answer, backend: "claude" },
	]);
	const target = view.logEl.children[4];
	let scrolled = false;
	target.scrollIntoView = () => { scrolled = true; };
	await plugin.openClarifications(root);
	root.querySelector(".zs-clar-item").click();
	root.querySelector(".zs-clar-chat").click();
	assert.equal(root.querySelector(".zs-panel"), null, "panel closes");
	assert.ok(scrolled, "scrolled to the question");
	assert.ok(target.classList.contains("zs-flash"), "the question is highlighted");
	await plugin.openClarifications(root);
	root.querySelector(".zs-clar-item").click();
	root.querySelector(".zs-clar-delete").click();
	await env.tick();
	assert.deepEqual(env.stored(), []);
	assert.ok(root.querySelector(".zs-panel .zs-clar-empty"), "empty state after deleting the last one");
	root.querySelector(".zs-panel").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.equal(root.querySelector(".zs-panel"), null);
	const unnamed = [];
	await plugin.openClarifications(root);
	for (const b of root.querySelectorAll(".zs-panel button")) {
		if (!b.title && !b.getAttribute("aria-label") && !b.textContent.trim()) unnamed.push(b.className);
	}
	assert.deepEqual(unnamed, []);
});
