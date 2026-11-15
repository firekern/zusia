import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const P = "extensions.zusia.";
const config = { baseURL: "http://127.0.0.1:11434/v1", auth: "none", contextTokens: 32768, outputTokens: 2048, capabilityModel: "local-model", tools: false, vision: false, stream: true };
function env(extra = {}) {
	return loadPlugin({ prefs: { [P + "backend"]: "openai", [P + "openai.model"]: "local-model", [P + "openai.api"]: JSON.stringify({ ...config, ...extra }) } });
}
const request = () => ({ ctx: { dir: "/paper" }, question: "Explain attention", history: [], session: null,
	files: { metadata: "# Paper", annotations: "", fullText: { status: "ok", paged: true, pages: ["Attention uses keys and queries. ".repeat(30)] }, focus: [0], query: "attention" },
	model: "local-model", effort: "", images: [], onProgress() {}, onSpawn() {} });

function http(e, replies) {
	const calls = [];
	e.window.Zotero.HTTP = { request: async (method, url, options) => {
		// Generic wire tests serve native profile metadata with neutral defaults;
        // strict profile/adapter behaviour is covered in api-profiles.test.mjs.
		let auxiliary = url.includes('/settings/openai-auto-switch/overrides') || url.endsWith('/props') || url.endsWith('/chat/count_tokens');
        if (!auxiliary) calls.push({ method, url, options, body: options.body && JSON.parse(options.body) });
		const reply = auxiliary ? url.endsWith('/chat/count_tokens') ? { status: 404, json: { detail: "Token counting not supported by this fixture" } } : { json: url.endsWith('/props') ? { default_generation_settings: { n_ctx: 32768 } } : { resolved: {} } } : replies.shift();
		if (!reply) throw new Error("unexpected HTTP call");
		const xhr = new e.window.EventTarget();
		Object.assign(xhr, { status: reply.status || 200, responseText: "", getResponseHeader: () => reply.json ? "application/json" : "text/event-stream" });
		options.requestObserver?.(xhr);
		options.cancellerReceiver?.(() => { throw new Error("cancelled"); });
		for (const chunk of reply.chunks || []) {
			xhr.responseText += chunk;
			xhr.dispatchEvent(new e.window.Event("progress"));
		}
		if (reply.json) xhr.responseText = JSON.stringify(url.includes('/inference/status') ? { context_length: 32768, ...reply.json } : reply.json);
		return xhr;
	} };
	return calls;
}
const sse = value => "data: " + JSON.stringify(value) + "\r\n\r\n";
const answer = text => ({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const done = () => ({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });

test("API presets coexist with CLI logins and validate endpoint URLs", () => {
	const { plugin: p } = env();
	assert.equal(p.isAPIBackend("claude"), false);
	assert.equal(p.isAPIBackend("openai"), true);
	assert.equal(p.getAPIConfig("unsloth").baseURL, "http://127.0.0.1:8888/v1");
	assert.equal(p.normalizeAPIURL("http://localhost:11434/v1/"), "http://localhost:11434/v1");
	for (const url of ["file:///etc/passwd", "http://key:secret@localhost/v1", "https://host/v1?key=secret", "https://host/v1#fragment"]) {
		assert.throws(() => p.normalizeAPIURL(url));
	}
});

test("API credentials stay outside preferences and are scoped to the endpoint", async () => {
	const e = env();
	const p = e.plugin;
	await p.setAPIKey("openai", config, "test-secret");
	assert.equal(await p.getAPIKey("openai", config), "test-secret");
	assert.equal(await p.getAPIKey("openai", { ...config, baseURL: "https://other.example/v1" }), "");
	assert.ok(!JSON.stringify(e.prefs).includes("test-secret"));
	await p.setAPIKey("openai", config, "");
	assert.equal(await p.getAPIKey("openai", config), "");
});

test("API discovery returns exact model ids and ignores a cache from another endpoint", async () => {
	const e = env();
	const calls = http(e, [{ json: { data: [{ id: "qwen-local", loaded: true }, { id: "another" }] } }]);
	await e.plugin.loadAPIModels("openai");
	assert.equal(calls[0].url, config.baseURL + "/models");
	assert.ok(e.plugin.getModels("openai").some(m => m.id === "qwen-local"));
	e.prefs[P + "openai.api"] = JSON.stringify({ ...config, baseURL: "https://other.example/v1" });
	assert.ok(!e.plugin.getModels("openai").some(m => m.id === "qwen-local"));
});

test("Unsloth loads the selected model on its native API before generating, preserving proxy prefix and credentials", async () => {
	const e = env();
	const cfg = { ...config, auth: "bearer", baseURL: "http://localhost:8888/studio/v1" };
	await e.plugin.setAPIKey("unsloth", cfg, "local-test-key");
	const calls = http(e, [
		{ json: { active_model: "old-model", loaded: ["old-model"] } },
		{ json: { status: "loaded" } },
		{ json: { active_model: "local-model", loaded: ["local-model"] } },
		{ chunks: [sse(answer("Model ready")), sse(done())] },
	]);
	const updates = [];
	const r = await e.plugin.runAPIBackend("unsloth", { ...request(), apiConfig: cfg, onProgress: u => updates.push(u) });
	assert.equal(r.text, "Model ready");
	assert.deepEqual(calls.map(c => c.url), ["/api/inference/status?model=local-model", "/api/inference/load", "/api/inference/status?model=local-model", "/v1/chat/completions"].map(path => "http://localhost:8888/studio" + path));
	assert.equal(calls[1].body.model_path, "local-model");
	assert.equal(calls[1].body.max_seq_length, undefined, "provider context is not overridden");
	assert.equal(calls[1].body.n_parallel, undefined, "provider parallelism is not overridden");
	assert.match(calls[1].body.load_request_id, /^zusia-/);
	assert.ok(calls.every(c => c.options.headers.Authorization === "Bearer local-test-key"));
	assert.ok(updates.some(u => u.status === "loading the model in Unsloth"));
	assert.equal(calls[3].body.enable_tools, false);
});

test("Unsloth reuses a loaded model without changing Studio's global switch-by-request setting", async () => {
	const e = env();
	const calls = http(e, [
		{ json: { active_model: "local-model", loaded: ["local-model"] } },
		{ chunks: [sse(answer("Already ready")), sse(done())] },
	]);
	const r = await e.plugin.runAPIBackend("unsloth", { ...request(), apiConfig: config });
	assert.equal(r.text, "Already ready");
	assert.equal(calls.length, 2);
	assert.ok(!calls.some(c => /load|settings/.test(c.url)));
});

test("Unsloth load failures prevent generation and a later request can recover", async () => {
	const e = env();
	const calls = http(e, [
		{ json: { loaded: [] } },
		{ status: 503, json: { detail: "Insufficient GPU memory" } },
		{ json: { loaded: ["local-model"] } },
		{ chunks: [sse(answer("Recovered")), sse(done())] },
	]);
	const failed = await e.plugin.runAPIBackend("unsloth", { ...request(), apiConfig: config });
	assert.match(failed.error, /Insufficient GPU memory/);
	assert.equal(calls.length, 2);
	const recovered = await e.plugin.runAPIBackend("unsloth", { ...request(), apiConfig: config });
	assert.equal(recovered.text, "Recovered");
});

test("Stop cancels only Zusia's own Unsloth load and never starts a completion", async () => {
	const e = env();
	const calls = [];
	let rejectLoad, loading, kill;
	const started = new Promise(resolve => { loading = resolve; });
	e.window.Zotero.HTTP = { request: async (method, url, options) => {
		const body = options.body && JSON.parse(options.body);
		calls.push({ url, body });
		if (url.endsWith("/load")) {
			const promise = new Promise((resolve, reject) => { rejectLoad = reject; });
			options.cancellerReceiver(() => rejectLoad(new Error("cancelled")));
			loading();
			return promise;
		}
		return { status: 200, responseText: JSON.stringify(url.endsWith("/status") ? { loaded: [] } : { status: "unloaded" }) };
	} };
	const running = e.plugin.runAPIBackend("unsloth", { ...request(), apiConfig: config, onSpawn: handle => { kill = () => handle.kill(); } });
	await started;
	kill();
	await running;
	const load = calls.find(c => c.url.endsWith("/load"));
	const cancel = calls.find(c => c.url.endsWith("/unload"));
	assert.equal(cancel.body.cancel_load_request_id, load.body.load_request_id);
	assert.equal(cancel.body.model_path, "local-model");
	assert.ok(!calls.some(c => c.url.includes("/chat/completions")));
	assert.equal(cancel.body.force_cancel_active, undefined);
});

test("Unsloth verifies the selected model after a successful load response", async () => {
	const e = env();
	const calls = http(e, [{ json: { loaded: [] } }, { json: { status: "loaded" } }, { json: { loaded: ["wrong-model"] } }]);
	const result = await e.plugin.runAPIBackend("unsloth", { ...request(), apiConfig: config });
	assert.match(result.error, /did not load the selected model/);
	assert.equal(calls.length, 3);
});

test("Unsloth settings can load a model without generating an answer", async () => {
	const e = env();
	e.prefs[P + "unsloth.model"] = "local-model";
	e.prefs[P + "unsloth.api"] = JSON.stringify(config);
	const calls = http(e, [{ json: { loaded: [] } }, { json: {} }, { json: { loaded: ["local-model"] } }, { json: { data: [{ id: "local-model", loaded: true }] } }]);
	const panel = e.plugin.buildAPIAssistant(e.document, "unsloth");
	e.document.body.appendChild(panel);
	const load = [...panel.querySelectorAll("button")].find(b => b.textContent === "Load model");
	load.click();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(panel.querySelector(".zs-agent-status").textContent, "Model ready");
	assert.ok(!calls.some(c => c.url.includes("/chat/completions")));
});

test("API streaming handles fragmented SSE, CRLF, reasoning and preserves the selected model", async () => {
	const e = env();
	const stream = ": keepalive\r\n\r\n" + sse({ choices: [{ delta: { reasoning_content: "private thought" } }] }) + sse(answer("Caffè ")) + sse(answer("works")) + sse(done()) + "data: [DONE]\r\n\r\n";
	const calls = http(e, [{ chunks: [...stream].map(c => c) }]);
	const updates = [];
	const r = await e.plugin.runAPIBackend("openai", { ...request(), onProgress: u => updates.push(u) });
	assert.equal(r.text, "Caffè works");
	assert.equal(calls[0].body.model, "local-model");
	assert.equal(calls[0].options.logBodyLength, 0);
	assert.equal(calls[0].options.successCodes, false);
	assert.ok(!calls[0].options.headers.Authorization);
	assert.ok(!updates.some(u => (u.text || "").includes("private thought")));
	assert.equal(r.sessionId, undefined, "Chat Completions history is local, no server session assumed");
});

test("stateless API calls resend context and conversation even if a stale CLI session is supplied", async () => {
	const e = env({ stream: false });
	const calls = http(e, [{ json: { choices: [{ message: { content: "Answer" }, finish_reason: "stop" }] } }]);
	const req = request();
	req.history = [{ role: "user", text: "Earlier question" }, { role: "assistant", text: "Earlier answer" }];
	req.session = { id: "old", seen: 2, paper: { complete: true } };
	await e.plugin.runAPIBackend("openai", req);
	const text = JSON.stringify(calls[0].body.messages);
	assert.match(text, /Earlier question/);
	assert.match(text, /Attention uses keys/);
	assert.doesNotMatch(text, /NEED_PAGES|working directory|Read tool/);
});

test("API tools read only the current document, replay tool ids and stop at a bounded round", async () => {
	const e = env({ tools: true, stream: false });
	const calls = http(e, [
		{ json: { choices: [{ message: { content: null, tool_calls: [{ id: "read-1", type: "function", function: { name: "read_pages", arguments: '{"pages":[1]}' } }] }, finish_reason: "tool_calls" }] } },
		{ json: { choices: [{ message: { content: "Grounded answer (p. 1)" }, finish_reason: "stop" }] } },
	]);
	const r = await e.plugin.runAPIBackend("openai", request());
	assert.match(r.text, /Grounded answer/);
	assert.equal(calls.length, 2);
	const tool = calls[1].body.messages.find(m => m.role === "tool");
	assert.equal(tool.tool_call_id, "read-1");
	assert.match(tool.content, /Attention uses keys/);
	assert.match(e.plugin.executeAPITool("read_pages", { pages: [999] }, request().files), /error/i);
	assert.match(e.plugin.executeAPITool("exec", { command: "anything" }, request().files), /error/i);
	assert.match(e.plugin.executeAPITool("read_pages", { pages: [1] }, { fullText: { status: "off" } }), /unavailable|disabled/i);
	const unpaged = { fullText: { status: "ok", paged: false, pages: ["Attention uses keys and queries."] } };
	assert.match(e.plugin.executeAPITool("read_pages", { pages: [1] }, unpaged), /no PDF page/);
	assert.ok(!e.plugin.executeAPITool("search_paper", { query: "attention" }, unpaged).includes('"page"'));
});

test("API errors redact keys, report auth errors and never replay a failed generation automatically", async () => {
	const e = env({ auth: "bearer" });
	await e.plugin.setAPIKey("openai", config, "test-secret");
	const calls = http(e, [{ status: 401, json: { error: { message: "invalid test-secret" } } }]);
	const result = await e.plugin.runAPIBackend("openai", request());
	assert.match(result.error, /401/);
	assert.ok(!result.error.includes("test-secret"));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].options.headers.Authorization, "Bearer test-secret");
});

test("API context budget is conservative, keeps the question and applies on Windows too", async () => {
	const e = env({ contextTokens: 16384, outputTokens: 1024, stream: false });
	e.window.Zotero.isWin = true;
	const req = request();
	req.files.fullText.pages = Array.from({ length: 250 }, (_, i) => ("Attention page " + i + " ").repeat(500));
	req.files.focus = [123];
	req.history = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "Old conversation ".repeat(200) }));
	const messages = e.plugin.buildAPIMessages(req, e.plugin.getAPIConfig("openai"));
	assert.ok(e.plugin.apiInputSize(messages) < 15360);
	assert.match(messages.at(-1).content, /Explain attention/);
	assert.match(JSON.stringify(messages), /page 124/);
});

test("API capabilities are opt-in for the selected model and reset on a model change", () => {
	const e = env({ tools: true, vision: true, reasoning: true });
	assert.equal(e.plugin.getAPIConfig("openai").tools, true);
	e.prefs[P + "openai.model"] = "another-model";
	const c = e.plugin.getAPIConfig("openai");
	assert.equal(c.tools, false);
	assert.equal(c.vision, false);
	assert.equal(c.reasoning, false);
});

test("API supports an 8k local context with compact grounded instructions", () => {
	const e = env({ contextTokens: 8192, outputTokens: 1024 });
	const messages = e.plugin.buildAPIMessages(request(), e.plugin.getAPIConfig("openai"));
	assert.ok(e.plugin.apiInputSize(messages) + 1024 < 8192);
	assert.match(messages[0].content, /untrusted study material/);
	assert.match(messages.at(-1).content, /Explain attention/);
});

test("API persistent credentials use encryption and their own login realm", async () => {
	const e = env();
	let stored = null;
	e.window.Services.logins = {
		findLogins: async (host, form, realm) => stored && stored.realm === realm ? [stored] : [],
		addLoginAsync: async login => { stored = login; },
		modifyLoginAsync: async (old, login) => { stored = login; },
		removeLoginAsync: async () => { stored = null; },
	};
	e.window.Components = { interfaces: { nsILoginInfo: {} }, Constructor: function () {
		return function (host, form, realm, username, password) { return { host, realm, password }; };
	} };
	e.window.Zotero.OSKeyStore = { encrypt: async text => "encrypted:" + text, decrypt: async text => text.slice(10) };
	await e.plugin.setAPIKey("openai", config, "test-secret");
	assert.equal(stored.password, "encrypted:test-secret");
	assert.equal(stored.host, "chrome://zusia");
	assert.equal(await e.plugin.getAPIKey("openai", config), "test-secret");
	await e.plugin.setAPIKey("openai", config, "");
	assert.equal(stored, null);
});

test("native Zotero synchronous login-manager methods can replace and remove encrypted API keys", async () => {
	const e = env();
	let stored = null;
	e.window.Services.logins = {
		findLogins: () => stored ? [stored] : [],
		addLoginAsync: async login => { stored = login; },
		modifyLogin: (old, login) => { stored = login; },
		removeLogin: () => { stored = null; },
	};
	e.window.Components = { interfaces: { nsILoginInfo: {} }, Constructor: function () {
		return function (host, form, realm, username, password) { return { host, realm, password }; };
	} };
	e.window.Zotero.OSKeyStore = { encrypt: async key => "encrypted:" + key, decrypt: async text => text.slice(10) };
	await e.plugin.setAPIKey("openai", config, "first-test-key");
	await e.plugin.setAPIKey("openai", config, "replacement-test-key");
	assert.equal(await e.plugin.getAPIKey("openai", config), "replacement-test-key");
	assert.equal(stored.password, "encrypted:replacement-test-key");
	await e.plugin.setAPIKey("openai", config, "");
	assert.equal(stored, null);
	assert.ok(!JSON.stringify(e.prefs).includes("replacement-test-key"));
});

test("OpenAI's endpoint receives max_completion_tokens for modern reasoning models", async () => {
	const e = env({ baseURL: "https://api.openai.com/v1", stream: false });
	const calls = http(e, [{ json: { choices: [{ message: { content: "answer" }, finish_reason: "stop" }] } }]);
	await e.plugin.runAPIBackend("openai", request());
	assert.equal(calls[0].body.max_completion_tokens, 2048);
	assert.equal(calls[0].body.max_tokens, undefined);
});

test("API Stop before credentials finish prevents any HTTP request", async () => {
	const e = env();
	let kill;
	let release;
	e.plugin.apiHeaders = () => new Promise(resolve => { release = () => resolve({}); });
	const calls = http(e, []);
	const running = e.plugin.runAPIBackend("openai", { ...request(), onSpawn: p => { kill = () => p.kill(); } });
	kill(); release();
	const result = await running;
	assert.equal(calls.length, 0);
	assert.equal(result.text, "");
});

test("API streamed tool arguments assemble across events and are replayed with the correct id", async () => {
	const e = env({ tools: true });
	const calls = http(e, [
		{ chunks: [sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "tool-1", function: { name: "read_pages", arguments: '{"pag' } }] } }] }),
			sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'es":[1]}' } }] }, finish_reason: "tool_calls" }] })] },
		{ chunks: [sse(answer("Final")), sse(done())] },
	]);
	assert.equal((await e.plugin.runAPIBackend("openai", request())).text, "Final");
	assert.equal(calls[1].body.messages.at(-1).tool_call_id, "tool-1");
	assert.match(calls[1].body.messages.at(-1).content, /Attention/);
});

test("API tool loops are bounded and a truncated stream is never accepted as a complete answer", async () => {
	const e = env({ tools: true, stream: false });
	const looping = { choices: [{ message: { tool_calls: [{ id: "call", function: { name: "get_outline", arguments: "{}" } }] }, finish_reason: "tool_calls" }] };
	const calls = http(e, Array.from({ length: 5 }, () => ({ json: looping })));
	assert.match((await e.plugin.runAPIBackend("openai", request())).error, /tool limit/);
	assert.equal(calls.length, 5);
	const truncated = env();
	http(truncated, [{ chunks: [sse(answer("Partial"))] }]);
	assert.match((await truncated.plugin.runAPIBackend("openai", request())).error, /ended before/);
});

test("API settings save configuration, list server models and keep keys out of preferences", async () => {
	const e = env();
	const body = e.document.createElement("div");
	e.document.body.appendChild(body);
	e.plugin.renderPrefsPane(e.document, body);
	const panel = body.querySelector('[data-backend="openai"]');
	const input = label => [...panel.querySelectorAll(".zs-row")].find(r => r.querySelector("label")?.textContent === label).querySelector("input,select");
	const model = input("Model ID");
	model.value = "new-model";
	model.dispatchEvent(new e.window.Event("change"));
	assert.equal(e.plugin.getModel("openai"), "new-model");
	const key = input("API key");
	key.value = "local-test-secret";
	[...panel.querySelectorAll("button")].find(b => b.textContent === "Save key").click();
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(key.value, "");
	assert.ok(!JSON.stringify(e.prefs).includes("local-test-secret"));
	http(e, [{ json: { data: [{ id: "loaded-model", loaded: true }] } }]);
	[...panel.querySelectorAll("button")].find(b => b.textContent === "Check connection and list models").click();
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.match(panel.querySelector(".zs-agent-status").textContent, /Connected/);
	const select = input("Server models");
	select.value = "loaded-model";
	select.dispatchEvent(new e.window.Event("change"));
	assert.equal(e.plugin.getModel("openai"), "loaded-model");
});

test("API memory uses the selected endpoint and model with document tools disabled", async () => {
	const e = env({ tools: true, stream: false });
	const calls = http(e, [{ json: { choices: [{ message: { content: '{"summary":"memory"}' }, finish_reason: "stop" }] } }]);
	const result = await e.runBackgroundCall.call(e.plugin, "openai", "Update memory");
	assert.equal(result.text, '{"summary":"memory"}');
	assert.equal(calls[0].body.model, "local-model");
	assert.equal(calls[0].body.tools, undefined);
});
