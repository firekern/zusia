import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const P = "extensions.zusia.", model = "small-context-model", baseURL = "http://fixture.invalid/v1";
function setup(backend = "ollama", { tokenizer = false, unicode = false } = {}) {
	const e = loadPlugin({ prefs: { [P + "backend"]: backend, [P + backend + ".model"]: model,
		[P + backend + ".api"]: JSON.stringify({ baseURL, auth: "none", contextTokens: 32768, outputTokens: 2048, stream: false }),
		[P + "memory.gists"]: true } });
	const p = e.plugin, calls = [];
	p.runBackgroundCall = e.runBackgroundCall;
	p._jobsStopped = true;
	p.refreshReadingChips = () => {};
	e.window.Zotero.HTTP = { request: async (method, url, options) => {
		const path = new URL(url).pathname, body = options.body && JSON.parse(options.body);
		calls.push({ path, body });
		let value, status = 200;
		if (path === "/api/show") value = { parameters: "num_ctx 8192", capabilities: ["completion"] };
		else if (path === "/api/ps") value = { models: [{ name: model + ":latest", context_length: 8192 }] };
		else if (path === "/api/inference/status") value = { active_model: model, loaded: [model], context_length: 8192, supports_tools: false, is_vision: false };
		else if (path === "/api/settings/openai-auto-switch/overrides") value = { resolved: {} };
		else if (path === "/v1/props") value = { default_generation_settings: { n_ctx: 8192 } };
		else if (path === "/v1/chat/count_tokens") {
			status = tokenizer ? 200 : 503;
			value = tokenizer ? { model, input_tokens: Math.ceil(p.apiInputSize(body.messages) / 2) } : { error: "Tokenizer busy" };
		}
		else if (path === "/api/chat" || path === "/v1/chat/completions") {
			assert.ok(p.apiInputSize(body.messages) + 2048 <= 8192, "background input fits even without a tokenizer");
			const prompt = body.messages.at(-1).content;
			assert.doesNotMatch(body.messages[0].content, /Return only the requested JSON/, "the system message respects a gist's prose output format");
			const text = prompt.includes("<conversation_turns>") ? '{"summary":"Updated reading memory."}' : "A short section summary.";
			value = path === "/api/chat" ? { model, message: { content: text }, done: true, done_reason: "stop" } :
				{ model, choices: [{ message: { content: text }, finish_reason: "stop" }] };
		}
		else throw new Error("Unexpected route " + path);
		return { status, responseText: JSON.stringify(value) };
	} };
	const text = unicode ? "阅读与理解。".repeat(1000) : "Long study discussion with detailed evidence. ".repeat(150);
	e.files.set("/d/chat.json", JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text }))));
	p.cachedStructure = async () => null;
	p.loadProgress = async () => null;
	return { ...e, calls, text };
}

for (const [backend, options] of [["ollama", {}], ["unsloth", { tokenizer: true }], ["unsloth", { unicode: true }]]) {
	test(`${backend}: memory batches follow 8192 native context${options.tokenizer ? " with tokenizer" : " with conservative fallback"}${options.unicode ? " and Unicode" : ""}`, async () => {
		const e = setup(backend, options), p = e.plugin;
		if (options.unicode) {
			e.files.set("/d/memory.json", JSON.stringify({ summary: e.text.slice(0, 1500), items: Array.from({ length: 30 }, (_, i) => ({ id: "m" + i, kind: "open", text: e.text.slice(0, 280) })) }));
			p.cachedStructure = async () => ({ pageCount: 40, labels: [], confidence: 0, outlineMethod: "native",
				outline: Array.from({ length: 40 }, (_, i) => ({ id: "section-" + i, title: "章节与阅读背景".repeat(10), start: i, end: i, level: 1 })) });
		}
		for (let attempt = 0; attempt < 12 && (await p.loadMemory("/d")).coveredThrough < 11; attempt++) {
			await p.consolidateMemory({ dir: "/d" });
			assert.equal(p._memoryFailed.has("/d"), false);
		}
		assert.equal((await p.loadMemory("/d")).coveredThrough, 11, "all turns are folded in without skipping a pair");
		assert.equal((await p.loadMemory("/d")).summary, "Updated reading memory.");
		if (options.unicode) assert.equal((await p.loadMemory("/d")).items.length, 30, "orientation trimming does not delete saved memory items");
		assert.ok(e.calls.some(c => c.path === (backend === "ollama" ? "/api/chat" : "/v1/chat/completions")));
		e.window.close();
	});
}

test("native context also bounds leaf gists and merged chapter summaries", async () => {
	const e = setup(), p = e.plugin;
	const pages = Array.from({ length: 24 }, () => e.text);
	const outline = [{ id: "chapter", title: "Chapter", start: 0, end: 23, level: 1 },
		...pages.map((_, i) => ({ id: "section-" + i, title: "Section " + i, start: i, end: i, level: 2 }))];
	const structure = { pageCount: 24, outline, labels: [], confidence: 0 };
	p.cachedStructure = async () => structure;
	e.files.set("/d/cache/pages.json", JSON.stringify({ pages }));
	await p.gistSection({ dir: "/d" }, "section-0");
	let saved = await p.loadGists("/d");
	assert.equal(saved.sections["section-0"]?.text, "A short section summary.");
	for (const entry of outline.slice(1)) saved.sections[entry.id] = { hash: e.map.sectionHash(pages, entry), text: "A previous section summary. ".repeat(30) };
	e.files.set("/d/gists.json", JSON.stringify(saved));
	await p.gistSection({ dir: "/d" }, "chapter");
	assert.equal((await p.loadGists("/d")).sections.chapter?.text, "A short section summary.");
	assert.equal(p._gistFailed.size, 0);
	e.window.close();
});

test("stopping background model preparation never builds or sends the pending memory prompt", async () => {
	const e = setup(), p = e.plugin, job = { cancelled: false, proc: null };
	const http = e.window.Zotero.HTTP.request;
	e.window.Zotero.HTTP.request = async (...args) => {
		job.cancelled = true;
		job.proc.kill();
		return http(...args);
	};
	await p.consolidateMemory({ dir: "/d" }, { job });
	assert.equal(e.calls.some(c => c.path === "/api/chat"), false);
	assert.equal(p._memoryFailed.has("/d"), false);
	assert.equal((await p.loadMemory("/d")).coveredThrough, -1);
	assert.equal(job.proc, null);
	e.window.close();
});
