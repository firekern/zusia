import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const PREFIX = "extensions.zusia.";

const paper = (id, extra = {}) => ({ id, isRegularItem: () => true, isFileAttachment: () => false, ...extra });
const pdf = (id, parentItem) => ({ id, parentItem, isRegularItem: () => false, isAttachment: () => true, isFileAttachment: () => true });
const note = id => ({ id, isRegularItem: () => false, isFileAttachment: () => false });

// Zotero's main window, reduced to what the dock touches: the row holding the app content,
// the tabs, the library selection, the readers and the tab notifier.
function mainWindow(prefs = {}) {
	const env = loadPlugin({ prefs: { [PREFIX + "onboarded"]: true, ...prefs } });
	const { window, document, plugin } = env;
	document.body.innerHTML = '<div id="browser"><div id="appcontent"><item-details zs-chat-ready=""></item-details></div></div>';
	Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
	const state = { tab: "library", selected: [], readers: new Map(), items: new Map(), sections: 0, observers: [], listeners: new Set() };
	window.Zotero_Tabs = {
		get selectedType() { return state.tab === "library" ? "library" : "reader"; },
		get selectedID() { return state.tab; },
	};
	window.ZoteroPane = {
		getSelectedItems: () => state.selected,
		itemsView: { onSelect: { addListener: fn => state.listeners.add(fn), removeListener: fn => state.listeners.delete(fn) } },
	};
	window.ZoteroContextPane = { collapsed: true, toggled: 0, togglePane() { this.toggled++; } };
	window.Zotero.Reader = { getByTabID: id => state.readers.get(id) || null, _readers: [] };
	window.Zotero.Items = { get: id => state.items.get(id) };
	window.Zotero.Notifier = {
		registerObserver: (observer) => { state.observers.push(observer); return "tab-observer"; },
		unregisterObserver: () => { state.observers.length = 0; },
	};
	window.Zotero.ItemPaneManager = {
		registerSection: () => { state.sections++; return "zusia-section"; },
		unregisterSection: () => { state.sections--; },
	};
	// What the dock asked the chat to show, in order.
	const shown = [];
	plugin.renderContent = async (doc, body, item) => { shown.push(item ? item.id : null); };
	plugin.leavePaper = (dir) => { state.left = dir; };
	const select = async (...items) => {
		state.selected = items;
		for (const listener of state.listeners) {
			listener();
		}
		await new Promise(resolve => setTimeout(resolve, 0));
	};
	const openReader = async (tabID, attachment) => {
		state.items.set(attachment.id, attachment);
		state.readers.set(tabID, { itemID: attachment.id, type: "pdf", _window: window });
		state.tab = tabID;
		for (const observer of state.observers) {
			observer.notify("select", "tab", [tabID]);
		}
		await new Promise(resolve => setTimeout(resolve, 0));
	};
	return { ...env, state, shown, select, openReader, dock: () => document.getElementById("zusia-dock") };
}

test("placement: the chat is a panel on the left by default, and no item pane section is registered", () => {
	const { plugin, document, state, dock } = mainWindow();
	plugin.applyPlacement();
	assert.ok(dock(), "the dock is in the window");
	assert.equal(dock().nextElementSibling, document.getElementById("appcontent"), "left of Zotero's own content");
	assert.equal(state.sections, 0);
	assert.equal(document.documentElement.getAttribute("zs-dock"), "open");
	assert.ok(dock().querySelector(".zs-root .zs-input"), "the chat is rendered in it");
	assert.equal(dock().style.width, "380px");
	assert.equal(document.querySelector("item-details").hasAttribute("zs-chat-ready"), false,
		"the item pane's chat view no longer hides Zotero's sections");
});

test("placement: 'pane' keeps the chat in Zotero's item pane, and switching moves it", () => {
	const { plugin, state, dock, prefs } = mainWindow({ [PREFIX + "placement"]: "pane" });
	plugin.applyPlacement();
	assert.equal(dock(), null);
	assert.equal(state.sections, 1);
	plugin.setPlacement("left");
	assert.ok(dock());
	assert.equal(state.sections, 0);
	assert.equal(state.observers.length, 1, "tab changes are followed");
	plugin.setPlacement("pane");
	assert.equal(prefs[PREFIX + "placement"], "pane");
	assert.equal(dock(), null);
	assert.equal(state.sections, 1);
	assert.equal(state.observers.length, 0);
	assert.equal(state.listeners.size, 0, "the selection listener is gone with the dock");
});

test("the dock follows the library's selection and the reader tab, and keeps its paper otherwise", async () => {
	const { plugin, shown, select, openReader, state } = mainWindow();
	plugin.applyPlacement();
	await select();
	assert.deepEqual(shown, [null], "nothing selected yet: the chat asks for a paper");
	const first = paper(1);
	await select(first);
	assert.deepEqual(shown, [null, 1]);
	await select();
	await select(first, paper(2));
	await select(note(9));
	assert.deepEqual(shown, [null, 1], "an empty, multiple or note selection leaves the chat on its paper");
	await select(first);
	assert.deepEqual(shown, [null, 1], "the same paper is not rendered again");
	const second = paper(2);
	await openReader("tab-2", pdf(20, second));
	assert.deepEqual(shown, [null, 1, 20], "a reader tab shows its paper");
	state.tab = "library";
	await select(second);
	assert.deepEqual(shown, [null, 1, 20], "the paper in the reader and in the library is one chat");
});

test("the dock hides to a rail with its header button and comes back from the rail", () => {
	const { plugin, document, dock, prefs } = mainWindow();
	plugin.applyPlacement();
	dock().querySelector(".zs-dock-hide").click();
	assert.equal(prefs[PREFIX + "dockOpen"], false);
	assert.equal(document.documentElement.getAttribute("zs-dock"), "closed");
	assert.equal(dock().querySelector(".zs-dock-body").hidden, true);
	assert.equal(dock().querySelector(".zs-dock-rail").hidden, false);
	assert.equal(dock().style.width, "", "the rail takes its own width");
	dock().querySelector(".zs-dock-open").click();
	assert.equal(prefs[PREFIX + "dockOpen"], true);
	assert.equal(dock().querySelector(".zs-dock-body").hidden, false);
	assert.equal(dock().querySelector(".zs-dock-rail").hidden, true);
});

test("a closed dock renders nothing until it is opened", async () => {
	const { plugin, shown, select, dock } = mainWindow({ [PREFIX + "dockOpen"]: false });
	plugin.applyPlacement();
	await select(paper(1));
	assert.deepEqual(shown, []);
	dock().querySelector(".zs-dock-open").click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(shown, [1]);
});

test("dragging the dock's edge resizes it within its limits and remembers the width", () => {
	const { plugin, window, dock, prefs } = mainWindow();
	plugin.applyPlacement();
	const resizer = dock().querySelector(".zs-dock-resizer");
	resizer.setPointerCapture = () => {};
	dock().getBoundingClientRect = () => ({ width: 380 });
	const pointer = (type, screenX) => {
		const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, screenX });
		event.pointerId = 1;
		resizer.dispatchEvent(event);
	};
	pointer("pointerdown", 500);
	pointer("pointermove", 560);
	assert.equal(dock().style.width, "440px");
	pointer("pointermove", 100);
	assert.equal(dock().style.width, "280px", "never narrower than the composer needs");
	pointer("pointermove", 2000);
	assert.equal(dock().style.width, "473px", "the library's panes keep the 927px they need of a 1400px window");
	pointer("pointermove", 560);
	pointer("pointerup", 560);
	assert.equal(prefs[PREFIX + "dockWidth"], 440);
	assert.equal(dock().style.width, "440px");
	pointer("pointermove", 900);
	assert.equal(dock().style.width, "440px", "the drag ended with the release");
	resizer.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
	assert.equal(prefs[PREFIX + "dockWidth"], 380, "a double click puts the width back");
});

test("Ask Zusia from the reader opens the dock and leaves Zotero's context pane alone", async () => {
	const { plugin, window, openReader, dock, prefs } = mainWindow({ [PREFIX + "dockOpen"]: false });
	plugin.applyPlacement();
	const attachment = pdf(20, paper(2, { libraryID: 1, key: "PAPER" }));
	attachment.libraryID = 1;
	attachment.key = "PDF";
	await openReader("tab-2", attachment);
	window.Zotero.DataDirectory = { dir: "/data" };
	plugin.askAboutSelection(window.Zotero.Reader.getByTabID("tab-2"), { text: "a passage", pageLabel: "3" }, false);
	assert.equal(prefs[PREFIX + "dockOpen"], true);
	assert.equal(dock().querySelector(".zs-dock-body").hidden, false);
	assert.equal(window.ZoteroContextPane.toggled, 0);
});

test("closing a window or shutting down takes the dock away and folds the chat into the paper's memory", () => {
	const { plugin, window, document, dock, state } = mainWindow();
	plugin.applyPlacement();
	plugin._shownDirs.set(dock().querySelector(".zs-dock-body"), "/data/zusia/1-PAPER");
	plugin.removePlacement();
	assert.equal(dock(), null);
	assert.equal(document.documentElement.hasAttribute("zs-dock"), false);
	assert.equal(state.left, "/data/zusia/1-PAPER");
	assert.equal(state.listeners.size, 0);
	assert.equal(plugin._docks.has(window), false);
});

test("Alt+Z shows and hides the dock from anywhere in the window, and nothing else does", () => {
	const { plugin, window, document, dock, prefs } = mainWindow();
	plugin.applyPlacement();
	const press = (init) => {
		const event = new window.KeyboardEvent("keydown", { code: "KeyZ", key: "z", altKey: true, bubbles: true, cancelable: true, ...init });
		document.body.dispatchEvent(event);
		return event;
	};
	assert.equal(press().defaultPrevented, true, "so macOS does not type the Option character");
	assert.equal(prefs[PREFIX + "dockOpen"], false);
	assert.equal(dock().querySelector(".zs-dock-body").hidden, true);
	press();
	assert.equal(prefs[PREFIX + "dockOpen"], true);
	for (const other of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { code: "KeyX" }]) {
		assert.equal(press(other).defaultPrevented, false, JSON.stringify(other));
	}
	assert.equal(prefs[PREFIX + "dockOpen"], true);
	assert.match(dock().querySelector(".zs-dock-hide").title, /^Hide Zusia \(Alt\+Z\)$/);
	assert.match(dock().querySelector(".zs-dock-open").title, /^Show Zusia \(Alt\+Z\)$/);
	plugin.removePlacement();
	press();
	assert.equal(prefs[PREFIX + "dockOpen"], true, "the shortcut goes with the dock");
});

test("the rail wears the buddy and the accent chosen in Settings", () => {
	const { plugin, dock } = mainWindow();
	plugin.applyPlacement();
	const icon = () => dock().querySelector(".zs-dock-open .zs-i").dataset.icon;
	assert.equal(icon(), "cat");
	assert.equal(dock().style.getPropertyValue("--zs-accent"), "var(--accent-blue)");
	plugin.saveAppearance({ ...plugin.getAppearance(), mascot: "robot", accent: "#6d4fd6" });
	plugin.refreshAllSidebars();
	assert.equal(icon(), "robot");
	assert.equal(dock().querySelectorAll(".zs-dock-open").length, 1);
	assert.equal(dock().style.getPropertyValue("--zs-accent"), "#6d4fd6");
});

test("setup wizard: its last step says how to show and hide the panel, only where there is one", () => {
	const { plugin, dock, document } = mainWindow();
	plugin.applyPlacement();
	const step = plugin.wizardStep(dock().querySelector(".zs-root"), "done");
	assert.equal(step.querySelector(".zs-wizard-tip").textContent, "Alt+Z shows and hides this panel.");
	const body = document.createElement("div");
	document.body.appendChild(body);
	plugin.renderSkeleton(document, body);
	assert.equal(plugin.wizardStep(body.querySelector(".zs-root"), "done").querySelector(".zs-wizard-tip"), null);
});

test("the dock never pushes Zotero's panes out of the window: it narrows, then becomes a drawer over them", () => {
	const { plugin, window, document, dock, state, prefs } = mainWindow();
	const resizeTo = (width) => {
		Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
		window.dispatchEvent(new window.Event("resize"));
	};
	plugin.applyPlacement();
	assert.equal(dock().style.width, "380px");
	assert.equal(dock().classList.contains("zs-dock-drawer"), false);

	resizeTo(1280);
	assert.equal(dock().style.width, "353px", "a 13-inch laptop: the room left beside collections, items and item pane");
	assert.equal(prefs[PREFIX + "dockWidth"], undefined, "the width you chose is kept for a wider window");
	assert.equal(dock().classList.contains("zs-dock-drawer"), false);

	resizeTo(1180);
	assert.equal(dock().classList.contains("zs-dock-drawer"), true, "not even 280px of room: it lies over the library");
	assert.equal(dock().style.width, "380px");

	// Zotero says what its fixed panes take; with the item pane collapsed that is less.
	document.documentElement.style.setProperty("--width-of-fixed-components", "237px");
	resizeTo(1180);
	assert.equal(dock().classList.contains("zs-dock-drawer"), false);
	assert.equal(dock().style.width, "380px");
	document.documentElement.style.removeProperty("--width-of-fixed-components");

	state.tab = "tab-2";
	resizeTo(960);
	assert.equal(dock().classList.contains("zs-dock-drawer"), false, "a reader shrinks further than the library");
	assert.equal(dock().style.width, "360px");

	resizeTo(700);
	assert.equal(dock().classList.contains("zs-dock-drawer"), true);
	plugin.setDockOpen(false);
	assert.equal(dock().classList.contains("zs-dock-drawer"), false, "the rail is never a drawer");
	plugin.removePlacement();
	resizeTo(1400);
});
