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
	assert.ok(args.includes("--setting-sources="), "no setting sources, as a single argument");
});

// Windows joins argv into one command line and Mozilla's quoting leaves "" bare,
// so an empty argument vanishes and the next flag is read as its value (issue #1).
test("no backend passes an empty argument", () => {
	const session = { id: "s1", seen: 0 };
	for (const args of [
		plugin.claudeArgs(base),
		plugin.claudeArgs({ ...base, session }),
		plugin.codexArgs({ ...base, session }),
		plugin.antigravityArgs({ ...base, session }),
	]) {
		assert.ok(!args.includes(""), "empty argument in: " + args.slice(0, 12).join(" | "));
		// The prompt and the system prompt are multi-line, so a newline means one leaked into argv.
		assert.ok(!args.some(a => a.includes("\n") || a.includes("Why?")), "prompt text in argv: " + args.join(" | "));
	}
});

test("claude: user settings load only when asked for", () => {
	const env = loadPlugin({ prefs: { "extensions.zusia.useClaudeUserSettings": true } });
	assert.ok(!env.plugin.claudeArgs(base).some(a => a.startsWith("--setting-sources")));
});

test("codex: -m and model_reasoning_effort go before resume", () => {
	const args = plugin.codexArgs({ ...base, model: "gpt-5.5", effort: "xhigh", session: { id: "t1", seen: 0 } });
	assert.equal(valueAfter(args, "-m"), "gpt-5.5");
	assert.equal(valueAfter(args, "-c"), 'model_reasoning_effort="xhigh"');
	assert.ok(args.indexOf("-c") < args.indexOf("resume"));
	assert.equal(valueAfter(args, "resume"), "t1");
});

test("antigravity: --model and --effort, and no print flag, since the prompt comes on stdin", () => {
	const args = plugin.antigravityArgs({ ...base, model: "gemini-3.1-pro-high", effort: "low" });
	assert.equal(valueAfter(args, "--model"), "gemini-3.1-pro-high");
	assert.equal(valueAfter(args, "--effort"), "low");
	// agy takes the token after a bare -p as the prompt, even an unknown flag.
	assert.ok(!args.some(a => a === "-p" || a.startsWith("--print")));
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

test("antigravity: a new session gets the paper inline, a resumed one only the question", () => {
	const prompt = plugin.buildAntigravityPrompt(base);
	assert.match(prompt, /<paper_metadata>\n# T\n<\/paper_metadata>/);
	assert.match(prompt, /<user_annotations>\n- \[highlight\] p\.2 key idea\n<\/user_annotations>/);
	assert.doesNotMatch(prompt, /<paper_fulltext>\n/, "no full text was exported");
	assert.ok(prompt.endsWith("Why?" + plugin.contextNote(base.files) + plugin.formattingReminder()));
	assert.equal(plugin.buildAntigravityPrompt({ ...base, session: { id: "c1", seen: 0 } }),
		"Why?" + plugin.contextNote(base.files, { resumed: true }) + plugin.formattingReminder());
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
	assert.match(seen.question, /^Prove it\n\n\[LaTeX mode: the user wants the maths written out properly/);
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
	assert.equal(record.instructions, p.systemPrompt(), "Claude gets the system prompt on every call");
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

// A fake Subprocess.call that records argv and what was written to stdin.
function fakeSpawn(env, stdout = "") {
	const runs = [];
	env.Subprocess.getEnvironment = () => ({ HOME: "/home/u", PATH: "/usr/bin" });
	env.Subprocess.call = async (options) => {
		const run = { command: options.command, args: [...options.arguments], stdin: [], closed: false };
		runs.push(run);
		const pipe = (text) => ({ readString: async () => { const out = text; text = ""; return out; } });
		return {
			stdin: {
				write: async (s) => { assert.ok(!run.closed, "write after close"); run.stdin.push(s); },
				close: async () => { run.closed = true; },
			},
			stdout: pipe(stdout),
			stderr: pipe(""),
			wait: async () => ({ exitCode: 0 }),
		};
	};
	return runs;
}
// cmd.exe metacharacters, a newline and a leading dash: all must reach the CLI untouched.
const QUESTION = 'QUESTION-MARKER: is "x" & y > 0? 100%\n- not a flag';
const noPromptInArgv = (args) => !args.some(a => a.includes("QUESTION-MARKER") || a.includes("You are Zusia"));

test("runProcess writes stdin, then closes it", async () => {
	const env = loadPlugin();
	const runs = fakeSpawn(env, "{\"a\":1}\n");
	const seen = [];
	const { stdout, exitCode } = await env.plugin.runProcess("/bin/x", ["--flag"], "/tmp/p", e => seen.push(e), null, "hello\nworld");
	assert.equal(exitCode, 0);
	assert.equal(stdout, "{\"a\":1}\n");
	assert.equal(seen.length, 1);
	assert.deepEqual(runs[0].stdin, ["hello\nworld"]);
	assert.ok(runs[0].closed);
	await env.plugin.runProcess("/bin/x", ["models"], "/tmp/p");
	assert.deepEqual(runs[1].stdin, [], "nothing to send: stdin is only closed");
	assert.ok(runs[1].closed);
});

test("runProcess reads the output while it is still writing stdin", async () => {
	const env = loadPlugin();
	// Like a real pipe: the write of a long prompt only finishes once the child, which
	// answers as it reads, has had its stdout drained.
	let drained;
	const stdoutDrained = new Promise(resolve => { drained = resolve; });
	let output = "{\"a\":1}\n";
	env.Subprocess.getEnvironment = () => ({ HOME: "/home/u", PATH: "/usr/bin" });
	env.Subprocess.call = async () => ({
		stdin: { write: () => stdoutDrained, close: async () => {} },
		stdout: { readString: async () => { const out = output; output = ""; if (!out) drained(); return out; } },
		stderr: { readString: async () => "" },
		wait: async () => ({ exitCode: 0 }),
	});
	let timer;
	const deadlock = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("pipe deadlock")), 1000); });
	const { stdout } = await Promise.race([env.plugin.runProcess("/bin/x", [], "/tmp/p", null, null, "long prompt"), deadlock]);
	clearTimeout(timer);
	assert.equal(stdout, "{\"a\":1}\n");
});

test("claude: the prompt goes on stdin and the system prompt in system.md, never in argv", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	p.findBinary = async () => "/bin/claude";
	const runs = fakeSpawn(env, JSON.stringify({ type: "assistant", session_id: "s", message: { content: [{ type: "text", text: "ok" }] } }));
	const result = await p.runClaude({ ...base, question: QUESTION, session: { id: "s1", seen: 0 }, onProgress() {} });
	assert.equal(result.text, "ok");
	const [run] = runs;
	assert.equal(run.args[0], "-p");
	assert.equal(valueAfter(run.args, "--resume"), "s1");
	assert.equal(valueAfter(run.args, "--append-system-prompt-file"), "/tmp/p/system.md");
	assert.ok(!run.args.includes("--append-system-prompt"));
	assert.equal(env.files.get("/tmp/p/system.md"), p.systemPrompt());
	assert.ok(noPromptInArgv(run.args), run.args.join(" | "));
	assert.equal(run.stdin.join(""), QUESTION + p.contextNote(base.files) + p.formattingReminder());
	assert.ok(run.closed);
});

test("codex: the prompt goes on stdin through a final -, also after resume", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	p.findBinary = async () => "/bin/codex";
	const runs = fakeSpawn(env, JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));
	await p.runCodex({ ...base, question: QUESTION, onProgress() {} });
	await p.runCodex({ ...base, question: QUESTION, session: { id: "t1", seen: 0 }, onProgress() {} });
	const [fresh, resumed] = runs;
	assert.equal(fresh.args[fresh.args.length - 1], "-");
	assert.deepEqual(resumed.args.slice(-3), ["resume", "t1", "-"]);
	for (const run of runs) {
		assert.ok(noPromptInArgv(run.args), run.args.join(" | "));
		assert.ok(run.closed);
	}
	const tail = QUESTION + p.contextNote(base.files) + p.formattingReminder();
	assert.equal(fresh.stdin.join(""), p.systemPrompt() + "\n\n---\n\n" + tail, "a new session starts with the instructions");
	assert.equal(resumed.stdin.join(""), tail);
});

test("codex: the session id comes from thread.started or the older session_configured", () => {
	assert.equal(plugin.parseCodexEvents([{ type: "thread.started", thread_id: "th-1" }]).sessionId, "th-1");
	assert.equal(plugin.parseCodexEvents([{ msg: { type: "session_configured", session_id: "se-1" } }]).sessionId, "se-1");
});

test("antigravity: the prompt goes on stdin", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	p.findBinary = async () => "/bin/agy";
	const runs = fakeSpawn(env, JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok", conversation_id: "c1" } }));
	const request = { ...base, question: QUESTION, onProgress() {} };
	const result = await p.runAntigravity(request);
	assert.equal(result.text, "ok");
	assert.ok(noPromptInArgv(runs[0].args), runs[0].args.join(" | "));
	assert.equal(runs[0].stdin.join(""), p.buildAntigravityPrompt(request));
	assert.ok(runs[0].closed);
});

// Claude writes "Let me check the page…" before a tool call; the eval on the textbook
// showed that narration landing in stored answers, so only what follows the last
// tool call is the answer.
test("claude: narration before a tool call is not part of the answer", async () => {
	const { plugin: p } = loadPlugin();
	const text = t => ({ type: "text", text: t });
	const tool = { type: "tool_use", name: "Grep", input: {} };
	const parsed = p.parseClaudeEvents([
		{ type: "assistant", session_id: "s", message: { content: [text("Let me search the section files."), tool] } },
		{ type: "assistant", message: { content: [text("Let me check the lead-in."), tool] } },
		{ type: "assistant", message: { content: [text("The book proves it on p. 23.")] } },
		{ type: "assistant", message: { content: [text("Then it shows the converse.")] } },
	]);
	assert.equal(parsed.text, "The book proves it on p. 23.\n\nThen it shows the converse.");
	assert.equal(p.parseClaudeEvents([{ type: "assistant", message: { content: [text("Only text.")] } }]).text, "Only text.");
	assert.equal(p.parseClaudeEvents([{ type: "assistant", message: { content: [text("Said before a tool."), tool] } }]).text,
		"Said before a tool.", "an answer that ends on a tool call keeps its text");

	p.findBinary = async () => "/bin/claude";
	const ev = e => ({ type: "stream_event", event: e });
	p.runProcess = async (command, args, dir, onEvent) => {
		[ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me look." } }),
			ev({ type: "content_block_stop", index: 0 }),
			ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Read" } }),
			ev({ type: "content_block_stop", index: 1 }),
			ev({ type: "content_block_start", index: 2, content_block: { type: "text" } }),
			ev({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Answer." } })].forEach(onEvent);
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	const shown = [];
	await p.runClaude({ ...base, onProgress: ({ text }) => { if (text !== undefined) shown.push(text); } });
	assert.deepEqual(shown, ["Let me look.", "", "Answer."], "the narration disappears from the sidebar once a tool runs");
});

test("claude: the prompt asks for the search to stay out of the answer", () => {
	assert.match(plugin.systemPrompt(), /without mentioning files, tools or how you searched/);
	assert.doesNotMatch(plugin.systemPrompt({ inline: true }), /how you searched/);
});
