var Zusia;
var ZusiaMap;

function log(msg) {
	Zotero.debug("[zusia] " + msg);
}

function install() {
	log("Installed");
}

async function startup({ id, version, rootURI }) {
	log("Starting up, rootURI=" + rootURI);

	// The reading map is pure functions that zusia.js calls, so it loads first.
	Services.scriptloader.loadSubScript(rootURI + "content/readingmap.js");
	Services.scriptloader.loadSubScript(rootURI + "content/zusia.js");
	for (let name of Zusia.MODULES) {
		Services.scriptloader.loadSubScript(rootURI + "content/modules/" + name + ".js");
	}
	Zusia.init({ id, version, rootURI });
	// The settings pane runs in the Settings window and reaches the plugin through Zotero.
	Zotero.Zusia = Zusia;
	Zusia.addToAllWindows();
	Zusia.applyPlacement();
	// Zotero removes the reader listeners itself when the plugin shuts down.
	Zusia.registerReaderHooks();
	Zusia.watchPrefs();
	Zusia.watchReading();
	await Zusia.registerPrefsPane();

	log("Startup complete");
}

function onMainWindowLoad({ window }) {
	Zusia.addToWindow(window);
	if (Zusia.placement() === "left") {
		Zusia.addDock(window);
	}
}

function onMainWindowUnload({ window }) {
	Zusia.removeDock(window);
	Zusia.removeFromWindow(window);
}

function shutdown() {
	log("Shutting down");
	if (!Zusia) {
		return;
	}
	// Before the pane goes: closing it would queue memory jobs for the papers it showed.
	Zusia.stopJobs();
	Zusia.unwatchPrefs();
	Zusia.unwatchReading();
	Zusia.removePlacement();
	Zusia.removeFromAllWindows();
	delete Zotero.Zusia;
	Zusia = undefined;
	ZusiaMap = undefined;
}

function uninstall() {
	log("Uninstalled");
}
