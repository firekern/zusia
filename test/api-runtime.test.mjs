import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, openChat } from "./load-plugin.mjs";
const P = "extensions.zusia.";
const model = "org/model-GGUF", baseURL = "http://localhost:8888/proxy/v1";
const cfg = { baseURL, auth: "none", contextTokens: 8192, outputTokens: 1024, stream: false };
const env = (backend = "unsloth", config = cfg, selected = model) => loadPlugin({ prefs: {
	[P + "onboarded"]: true, [P + "backend"]: backend, [P + backend + ".model"]: selected, [P + backend + ".api"]: JSON.stringify(config),
} });
const req = () => ({ model, question: "Explain attention", history: [], images: [], effort: "", onSpawn() {}, onProgress() {},
	files: { metadata: "# Attention", annotations: "", focus: [2], fullText: { status: "ok", paged: true,
		pages: Array.from({ length: 30 }, (_, i) => (`Page ${i}: Attention uses queries, keys and values. `).repeat(200)) } } });
function server(e, handler) {
	const calls = [];
	e.window.Zotero.HTTP = { request: async (method, url, options) => {
		const call = { method, path: new URL(url).pathname.replace("/proxy", ""), body: options.body && JSON.parse(options.body), options };
		calls.push(call); const reply = await handler(call);
		assert.ok(reply, `Unexpected HTTP path ${call.path}`);
		const xhr = new e.window.EventTarget(); Object.assign(xhr, { status: reply.status || 200, responseText: "" });
		options.requestObserver?.(xhr); options.cancellerReceiver?.(() => {});
		for (const chunk of reply.chunks || []) { xhr.responseText += chunk; xhr.dispatchEvent(new e.window.Event("progress")); }
		if (reply.json) xhr.responseText = JSON.stringify(reply.json);
		if (reply.fail) throw new Error("socket closed");
		return xhr;
	} };
	return calls;
}
function metadata(call) {
	if (call.path === "/api/inference/status") return { json: { active_model: model, loaded: [model], gguf_variant: "Q4_K_M", context_length: 8192, supports_tools: false, is_vision: false } };
	if (call.path === "/v1/props") return { json: { default_generation_settings: { n_ctx: 8192 } } };
	if (call.path === "/v1/models") return { json: { data: [{ id: model, quant: "Q4_K_M" }] } };
	if (call.path.includes("/overrides")) return { json: { resolved: {} } };
}

test("native status is read-only, authenticated on the original realm, and notices external model changes", async () => {
	const e = env("unsloth", { ...cfg, auth: "bearer" }); const p = e.plugin;
	await p.setAPIKey("unsloth", cfg, "fixture-secret");
	const { root } = openChat(e);
	let current = model;
	const calls = server(e, call => call.path.endsWith("/status") ? { json: { active_model: current, loaded: [current], context_length: 8192, supports_tools: true, is_vision: true } } : metadata(call));
	await p.refreshAPIRuntime("unsloth", { force: true });
	assert.match(root.querySelector(".zs-api-runtime").textContent, /Loaded/);
	assert.equal(p.getAPIConfig("unsloth").tools, true);
	current = "externally-selected";
	await p.refreshAPIRuntime("unsloth", { force: true });
	const state = p.apiState(cfg, model);
	assert.equal(state.loaded, false); assert.equal(state.actualModel, current);
	assert.equal(state.runtime, null);
	assert.match(root.querySelector(".zs-api-runtime-detail").textContent, /externally-selected/);
	assert.ok(calls.every(c => c.method === "GET" && c.options.headers.Authorization === "Bearer fixture-secret"));
	assert.ok(!calls.some(c => c.path.endsWith("/load")));
});

test("Ollama status never warms a model and does not display the selected model as loaded when absent", async () => {
	const e = env("ollama");
	const calls = server(e, call => call.path === "/api/show" ? { json: { capabilities: ["completion"], details: { quantization_level: "Q8_0" } } } :
		call.path === "/api/ps" ? { json: { models: [{ name: "another:latest", context_length: 32768 }] } } : null);
	const state = await e.plugin.refreshAPIRuntime("ollama", { force: true });
	assert.equal(state.loaded, false); assert.equal(state.actualModel, "another:latest");
	assert.equal(calls.length, 2); assert.ok(!calls.some(c => c.path.endsWith("/chat")));
});

test("empty model preflight keeps the prompt and never starts an export/request", () => {
	const e = env("unsloth", cfg, ""); const { view } = openChat(e);
	view.input.value = "Question to preserve";
	let called = false; e.plugin.ask = async () => { called = true; };
	e.plugin.startRequest(view, view.input.value);
	assert.equal(called, false); assert.equal(view.input.value, "Question to preserve");
	assert.match(view.logEl.querySelector(".zs-error").textContent, /Choose.*model/);
});

test("diagnostics distinguish auth, memory, unavailable model, context and truncated streams", () => {
	const p = env().plugin;
	for (const [message, expected] of [["API HTTP 401. invalid key", "auth"], ["API HTTP 503. Insufficient GPU memory", "memory"],
		["API HTTP 404. model not found", "model"], ["The context budget is full.", "context"],
		["The API response ended before a complete answer.", "incomplete"], ["API connection interrupted, cancelled or timed out.", "connection"]]) {
		const result = p.apiDiagnostic(new Error(message)); assert.equal(result.code, expected); assert.ok(result.actionLabel);
	}
});

test("native Ollama HTTP error strings retain useful details, classify memory failures and redact credentials", () => {
	const p = env("ollama").plugin;
	const memory = p.apiError(500, JSON.stringify({ error: "model requires more system memory (16 GiB) than is available (8 GiB)" }));
	assert.equal(p.apiDiagnostic(memory).code, "memory"); assert.match(memory.message, /requires more system memory/);
	const auth = p.apiError(401, JSON.stringify({ error: "invalid fixture-secret" }), { Authorization: "Bearer fixture-secret" });
	assert.equal(p.apiDiagnostic(auth).code, "auth"); assert.ok(!auth.message.includes("fixture-secret"));
});

test("a busy tokenizer permits an explicit fallback and is retried on the next request", async () => {
	const e = env(); let busy = true;
	server(e, call => {
		if (call.path.endsWith("/count_tokens")) return busy ? { status: 503, json: { detail: "Cannot count while another generation is in progress" } } : { json: { input_tokens: 100, model } };
		if (call.path.endsWith("/chat/completions")) return { json: { choices: [{ message: { content: "Answer" }, finish_reason: "stop" }] } };
		return metadata(call);
	});
	let result = await e.plugin.runAPIBackend("unsloth", req());
	assert.equal(result.text, "Answer"); assert.equal(result.metrics.budgetSource, "conservative estimate"); assert.match(result.metrics.tokenizerFallback, /HTTP 503/);
	busy = false;
	result = await e.plugin.runAPIBackend("unsloth", req());
	assert.equal(result.text, "Answer"); assert.equal(result.metrics.budgetSource, "provider tokenizer");
});

test("native tokenizer expands useful document excerpts and recounts the complete prompt before completion", async () => {
	const e = env(); let promptTokens = 0;
	const calls = server(e, call => {
		if (call.path === "/v1/chat/count_tokens") {
			promptTokens = Math.ceil(JSON.stringify(call.body.messages).length / 5);
			return { json: { model, input_tokens: promptTokens } };
		}
		if (call.path === "/v1/chat/completions") return { json: { model, choices: [{ message: { content: "Grounded answer" }, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } } } };
		return metadata(call);
	});
	const result = await e.plugin.runAPIBackend("unsloth", req());
	assert.equal(result.text, "Grounded answer"); assert.equal(result.metrics.budgetSource, "provider tokenizer");
	const completion = calls.find(c => c.path === "/v1/chat/completions");
	assert.ok(e.plugin.apiInputSize(completion.body.messages) > cfg.contextTokens, "more evidence than the byte-only baseline fits");
	assert.ok(promptTokens + cfg.outputTokens < cfg.contextTokens);
	assert.match(JSON.stringify(completion.body.messages), /Explain attention/);
	assert.ok(calls.filter(c => c.path.endsWith("/count_tokens")).length >= 2);
	assert.equal(result.metrics.promptTokens, promptTokens); assert.equal(result.metrics.completionTokens, 15); assert.equal(result.metrics.cachedTokens, 0);
});

test("unavailable tokenizer uses an explicit conservative fallback and caches only unsupported routes", async () => {
	const e = env(); let counts = 0;
	server(e, call => {
		if (call.path.endsWith("/count_tokens")) { counts++; return { status: 404, json: { detail: "Unknown route" } }; }
		if (call.path.endsWith("/chat/completions")) return { json: { choices: [{ message: { content: "Fallback answer" }, finish_reason: "stop" }] } };
		return metadata(call);
	});
	for (let i = 0; i < 2; i++) {
		const result = await e.plugin.runAPIBackend("unsloth", req());
		assert.equal(result.text, "Fallback answer"); assert.equal(result.metrics.budgetSource, "conservative estimate");
		assert.match(result.metrics.tokenizerFallback, /conservative|server version/);
	}
	assert.equal(counts, 1);
});

test("tokenizer authentication errors and a changed running model prevent a completion", async () => {
	for (const variant of ["auth", "model"]) {
		const e = env(); const calls = server(e, call => call.path.endsWith("/count_tokens") ? variant === "auth" ?
			{ status: 403, json: { detail: "Access denied" } } : { json: { input_tokens: 20, model: "different-model" } } : metadata(call));
		const result = await e.plugin.runAPIBackend("unsloth", req());
		assert.equal(result.diagnostic.code, variant === "auth" ? "auth" : "model_changed");
		assert.ok(!calls.some(c => c.path.endsWith("/chat/completions")));
	}
});

test("stream-only usage events are captured and an interrupted partial answer stays incomplete", async () => {
	const e = env("openai", { ...cfg, stream: true });
	let fail = false;
	server(e, () => ({ chunks: ['data: {"model":"resolved-model","choices":[{"delta":{"content":"Partial text"},"finish_reason":null}]}\n\n',
		...(fail ? [] : ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3},"timings":{"predicted_ms":50,"prompt_ms":10}}\n\n'])], fail }));
	let result = await e.plugin.runAPIBackend("openai", { ...req(), messages: [{ role: "user", content: "Hello" }] });
	assert.equal(result.metrics.promptTokens, 12); assert.equal(result.metrics.completionTokens, 3);
	assert.equal(result.metrics.generationMs, 50); assert.equal(result.metrics.promptMs, 10); assert.ok(result.metrics.responseMs >= 0);
	assert.equal(e.plugin.apiState(cfg, model).actualModel, "resolved-model");
	fail = true;
	result = await e.plugin.runAPIBackend("openai", { ...req(), messages: [{ role: "user", content: "Hello" }] });
	assert.equal(result.text, ""); assert.equal(result.partialText, "Partial text"); assert.equal(result.diagnostic.code, "incomplete");
});

test("Ollama metrics use native counters and nanosecond durations, preserving genuine zeros", () => {
	const e = env("ollama"), p = e.plugin;
	const stats = p.apiUsage({ prompt_eval_count: 100, prompt_eval_cached_count: 0, eval_count: 20, eval_duration: 500000000, load_duration: 200000000 }, "ollama");
	assert.equal(stats.cachedTokens, 0); assert.equal(stats.generationMs, 500); assert.equal(stats.loadMs, 200);
	const view = p.renderAPIMetrics(e.document, { ...stats, lastInputTokens: 110, contextTokens: 32768, budgetSource: "conservative estimate" });
	assert.match(view.textContent, /40 tokens\/s/); assert.match(view.textContent, /Cached input: 0/); assert.match(view.textContent, /conservative estimate/);
});

test("API errors render expanded recovery actions and keep partial answers visibly incomplete", async () => {
	const e = env(); const p = e.plugin; const { view } = openChat(e);
	p.loadHistory = async () => [];
	let opened = 0; p.openSettings = () => opened++;
	const diagnostic = p.apiDiagnostic(new Error("API HTTP 503. Insufficient GPU memory"));
	const pending = { backend: "unsloth", question: "Question", images: [], modes: [], status: "", startedAt: Date.now(), partial: "", steps: [], listeners: new Set(),
		promise: Promise.resolve({ error: diagnostic.message, diagnostic, partialText: "Unfinished" }) };
	await p.showPending(view, pending);
	assert.equal(view.logEl.querySelector(".zs-error-details").hidden, false);
	assert.match(view.logEl.textContent, /Incomplete response/);
	view.logEl.querySelector(".zs-error-recovery").click(); assert.equal(opened, 1);
});

test("visible-chat monitoring refreshes on its cadence and aborts outstanding reads on shutdown", async () => {
	const e = env(); const p = e.plugin; const { root } = openChat(e);
	root.getClientRects = () => [{}];
	const timers = [], cleared = [];
	const win = { closed: false, setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout(id) { cleared.push(id); } };
	let refreshed = 0, aborted = 0;
	p.refreshAPIRuntime = async () => { refreshed++; };
	p.startAPIMonitoring(win);
	assert.equal(timers[0].ms, 500);
	await timers[0].fn();
	assert.equal(refreshed, 1); assert.equal(timers[1].ms, 12000);
	p._apiMonitorControls = new Set([{ cancelled: false, abort: () => aborted++ }]);
	p.stopAPIMonitoring();
	assert.equal(aborted, 1); assert.ok(cleared.includes(2)); assert.equal(p._apiMonitorWindow, null);
});

test("tool rounds aggregate provider usage while reasoning stays internal and out of the result", async () => {
	const e = env("openai", { ...cfg, tools: true, capabilityModel: model });
	let generation = 0;
	server(e, call => {
		generation++;
		if (generation === 1) return { json: { choices: [{ message: { content: "", reasoning_content: "private tool reasoning", tool_calls: [
			{ id: "call-1", type: "function", function: { name: "read_pages", arguments: '{"pages":[1]}' } },
		] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
		assert.equal(call.body.messages.find(m => m.role === "assistant").reasoning_content, "private tool reasoning");
		return { json: { choices: [{ message: { content: "Public answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4 } } };
	});
	const result = await e.plugin.runAPIBackend("openai", req());
	assert.equal(result.text, "Public answer"); assert.equal(result.metrics.rounds, 2);
	assert.equal(result.metrics.promptTokens, 30); assert.equal(result.metrics.completionTokens, 9);
	assert.ok(!JSON.stringify(result).includes("private tool reasoning"));
});

test("the final bounded tool round counts the exact schema that is actually sent", async () => {
	const e = env("unsloth", { ...cfg, tools: true, capabilityModel: model });
	let generation = 0, lastCountHasTools;
	server(e, call => {
		if (call.path.endsWith("/count_tokens")) {
			lastCountHasTools = !!call.body.tools?.length;
			return { json: { model, input_tokens: lastCountHasTools ? 1000 : 100 } };
		}
		if (call.path.endsWith("/chat/completions")) {
			assert.equal(!!call.body.tools?.length, lastCountHasTools);
			generation++;
			return generation < 5 ? { json: { choices: [{ message: { content: "", tool_calls: [{ id: "read-" + generation, type: "function", function: { name: "read_pages", arguments: '{"pages":[1]}' } }] }, finish_reason: "tool_calls" }] } } :
				{ json: { choices: [{ message: { content: "Final answer" }, finish_reason: "stop" }] } };
		}
		return metadata(call);
	});
	const result = await e.plugin.runAPIBackend("unsloth", req());
	assert.equal(result.text, "Final answer"); assert.equal(result.metrics.rounds, 5); assert.equal(result.metrics.lastInputTokens, 100);
});

for (const effort of ["thinking:false", "not-supported"]) {
	test(`the first chat request validates saved ${effort} after native discovery`, async () => {
		const e = env(), p = e.plugin;
		p.setPref("unsloth.effort", effort);
		assert.equal(p.getEffort("unsloth"), "");
		const { view } = openChat(e);
		const calls = server(e, call => {
			if (call.path === "/api/inference/status") return { json: { active_model: model, loaded: [model], gguf_variant: "Q4_K_M", context_length: 8192,
				supports_reasoning: true, reasoning_style: "enable_thinking", supports_tools: false, is_vision: false } };
			if (call.path.endsWith("/count_tokens")) return { json: { model, input_tokens: 20 } };
			if (call.path.endsWith("/chat/completions")) return { json: { choices: [{ message: { content: "Cold-start answer" }, finish_reason: "stop" }] } };
			return metadata(call);
		});
		p.showPending = () => {};
		p.ask = async (_ctx, _question, pending) => p.runBackend(pending.backend, { model: pending.model, apiConfig: pending.apiConfig,
			effort: pending.effort, messages: [{ role: "user", content: "Cold-start question" }] });
		p.startRequest(view, "Cold-start question");
		const result = await p._pending.get(view.ctx.dir).promise;
		assert.equal(result.text, "Cold-start answer", result.error);
		for (const call of calls.filter(c => c.path.endsWith("/count_tokens") || c.path.endsWith("/chat/completions"))) {
			assert.equal(call.body.enable_thinking, effort === "thinking:false" ? false : undefined);
			assert.equal(call.body.reasoning_effort, undefined);
		}
		e.window.close();
	});
}
