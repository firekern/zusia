// What the review of the API assistants found: lost chats, budgets that cannot answer,
// fixed time limits and memory jobs that fail without saying so.
import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, openChat } from "./load-plugin.mjs";

const P = "extensions.zusia.";
const env = (backend, api = {}, model = "m", extra = {}) => loadPlugin({ prefs: { [P + "onboarded"]: true, [P + "backend"]: backend,
	[P + backend + ".model"]: model, [P + backend + ".api"]: JSON.stringify({ auth: "none", ...api }), ...extra } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// About one printed page each.
const paper = count => Array.from({ length: count }, (_, i) => `Page ${i + 1}. ` + "Attention uses queries, keys and values to weigh the evidence. ".repeat(56));
const request = (pages = paper(20)) => ({ model: "m", question: "Explain the main theorem", history: [], images: [], effort: "", onSpawn() {}, onProgress() {},
	files: { metadata: "# Paper", annotations: "", focus: [3], query: "theorem", fullText: { status: "ok", paged: true, pages } } });
const kept = messages => Number(/Selected excerpts: (\d+) of/.exec(messages.at(-1).content)[1]);

function server(e, handler) {
	const calls = [];
	e.window.Zotero.HTTP = { request: async (method, url, options) => {
		const call = { method, path: new URL(url).pathname, body: options.body && JSON.parse(options.body), options };
		calls.push(call);
		const reply = await handler(call);
		assert.ok(reply, "unexpected " + call.path);
		const xhr = new e.window.EventTarget();
		Object.assign(xhr, { status: reply.status || 200, responseText: "" });
		options.requestObserver?.(xhr);
		for (const chunk of reply.chunks || []) {
			xhr.responseText += chunk;
			xhr.dispatchEvent(new e.window.Event("progress"));
		}
		if (reply.json) xhr.responseText = JSON.stringify(reply.json);
		return xhr;
	} };
	return calls;
}

test("retry keeps the last exchange when the API assistant has no model", async () => {
	const e = env("ollama", {}, "");
	e.files.set("/d/chat.json", JSON.stringify([{ role: "user", text: "Why?" }, { role: "assistant", text: "Because." }]));
	const { view } = openChat(e);
	await e.plugin.retry(view, 1);
	assert.equal(JSON.parse(e.files.get("/d/chat.json")).length, 2, "nothing is dropped before a request can start");
	assert.match(view.logEl.querySelector(".zs-error").textContent, /Choose.*model/);
	e.window.close();
});

test("the smallest context the plugin accepts can answer with the default output budget", () => {
	const e = env("ollama"), p = e.plugin;
	const config = { ...p.getAPIConfig("ollama"), contextTokens: 8192 };
	assert.equal(config.outputTokens, 2048);
	const messages = p.buildAPIMessages(request(), config);
	assert.ok(kept(messages) >= 1);
	assert.ok(p.apiInputSize(messages) + config.outputTokens <= config.contextTokens, "and what it builds passes its own guard");
	e.window.close();
});

test("the input estimate is cautious but no longer counts a byte as a token", () => {
	const e = env("openai"), p = e.plugin;
	const tokens = p.apiInputSize([{ role: "user", content: "word ".repeat(2000) }]);
	// English runs near four bytes a token: the estimate stays above that and well under one a byte.
	assert.ok(tokens > 10000 / 4 && tokens < 10000 / 2, String(tokens));
	const config = { ...p.getAPIConfig("openai"), contextTokens: 32768 };
	const messages = p.buildAPIMessages(request(), config);
	assert.ok(kept(messages) >= 14, "a 32k context carries most of a 20-page paper, got " + kept(messages));
	assert.ok(p.apiInputSize(messages) + config.outputTokens <= config.contextTokens);
	e.window.close();
});

test("Ollama on its own default context is asked for the minimum instead of being refused", async () => {
	const e = env("ollama"), p = e.plugin;
	let context = 4096;
	const calls = server(e, call => {
		if (call.path === "/api/show") return { json: { capabilities: ["completion"] } };
		if (call.path === "/api/ps") return { json: { models: [{ name: "m:latest", context_length: context }] } };
		if (call.path === "/api/chat") { context = call.body.options.num_ctx; return { json: { done: true } }; }
	});
	const prepared = await p.prepareAPIModel("ollama", "m", p.getAPIConfig("ollama"));
	assert.equal(calls.find(c => c.path === "/api/chat").body.options.num_ctx, 8192);
	assert.equal(prepared.contextTokens, 8192);
	assert.equal(prepared.runtimeProfile.options.num_ctx, 8192, "the answer is asked for with the same context, so nothing reloads");
	e.window.close();
});

test("an Ollama model that is loaded with room to spare is used as it is, without a warm-up call", async () => {
	const e = env("ollama"), p = e.plugin;
	const calls = server(e, call => {
		if (call.path === "/api/show") return { json: { capabilities: ["completion"] } };
		if (call.path === "/api/ps") return { json: { models: [{ name: "m:latest", context_length: 32768 }] } };
	});
	const prepared = await p.prepareAPIModel("ollama", "m", p.getAPIConfig("ollama"));
	assert.ok(!calls.some(c => c.path === "/api/chat"));
	assert.equal(prepared.contextTokens, 32768);
	assert.equal(prepared.runtimeProfile.options.num_ctx, 32768);
	e.window.close();
});

test("a context the Modelfile sets below the minimum is still refused, since that is the user's choice", async () => {
	const e = env("ollama"), p = e.plugin;
	server(e, call => {
		if (call.path === "/api/show") return { json: { parameters: "num_ctx 4096" } };
		if (call.path === "/api/ps") return { json: { models: [{ name: "m:latest", context_length: 4096 }] } };
		if (call.path === "/api/chat") return { json: { done: true } };
	});
	await assert.rejects(p.prepareAPIModel("ollama", "m", p.getAPIConfig("ollama")), /4096.*8192/);
	e.window.close();
});

// A request whose progress the test drives by hand.
function manual(e) {
	const state = { cancelled: false };
	e.window.Zotero.HTTP = { request: (method, url, options) => new Promise((resolve, reject) => {
		const xhr = new e.window.EventTarget();
		Object.assign(xhr, { status: 200, responseText: "" });
		options.requestObserver?.(xhr);
		options.cancellerReceiver?.(() => { state.cancelled = true; reject(new Error("cancelled")); });
		Object.assign(state, { options, resolve: () => resolve(xhr), send(chunk) { xhr.responseText += chunk; xhr.dispatchEvent(new e.window.Event("progress")); } });
	}) };
	return state;
}
const quick = e => { e.window.Zotero.Promise.delay = ms => pause(Math.min(ms, 5)); };

test("a streamed answer has no fixed time limit: only silence ends it", async () => {
	const e = env("openai", { baseURL: "https://api.example/v1" }), p = e.plugin, state = manual(e);
	quick(e);
	p.API_IDLE_MS = 60;
	let chunks = 0;
	const answer = p.apiHTTPRequest("openai", p.getAPIConfig("openai"), "/chat/completions", { body: {}, headers: {}, slow: true, onChunk: () => { chunks++; } });
	await pause(0);
	assert.equal(state.options.timeout, 0, "Zotero's limit counts the whole request, so it is switched off");
	for (let i = 0; i < 12; i++) { await pause(20); state.send("x"); }
	assert.equal(state.cancelled, false, "four times the silence limit, and still running");
	state.resolve();
	await answer;
	assert.equal(chunks, 12);
	e.window.close();
});

test("a server that goes silent is cancelled, and the error says so", async () => {
	const e = env("openai", { baseURL: "https://api.example/v1" }), p = e.plugin, state = manual(e);
	quick(e);
	p.API_IDLE_MS = 30;
	await assert.rejects(p.apiHTTPRequest("openai", p.getAPIConfig("openai"), "/chat/completions", { body: {}, headers: {}, slow: true, onChunk() {} }), /sent nothing/);
	assert.equal(state.cancelled, true);
	e.window.close();
});

test("a status call keeps a short limit of its own", async () => {
	const e = env("openai", { baseURL: "https://api.example/v1" }), p = e.plugin;
	const calls = server(e, () => ({ json: { data: [] } }));
	await p.loadAPIModels("openai");
	assert.equal(calls[0].options.timeout, 60000);
	e.window.close();
});

test("a broken stream is cancelled at once and reported for what it is", async () => {
	const e = env("openai", { baseURL: "https://api.example/v1", stream: true }), p = e.plugin, state = manual(e);
	const result = p.runAPIBackend("openai", request());
	for (let i = 0; i < 20 && !state.send; i++) await pause(5);
	state.send("data: not json\n\n");
	const settled = await Promise.race([result, pause(300).then(() => "still waiting")]);
	assert.equal(state.cancelled, true, "the server is not left generating");
	assert.match(settled.error, /Invalid API stream/);
	e.window.close();
});

test("an answer cut at the output limit is kept and marked, not thrown away", async () => {
	const e = env("openai", { baseURL: "https://api.example/v1", stream: false }), p = e.plugin;
	let content = "Half an answ";
	server(e, () => ({ json: { choices: [{ message: { content }, finish_reason: "length" }] } }));
	const result = await p.runAPIBackend("openai", request());
	assert.equal(result.text, "Half an answ");
	assert.equal(result.truncated, true);
	assert.equal(result.error, undefined);
	content = "";
	assert.match((await p.runAPIBackend("openai", request())).error, /output/, "with nothing written there is nothing to keep");
	e.window.close();
});

function memory(outputTokens) {
	const e = env("ollama", { baseURL: "https://fixture.invalid/v1", outputTokens, stream: false }, "m", { [P + "memory.gists"]: true }), p = e.plugin;
	p.runBackgroundCall = e.runBackgroundCall;
	p._jobsStopped = true;
	p.refreshReadingChips = () => {};
	p.cachedStructure = async () => null;
	p.loadProgress = async () => null;
	const calls = server(e, call => {
		if (call.path === "/api/show") return { json: { parameters: "num_ctx 8192", capabilities: ["completion"] } };
		if (call.path === "/api/ps") return { json: { models: [{ name: "m:latest", context_length: 8192 }] } };
		if (call.path === "/api/chat") return { json: { message: { content: '{"summary":"Updated."}' }, done: true, done_reason: "stop" } };
	});
	e.files.set("/d/chat.json", JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "A long study discussion. ".repeat(60) }))));
	return { ...e, calls };
}

test("a memory update that has no room records its failure instead of crashing", async () => {
	const e = memory(7000), p = e.plugin;
	const result = await p.consolidateMemory({ dir: "/d" });
	assert.equal(result.called, true);
	assert.ok(p._memoryFailed.has("/d"), "so the same call is not repeated every few questions");
	assert.ok(!e.calls.some(c => c.path === "/api/chat" && c.body.messages.length), "and nothing is sent");
	e.window.close();
});

test("a section summary is never asked for without the section's text", () => {
	const e = memory(7000), p = e.plugin;
	const config = { contextTokens: 8192, outputTokens: 7000 };
	const entry = { id: "s1", title: "Method", start: 0, end: 0, level: 1 };
	assert.throws(() => p.gistPrompt(entry, ["Section text. ".repeat(400)], null, null, "ollama", config), /context budget/);
	assert.throws(() => p.gistMergePrompt(entry, [{ entry, text: "A summary. ".repeat(400) }], null, "ollama", config), /context budget/);
	assert.match(p.gistPrompt(entry, ["Section text. ".repeat(400)], null, null, "ollama", { contextTokens: 8192, outputTokens: 2048 }), /Section text/);
	e.window.close();
});

function unsloth() {
	const config = { baseURL: "https://fixture.invalid/v1", auth: "none", contextTokens: 8192, outputTokens: 1024, stream: false };
	const e = env("unsloth", config, "A"), p = e.plugin, events = [], gate = deferred();
	let active = "B";
	server(e, async call => {
		if (call.path === "/api/inference/status") return { json: { active_model: active, loaded: [active], context_length: 8192 } };
		if (call.path === "/api/settings/openai-auto-switch/overrides") return { json: { resolved: {} } };
		if (call.path === "/api/inference/load") { events.push("load"); await gate.promise; active = call.body.model_path; return { json: {} }; }
		if (call.path === "/v1/props") return { json: { default_generation_settings: { n_ctx: 8192 } } };
		if (call.path === "/v1/chat/count_tokens") return { json: { model: active, input_tokens: 10 } };
		if (call.path === "/v1/chat/completions") return { json: { choices: [{ message: { content: "Answer " + active }, finish_reason: "stop" }] } };
	});
	const run = (extra = {}) => p.runBackend("unsloth", { model: "A", apiConfig: config, messages: [{ role: "user", content: "Question" }], ...extra });
	return { ...e, run, events, gate };
}

test("Stop works while a request waits for another one's Unsloth model load", async () => {
	const e = unsloth();
	let handle;
	const first = e.run();
	const second = e.run({ onSpawn: h => { handle = h; } });
	for (let i = 0; i < 20 && !e.events.length; i++) await pause(5);
	await pause(10);
	handle.kill();
	const stopped = await Promise.race([second, pause(200).then(() => "still waiting")]);
	assert.equal(stopped.cancelled, true, "without waiting for the load");
	const third = e.run();
	await pause(20);
	assert.deepEqual(e.events, ["load"], "and a later request still queues behind the load that is running");
	e.gate.resolve();
	assert.equal((await first).text, "Answer A");
	assert.equal((await third).text, "Answer A");
	assert.deepEqual(e.events, ["load"]);
	e.window.close();
});

test("the status line and the request agree on when an Unsloth model is loaded", async () => {
	const e = env("unsloth", { baseURL: "https://fixture.invalid/v1" }, "org/model"), p = e.plugin;
	server(e, call => {
		if (call.path === "/api/inference/status") return { json: { model_identifier: "/models/org--model.gguf", active_model: "other", loaded: ["org/model"], context_length: 8192 } };
		if (call.path === "/v1/props") return { json: { default_generation_settings: { n_ctx: 8192 } } };
	});
	assert.equal(p.unslothModelReady({ loaded: ["a"] }, "a"), true);
	assert.equal(p.unslothModelReady({ active_model: "b", model_identifier: "c" }, "a"), false);
	const state = await p.refreshAPIRuntime("unsloth", { force: true });
	assert.equal(state.loaded, true);
	assert.equal(state.actualModel, "org/model");
	e.window.close();
});
