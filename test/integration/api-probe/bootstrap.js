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
		let phase = Zotero.Prefs.get("extensions.zusia-api-probe.phase", true);
		if (phase === "upgrade-seed" || phase === "upgrade") {
			let snapshotPath = PathUtils.join(out, "upgrade-snapshot.json"), historyPath = PathUtils.join(out, "upgrade-chat.json");
			let key = "synthetic-upgrade-key", config = { baseURL: Zotero.Prefs.get("extensions.zusia-api-probe.url", true), auth: "bearer",
				contextTokens: 32768, outputTokens: 2048, profiles: {}, stream: false };
			let scope = CS.apiProfileKey(config, "smoke-model");
			config.profiles[scope] = { mode: "custom", overrides: { contextTokens: 32768, temperature: 0.2 } };
			if (phase === "upgrade-seed") {
				CS.setPref("unsloth.api", JSON.stringify(config)); CS.setAPIModel("unsloth", "smoke-model");
				CS.setPref("backend", "unsloth"); CS.setPref("unsloth.effort", "thinking:false");
				let credentialMode = await CS.setAPIKey("unsloth", config, key);
				await IOUtils.writeUTF8(historyPath, JSON.stringify([{ role: "user", text: "Synthetic upgrade history" }, { role: "assistant", text: "Preserved answer" }]));
				await IOUtils.writeUTF8(snapshotPath, JSON.stringify({ version: CS.version, credentialMode }));
				Services.prefs.savePrefFile(null);
				await IOUtils.writeUTF8(PathUtils.join(out, "upgrade-seed-results.json"), JSON.stringify({ checks: [{ name: "previous package seeds a real Zotero profile", ok: true }], version: CS.version }));
			}
			else {
				let snapshot = JSON.parse(await IOUtils.readUTF8(snapshotPath));
				check("upgrade runs a different packaged version", CS.version !== snapshot.version);
				check("upgrade preserves assistant and scoped model selection", CS.getPref("backend") === "unsloth" && CS.getModel("unsloth") === "smoke-model");
				let restored = CS.getAPIConfig("unsloth");
				check("upgrade preserves endpoint and custom provider profile", restored.baseURL === config.baseURL && restored.auth === "bearer" && JSON.stringify(restored.profiles) === JSON.stringify(config.profiles));
				check("upgrade preserves cold reasoning preference", CS.getEffort("unsloth", { deferCapabilities: true }) === "thinking:false");
				let history = JSON.parse(await IOUtils.readUTF8(historyPath));
				check("upgrade preserves synthetic chat history", history[0].text === "Synthetic upgrade history" && history[1].text === "Preserved answer");
				let restoredKey = await CS.getAPIKey("unsloth", config), persistent = snapshot.credentialMode.includes("OS key store");
				check("upgrade follows the advertised credential persistence mode", persistent ? restoredKey === key : restoredKey === "" && snapshot.credentialMode.includes("after restarting"));
				if (!persistent) await CS.setAPIKey("unsloth", config, key);
				let response = await CS.runBackend("unsloth", { model: CS.getModel("unsloth"), effort: CS.getEffort("unsloth", { deferCapabilities: true }), messages: [{ role: "user", content: "Upgrade authentication probe" }] });
				check("upgraded package authenticates and answers", !response.error && response.text === "JSON verified");
				await CS.setAPIKey("unsloth", config, "");
				await IOUtils.writeUTF8(PathUtils.join(out, "upgrade-results.json"), JSON.stringify({ checks, from: snapshot.version, to: CS.version, credentialMode: snapshot.credentialMode }, null, 2));
			}
			Zotero.Utilities.Internal.quit(); return;
		}
		if (Zotero.Prefs.get("extensions.zusia-api-probe.phase", true) === "restart") {
			check("scoped model selection survives a native Zotero restart", CS.getModel("unsloth") === "smoke-model");
			CS._apiCapabilities?.clear();
			let effort = CS.getEffort("unsloth", { deferCapabilities: true });
			check("saved reasoning survives restart before capability discovery", effort === "thinking:false" && CS.getEffort("unsloth") === "");
			let response = await CS.runBackend("unsloth", { model: CS.getModel("unsloth"), effort, messages: [{ role: "user", content: "Restart probe" }], onProgress() {}, onSpawn() {} });
			check("restored native connection generates after restart", response.text === "JSON verified" && response.metrics?.budgetSource === "provider tokenizer");
			check("saved Thinking off is applied on the first native request", response.text === "JSON verified" && !response.error);
			await IOUtils.writeUTF8(PathUtils.join(out, "restart-results.json"), JSON.stringify({ checks }, null, 2));
			Zotero.Utilities.Internal.quit(); return;
		}
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
		check("native SSE captures the final usage-only event", result.metrics?.promptTokens === 120 && result.metrics?.cachedTokens === 0);
		if (result.error) throw new Error(result.error);
		config.tools = true;
		let withTools = await CS.runBackend("openai", { ...request, apiConfig: config });
		check("native agent executes a document tool and returns its result", withTools.text === "Tool verified (p. 1)");
		if (withTools.error) throw new Error(withTools.error);
		let json = await CS.runBackend("unsloth", { ...request, apiConfig: { ...config, tools: false, stream: false } });
		check("non-streaming Unsloth preset works with server tools disabled", json.text === "JSON verified");
		check("native Unsloth tokenizer controls the context budget", json.metrics?.budgetSource === "provider tokenizer");
		let expired = await CS.runBackend("unsloth", { ...request, apiConfig: { ...config, tools: false, stream: false }, effort: "thinking:false",
			messages: prepared => {
				CS._apiCapabilities.get(CS.apiProfileKey(prepared, "smoke-model")).checkedAt -= 600001;
				return [{ role: "user", content: "Expired capability probe" }];
			} });
		check("native reasoning snapshot survives discovery-cache expiry", expired.text === "JSON verified" && !expired.error);
		let raceURL = config.baseURL.replace(/\/v1$/, "/race/v1");
		let racing = await Promise.all(["race-A", "race-B"].map(model => CS.runBackend("unsloth", { model,
			apiConfig: { ...config, baseURL: raceURL, stream: false }, messages: [{ role: "user", content: "Concurrent model probe" }] })));
		check("native concurrent model switches preserve both answers", racing[0].text === "Answer race-A" && racing[1].text === "Answer race-B");
		let stress = await Promise.all(Array.from({ length: 20 }, (_, i) => {
			let model = "race-" + (i % 3);
			return CS.runBackend("unsloth", { model, apiConfig: { ...config, baseURL: raceURL, stream: false },
				messages: [{ role: "user", content: "Queued model switch " + i }] }).then(result => ({ result, model }));
		}));
		check("20 queued native model switches preserve every answer", stress.every(({ result, model }) => !result.error && result.text === "Answer " + model));
		check("native stress releases all connection leases and request controls", !CS._apiConnections?.size && !CS._apiRequestControls?.size && !CS._unslothLoads?.size);
		for (let [status, code] of [[401, "auth"], [403, "auth"], [404, "model"], [429, "rate_limit"], [500, "request"], [503, "request"]]) {
			let failed = await CS.runBackend("openai", { model: "http-" + status, apiConfig: config, messages: [{ role: "user", content: "Synthetic failure" }] });
			check("native HTTP " + status + " produces its recovery diagnostic", failed.diagnostic?.code === code && !!failed.error);
		}
		let incomplete = await CS.runBackend("openai", { model: "incomplete-model", apiConfig: config, messages: [{ role: "user", content: "Synthetic interruption" }] });
		check("native incomplete SSE preserves partial text and offers retry", incomplete.partialText === "Partial synthetic answer" && incomplete.diagnostic?.code === "incomplete" && incomplete.diagnostic?.action === "retry");
		let stopped = false, kill;
		let cancelled = await CS.runBackend("openai", { ...request, model: "cancel-model", onSpawn: handle => { kill = () => handle.kill(); },
			onProgress: update => { if (update.text && !stopped) { stopped = true; kill(); } } });
		check("Stop aborts the native HTTP stream", stopped && cancelled.cancelled && cancelled.stopped);
		let doc = Zotero.getMainWindow().document;
		let panel = CS.buildAPIAssistant(doc, "openai");
		check("API settings render in native Gecko", panel.querySelectorAll("input").length === 5 && panel.querySelectorAll('[role="switch"]').length === 4);
		let emptyPanel = CS.buildAPIAssistant(doc, "unsloth");
		[...emptyPanel.querySelectorAll("button")].find(button => button.textContent === "Load model").click();
		await Zotero.Promise.delay(0);
		check("native first-run model loading reports an empty selection without failing", !emptyPanel.querySelector("input[list]").checkValidity() && emptyPanel.textContent.includes("Choose an exact model ID before loading"));
		await CS.setAPIKey("openai", config, "native-test-key-one");
		await CS.setAPIKey("openai", config, "native-test-key-two");
		check("native credential replacement works", await CS.getAPIKey("openai", config) === "native-test-key-two");
		await CS.setAPIKey("openai", config, "");
		check("native credential removal works", await CS.getAPIKey("openai", config) === "");
		let ollama = { ...config, tools: false, profiles: {} };
		CS.setPref("ollama.api", JSON.stringify(ollama));
		CS.setAPIModel("ollama", "smoke-model");
		let native = await CS.runBackend("ollama", request);
		check("native Ollama NDJSON handles fragmented UTF-8", native.text === "Profilo caffè verificato");
		check("native Ollama counters and timing are collected", native.metrics?.completionTokens > 0 && native.metrics?.generationMs > 0 && native.metrics?.cachedTokens === 0);
		check("native Ollama capabilities and model-defined thinking values are detected", CS.getAPIConfig("ollama").tools && CS.apiReasoningChoices("ollama").some(c => c.id === "deep"));
		let nativeMemoryError = await CS.runBackend("ollama", { ...request, model: "memory-error-model" });
		check("native Ollama HTTP error strings produce a memory recovery action", nativeMemoryError.diagnostic?.code === "memory" && nativeMemoryError.diagnostic?.action === "settings");
		let runtime = CS._apiRuntimeProfiles.get(CS.apiProfileKey(ollama, "smoke-model"));
		check("Ollama provider profile reads actual context and quantization", runtime.contextTokens === 16384 && runtime.quantization === "Q4_K_M");
		ollama.tools = true;
		ollama.profiles[CS.apiProfileKey(ollama, "smoke-model")] = { mode: "custom", overrides: { contextTokens: 32768, temperature: 0.2 } };
		CS.setPref("ollama.api", JSON.stringify(ollama));
		let custom = await CS.runBackend("ollama", request);
		check("native Ollama context override and document tool loop work", custom.text === "Profilo caffè verificato" && CS._apiRuntimeProfiles.get(CS.apiProfileKey(ollama, "smoke-model")).contextTokens === 32768);
		let nativePanel = CS.buildAPIAssistant(doc, "ollama");
		check("provider profile controls render in native Gecko", !!nativePanel.querySelector(".zs-api-profile") && !nativePanel.querySelector(".zs-api-profile-overrides").hidden);
		check("native settings show automatic capabilities with explicit overrides", nativePanel.querySelector('select[aria-label="Document tools"]')?.value === "on");
		CS.setPref("ollama.effort", "deep");
		CS._apiCapabilities.clear();
		let cold = await CS.runBackend("ollama", { model: "smoke-model", effort: CS.getEffort("ollama", { deferCapabilities: true }),
			messages: [{ role: "user", content: "Ollama cold reasoning probe" }] });
		check("native Ollama preserves a named reasoning choice through cold discovery", !cold.error && cold.text === "Profilo caffè verificato");
		let body = CS.el(doc, "div"); doc.documentElement.appendChild(body);
		CS.setPref("backend", "ollama"); CS.renderSkeleton(doc, body);
		let root = body.querySelector(".zs-root");
		await CS.refreshAPIRuntime("ollama", { force: true });
		check("native chat displays actual model context", !root.querySelector(".zs-api-runtime").hidden && root.querySelector(".zs-api-runtime").textContent.includes((32768).toLocaleString()));
		let stats = CS.renderAPIMetrics(doc, native.metrics);
		check("native chat renders metrics and conservative fallback honestly", stats.textContent.includes("output tokens") && stats.textContent.includes("conservative estimate"));
		body.remove();
		let budgetDir = PathUtils.join(out, "small-context-memory");
		await Zotero.File.createDirectoryIfMissingAsync(budgetDir);
		let history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "Study discussion and evidence. ".repeat(200) }));
		await CS.writeAtomic(PathUtils.join(budgetDir, "chat.json"), JSON.stringify(history));
		CS.setPref("ollama.api", JSON.stringify({ ...config, profiles: {}, stream: false }));
		CS.setAPIModel("ollama", "small-context-model");
		let jobsWereStopped = CS._jobsStopped; CS._jobsStopped = true;
		try {
			await CS.consolidateMemory({ dir: budgetDir });
			check("native memory batch fits 8192 despite the legacy 32768 context", (await CS.loadMemory(budgetDir)).coveredThrough >= 1 && !CS._memoryFailed.has(budgetDir));
			let pages = ["Section evidence. ".repeat(2000)], entry = { id: "section", title: "Section", start: 0, end: 0, level: 1 };
			CS._structures.set(budgetDir, { structure: { pageCount: 1, outline: [entry], labels: [], confidence: 0 } });
			await Zotero.File.createDirectoryIfMissingAsync(PathUtils.join(budgetDir, "cache"));
			await CS.writeAtomic(PathUtils.join(budgetDir, "cache", "pages.json"), JSON.stringify({ pages }));
			CS.setPref("memory.gists", true);
			await CS.gistSection({ dir: budgetDir }, "section");
			check("native section gist fits 8192 and retains prose output", (await CS.loadGists(budgetDir)).sections.section?.text === "Native section summary.");
		}
		finally { CS._jobsStopped = jobsWereStopped; }
		for (let backend of ["unsloth", "ollama"]) {
			let svg = await CS.loadIcon(doc, CS.BACKEND_ICONS[backend]);
			check(backend + " provider icon loads from the packaged XPI", svg?.localName === "svg" && svg.childElementCount > 0);
		}
		CS.setPref("unsloth.api", JSON.stringify({ ...config, tools: false, stream: false }));
		CS.setAPIModel("unsloth", "smoke-model");
		CS.setPref("unsloth.effort", "thinking:false");
		Zotero.Prefs.set("extensions.zusia.unsloth.model", "", true);
		check("scoped selection tolerates a missing legacy scalar", CS.getModel("unsloth") === "smoke-model");
		Services.prefs.savePrefFile(null);
	}
	catch (e) { checks.push({ name: String(e), ok: false, stack: e.stack }); }
	let resultName = Zotero.Prefs.get("extensions.zusia-api-probe.phase", true) === "restart" ? "restart-results.json" : "results.json";
	await IOUtils.writeUTF8(PathUtils.join(out, resultName), JSON.stringify({ checks }, null, 2));
	Zotero.Utilities.Internal.quit();
}
function startup() { run(); }
function shutdown() {}
function install() {}
function uninstall() {}
