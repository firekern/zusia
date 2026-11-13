import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPlugin, openChat } from "./load-plugin.mjs";

const PREFIX = "extensions.zusia.";

function sidebar(prefs = {}, { dock = false } = {}) {
	const env = loadPlugin({ prefs: { [PREFIX + "onboarded"]: true, ...prefs } });
	const { root, view } = openChat(env, { ctx: { dir: "/tmp/x" }, className: dock ? "zs-dock" : "" });
	view.send = () => {};
	return { ...env, root };
}
const menuLabels = root => [...root.querySelectorAll(".zs-menu .zs-menu-label")].map(n => n.textContent);

test("the layout is Standard until one is chosen, and is set on the chat for the stylesheet", () => {
	const { plugin, root } = sidebar();
	assert.equal(plugin.getAppearance().layout, "standard");
	assert.equal(root.dataset.layout, "standard");
	const other = sidebar({ [PREFIX + "appearance"]: JSON.stringify({ layout: "rich" }) });
	assert.equal(other.root.dataset.layout, "rich");
	const unknown = sidebar({ [PREFIX + "appearance"]: JSON.stringify({ layout: "huge" }) });
	assert.equal(unknown.plugin.getAppearance().layout, "standard");
});

test("choosing a layout sets the look it starts from and keeps the rest", () => {
	const { plugin } = sidebar({ [PREFIX + "appearance"]: JSON.stringify({ accent: "#6d4fd6", mascot: "owl", font: "serif" }) });
	const minimal = plugin.layoutLook("minimal");
	assert.deepEqual([minimal.layout, minimal.style, minimal.mascot, minimal.glow, minimal.density], ["minimal", "flat", "none", false, "compact"]);
	assert.deepEqual([minimal.accent, minimal.font], ["#6d4fd6", "serif"], "what a layout does not set stays");
	const rich = plugin.layoutLook("rich");
	assert.deepEqual([rich.layout, rich.labels, rich.mascot], ["rich", "text", "owl"], "the buddy you chose stays");
	assert.equal(plugin.layoutLook("visual", minimal).mascot, "cat", "after Minimal the buddy comes back");
	for (const layout of Object.keys(plugin.LAYOUTS)) {
		// What a layout sets must be values the appearance accepts, or saving would drop them.
		plugin.saveAppearance(plugin.layoutLook(layout));
		assert.deepEqual(plugin.getAppearance(), plugin.layoutLook(layout), layout);
	}
});

test("every layout but Standard has a stylesheet of its own", () => {
	const { plugin } = sidebar();
	for (const layout of Object.keys(plugin.LAYOUTS).filter(l => l !== "standard")) {
		const css = readFileSync(new URL("../src/content/styles/layout-" + layout + ".css", import.meta.url), "utf8");
		assert.ok(css.includes('[data-layout="' + layout + '"]'), layout);
	}
});

test("Minimal's header menu holds the tools the other layouts show as icons", () => {
	const { root, plugin } = sidebar();
	const opened = [];
	plugin.openHistoryMenu = () => opened.push("history");
	plugin.openSearchMenu = () => opened.push("search");
	plugin.openSettings = () => opened.push("settings");
	plugin.openClarifications = async () => opened.push("clarifications");
	root.querySelector(".zs-header-more").click();
	assert.deepEqual(menuLabels(root), ["Previous chats", "Search all chats", "Clarifications", "Settings"]);
	for (const label of ["Previous chats", "Search all chats", "Clarifications", "Settings"]) {
		if (!root.querySelector(".zs-menu")) {
			root.querySelector(".zs-header-more").click();
		}
		[...root.querySelectorAll(".zs-menu-item")].find(i => i.querySelector(".zs-menu-label").textContent === label).click();
		assert.equal(root.querySelector(".zs-menu"), null, "the menu closes on a choice");
	}
	assert.deepEqual(opened, ["history", "search", "clarifications", "settings"]);
});

test("in the left panel the header menu can also hide Zusia", () => {
	const { root, plugin, prefs } = sidebar({}, { dock: true });
	plugin.updateDocks = () => {};
	root.querySelector(".zs-header-more").click();
	assert.equal(menuLabels(root).at(-1), "Hide Zusia");
	[...root.querySelectorAll(".zs-menu-item")].at(-1).click();
	assert.equal(prefs[PREFIX + "dockOpen"], false);
});

test("the paper card shows the title, who wrote it, where you are and how much you have read", () => {
	const { root, plugin } = sidebar();
	const card = root.querySelector(".zs-paper-card");
	assert.equal(card.hidden, true, "nothing to show before a paper is known");
	plugin.renderPaperChip(root, { label: "Dohare et al., 2024", title: "Loss of plasticity", reading: "§3 · p. 12 · 4/9 read", readFraction: 0.417 });
	assert.equal(card.hidden, false);
	assert.equal(card.querySelector(".zs-paper-card-title").textContent, "Loss of plasticity");
	assert.equal(card.querySelector(".zs-paper-card-byline").textContent, "Dohare et al., 2024");
	assert.equal(card.querySelector(".zs-paper-card-reading").textContent, "§3 · p. 12 · 4/9 read");
	const bar = card.querySelector(".zs-paper-card-progress");
	assert.equal(bar.getAttribute("aria-valuenow"), "42");
	assert.equal(bar.style.getPropertyValue("--zs-read"), "42%");

	plugin.renderPaperChip(root, { label: "Untitled note", title: "" });
	assert.equal(card.querySelector(".zs-paper-card-title").textContent, "Untitled note");
	assert.equal(card.querySelector(".zs-paper-card-byline"), null, "the label is not said twice");
	assert.equal(card.querySelector(".zs-paper-card-progress"), null, "no bar without a reading map");
	plugin.renderPaperChip(root, null);
	assert.equal(card.hidden, true);
});

test("the paper card opens the Memory sheet, by click and by keyboard", () => {
	const { root, plugin, window } = sidebar();
	let opened = 0;
	plugin.openMemory = async () => { opened++; };
	const card = root.querySelector(".zs-paper-card");
	card.click();
	card.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	card.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
	assert.equal(opened, 2);
});

test("Settings: choosing a layout saves its look and redraws the rows it changed", () => {
	const env = loadPlugin();
	const container = env.document.createElement("div");
	env.document.body.appendChild(container);
	env.plugin.renderPrefsPane(env.document, container);
	const appearance = () => [...container.querySelectorAll(".zs-card")].find(c => c.querySelector(".zs-card-title").textContent === "Appearance");
	const row = label => [...appearance().querySelectorAll(".zs-row")].find(r => r.querySelector(".zs-row-label").textContent === label);
	const checked = label => row(label).querySelector('[aria-checked="true"]').textContent;
	assert.equal(checked("Layout"), "Standard");
	row("Layout").querySelector('.zs-tile[data-value="minimal"]').click();
	const saved = JSON.parse(env.prefs[PREFIX + "appearance"]);
	assert.deepEqual([saved.layout, saved.style, saved.mascot], ["minimal", "flat", "none"]);
	assert.equal(checked("Layout"), "Minimal");
	assert.match(row("Layout").querySelector(".zs-row-hint").textContent, /^Minimal: only the conversation/, "the row says what the chosen layout is");
	assert.equal(checked("Style"), "Flat", "the Style row shows what the layout set");
	assert.equal(checked("Spacing"), "Compact");
	assert.equal(container.querySelector(".zs-prefs").dataset.layout, "minimal");
	assert.equal(container.querySelectorAll(".zs-card").length, 5, "the card is replaced, not added");
});

test("setup wizard: the look step offers the layouts and shows the style a layout brings", () => {
	const { root, plugin, prefs } = sidebar({ [PREFIX + "onboarded"]: false });
	const step = plugin.wizardStep(root, "look");
	const tile = (group, value) => group.querySelector('.zs-tile[data-value="' + value + '"]');
	const [layouts, styles] = step.querySelectorAll(".zs-tiles");
	assert.deepEqual([...layouts.querySelectorAll(".zs-tile-label")].map(n => n.textContent), ["Minimal", "Standard", "Rich", "Visual"]);
	assert.equal(tile(styles, "glass").getAttribute("aria-checked"), "true");
	tile(layouts, "minimal").click();
	assert.equal(JSON.parse(prefs[PREFIX + "appearance"]).layout, "minimal");
	assert.equal(root.dataset.layout, "minimal");
	assert.equal(tile(styles, "flat").getAttribute("aria-checked"), "true");
});

test("the answer still being written is marked, so a layout can show its buddy at work", async () => {
	const { root, plugin, window } = sidebar();
	const view = plugin._views.get(root);
	plugin.showPending(view, {
		question: "And the inverse?", backend: "claude", startedAt: Date.now(), partial: "The inverse", status: "writing",
		listeners: new Set(), promise: new Promise(() => {}), steps: [], images: [], modes: [],
	});
	const turns = [...root.querySelectorAll(".zs-turn")];
	assert.equal(turns.length, 1);
	assert.ok(turns[0].classList.contains("zs-live"));
	plugin.renderMessages(view, [{ role: "user", text: "q" }, { role: "assistant", text: "a", backend: "claude" }]);
	assert.equal(root.querySelector(".zs-turn.zs-live"), null, "a finished answer is not live");
	// The live answer counts its seconds on a timer, which would keep the test process alive.
	window.close();
});

test("Minimal: the menus opened from the header menu hang from its button, the only one left on screen", async () => {
	const { root, plugin } = sidebar({ [PREFIX + "appearance"]: JSON.stringify({ layout: "minimal" }) });
	plugin.listArchives = async () => [];
	plugin.loadAllChats = async () => [];
	const more = root.querySelector(".zs-header-more");
	const choose = (label) => {
		more.click();
		[...root.querySelectorAll(".zs-menu-item")].find(i => i.querySelector(".zs-menu-label").textContent === label).click();
	};
	choose("Previous chats");
	assert.ok(root.querySelector(".zs-history-menu"));
	assert.equal(more.getAttribute("aria-expanded"), "true", "anchored at More");
	assert.notEqual(root.querySelector(".zs-history").getAttribute("aria-expanded"), "true", "not at the hidden History button");
	plugin.closeMenu(root);
	choose("Search all chats");
	assert.ok(root.querySelector(".zs-search-menu"));
	assert.equal(more.getAttribute("aria-expanded"), "true");
	plugin.closeMenu(root);
	// The header's own buttons still open them where they are.
	root.querySelector(".zs-history").click();
	assert.equal(root.querySelector(".zs-history").getAttribute("aria-expanded"), "true");
});

test("a sheet or the wizard over the chat marks it, so it gets room without :has()", async () => {
	const { root, plugin } = sidebar();
	const settle = () => new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(root.classList.contains("zs-overlaid"), false);
	const { panel } = plugin.openPanel(root, { label: "Reading memory", icon: "memory" });
	await settle();
	assert.equal(root.classList.contains("zs-overlaid"), true);
	panel.remove();
	await settle();
	assert.equal(root.classList.contains("zs-overlaid"), false);
	plugin.showWizard(root);
	await settle();
	assert.equal(root.classList.contains("zs-overlaid"), true);
	plugin.finishWizard(root);
	await settle();
	assert.equal(root.classList.contains("zs-overlaid"), false);
	// Zotero 7's Gecko drops a whole rule whose selector list holds :has().
	for (const name of plugin.STYLES) {
		const css = readFileSync(new URL("../src/content/styles/" + name + ".css", import.meta.url), "utf8").replace(/\/\*[^]*?\*\//g, "");
		for (const [selectors] of css.matchAll(/[^{}]*:has\([^{}]*\{/g)) {
			assert.ok(!/,/.test(selectors.replace(/\([^()]*\)/g, "")), name + ".css: :has() shares a rule with other selectors: " + selectors.trim().slice(0, 80));
		}
	}
});

test("while there is more below, the conversation is marked so its last lines fade under the jump button", () => {
	const { root, plugin } = sidebar();
	const log = root.querySelector(".zs-log");
	const wrap = root.querySelector(".zs-log-wrap");
	const jump = root.querySelector(".zs-jump");
	const scrolledTo = (top) => {
		Object.defineProperties(log, {
			scrollHeight: { value: 2000, configurable: true },
			clientHeight: { value: 600, configurable: true },
			scrollTop: { value: top, configurable: true, writable: true },
		});
		plugin.updateJump(root);
	};
	scrolledTo(1400);
	assert.deepEqual([wrap.classList.contains("zs-more-below"), jump.hidden], [false, true], "at the end");
	scrolledTo(1340);
	assert.deepEqual([wrap.classList.contains("zs-more-below"), jump.hidden], [true, true], "a little above: the fade, no button yet");
	scrolledTo(900);
	assert.deepEqual([wrap.classList.contains("zs-more-below"), jump.hidden], [true, false]);
	assert.equal(wrap.classList.contains("zs-more-above"), true, "scrolled down: the first lines fade under the header too");
	scrolledTo(0);
	assert.equal(wrap.classList.contains("zs-more-above"), false, "at the top nothing is hidden above");
});

test("glass: what lies over the chat's text is opaque, whatever opacity the cards have", () => {
	const { root } = sidebar({ [PREFIX + "appearance"]: JSON.stringify({ style: "glass", glassOpacity: 20 }) });
	assert.equal(root.style.getPropertyValue("--zs-overlay-pct"), "", "no opacity is handed to menus and sheets");
	const glass = readFileSync(new URL("../src/content/styles/glass.css", import.meta.url), "utf8");
	for (const [, value] of glass.matchAll(/--zs-overlay:([^;]*);/g)) {
		assert.ok(!/transparent|rgba|pct/.test(value), "menus, sheets and the wizard would show the text under them: " + value.trim());
	}
});

test("no Zusia button keeps the height Zotero caps every button at on macOS", () => {
	// Zotero's own stylesheet there: button { max-height: 25px }. A menu row with a second
	// line, the error card's title and the wizard's tiles are taller and were cut to it.
	const css = readFileSync(new URL("../src/content/styles/base.css", import.meta.url), "utf8").replace(/\/\*[^]*?\*\//g, "");
	const lifted = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , body]) => /max-height:\s*none/.test(body))
		.flatMap(([, selectors]) => selectors.split(",").map(s => s.trim()));
	for (const where of [".zs-root button", ".zs-prefs button", ".zs-dock button"]) {
		assert.ok(lifted.includes(where), where);
	}
});

test("the chat stays at its latest message while what it shows settles, unless you scrolled up to read", async () => {
	const env = loadPlugin({ prefs: { [PREFIX + "onboarded"]: true } });
	const { window, document, plugin } = env;
	// jsdom has no layout: the sizes are set here, and reported the way a browser reports them.
	const observers = [];
	window.ResizeObserver = class {
		constructor(callback) {
			this.callback = callback;
			this.targets = new Set();
			observers.push(this);
		}
		observe(target) { this.targets.add(target); }
		unobserve(target) { this.targets.delete(target); }
	};
	window.requestAnimationFrame = fn => setTimeout(fn, 0);
	window.cancelAnimationFrame = clearTimeout;
	const { root } = openChat(env, { ctx: { dir: "/tmp/x" }, className: "zs-dock" });
	const log = root.querySelector(".zs-log");
	const wrap = root.querySelector(".zs-log-wrap");
	let height = 2000;
	let top = 0;
	Object.defineProperties(log, {
		scrollHeight: { get: () => height },
		clientHeight: { get: () => 600 },
		scrollTop: { get: () => top, set: (value) => { top = Math.max(0, Math.min(value, height - 600)); } },
	});
	const resized = () => observers.forEach(o => o.callback([{ target: log, contentRect: { width: 300 } }]));
	const scrolledTo = (value) => {
		top = value;
		log.dispatchEvent(new window.Event("scroll"));
	};
	const settle = () => new Promise(resolve => setTimeout(resolve, 0));

	plugin.scrollToEnd(log);
	assert.equal(top, 1400);
	// A drawing gets its height and the maths font arrives after that first scroll; the
	// scroll event of the first scroll comes later still, when the end is already further.
	height = 2114;
	scrolledTo(1400);
	resized();
	assert.equal(top, 1514, "still at the latest message");
	assert.equal(wrap.classList.contains("zs-more-below"), false);

	scrolledTo(700);
	height = 2300;
	resized();
	assert.equal(top, 700, "scrolled up to read: left there");
	assert.equal(wrap.classList.contains("zs-more-below"), true, "and the edge says there is more");

	scrolledTo(1700);
	height = 2500;
	resized();
	assert.equal(top, 1900, "back at the end, it follows again");

	// An answer being written follows Settings → Follow the answer, not this.
	const live = document.createElement("div");
	live.className = "zs-turn zs-live";
	log.appendChild(live);
	await settle();
	assert.ok(observers.some(o => o.targets.has(live)), "every message is watched for its height");
	height = 2700;
	resized();
	assert.equal(top, 1900);
	live.remove();
	await settle();
	assert.ok(!observers.some(o => o.targets.has(live)), "and no longer once it is gone");
});

test("an answer still being written is styled like a finished one", () => {
	const { root, plugin, window } = sidebar();
	const view = plugin._views.get(root);
	plugin.showPending(view, {
		question: "And the inverse?", backend: "claude", startedAt: Date.now(), partial: "## Why roots of unity\n\nBecause.", status: "writing",
		listeners: new Set(), promise: new Promise(() => {}), steps: [], images: [], modes: [],
	});
	// Headings, lists, tables and code are styled under .zs-rich, which the finished answer
	// carries: without it they were plain text until the answer ended, and then jumped.
	const heading = root.querySelector(".zs-live .zs-h2");
	// The live answer counts its seconds on a timer, which would keep the test process alive.
	window.close();
	assert.equal(heading.textContent, "Why roots of unity");
	assert.ok(heading.closest(".zs-rich"));
});
