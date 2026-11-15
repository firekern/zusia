var report = { checks: [], stage: "starting" };
function check(name, ok, detail) { report.checks.push({ name, ok: !!ok, ...(!ok && detail ? { detail } : {}) }); }
function contains(text, code) { return text.replace(/\\_/g, "_").includes(code); }
async function run() {
	let pref = name => Zotero.Prefs.get("extensions.zusia-live-api-probe." + name, true);
	let out = pref("out"), backend = pref("backend"), model = pref("model"), phase = pref("phase"), CS;
	let save = () => IOUtils.writeUTF8(PathUtils.join(out, phase + "-results.json"), JSON.stringify(report, null, 2));
	try {
		let key = Services.env.get("ZUSIA_LIVE_KEY"); Services.env.set("ZUSIA_LIVE_KEY", "");
		await save(); await Zotero.uiReadyPromise;
		for (let i = 0; !Zotero.Zusia && i < 200; i++) await Zotero.Promise.delay(100);
		CS = Zotero.Zusia;
		if (!CS) throw new Error("Packaged plugin did not start");
		report.version = CS.version; report.model = model;
		let config = { baseURL: pref("url"), auth: key ? "bearer" : "none", contextTokens: 32768,
			outputTokens: pref("outputTokens"), profiles: {}, capabilities: {}, stream: true };
		if (pref("contextTokens")) config.profiles[CS.apiProfileKey(config, model)] = { mode: "custom", overrides: { contextTokens: pref("contextTokens") } };
		report.requestSettings = { contextOverride: pref("contextTokens"), outputTokens: config.outputTokens };
		// A supplied real key lives only in this process, never in a throwaway profile.
		if (key) CS._apiKeys = new Map([[CS.apiCredentialRealm(backend, config), key]]);
		key = "";
		let headers = await CS.apiHeaders(backend, config), before;
		if (backend === "unsloth") {
			before = await CS.providerJSON(backend, CS.nativeAPIConfig(config, "/api/inference"), "/status", { headers });
			let profile = await CS.readUnslothProfile(model, config, { headers, status: before });
			if (before.loading?.length || !CS.unslothProfileMatches(model, profile, config)) {
				throw new Error("Read-only guard: Unsloth must already have this model and its saved profile loaded");
			}
		}
		if (phase === "restart") {
			check("live model selection survives restart", CS.getModel(backend) === model);
			check("live connection settings survive restart", CS.getAPIConfig(backend).baseURL === config.baseURL);
			if (pref("contextTokens")) check("live custom provider profile survives restart", CS.getAPIConfig(backend).profiles[CS.apiProfileKey(config, model)]?.overrides.contextTokens === pref("contextTokens"));
			let response = await CS.runBackend(backend, { model: CS.getModel(backend), effort: CS.getEffort(backend, { deferCapabilities: true }),
				messages: [{ role: "user", content: "Reply with exactly RESTART_OK and nothing else." }] });
			check("real provider answers after Zotero restart", !response.error && contains(response.text, "RESTART_OK"), response);
		}
		else {
			CS.setPref(backend + ".api", JSON.stringify(config)); CS.setAPIModel(backend, model); CS.setPref("backend", backend);
			let models = await CS.loadAPIModels(backend);
			check("real provider discovers the exact model", models.some(m => m.id === model));
			await CS.prepareAPIModel(backend, model, config, { headers });
			let detected = CS.getAPIConfig(backend), choices = CS.apiReasoningChoices(backend, detected, model);
			report.capabilities = detected.detectedCapabilities;
			let effort = choices.some(c => c.id === "thinking:false") ? "thinking:false" : "";
			CS.setPref(backend + ".effort", effort);
			// Disable tools only for the first request, to prove document injection separately.
			let scope = CS.apiProfileKey(config, model);
			let plain = { ...config, capabilities: { [scope]: { tools: "off" } } };
			const files = { metadata: "# Synthetic integration document", annotations: "", focus: [0],
				fullText: { status: "ok", paged: true, pages: ["The exact verification code is ZUSIA_LIVE_427. This is synthetic test data."] } };
			report.stage = "document"; await save();
			let chunks = 0;
			let response = await CS.runBackend(backend, { model, apiConfig: plain, effort, files, history: [], images: [],
				question: "What is the exact verification code in the document? Reply only with that code.", onProgress(u) { if (u.text) chunks++; } });
			if (response.error) throw new Error(response.error);
			check("real streamed answer uses synthetic document evidence", contains(response.text, "ZUSIA_LIVE_427") && chunks > 0, { text: response.text, chunks });
			check("real provider reports token usage", response.metrics?.promptTokens > 0 && response.metrics?.completionTokens > 0);
			report.metrics = response.metrics;
			let runtime = CS._apiRuntimeProfiles.get(scope); report.runtime = runtime;
			check("real provider reports effective context and quantization", runtime?.contextTokens >= 8192 && !!runtime.quantization);
			if (pref("contextTokens")) check("real Ollama applies the explicit context override", runtime.contextTokens === pref("contextTokens"));
			check("budget fits the actual provider context", response.metrics.contextTokens === runtime.contextTokens && response.metrics.lastInputTokens + response.metrics.outputBudget <= runtime.contextTokens);
			if (backend === "unsloth") check("real Unsloth tokenizer is used", response.metrics.budgetSource === "provider tokenizer");
			else check("Ollama estimate is labelled honestly", response.metrics.budgetSource === "conservative estimate");
			report.stage = "nonstream"; await save();
			let json = await CS.runBackend(backend, { model, apiConfig: { ...plain, stream: false }, effort,
				messages: [{ role: "user", content: "Repeat this exact string: ZUSIA_NONSTREAM_427" }] });
			check("real non-streaming completion works", !json.error && contains(json.text, "ZUSIA_NONSTREAM_427"), json);
			if (detected.tools) {
				report.stage = "tools"; await save();
				let toolNames = [];
				let tools = await CS.runBackend(backend, { model, apiConfig: config, effort, files, history: [], images: [],
					question: "You must call read_pages with pages [1] before answering. What is the exact verification code on page 1? Return the code from the tool result.",
					onProgress(u) { if (u.step) toolNames.push(u.step); } });
				report.toolRounds = tools.metrics?.rounds;
				check("real model calls a document tool and uses its result", !tools.error && tools.metrics?.rounds >= 2 && toolNames.length > 0 && contains(tools.text, "ZUSIA_LIVE_427"), tools);
			}
			if (choices.some(c => c.id === "thinking:true")) {
				report.stage = "reasoning"; await save();
				let reasoning = await CS.runBackend(backend, { model, apiConfig: plain, effort: "thinking:true",
					messages: [{ role: "user", content: "What is 17 + 25? Answer with the number." }] });
				check("real model accepts its declared Thinking on mode", !reasoning.error && reasoning.text.includes("42"), reasoning);
			}
			report.stage = "stop"; await save();
			let handle, stopped = false;
			let cancelled = await CS.runBackend(backend, { model, apiConfig: { ...plain, outputTokens: 2048 }, effort,
				messages: [{ role: "user", content: "Write the integers from 1 to 500, one per line. Do not skip any." }],
				onSpawn(h) { handle = h; }, onProgress(u) { if (u.text && !stopped) { stopped = true; handle.kill(); } } });
			check("Stop cancels a real provider stream", stopped && cancelled.cancelled && cancelled.stopped);
			if (pref("image") && detected.vision) {
				report.stage = "vision"; await save();
				let vision = await CS.runBackend(backend, { model, apiConfig: plain, effort, images: [pref("image")],
					messages: [{ role: "user", content: "What is the background color of this image? Reply with one English color word." }] });
				check("real vision model reads the synthetic green image", !vision.error && /green/i.test(vision.text));
			}
			check("real requests release connection leases and controls", !CS._apiConnections?.size && !CS._apiRequestControls?.size);
			Services.prefs.savePrefFile(null);
		}
		if (before) {
			let after = await CS.providerJSON(backend, CS.nativeAPIConfig(config, "/api/inference"), "/status", { headers });
			let fields = ["model_identifier", "active_model", "context_length", "requested_context_length", "gguf_variant", "cache_type_kv", "parallel_slots", "gpu_memory_mode", "gpu_layers"];
			check("existing Unsloth model runtime stays unchanged", fields.every(name => before[name] === after[name]));
		}
		report.stage = "finished";
	}
	catch (e) { report.error = e.message; report.stage = "error"; }
	finally { CS?._apiKeys?.clear(); await save(); Zotero.Utilities.Internal.quit(); }
}
function startup() { run(); }
function shutdown() {}
function install() {}
function uninstall() {}
