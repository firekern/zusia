import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("placement: the chat is a panel on the right by default, and no item pane section is registered", () => {
	const { plugin, document, state, dock } = mainWindow();
	plugin.applyPlacement();
	assert.ok(dock(), "the dock is in the window");
	assert.equal(plugin.placement(), "right");
	assert.equal(dock().previousElementSibling, document.getElementById("appcontent"), "right of Zotero's own content");
	assert.equal(dock().dataset.side, "right");
	assert.equal(state.sections, 0);
	assert.equal(document.documentElement.getAttribute("zs-dock"), "open");
	assert.ok(dock().querySelector(".zs-root .zs-input"), "the chat is rendered in it");
	assert.equal(dock().style.width, "380px");
	assert.equal(document.querySelector("item-details").hasAttribute("zs-chat-ready"), false,
		"the item pane's chat view no longer hides Zotero's sections");
});

test("placement: the default Zotero is given is the one the plugin falls back to", () => {
	// Zotero reads src/prefs.js, which these tests never load: the two must not drift apart.
	const defaults = readFileSync(new URL("../src/prefs.js", import.meta.url), "utf8");
	const { plugin } = mainWindow();
	assert.equal(defaults.match(/pref\("extensions\.zusia\.placement", "(\w+)"\)/)[1], plugin.placement());
});

test("placement: 'left' puts the panel on the other side, and switching sides moves the same chat", () => {
	const { plugin, document, state, shown, dock, prefs } = mainWindow({ [PREFIX + "placement"]: "left" });
	plugin.applyPlacement();
	const content = document.getElementById("appcontent");
	assert.equal(dock().nextElementSibling, content, "left of Zotero's own content");
	assert.equal(dock().dataset.side, "left");
	const box = dock();
	const rendered = shown.length;
	plugin.setPlacement("right");
	assert.equal(prefs[PREFIX + "placement"], "right");
	assert.equal(dock(), box, "the panel is moved, not rebuilt");
	assert.equal(box.previousElementSibling, content);
	assert.equal(box.dataset.side, "right");
	assert.equal(shown.length, rendered, "the conversation is not rendered again");
	assert.equal(state.sections, 0);
	assert.equal(document.querySelectorAll("#zusia-dock").length, 1);
});

test("dragging the edge of a panel on the right widens it towards the left", () => {
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
	pointer("pointerdown", 1000);
	pointer("pointermove", 940);
	assert.equal(dock().style.width, "440px");
	pointer("pointermove", 1060);
	assert.equal(dock().style.width, "320px");
	pointer("pointerup", 1060);
	assert.equal(prefs[PREFIX + "dockWidth"], 320);
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
	const { plugin, window, dock, prefs } = mainWindow({ [PREFIX + "placement"]: "left" });
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

test("the dock follows Zotero's panes being collapsed or dragged, without a window resize", async () => {
	const { plugin, window, document, dock } = mainWindow();
	Object.defineProperty(window, "innerWidth", { value: 1180, configurable: true });
	plugin.applyPlacement();
	assert.equal(dock().classList.contains("zs-dock-drawer"), true);
	// What Zotero writes when the item pane is collapsed.
	document.documentElement.style.setProperty("--width-of-fixed-components", "237px");
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(dock().classList.contains("zs-dock-drawer"), false);
	plugin.removePlacement();
	document.documentElement.style.setProperty("--width-of-fixed-components", "557px");
	await new Promise(resolve => setTimeout(resolve, 0));
});

test("someone who updates is told once where the chat went, and can send it back", () => {
	const { plugin, dock, prefs, state } = mainWindow();
	plugin.applyPlacement();
	const tip = () => dock()?.querySelector(".zs-dock-tip");
	assert.match(tip().textContent, /its own panel here.*Alt\+Z hides it/);
	assert.equal(tip().nextElementSibling, dock().querySelector(".zs-dock-body"), "above the chat");
	plugin.updateDocks();
	assert.equal(dock().querySelectorAll(".zs-dock-tip").length, 1);
	const [gotIt, back] = tip().querySelectorAll("button");
	gotIt.click();
	assert.equal(prefs[PREFIX + "dockTipSeen"], true);
	assert.equal(tip(), null);

	prefs[PREFIX + "dockTipSeen"] = false;
	plugin.updateDocks();
	assert.equal(back.textContent, "Back to the item pane");
	tip().querySelectorAll("button")[1].click();
	assert.equal(prefs[PREFIX + "placement"], "pane");
	assert.equal(dock(), null);
	assert.equal(state.sections, 1);
});

test("a new user gets the setup wizard, not the note, and finishing it counts as having read it", () => {
	const { plugin, dock, prefs } = mainWindow({ [PREFIX + "onboarded"]: false });
	plugin.applyPlacement();
	assert.equal(dock().querySelector(".zs-dock-tip"), null);
	assert.ok(dock().querySelector(".zs-wizard"));
	plugin.finishWizard(dock().querySelector(".zs-root"));
	plugin.updateDocks();
	assert.equal(prefs[PREFIX + "dockTipSeen"], true);
	assert.equal(dock().querySelector(".zs-dock-tip"), null);
});

test("a dock made before Zotero has built its items tree still ends up following the selection", async () => {
	const { plugin, window, state, shown } = mainWindow();
	const itemsView = window.ZoteroPane.itemsView;
	// As when a window is still loading: no items tree yet.
	window.ZoteroPane.itemsView = undefined;
	plugin.applyPlacement();
	assert.equal(state.listeners.size, 0);
	window.ZoteroPane.itemsView = itemsView;
	await new Promise(resolve => setTimeout(resolve, 320));
	assert.equal(state.listeners.size, 1, "the wait for the tree outlives the dock's first render");
	state.selected = [paper(7)];
	for (const listener of state.listeners) {
		listener();
	}
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(shown.at(-1), 7);
	plugin.removePlacement();
});

test("on a Mac, Option+Z typed into a text field stays a character and does not toggle the dock", () => {
	const { plugin, window, document, dock, prefs } = mainWindow();
	plugin.applyPlacement();
	const press = (target) => {
		const event = new window.KeyboardEvent("keydown", { code: "KeyZ", key: "ż", altKey: true, bubbles: true, cancelable: true });
		target.dispatchEvent(event);
		return event.defaultPrevented;
	};
	const field = dock().querySelector(".zs-input");
	window.Zotero.isMac = true;
	assert.equal(press(field), false, "the message box keeps the key");
	assert.notEqual(prefs[PREFIX + "dockOpen"], false);
	assert.equal(press(document.body), true, "anywhere else it is the shortcut");
	assert.equal(prefs[PREFIX + "dockOpen"], false);
	window.Zotero.isMac = false;
	plugin.setDockOpen(true);
	assert.equal(press(field), true, "elsewhere Alt types nothing, so the field gives the key up");
	plugin.removePlacement();
});

test("the selection listener hands Zotero nothing to wait for", () => {
	// Zotero awaits each select listener before the next, and before selectItem() returns:
	// a promise that lasts as long as an answer being written would hold all of that up.
	const { plugin, state } = mainWindow();
	plugin.renderContent = () => new Promise(() => {});
	plugin.applyPlacement();
	state.selected = [paper(1)];
	for (const listener of state.listeners) {
		assert.equal(listener(), undefined);
	}
	plugin.removePlacement();
});

test("a drag past either limit saves the width that was shown, and ends when the capture is lost", () => {
	const { plugin, window, dock, prefs } = mainWindow({ [PREFIX + "placement"]: "left" });
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
	pointer("pointermove", 3000);
	pointer("pointerup", 3000);
	assert.equal(prefs[PREFIX + "dockWidth"], 473, "not the 2880 the pointer asked for");
	pointer("pointerdown", 500);
	pointer("pointermove", 0);
	pointer("pointerup", 0);
	assert.equal(prefs[PREFIX + "dockWidth"], 280);

	// Another app comes to the front mid-drag: no pointerup ever arrives.
	pointer("pointerdown", 500);
	pointer("pointermove", 520);
	pointer("lostpointercapture", 520);
	assert.equal(dock().classList.contains("zs-dock-resizing"), false);
	assert.equal(prefs[PREFIX + "dockWidth"], 400);
	pointer("pointermove", 700);
	assert.equal(dock().style.width, "400px", "hovering the grip afterwards moves nothing");
	plugin.removePlacement();
});

test("when Zotero rebuilds its items tree the dock listens to the new one", async () => {
	const { plugin, window, state, shown } = mainWindow();
	plugin.applyPlacement();
	const fresh = new Set();
	const old = window.ZoteroPane.itemsView;
	window.ZoteroPane.itemsView = { onSelect: { addListener: fn => fresh.add(fn), removeListener: fn => fresh.delete(fn) } };
	// The next thing that makes the dock look again, here a tab change.
	for (const observer of state.observers) {
		observer.notify("select", "tab", ["zotero-pane"]);
	}
	assert.equal(state.listeners.size, 0, "off the old tree");
	assert.equal(fresh.size, 1);
	state.selected = [paper(5)];
	for (const listener of fresh) {
		listener();
	}
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(shown.at(-1), 5);
	plugin.removePlacement();
	assert.equal(fresh.size, 0);
	window.ZoteroPane.itemsView = old;
});

test("finishing the setup wizard never flashes the note meant for people who update", () => {
	const { plugin, dock, prefs } = mainWindow({ [PREFIX + "onboarded"]: false });
	plugin.applyPlacement();
	// Zotero calls a pref's observers as it is set; this one redraws every chat and the dock.
	const { setPref } = plugin;
	const tips = [];
	plugin.setPref = (name, value) => {
		setPref.call(plugin, name, value);
		if (name === "onboarded") {
			plugin.refreshAllSidebars();
			tips.push(!!dock().querySelector(".zs-dock-tip"));
		}
	};
	plugin.finishWizard(dock().querySelector(".zs-root"));
	assert.deepEqual(tips, [false]);
	assert.equal(prefs[PREFIX + "dockTipSeen"], true);
	plugin.removePlacement();
});
