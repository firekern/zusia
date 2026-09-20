import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const { plugin } = loadPlugin();
const base = { ctx: { dir: "/tmp/p" }, question: "Why?", history: [], session: null, files: { metadata: "# T\n", annotations: "- [highlight] p.2 key idea" } };
const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test("claude: model and effort flags only when chosen", () => {
	let args = plugin.claudeArgs(base);
	assert.ok(!args.includes("--model") && !args.includes("--effort"));
	args = plugin.claudeArgs({ ...base, model: "opus", effort: "max", session: { id: "s1", seen: 0 } });
	assert.equal(valueAfter(args, "--model"), "opus");
	assert.equal(valueAfter(args, "--effort"), "max");
	assert.equal(valueAfter(args, "--resume"), "s1");
	assert.equal(valueAfter(args, "--setting-sources"), "");
});

test("codex: -m and model_reasoning_effort go before resume", () => {
	const args = plugin.codexArgs({ ...base, model: "gpt-5.5", effort: "xhigh", session: { id: "t1", seen: 0 } });
	assert.equal(valueAfter(args, "-m"), "gpt-5.5");
	assert.equal(valueAfter(args, "-c"), 'model_reasoning_effort="xhigh"');
	assert.ok(args.indexOf("-c") < args.indexOf("resume"));
	assert.equal(valueAfter(args, "resume"), "t1");
});

test("antigravity: --model and --effort precede the prompt", () => {
	const args = plugin.antigravityArgs({ ...base, model: "gemini-3.1-pro-high", effort: "low" });
	assert.equal(valueAfter(args, "--model"), "gemini-3.1-pro-high");
	assert.equal(valueAfter(args, "--effort"), "low");
	assert.ok(args[args.length - 1].startsWith("--print="));
});

test("every backend offers only efforts its CLI accepts", () => {
	assert.deepEqual([...plugin.BACKENDS.claude.efforts], ["", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual([...plugin.BACKENDS.codex.efforts], ["", "low", "medium", "high", "xhigh"]);
	assert.deepEqual([...plugin.BACKENDS.agy.efforts], ["", "low", "medium", "high"]);
	for (const backend of Object.values(plugin.BACKENDS)) {
		for (const effort of backend.efforts) {
			assert.ok(plugin.EFFORTS[effort], "label for " + effort);
		}
	}
});

function fakeStore(p) {
	const store = { history: [], sessions: {} };
	p.exportContext = async () => base.files;
	p.loadHistory = async () => JSON.parse(JSON.stringify(store.history));
	p.appendHistory = async (dir, msgs) => { store.history.push(...msgs); };
	p.loadSessions = async () => ({ ...store.sessions });
	p.saveSessions = async (dir, s) => { store.sessions = s; };
	return store;
}
function pendingFor(p, backend = "claude") {
	const pending = { backend, model: "opus", effort: "high", partial: "", cancelled: false, proc: null, listeners: new Set() };
	pending.progress = ({ text }) => { if (text !== undefined) pending.partial = text; };
	return pending;
}

test("stopping mid-answer keeps what was written, marked as stopped, and does not retry", async () => {
	const { plugin: p } = loadPlugin();
	const store = fakeStore(p);
	let runs = 0;
	const pending = pendingFor(p);
	p.runBackend = async (backend, request) => {
		runs++;
		assert.equal(request.model, "opus");
		assert.equal(request.effort, "high");
		request.onProgress({ text: "Partial answer with $x$" });
		pending.cancelled = true;
		return { text: "", error: "killed", resumeFailed: true };
	};
	store.sessions = { claude: { id: "s1", seen: 0 } };
	const result = await p.ask(base.ctx, "Why?", pending);
	assert.deepEqual({ ...result }, {});
	assert.equal(runs, 1, "a stopped run is not retried as a new session");
	const answer = store.history[1];
	assert.equal(answer.text, "Partial answer with $x$");
	assert.equal(answer.stopped, true);
	assert.equal(answer.model, "opus");
	assert.equal(answer.effort, "high");
});

test("stopping before any text returns cancelled and saves nothing", async () => {
	const { plugin: p } = loadPlugin();
	const store = fakeStore(p);
	const pending = pendingFor(p);
	p.runBackend = async () => {
		pending.cancelled = true;
		return { text: "", error: "killed" };
	};
	const result = await p.ask(base.ctx, "Why?", pending);
	assert.equal(result.cancelled, true);
	assert.equal(store.history.length, 0);
});

test("a spawned process is killed at once if Stop came first", async () => {
	const { plugin: p } = loadPlugin();
	fakeStore(p);
	const pending = pendingFor(p);
	pending.cancelled = true;
	let killed = false;
	p.runBackend = async (backend, request) => {
		request.onSpawn({ kill: () => { killed = true; } });
		return { text: "" };
	};
	await p.ask(base.ctx, "Why?", pending);
	assert.ok(killed);
});

test("tool calls become readable activity steps", () => {
	assert.deepEqual({ ...plugin.describeTool("Read", { file_path: "/home/u/Zotero/zusia/1-AB/paper.txt" }) },
		{ kind: "read", target: "paper.txt", label: "Read paper.txt" });
	assert.equal(plugin.describeTool("Grep", { pattern: "Fourier", path: "/x/paper.txt" }).label, "Searched for “Fourier” in paper.txt");
	assert.equal(plugin.describeTool("Glob", { pattern: "*.md" }).label, "Looked for files matching *.md");
	assert.equal(plugin.describeTool("view_file", { AbsolutePath: "/a/metadata.md" }).label, "Read metadata.md");
	assert.equal(plugin.describeTool("exec", { command: "sed -n 1,80p paper.txt" }).label, "Ran sed -n 1,80p paper.txt");
});

test("activity summary counts reads, searches and thinking time", () => {
	const steps = [
		{ kind: "read", target: "paper.txt", label: "Read paper.txt" },
		{ kind: "search", target: "FFT", label: "Searched for “FFT”" },
		{ kind: "read", target: "paper.txt", label: "Read paper.txt" },
		{ kind: "search", target: "DFT", label: "Searched for “DFT”" },
	];
	assert.equal(plugin.summarizeActivity({ steps, thoughtMs: 8400 }), "Read paper.txt · searched twice · thought for 8s");
	assert.equal(plugin.summarizeActivity({ steps: [steps[0], { kind: "read", target: "metadata.md" }], thoughtMs: 0 }), "Read 2 files");
	assert.equal(plugin.summarizeActivity({ steps: [], thoughtMs: 300 }), "");
});

test("Claude stream events produce steps, thinking time and text", async () => {
	const { plugin: p } = loadPlugin();
	p.findBinary = async () => "/bin/claude";
	const events = [
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Read" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"file_path\": \"/d/pa" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "per.txt\"}" } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 1 } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer $x$" } } },
	];
	p.runProcess = async (command, args, dir, onEvent) => {
		events.forEach(onEvent);
		return { stdout: JSON.stringify({ type: "assistant", session_id: "s", message: { content: [{ type: "text", text: "Answer $x$" }] } }), stderr: "", exitCode: 0 };
	};
	const seen = { steps: [], thinking: [], text: "" };
	const onProgress = ({ step, thinking, text }) => {
		if (step) seen.steps.push(step.label);
		if (thinking !== undefined) seen.thinking.push(thinking);
		if (text) seen.text = text;
	};
	const result = await p.runClaude({ ...base, onProgress });
	assert.deepEqual(seen.steps, ["Read paper.txt"]);
	assert.deepEqual(seen.thinking, [true, false]);
	assert.equal(seen.text, "Answer $x$");
	assert.equal(result.text, "Answer $x$");
});

test("the paper's full text is never offered: prompts mention only metadata and annotations", () => {
	assert.doesNotMatch(plugin.systemPrompt(), /paper\.txt/);
	assert.match(plugin.systemPrompt(), /full text is deliberately not provided/);
	const prompt = plugin.buildAntigravityPrompt(base);
	assert.doesNotMatch(prompt, /<paper>/);
	assert.match(prompt, /<metadata>\n# T\n<\/metadata>/);
	assert.match(prompt, /<annotations>\n- \[highlight\] p\.2 key idea/);
	assert.ok(prompt.endsWith("Why?" + plugin.formattingReminder()));
	assert.equal(plugin.buildAntigravityPrompt({ ...base, session: { id: "c1", seen: 0 } }), "Why?" + plugin.formattingReminder());
});

test("images: Claude is told to Read each path, Codex gets --image=, both are stored relative to the paper folder", async () => {
	const p = loadPlugin().plugin;
	for (const backend of ["claude", "codex"]) {
		const store = fakeStore(p);
		let seen;
		p.runBackend = async (b, request) => { seen = request; return { text: "A cat." }; };
		const pending = pendingFor(p, backend);
		pending.images = ["/tmp/p/attachments/image-1.png", "/tmp/p/attachments/image-2.jpg"];
		const result = await p.ask(base.ctx, "", pending);
		assert.deepEqual({ ...result }, {});
		assert.equal(store.history[0].text, "");
		assert.deepEqual([...store.history[0].images], ["attachments/image-1.png", "attachments/image-2.jpg"]);
		assert.match(seen.question, /^Look at the attached image\./);
		if (backend === "claude") {
			assert.match(seen.question, /with the Read tool before answering: \/tmp\/p\/attachments\/image-1\.png, \/tmp\/p\/attachments\/image-2\.jpg\]/);
		}
		else {
			const args = p.codexArgs({ ...seen, session: { id: "t1", seen: 0 } });
			assert.ok(args.includes("--image=/tmp/p/attachments/image-1.png"));
			assert.ok(args.indexOf("--image=/tmp/p/attachments/image-2.jpg") < args.indexOf("resume"));
		}
	}
});

test("images: Antigravity refuses them without running, and transcripts mention them", async () => {
	const p = loadPlugin().plugin;
	fakeStore(p);
	let ran = false;
	p.runBackend = async () => { ran = true; return { text: "x" }; };
	const pending = pendingFor(p, "agy");
	pending.images = ["/tmp/p/attachments/image-1.png"];
	const result = await p.ask(base.ctx, "What is this?", pending);
	assert.match(result.error, /Antigravity cannot see images/);
	assert.equal(ran, false);
	assert.match(p.transcriptFor([{ role: "user", text: "Look", images: ["a.png", "b.png"] }], null), /User: Look \[attached 2 images\]/);
});

test("modes: instructions go to the assistant, not into the stored question", async () => {
	const p = loadPlugin().plugin;
	const store = fakeStore(p);
	let seen;
	p.runBackend = async (b, request) => { seen = request; return { text: "ok" }; };
	const pending = pendingFor(p);
	pending.modes = ["latex"];
	await p.ask(base.ctx, "Prove it", pending);
	assert.match(seen.question, /^Prove it\n\n\[Write the answer as rigorous mathematics in LaTeX/);
	assert.equal(store.history[0].text, "Prove it");
	assert.deepEqual([...store.history[0].modes], ["latex"]);
});

test("clarifications: a request about a PDF selection saves passage, exact prompt, instructions and answer", async () => {
	const p = loadPlugin().plugin;
	const store = fakeStore(p);
	const saved = [];
	p.appendClarification = async (dir, record) => saved.push({ dir, record });
	let seen;
	p.runBackend = async (b, request) => { seen = request; return { text: "It means the limit exists." }; };
	store.history = [{ role: "user", text: "earlier" }, { role: "assistant", text: "ok" }];
	const pending = pendingFor(p);
	pending.selection = { text: "the limit exists", pageLabel: "12", position: { pageIndex: 11, rects: [[1, 2, 3, 4]] }, attachmentID: 42 };
	await p.ask(base.ctx, "Explain this passage (p. 12):\n\n> the limit exists", pending);
	assert.equal(saved.length, 1);
	const { dir, record } = saved[0];
	assert.equal(dir, "/tmp/p");
	assert.equal(record.passage, "the limit exists");
	assert.equal(record.pageLabel, "12");
	assert.equal(record.attachmentID, 42);
	assert.deepEqual(JSON.parse(JSON.stringify(record.position)), { pageIndex: 11, rects: [[1, 2, 3, 4]] });
	assert.equal(record.question, "Explain this passage (p. 12):\n\n> the limit exists");
	assert.equal(record.prompt, seen.question, "the exact text sent to the assistant");
	assert.match(record.instructions, /sidebar assistant/);
	assert.equal(record.answer, "It means the limit exists.");
	assert.equal(record.backend, "claude");
	assert.equal(record.model, "opus");
	assert.equal(record.messageIndex, 2, "index of the question in the chat");
	assert.ok(record.id && record.ts);
});

test("clarifications: nothing is saved without a selection or when the request fails", async () => {
	const p = loadPlugin().plugin;
	fakeStore(p);
	let count = 0;
	p.appendClarification = async () => count++;
	p.runBackend = async () => ({ text: "fine" });
	await p.ask(base.ctx, "Why?", pendingFor(p));
	p.runBackend = async () => ({ text: "", error: "boom" });
	const failing = pendingFor(p);
	failing.selection = { text: "x", pageLabel: "1" };
	await p.ask(base.ctx, "Explain", failing);
	assert.equal(count, 0);
});
