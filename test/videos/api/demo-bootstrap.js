// Backend-only setup for a separate documentation profile. All walkthrough UI
// interactions and captures are performed with the official Computer Use API.
async function startup() {
	await Zotero.uiReadyPromise;
	for (let i = 0; !Zotero.Zusia && i < 200; i++) await Zotero.Promise.delay(100);
	let CS = Zotero.Zusia;
	if (!CS) throw new Error("Zusia did not start in the documentation profile");
	let key = Services.env.get("ZUSIA_LIVE_KEY"); Services.env.set("ZUSIA_LIVE_KEY", "");
	let config = { baseURL: "http://127.0.0.1:8888/v1", auth: "bearer", outputTokens: 1024,
		contextTokens: 32768, profiles: {}, capabilities: {}, stream: true };
	CS._apiKeys = new Map([[CS.apiCredentialRealm("unsloth", config), key]]); key = "";
	CS.setPref("unsloth.api", JSON.stringify(config));
	CS.setAPIModel("unsloth", "unsloth/gemma-4-E2B-it-GGUF");
	CS.setPref("unsloth.effort", "thinking:false");
	CS.setPref("backend", "unsloth");
	let ollamaURL = Services.env.get("ZUSIA_DEMO_OLLAMA_URL"); Services.env.set("ZUSIA_DEMO_OLLAMA_URL", "");
	if (ollamaURL) CS.setPref("ollama.api", JSON.stringify({ baseURL: ollamaURL, auth: "none", outputTokens: 1024, profiles: {}, capabilities: {}, stream: true }));
	CS.setPref("language", "en");
	CS.setPref("memory.consolidate", false);
	CS.setPref("memory.gists", false);
	let items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
	let item = items.find(i => i.isRegularItem() && i.getField("title") === "A short note on attention - synthetic study material");
	if (!item) {
		item = new Zotero.Item("document");
		item.libraryID = Zotero.Libraries.userLibraryID;
		item.setField("title", "A short note on attention - synthetic study material");
		item.setField("date", "2026-11-15");
		item.setCreators([{ firstName: "Zusia", lastName: "demo", creatorType: "author" }]);
		await item.saveTx();
		await Zotero.Attachments.importFromFile({ file: Zotero.Prefs.get("extensions.zusia-demo.pdf", true), parentItemID: item.id });
	}
	item.setField("abstractNote", "Original two-page demo material about attention and context budgeting. Read the PDF for the worked example and document-tool verification code. This is synthetic documentation data.");
	await item.saveTx();
	Services.prefs.savePrefFile(null);
}
function shutdown() { Zotero.Zusia?._apiKeys?.clear(); }
function install() {}
function uninstall() {}
