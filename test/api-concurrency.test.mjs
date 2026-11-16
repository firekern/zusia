import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const P = "extensions.zusia.", baseURL = "https://fixture.invalid/v1";
const config = { baseURL, auth: "none", contextTokens: 8192, outputTokens: 1024, stream: false };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(complete = () => {}) {
	const e = loadPlugin({ prefs: { [P + "backend"]: "unsloth", [P + "unsloth.model"]: "A", [P + "unsloth.api"]: JSON.stringify(config) } });
	const p = e.plugin, events = [];
	let active = "A", context = 8192;
	e.window.Zotero.HTTP = { request: async (_method, url, options) => {
		const path = new URL(url).pathname, body = options.body && JSON.parse(options.body);
		let value, status = 200;
		if (path === "/api/inference/status") value = { active_model: active, loaded: [active], context_length: context };
		else if (path === "/api/settings/openai-auto-switch/overrides") value = { resolved: {} };
		else if (path === "/api/inference/load") { active = body.model_path; context = body.max_seq_length || 8192; events.push("load " + active + " " + context); value = {}; }
		else if (path === "/v1/props") value = { default_generation_settings: { n_ctx: context } };
		else if (path === "/v1/chat/count_tokens") value = { model: active, input_tokens: 10 };
		else if (path === "/v1/chat/completions") {
			events.push("start " + body.model);
			let reply = await complete({ body, options, active });
			events.push("finish " + body.model);
			status = active === body.model ? 200 : 409;
			value = status === 200 ? reply || { choices: [{ message: { content: "Answer " + active }, finish_reason: "stop" }] } : { detail: "Requested model is not loaded" };
		}
		else throw new Error("Unexpected path " + path);
		return { status, responseText: JSON.stringify(value) };
	} };
	const run = (model = "A", extra = {}) => p.runBackend("unsloth", { model, apiConfig: config, messages: [{ role: "user", content: "Question" }], ...extra });
	return { ...e, run, events };
}

test("different Unsloth models cannot replace each other during concurrent requests", async () => {
	const e = fixture();
	const results = await Promise.all([e.run("A"), e.run("B")]);
	assert.deepEqual(results.map(r => r.text), ["Answer A", "Answer B"]);
	assert.ok(e.events.indexOf("finish A") < e.events.indexOf("load B 8192"));
	e.window.close();
});

test("requests for the same Unsloth model and profile retain parallel generation", { timeout: 5000 }, async () => {
	let arrived = 0; const both = deferred();
	const e = fixture(async () => { if (++arrived === 2) both.resolve(); await both.promise; });
	const results = await Promise.all([e.run(), e.run()]);
	assert.ok(results.every(r => r.text === "Answer A"));
	assert.deepEqual(e.events.slice(0, 2), ["start A", "start A"]);
	e.window.close();
});

test("a queued model switch can be cancelled without accessing credentials or loading it", { timeout: 5000 }, async () => {
	const started = deferred(), finish = deferred(), queued = deferred();
	const e = fixture(async ({ body }) => { if (body.model === "A") { started.resolve(); await finish.promise; } });
	const first = e.run(); await started.promise;
	let credentialsAccessed = false;
	e.plugin.getAPIKey = async () => { credentialsAccessed = true; throw new Error("Cancelled requests must not access the key store"); };
	let kill;
	const second = e.run("B", { apiConfig: { ...config, auth: "bearer" }, onSpawn: proc => { kill = () => proc.kill(); }, onProgress: update => { if (/waiting/i.test(update.status || "")) queued.resolve(); } });
	await queued.promise; kill();
	const stopped = await second;
	assert.equal(stopped.cancelled, true); assert.equal(stopped.stopped, true);
	assert.equal(credentialsAccessed, false);
	finish.resolve(); assert.equal((await first).text, "Answer A");
	assert.ok(!e.events.some(s => s.startsWith("load B")));
	e.window.close();
});

test("connection leases are isolated by normalized endpoint", async () => {
	const e = fixture(), p = e.plugin;
	const first = await p.acquireUnslothConnection(config, "A", { cancelled: false });
	const second = await p.acquireUnslothConnection({ ...config, baseURL: "https://other.invalid/v1" }, "B", { cancelled: false });
	assert.equal(p._apiConnections.size, 2);
	first(); second(); assert.equal(p._apiConnections.size, 0);
	e.window.close();
});

test("later same-model requests cannot starve a queued model switch", async () => {
	const e = fixture(), p = e.plugin, order = [];
	const first = await p.acquireUnslothConnection(config, "A", { cancelled: false });
	const second = p.acquireUnslothConnection(config, "B", { cancelled: false }).then(release => { order.push("B"); return release; });
	const third = p.acquireUnslothConnection(config, "A", { cancelled: false }).then(release => { order.push("A"); return release; });
	first(); const releaseSecond = await second;
	assert.deepEqual(order, ["B"]);
	releaseSecond(); (await third)();
	assert.deepEqual(order, ["B", "A"]); assert.equal(p._apiConnections.size, 0);
	e.window.close();
});

test("Settings cannot reload a model profile until the active answer is finished", { timeout: 5000 }, async () => {
	const started = deferred(), finish = deferred(), queued = deferred();
	const e = fixture(async () => { started.resolve(); await finish.promise; });
	const first = e.run(); await started.promise;
	const custom = { ...config, profiles: { [e.plugin.apiProfileKey(config, "A")]: { mode: "custom", overrides: { contextTokens: 16384 } } } };
	const loaded = e.plugin.prepareAPIModel("unsloth", "A", custom, { onProgress: update => { if (/waiting/i.test(update.status || "")) queued.resolve(); } });
	await queued.promise; assert.ok(!e.events.some(s => s.startsWith("load")));
	finish.resolve(); await first;
	assert.equal((await loaded).contextTokens, 16384);
	assert.ok(e.events.indexOf("finish A") < e.events.indexOf("load A 16384"));
	e.window.close();
});

test("a failed request releases its connection for the next model", async () => {
	const e = fixture(({ body }) => { if (body.model === "A") throw new Error("socket closed"); });
	const results = await Promise.all([e.run(), e.run("B")]);
	assert.ok(results[0].error); assert.equal(results[1].text, "Answer B");
	assert.equal(e.plugin._apiConnections?.size || 0, 0);
	e.window.close();
});

test("a model switch also waits for document tool replay and the final answer", { timeout: 5000 }, async () => {
	const finalRound = deferred(), finish = deferred(), queued = deferred();
	let rounds = 0;
	const e = fixture(async ({ body }) => {
		if (body.model !== "A") return;
		if (++rounds === 1) return { choices: [{ message: { tool_calls: [{ id: "read", type: "function", function: { name: "read_pages", arguments: '{"pages":[1]}' } }] }, finish_reason: "tool_calls" }] };
		assert.ok(body.messages.some(m => m.role === "tool"));
		finalRound.resolve(); await finish.promise;
	});
	const first = e.run("A", { apiConfig: { ...config, tools: true, capabilityModel: "A" }, messages: undefined,
		question: "Explain", files: { metadata: "Paper", fullText: { status: "ok", paged: true, pages: ["Evidence"] } } });
	await finalRound.promise;
	const second = e.run("B", { onProgress: update => { if (/waiting/i.test(update.status || "")) queued.resolve(); } });
	await queued.promise; assert.ok(!e.events.some(s => s.startsWith("load B")));
	finish.resolve(); assert.deepEqual((await Promise.all([first, second])).map(r => r.text), ["Answer A", "Answer B"]);
	e.window.close();
});

test("shutdown stops both active and queued API connection work", { timeout: 5000 }, async () => {
	const started = deferred(), queued = deferred();
	const e = fixture(({ options }) => new Promise((_resolve, reject) => { options.cancellerReceiver(() => reject(new Error("cancelled"))); started.resolve(); }));
	const first = e.run(); await started.promise;
	const second = e.run("B", { onProgress: update => { if (/waiting/i.test(update.status || "")) queued.resolve(); } });
	await queued.promise; e.plugin.stopAPIConnections();
	const results = await Promise.all([first, second]);
	assert.ok(results.every(r => r.cancelled));
	assert.ok(!e.events.some(s => s.startsWith("load B")));
	assert.equal(e.plugin._apiConnections.size, 0);
	e.window.close();
});

test("shutdown also stops HTTP assistants without an Unsloth lease and marks chat cancellation", { timeout: 5000 }, async () => {
	const started = deferred();
	const e = fixture(({ options }) => new Promise((_resolve, reject) => { options.cancellerReceiver(() => reject(new Error("cancelled"))); started.resolve(); }));
	let chatCancelled = false;
	e.plugin._pending.set("/chat", { backend: "openai", cancel: () => { chatCancelled = true; throw new Error("A closing view is detached"); } });
	const result = e.plugin.runBackend("openai", { model: "A", apiConfig: config, messages: [{ role: "user", content: "Question" }] });
	await started.promise; assert.doesNotThrow(() => e.plugin.stopAPIConnections());
	assert.equal((await result).cancelled, true); assert.equal(chatCancelled, true);
	assert.equal(e.plugin._apiRequestControls.size, 0);
	e.window.close();
});
