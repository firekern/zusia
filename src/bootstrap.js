var Zusia;

function log(msg) {
	Zotero.debug("[zusia] " + msg);
}

function install() {
	log("Installed");
}

async function startup({ id, version, rootURI }) {
	log("Starting up, rootURI=" + rootURI);

	Services.scriptloader.loadSubScript(rootURI + "content/zusia.js");
	Zusia.init({ id, version, rootURI });
	// The settings pane runs in the Settings window and reaches the plugin through Zotero.
	Zotero.Zusia = Zusia;
	Zusia.addToAllWindows();
	Zusia.registerPaneSection();
	// Zotero removes the reader listeners itself when the plugin shuts down.
	Zusia.registerReaderHooks();
	Zusia.watchPrefs();
	await Zusia.registerPrefsPane();

	log("Startup complete");
}

function onMainWindowLoad({ window }) {
	Zusia.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	Zusia.removeFromWindow(window);
}

function shutdown() {
	log("Shutting down");
	if (!Zusia) {
		return;
	}
	Zusia.unwatchPrefs();
	Zusia.unregisterPaneSection();
	Zusia.removeFromAllWindows();
	delete Zotero.Zusia;
	Zusia = undefined;
}

function uninstall() {
	log("Uninstalled");
}
