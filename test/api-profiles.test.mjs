import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const P = "extensions.zusia.";
const model = "org/model-GGUF";
const cfg = { baseURL: "http://localhost:8888/proxy/v1", auth: "none", contextTokens: 32768, outputTokens: 2048, stream: false, capabilityModel: model, profiles: {} };
const request = () => ({ model, question: "Explain attention", history: [], images: [], effort: "", onProgress() {}, onSpawn() {},
	files: { metadata: "# Attention", annotations: "", fullText: { status: "ok", paged: true, pages: Array.from({ length: 20 }, (_, i) => ("Attention page " + i + ". ").repeat(300)) }, focus: [0] } });

function environment(backend, config = cfg, selected = model) {
	return loadPlugin({ prefs: { [P + "backend"]: backend, [P + backend + ".model"]: selected, [P + backend + ".api"]: JSON.stringify(config) } });
}
function server(e, handler) {
	const calls = [];
	e.window.Zotero.HTTP = { request: async (method, url, options) => {
		const call = { method, url, path: new URL(url).pathname.replace("/proxy", ""), body: options.body && JSON.parse(options.body), options };
		calls.push(call);
		const reply = await handler(call);
		if (!reply) throw new Error("Unexpected API path: " + call.path);
		const xhr = new e.window.EventTarget();
		Object.assign(xhr, { status: reply.status || 200, responseText: "" });
		options.requestObserver?.(xhr);
		options.cancellerReceiver?.(() => {});
		if (reply.chunks) for (const chunk of reply.chunks) { xhr.responseText += chunk; xhr.dispatchEvent(new e.window.Event("progress")); }
		else xhr.responseText = JSON.stringify(reply.json);
		return xhr;
	} };
	return calls;
}
const json = value => ({ json: value });
const answer = text => json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
const line = value => JSON.stringify(value) + "\r\n";
function nativeUnsloth(e, { saved = {}, status = {}, context = 32768, profileStatus = 200, fitContext } = {}) {
	let current = { loaded: [], context_length: 32768, ...status };
	return server(e, call => {
		if (call.path === "/v1/chat/count_tokens") return { status: 404, json: { detail: "No tokenizer in this profile-only fixture" } };
		if (call.path === "/api/inference/status") return json(current);
		if (call.path === "/v1/models") return json({ data: [{ id: model, quant: "Q4_K_M" }] });
		if (call.path === "/api/settings/openai-auto-switch/overrides") return { status: profileStatus, json: { resolved: saved, resolved_key: model + ":Q4_K_M" } };
		if (call.path === "/api/inference/load") {
			current = { active_model: model, loaded: [model], gguf_variant: call.body.gguf_variant, context_length: fitContext || call.body.max_seq_length || 32768,
				requested_context_length: call.body.max_seq_length, cache_type_kv: call.body.cache_type_kv, gpu_layers: call.body.gpu_layers,
				gpu_memory_mode: call.body.gpu_memory_mode, parallel_slots: call.body.n_parallel || 1, requested_parallel_slots: call.body.n_parallel };
			return json({ status: "loaded" });
		}
		if (call.path === "/v1/props") return json({ default_generation_settings: { n_ctx: context } });
		if (call.path === "/v1/chat/completions") return answer("Grounded answer");
	});
}

test("native profiles default to the provider and overrides are scoped to endpoint and model", () => {
	const e = environment("unsloth");
	assert.equal(e.plugin.apiProfileSettings(cfg, model).mode, "provider");
	const key = e.plugin.apiProfileKey(cfg, model);
	const custom = { ...cfg, profiles: { [key]: { mode: "custom", overrides: { contextTokens: 65536, temperature: 0 } } } };
	assert.equal(e.plugin.apiProfileSettings(custom, model).overrides.temperature, 0);
	assert.equal(e.plugin.apiProfileSettings(custom, "other-model").mode, "provider");
	assert.equal(e.plugin.apiProfileSettings({ ...custom, baseURL: "https://different.example/v1" }, model).mode, "provider");
	assert.equal(Object.keys(e.plugin.cleanAPIProfileOverrides({ contextTokens: -1, temperature: 99, parallelSlots: 0, ggufVariant: "../../file", cacheTypeKV: "invalid" })).length, 0);
});

test("Unsloth inherits saved context, quant, KV and GPU settings and budgets against the actual per-slot window", async () => {
	const e = environment("unsloth");
	const calls = nativeUnsloth(e, { saved: { custom_context_length: 65536, kv_cache_dtype: "q8_0", gpu_layers: 45, gpu_memory_mode: "manual", n_parallel: 2 }, context: 32768 });
	const result = await e.plugin.runAPIBackend("unsloth", request());
	assert.equal(result.text, "Grounded answer");
	const load = calls.find(c => c.path.endsWith("/load"));
	assert.equal(load.body.max_seq_length, 65536);
	assert.equal(load.body.cache_type_kv, "q8_0");
	assert.equal(load.body.gpu_layers, 45);
	assert.equal(load.body.n_parallel, 2);
	assert.equal(load.body.gguf_variant, "Q4_K_M");
	assert.equal(new URL(calls.find(c => c.path.includes("/overrides")).url).searchParams.get("gguf_variant"), "Q4_K_M");
	const sent = calls.find(c => c.path.endsWith("/chat/completions")).body;
	assert.ok(e.plugin.apiInputSize(sent.messages) + cfg.outputTokens <= 32768);
	assert.equal(sent.temperature, undefined, "sampling defaults remain on the provider");
	assert.ok(!calls.some(c => c.method !== "GET" && c.path.startsWith("/api/settings")), "provider presets are read-only");
	assert.equal(e.plugin._apiRuntimeProfiles.get(e.plugin.apiProfileKey(cfg, model)).contextTokens, 32768);
});

test("Unsloth custom values override the provider only for the selected model", async () => {
	const e = environment("unsloth");
	const profiles = { [e.plugin.apiProfileKey(cfg, model)]: { mode: "custom", overrides: { contextTokens: 32768, cacheTypeKV: "q4_0", ggufVariant: "Q8_0", parallelSlots: 1, temperature: 0, topP: 0.9 } } };
	e.prefs[P + "unsloth.api"] = JSON.stringify({ ...cfg, profiles });
	const calls = nativeUnsloth(e, { saved: { max_seq_length: 65536, kv_cache_dtype: "q8_0", n_parallel: 4 } });
	assert.equal((await e.plugin.runAPIBackend("unsloth", request())).text, "Grounded answer");
	const load = calls.find(c => c.path.endsWith("/load")).body;
	assert.equal(load.max_seq_length, 32768);
	assert.equal(load.gguf_variant, "Q8_0");
	assert.equal(load.cache_type_kv, "q4_0");
	assert.equal(load.n_parallel, 1);
	const completion = calls.find(c => c.path.endsWith("/chat/completions")).body;
	assert.equal(completion.temperature, 0);
	assert.equal(completion.top_p, 0.9);
});

test("a fitted Unsloth context does not cause endless reloads", async () => {
	const e = environment("unsloth");
	const calls = nativeUnsloth(e, { saved: { max_seq_length: 65536 }, status: { loaded: [model], active_model: model, gguf_variant: "Q4_K_M", requested_context_length: 65536, context_length: 32768, max_context_length: 262144 }, context: 16384 });
	const effective = await e.plugin.prepareAPIModel("unsloth", model, e.plugin.getAPIConfig("unsloth"));
	assert.equal(effective.contextTokens, 16384);
	assert.ok(!calls.some(c => c.path.endsWith("/load")));
});

test("Unsloth applies extra profile options once and re-applies changed provider settings", async () => {
	const e = environment("unsloth");
	const saved = { max_seq_length: 32768, speculative_type: "auto", n_batch: 512 };
	const calls = nativeUnsloth(e, { saved });
	await e.plugin.prepareAPIModel("unsloth", model, e.plugin.getAPIConfig("unsloth"));
	await e.plugin.prepareAPIModel("unsloth", model, e.plugin.getAPIConfig("unsloth"));
	assert.equal(calls.filter(c => c.path.endsWith("/load")).length, 1);
	saved.max_seq_length = 65536;
	await e.plugin.prepareAPIModel("unsloth", model, e.plugin.getAPIConfig("unsloth"));
	assert.equal(calls.filter(c => c.path.endsWith("/load")).length, 2);
	assert.equal(calls.filter(c => c.path.endsWith("/load"))[1].body.max_seq_length, 65536);
});

test("switching from custom settings to the provider removes old runtime overrides", async () => {
	const e = environment("unsloth");
	const key = e.plugin.apiProfileKey(cfg, model);
	let profiles = { [key]: { mode: "custom", overrides: { cacheTypeKV: "q4_0", parallelSlots: 1 } } };
	e.prefs[P + "unsloth.api"] = JSON.stringify({ ...cfg, profiles });
	const calls = nativeUnsloth(e);
	await e.plugin.prepareAPIModel("unsloth", model, e.plugin.getAPIConfig("unsloth"));
	profiles[key].mode = "provider";
	e.prefs[P + "unsloth.api"] = JSON.stringify({ ...cfg, profiles });
	await e.plugin.prepareAPIModel("unsloth", model, e.plugin.getAPIConfig("unsloth"));
	const loads = calls.filter(c => c.path.endsWith("/load"));
	assert.equal(loads.length, 2);
	assert.equal(loads[1].body.cache_type_kv, undefined);
	assert.equal(loads[1].body.n_parallel, undefined);
});

test("missing saved-profile endpoints use provider defaults but authentication errors stop the request", async () => {
	const e = environment("unsloth");
	let calls = nativeUnsloth(e, { profileStatus: 404, status: { loaded: [model], gguf_variant: "Q4_K_M" } });
	assert.equal((await e.plugin.runAPIBackend("unsloth", request())).text, "Grounded answer");
	assert.equal(e.plugin._apiRuntimeProfiles.get(e.plugin.apiProfileKey(cfg, model)).savedProfile, false);
	calls = nativeUnsloth(e, { profileStatus: 403, status: { loaded: [model], gguf_variant: "Q4_K_M" } });
	assert.match((await e.plugin.runAPIBackend("unsloth", request())).error, /403/);
	assert.ok(!calls.some(c => c.path.endsWith("/load") || c.path.endsWith("/chat/completions")));
});

test("Ollama inherits its model profile and handles fragmented native NDJSON without exposing thinking", async () => {
	const e = environment("ollama", { ...cfg, stream: true });
	const stream = line({ message: { thinking: "private" } }) + line({ message: { content: "Caffè" } }) + line({ done: true, done_reason: "stop" });
	const calls = server(e, call => {
		if (call.path === "/api/show") return json({ parameters: "num_ctx 16384\ntemperature 0.6", details: { quantization_level: "Q4_K_M" } });
		if (call.path === "/api/ps") return json({ models: [{ name: model + ":latest", context_length: 16384 }] });
		if (call.path === "/api/chat") return { chunks: [...stream] };
	});
	const progress = [];
	const result = await e.plugin.runAPIBackend("ollama", { ...request(), onProgress: p => progress.push(p) });
	assert.equal(result.text, "Caffè");
	assert.ok(!progress.some(p => p.text?.includes("private")));
	const sent = calls.find(c => c.path === "/api/chat").body;
	assert.equal(sent.options.num_ctx, undefined);
	assert.equal(sent.options.temperature, undefined);
	assert.equal(sent.options.num_predict, 2048);
	assert.ok(!calls.some(c => c.path === "/v1/chat/completions"));
});

test("Ollama custom context is sent on both preload and chat and its actual window limits document input", async () => {
	const e = environment("ollama");
	e.prefs[P + "ollama.api"] = JSON.stringify({ ...cfg, outputTokens: 1024, profiles: { [e.plugin.apiProfileKey(cfg, model)]: { mode: "custom", overrides: { contextTokens: 32768, temperature: 0, topK: 40 } } } });
	let loaded = false;
	const calls = server(e, call => {
		if (call.path === "/api/show") return json({ parameters: "num_ctx 16384", details: { quantization_level: "Q8_0" } });
		if (call.path === "/api/ps") return json({ models: [{ name: model, context_length: loaded ? 8192 : 16384 }] });
		if (call.path === "/api/chat") { loaded = true; return json({ message: { content: call.body.messages.length ? "Native answer" : "" }, done: true }); }
	});
	assert.equal((await e.plugin.runAPIBackend("ollama", request())).text, "Native answer");
	const chats = calls.filter(c => c.path === "/api/chat");
	assert.equal(chats.length, 2);
	for (const call of chats) { assert.equal(call.body.options.num_ctx, 32768); assert.equal(call.body.options.temperature, 0); }
	assert.equal(chats[0].body.messages.length, 0);
	assert.ok(e.plugin.apiInputSize(chats[1].body.messages) + 1024 <= 8192);
});

test("Ollama document tools replay native argument objects, tool names and private thinking", async () => {
	const e = environment("ollama", { ...cfg, tools: true, stream: true });
	let round = 0;
	const calls = server(e, call => {
		if (call.path === "/api/show") return json({ parameters: "num_ctx 32768" });
		if (call.path === "/api/ps") return json({ models: [{ name: model, context_length: 32768 }] });
		if (call.path === "/api/chat") return { chunks: [++round === 1 ? line({ message: { thinking: "private reasoning", tool_calls: [{ function: { name: "read_pages", arguments: { pages: [1] } } }] }, done: true }) : JSON.stringify({ message: { content: "Read page 1" }, done: true })] };
	});
	assert.equal((await e.plugin.runAPIBackend("ollama", request())).text, "Read page 1");
	const sent = calls.filter(c => c.path === "/api/chat")[1].body;
	assert.equal(sent.messages.find(m => m.role === "tool").tool_name, "read_pages");
	assert.match(sent.messages.find(m => m.role === "tool").content, /Attention/);
	assert.equal(sent.messages.find(m => m.tool_calls).thinking, "private reasoning");
	assert.equal(typeof sent.messages.find(m => m.tool_calls).tool_calls[0].function.arguments, "object");
});

test("small provider contexts and truncated Ollama streams do not produce successful answers", async () => {
	const e = environment("ollama", { ...cfg, stream: true });
	let context = 4096;
	const calls = server(e, call => {
		if (call.path === "/api/show") return json({ parameters: "num_ctx " + context });
		if (call.path === "/api/ps") return json({ models: [{ name: model, context_length: context }] });
		if (call.path === "/api/chat") return { chunks: [line({ message: { content: "Partial" } })] };
	});
	assert.match((await e.plugin.runAPIBackend("ollama", request())).error, /4096.*8192/);
	assert.ok(!calls.some(c => c.path === "/api/chat"));
	context = 16384;
	assert.match((await e.plugin.runAPIBackend("ollama", request())).error, /ended before/);
});

test("native Ollama preserves attached image data and rejects malformed NDJSON", async () => {
	const e = environment("ollama", { ...cfg, vision: true, stream: true });
	e.plugin.apiImagePart = async () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } });
	const calls = server(e, call => {
		if (call.path === "/api/show") return json({ parameters: "num_ctx 32768" });
		if (call.path === "/api/ps") return json({ models: [{ name: model, context_length: 32768 }] });
		if (call.path === "/api/chat") return { chunks: ["invalid JSON\n"] };
	});
	assert.match((await e.plugin.runAPIBackend("ollama", { ...request(), images: ["attached.png"] })).error, /Ollama NDJSON/);
	const sent = calls.find(c => c.path === "/api/chat").body.messages.at(-1);
	assert.equal(sent.images[0], "AA==");
	assert.match(sent.content, /Explain attention/);
});

test("profile controls preserve per-model overrides when switching back to provider settings", () => {
	const e = environment("unsloth");
	const panel = e.plugin.buildAPIAssistant(e.document, "unsloth");
	e.document.body.appendChild(panel);
	const input = label => [...panel.querySelectorAll(".zs-row")].find(row => row.querySelector("label")?.textContent === label).querySelector("input,select");
	const change = (label, value) => { let node = input(label); node.value = value; node.dispatchEvent(new e.window.Event("change")); };
	change("Model settings", "custom");
	change("Context override (tokens)", "65536");
	change("KV cache quantization", "q4_0");
	assert.equal(e.plugin.apiProfileSettings(e.plugin.getAPIConfig("unsloth"), model).overrides.contextTokens, 65536);
	change("Model settings", "provider");
	assert.equal(Object.keys(e.plugin.apiProfileSettings(e.plugin.getAPIConfig("unsloth"), model).overrides).length, 0);
	assert.equal(panel.querySelector(".zs-api-profile-overrides").hidden, true);
	change("Model ID", "other-model");
	assert.equal(input("Model settings").value, "provider");
	change("Model ID", model);
	change("Model settings", "custom");
	assert.equal(input("Context override (tokens)").value, "65536");
});

test("invalid visible overrides block model loading and provider mode clears their validation state", async () => {
	const e = environment("unsloth");
	let loaded = 0;
	e.plugin.prepareAPIModel = async () => { loaded++; return cfg; };
	e.plugin.loadAPIModels = async () => [{ id: model, loaded: true }];
	const panel = e.plugin.buildAPIAssistant(e.document, "unsloth");
	e.document.body.appendChild(panel);
	const input = label => [...panel.querySelectorAll(".zs-row")].find(row => row.querySelector("label")?.textContent === label).querySelector("input,select");
	const mode = input("Model settings"); mode.value = "custom"; mode.dispatchEvent(new e.window.Event("change"));
	const context = input("Context override (tokens)"); context.value = "1"; context.dispatchEvent(new e.window.Event("change"));
	const load = [...panel.querySelectorAll("button")].find(button => button.textContent === "Load model");
	load.click(); await new Promise(resolve => setImmediate(resolve));
	assert.equal(loaded, 0);
	mode.value = "provider"; mode.dispatchEvent(new e.window.Event("change"));
	load.click(); await new Promise(resolve => setImmediate(resolve));
	assert.equal(loaded, 1);
});
