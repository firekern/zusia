var checks = [];
function check(name, ok) { checks.push({ name, ok: !!ok }); }
async function run() {
	let out = Zotero.Prefs.get("extensions.zusia-api-probe.out", true);
	try {
		await IOUtils.writeUTF8(PathUtils.join(out, "probe-started.json"), JSON.stringify({ stage: "waiting for Zotero UI" }));
		await Zotero.uiReadyPromise;
		for (let i = 0; !Zotero.Zusia && i < 200; i++) await Zotero.Promise.delay(100);
		let CS = Zotero.Zusia;
		if (!CS) throw new Error("Packaged plugin did not start");
		check("packaged plugin starts", true);
		let config = { baseURL: Zotero.Prefs.get("extensions.zusia-api-probe.url", true), auth: "none", contextTokens: 32768,
			outputTokens: 2048, tools: false, vision: false, stream: true, capabilityModel: "smoke-model" };
		CS.setPref("openai.api", JSON.stringify(config));
		CS.setPref("openai.model", "smoke-model");
		let models = await CS.loadAPIModels("openai");
		check("native Zotero HTTP discovers model ids", models.some(m => m.id === "smoke-model"));
		let request = { ctx: { dir: out }, question: "Explain attention", history: [], session: null, model: "smoke-model", images: [],
			files: { metadata: "# Native smoke test", annotations: "", fullText: { status: "ok", paged: true,
				pages: ["Attention uses queries, keys and values. ".repeat(30)] }, focus: [0], query: "attention" },
			onSpawn() {}, onProgress() {} };
		let result = await CS.runBackend("openai", request);
		check("native SSE parser receives fragmented UTF-8 answer", result.text === "Verified café (p. 1)");
		if (result.error) throw new Error(result.error);
		config.tools = true;
		let withTools = await CS.runBackend("openai", { ...request, apiConfig: config });
		check("native agent executes a document tool and returns its result", withTools.text === "Tool verified (p. 1)");
		if (withTools.error) throw new Error(withTools.error);
		let json = await CS.runBackend("unsloth", { ...request, apiConfig: { ...config, tools: false, stream: false } });
		check("non-streaming Unsloth preset works with server tools disabled", json.text === "JSON verified");
		let stopped = false, kill;
		let cancelled = await CS.runBackend("openai", { ...request, model: "cancel-model", onSpawn: handle => { kill = () => handle.kill(); },
			onProgress: update => { if (update.text && !stopped) { stopped = true; kill(); } } });
		check("Stop aborts the native HTTP stream", stopped && !!cancelled.error);
		let doc = Zotero.getMainWindow().document;
		let panel = CS.buildAPIAssistant(doc, "openai");
		check("API settings render in native Gecko", panel.querySelectorAll("input").length === 5 && panel.querySelectorAll('[role="switch"]').length === 4);
		await CS.setAPIKey("openai", config, "native-test-key-one");
		await CS.setAPIKey("openai", config, "native-test-key-two");
		check("native credential replacement works", await CS.getAPIKey("openai", config) === "native-test-key-two");
		await CS.setAPIKey("openai", config, "");
		check("native credential removal works", await CS.getAPIKey("openai", config) === "");
		CS.setPref("ollama.model", "smoke-model");
		let ollama = { ...config, tools: false, profiles: {} };
		CS.setPref("ollama.api", JSON.stringify(ollama));
		let native = await CS.runBackend("ollama", request);
		check("native Ollama NDJSON handles fragmented UTF-8", native.text === "Profilo caffè verificato");
		let runtime = CS._apiRuntimeProfiles.get(CS.apiProfileKey(ollama, "smoke-model"));
		check("Ollama provider profile reads actual context and quantization", runtime.contextTokens === 16384 && runtime.quantization === "Q4_K_M");
		ollama.tools = true;
		ollama.profiles[CS.apiProfileKey(ollama, "smoke-model")] = { mode: "custom", overrides: { contextTokens: 32768, temperature: 0.2 } };
		CS.setPref("ollama.api", JSON.stringify(ollama));
		let custom = await CS.runBackend("ollama", request);
		check("native Ollama context override and document tool loop work", custom.text === "Profilo caffè verificato" && CS._apiRuntimeProfiles.get(CS.apiProfileKey(ollama, "smoke-model")).contextTokens === 32768);
		let nativePanel = CS.buildAPIAssistant(doc, "ollama");
		check("provider profile controls render in native Gecko", !!nativePanel.querySelector(".zs-api-profile") && !nativePanel.querySelector(".zs-api-profile-overrides").hidden);
		for (let backend of ["unsloth", "ollama"]) {
			let svg = await CS.loadIcon(doc, CS.BACKEND_ICONS[backend]);
			check(backend + " provider icon loads from the packaged XPI", svg?.localName === "svg" && svg.childElementCount > 0);
		}
	}
	catch (e) { checks.push({ name: String(e), ok: false, stack: e.stack }); }
	await IOUtils.writeUTF8(PathUtils.join(out, "results.json"), JSON.stringify({ checks }, null, 2));
	Zotero.Utilities.Internal.quit();
}
function startup() { run(); }
function shutdown() {}
function install() {}
function uninstall() {}
