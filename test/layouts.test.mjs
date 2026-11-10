import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPlugin } from "./load-plugin.mjs";

const PREFIX = "extensions.zusia.";

function sidebar(prefs = {}, { dock = false } = {}) {
	const env = loadPlugin({ prefs: { [PREFIX + "onboarded"]: true, ...prefs } });
	const { plugin, document } = env;
	const body = document.createElement("div");
	body.className = dock ? "zs-dock" : "";
	document.body.appendChild(body);
	plugin.renderSkeleton(document, body);
	const root = body.querySelector(".zs-root");
	plugin._views.set(root, { doc: document, root, ctx: { dir: "/tmp/x" }, logEl: root.querySelector(".zs-log"), input: root.querySelector(".zs-input"), send() {} });
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
