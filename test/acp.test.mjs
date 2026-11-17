import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";
import { loadWindowsPlugin } from "./windows-env.mjs";
import { fakeAgent, flush, stream } from "./acp-fake.mjs";

const { plugin } = loadPlugin();

const plain = value => JSON.parse(JSON.stringify(value));

function fakeProcess() {
	const stdout = stream();
	const stderr = stream();
	const writes = [];
	let finish;
	const proc = {
		stdin: {
			closed: false,
			async write(text) {
				assert.ok(!proc.stdin.closed, "write after stdin was closed");
				writes.push(text);
			},
			async close() {
				proc.stdin.closed = true;
			},
		},
		stdout: { readString: () => stdout.readString() },
		stderr: { readString: () => stderr.readString() },
		killed: false,
		wait: () => proc.exit,
	};
	proc.exit = new Promise((resolve) => {
		finish = resolve;
	});
	proc.finish = (exitCode = 0) => {
		stdout.end();
		stderr.end();
		finish({ exitCode });
	};
	proc.kill = () => {
		proc.killed = true;
		proc.finish(1);
	};
	return {
		proc,
		stdout,
		stderr,
		writes,
		finish: exitCode => proc.finish(exitCode),
		messages: () => writes.map(text => JSON.parse(text)),
		send: message => stdout.push(JSON.stringify(message) + "\n"),
		sendRaw: text => stdout.push(text),
	};
}

test("acp: each request is answered by the message carrying its id", async () => {
	const env = loadPlugin();
	const fake = fakeProcess();
	const connection = env.plugin.createAcpConnection(fake.proc);
	const hello = connection.request("initialize", { protocolVersion: 1, clientInfo: { name: "Zusia", version: "1.7.0" } });
	const opened = connection.request("session/new", { cwd: "/d", mcpServers: [] });
	await flush();
	assert.deepEqual(fake.messages(), [
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "Zusia", version: "1.7.0" } } },
		{ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/d", mcpServers: [] } },
	]);
	fake.send({ jsonrpc: "2.0", id: 2, result: { sessionId: "s-2", modes: {}, configOptions: [] } });
	fake.send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
	assert.deepEqual(plain(await hello), { protocolVersion: 1, agentCapabilities: { loadSession: true } });
	assert.deepEqual(plain(await opened), { sessionId: "s-2", modes: {}, configOptions: [] });
	fake.finish(0);
	await connection.close();
});

test("acp: a notification reaches onNotification, and one that throws does not stop the reader", async () => {
	const env = loadPlugin();
	const fake = fakeProcess();
	const seen = [];
	const connection = env.plugin.createAcpConnection(fake.proc, {
		onNotification: (method, params) => {
			seen.push([method, params]);
			if (method === "boom") {
				throw new Error("handler trouble");
			}
		},
		onRequest: async () => ({ content: "the paper" }),
	});
	fake.send({ jsonrpc: "2.0", method: "session/update", params: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } } });
	fake.send({ jsonrpc: "2.0", method: "boom" });
	fake.send({ jsonrpc: "2.0", id: 9, method: "fs/read_text_file", params: { path: "paper.txt" } });
	await flush();
	assert.deepEqual(plain(seen).map(entry => entry[0]), ["session/update", "boom"]);
	assert.deepEqual(plain(seen)[0][1], { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } });
	assert.ok(env.plugin._logLines.some(line => line.includes("ERROR in handling ACP notification boom")), "the failure is logged");
	assert.deepEqual(fake.messages().pop(), { jsonrpc: "2.0", id: 9, result: { content: "the paper" } });
	fake.finish(0);
	await connection.close();
});

test("acp: an agent request gets a result reply", async () => {
	const fake = fakeProcess();
	const connection = plugin.createAcpConnection(fake.proc, {
		onRequest: async (method, params) => ({ content: method + " " + params.path }),
	});
	fake.send({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: { sessionId: "s", path: "/d/paper.txt" } });
	await flush();
	assert.deepEqual(fake.messages(), [{ jsonrpc: "2.0", id: 7, result: { content: "fs/read_text_file /d/paper.txt" } }]);
	fake.finish(0);
	await connection.close();
});

test("acp: an agent request whose handler throws is answered with a JSON-RPC error", async () => {
	const fake = fakeProcess();
	const connection = plugin.createAcpConnection(fake.proc, {
		onRequest: (method) => {
			const error = new Error("No handler for " + method);
			error.code = -32601;
			throw error;
		},
	});
	fake.send({ jsonrpc: "2.0", id: 4, method: "terminal/create", params: {} });
	await flush();
	assert.deepEqual(fake.messages(), [{ jsonrpc: "2.0", id: 4, error: { code: -32601, message: "No handler for terminal/create" } }]);
	fake.finish(0);
	await connection.close();
});

test("acp: a JSON-RPC error rejects the request with its code and data", async () => {
	const fake = fakeProcess();
	const connection = plugin.createAcpConnection(fake.proc);
	const pending = connection.request("session/new", { cwd: "/d", mcpServers: [] });
	await flush();
	fake.send({
		jsonrpc: "2.0",
		id: 1,
		error: { code: -32000, message: "Not authenticated. Run `cmd login` in a terminal first.", data: { hint: "login" } },
	});
	await assert.rejects(pending, (e) => {
		assert.equal(e.code, -32000);
		assert.equal(e.data.hint, "login");
		assert.match(e.message, /Not authenticated/);
		return true;
	});
	fake.finish(0);
	await connection.close();
});

test("acp: a non-JSON line is logged and skipped", async () => {
	const env = loadPlugin();
	const fake = fakeProcess();
	const connection = env.plugin.createAcpConnection(fake.proc);
	const pending = connection.request("initialize", { protocolVersion: 1 });
	await flush();
	fake.sendRaw("Starting an ACP agent v1…\n");
	fake.send({ jsonrpc: "2.0", id: 1, result: { agentCapabilities: {} } });
	assert.deepEqual(plain(await pending), { agentCapabilities: {} });
	assert.ok(env.plugin._logLines.some(line => line.includes("Skipping non-JSON ACP output line")), "the line is logged");
	fake.finish(0);
	await connection.close();
});

test("acp: when the pipe ends, a pending request rejects with the exit code and the end of stderr", async () => {
	const fake = fakeProcess();
	const connection = plugin.createAcpConnection(fake.proc, { label: "Command Code" });
	const pending = connection.request("session/prompt", { sessionId: "s", prompt: [] });
	await flush();
	fake.stderr.push("booting\nNot authenticated. Run `cmd login` in a terminal first.\n");
	fake.finish(1);
	await assert.rejects(pending, (e) => {
		assert.equal(e.acpClosed, true);
		assert.equal(e.message, "Command Code exited with code 1: booting\nNot authenticated. Run `cmd login` in a terminal first.");
		assert.equal(e.exitCode, 1);
		assert.equal(e.stderr, "booting\nNot authenticated. Run `cmd login` in a terminal first.");
		return true;
	});
	assert.equal(await connection.close(), undefined, "close reports nothing: the errors carry the end");
});

test("acp: an agent that closes its output without exiting says so", async () => {
	const fake = fakeProcess();
	const connection = plugin.createAcpConnection(fake.proc, { label: "OpenCode" });
	const pending = connection.request("initialize", { protocolVersion: 1 });
	await flush();
	fake.stdout.end();
	await assert.rejects(pending, (e) => {
		assert.equal(e.message, "OpenCode closed its output.");
		assert.equal(e.exitCode, null);
		assert.equal(e.stderr, "");
		return true;
	});
	await connection.close();
});

test("acp: writes go out one at a time, in order", async () => {
	const fake = fakeProcess();
	let releaseFirst;
	const firstWrite = new Promise((resolve) => {
		releaseFirst = resolve;
	});
	const order = [];
	const write = fake.proc.stdin.write;
	fake.proc.stdin.write = async (text) => {
		const method = JSON.parse(text).method;
		order.push("start " + method);
		if (order.length === 1) {
			await firstWrite;
		}
		await write(text);
		order.push("end " + method);
	};
	const connection = plugin.createAcpConnection(fake.proc);
	const asked = [connection.request("initialize", { protocolVersion: 1 }), connection.request("session/new", { cwd: "/d", mcpServers: [] })];
	await flush();
	assert.deepEqual(order, ["start initialize"], "nothing is written while the first write is in flight");
	releaseFirst();
	await flush();
	assert.deepEqual(order, ["start initialize", "end initialize", "start session/new", "end session/new"]);
	assert.deepEqual(fake.messages().map(message => [message.id, message.method]), [[1, "initialize"], [2, "session/new"]]);
	fake.finish(0);
	await connection.close();
	for (const request of asked) {
		await assert.rejects(request, e => e.acpClosed === true, "unanswered when the agent went");
	}
});

test("acp: close kills a process that is still running and is idempotent", async () => {
	const fake = fakeProcess();
	const connection = plugin.createAcpConnection(fake.proc, { label: "Agent" });
	const pending = connection.request("session/prompt", { sessionId: "s", prompt: [] });
	await flush();
	fake.stderr.push("y".repeat(5000) + "\nwarning: slow\n");
	await flush();
	const closing = connection.close();
	assert.equal(connection.close(), closing, "a second close waits for the first");
	await closing;
	assert.equal(fake.proc.stdin.closed, true);
	assert.equal(fake.proc.killed, true);
	await assert.rejects(pending, (e) => {
		assert.equal(e.stderr.length, 1000, "only the end of stderr is kept");
		assert.ok(e.stderr.endsWith("y\nwarning: slow"));
		assert.ok(e.message.endsWith(e.stderr));
		return true;
	});
	await assert.rejects(connection.request("session/prompt", { sessionId: "s" }), (e) => {
		assert.equal(e.acpClosed, true);
		return true;
	});
	assert.equal(fake.writes.length, 1, "a closed pipe writes nothing more");
});

test("acp: a stdin that will not close still ends in a kill, settled requests and a log line", async () => {
	const env = loadPlugin();
	const fake = fakeProcess();
	fake.proc.stdin.close = async () => { throw new Error("pipe is broken"); };
	// A hung agent: it neither exits nor closes stderr until it is killed, and then not even that.
	fake.proc.wait = () => new Promise(() => {});
	fake.proc.kill = () => { fake.proc.killed = true; };
	const connection = env.plugin.createAcpConnection(fake.proc);
	const pending = connection.request("session/prompt", { sessionId: "s", prompt: [] });
	await connection.close();
	assert.equal(fake.proc.killed, true);
	await assert.rejects(pending, e => e.acpClosed === true);
	assert.ok(env.plugin._logLines.some(line => line.includes("closing the ACP stdin: Error: pipe is broken")), "the failed close is in Zusia's log");
});

test("acp: a kill that throws still settles every pending request", async () => {
	const env = loadPlugin();
	const fake = fakeProcess();
	fake.proc.wait = () => new Promise(() => {});
	fake.proc.kill = () => { throw new Error("no such process"); };
	const connection = env.plugin.createAcpConnection(fake.proc);
	const pending = connection.request("session/new", { cwd: "/d", mcpServers: [] });
	await connection.close();
	await assert.rejects(pending, e => e.acpClosed === true);
	assert.ok(env.plugin._logLines.some(line => line.includes("killing the ACP agent: Error: no such process")));
});

const OPTIONS = [
	{ optionId: "once", name: "Allow once", kind: "allow_once" },
	{ optionId: "always", name: "Always allow", kind: "allow_always" },
	{ optionId: "no", name: "Reject", kind: "reject_once" },
	{ optionId: "never", name: "Never", kind: "reject_always" },
];
const chosen = reply => (reply.outcome.outcome === "selected" ? reply.outcome.optionId : reply.outcome.outcome);

test("acp: thinking, and a read or search inside the folder, are allowed once and never always", () => {
	for (const call of [
		{ kind: "think" },
		{ kind: "read", locations: [{ path: "/d/paper.txt" }] },
		{ kind: "read", locations: [{ path: "/d/text/03.md", line: 4 }, { path: "/d" }] },
		{ kind: "search", locations: [{ path: "/d/text" }] },
		{ kind: "search", rawInput: { path: "/d", pattern: "FFT" } },
		{ kind: "read", rawInput: { file_path: "text/03.md" } },
		{ kind: "read", locations: [{}], rawInput: { AbsolutePath: "/d/metadata.md" } },
	]) {
		assert.equal(chosen(plugin.acpPermissionReply(call, OPTIONS, "/d")), "once", JSON.stringify(call));
	}
});

test("acp: a read or search elsewhere, or of nothing named, is refused", () => {
	for (const call of [
		{ kind: "read", locations: [{ path: "/home/u/.ssh/id_rsa" }] },
		{ kind: "read", locations: [{ path: "/d/paper.txt" }, { path: "/home/u/.aws/credentials" }] },
		{ kind: "read", locations: [{ path: "/d/../secrets.txt" }] },
		{ kind: "read", locations: [{ path: "/dx/paper.txt" }] },
		{ kind: "read", locations: [{ path: "/d\\..\\x" }], rawInput: {} },
		{ kind: "search", locations: [{ path: "/home/u" }] },
		{ kind: "search", title: "Web search" },
		{ kind: "search", locations: [] },
		{ kind: "read", rawInput: { file_path: "/etc/passwd" } },
		{ kind: "read", locations: [{ path: 7 }] },
		{},
	]) {
		assert.equal(chosen(plugin.acpPermissionReply(call, OPTIONS, "/d")), "no", JSON.stringify(call));
	}
	for (const kind of ["edit", "delete", "move", "execute", "fetch", "switch_mode", "other"]) {
		assert.equal(chosen(plugin.acpPermissionReply({ kind, locations: [{ path: "/d/paper.txt" }] }, OPTIONS, "/d")), "no",
			kind + " is refused even inside the folder");
	}
});

test("acp: a permission answer takes only the option kinds it knows", () => {
	const inside = { kind: "read", locations: [{ path: "/d/paper.txt" }] };
	const outside = { kind: "read", locations: [{ path: "/etc/passwd" }] };
	const [once, always, no, never] = OPTIONS;
	assert.equal(chosen(plugin.acpPermissionReply(inside, [always, no], "/d")), "no", "no allow_once: refused rather than allowed for good");
	assert.equal(chosen(plugin.acpPermissionReply(inside, [always], "/d")), "cancelled");
	assert.equal(chosen(plugin.acpPermissionReply(outside, [once, never], "/d")), "never", "reject_always when there is no reject_once");
	assert.equal(chosen(plugin.acpPermissionReply(outside, [once, always], "/d")), "cancelled", "no reject option: nothing is chosen");
	assert.equal(chosen(plugin.acpPermissionReply(inside, [{ optionId: "all", kind: "allow_everything_forever" }, no], "/d")), "no",
		"an unknown allow kind is never picked");
	assert.equal(chosen(plugin.acpPermissionReply(inside, [{ name: "Allow", kind: "allow_once" }], "/d")), "cancelled", "an option needs an id");
	assert.equal(chosen(plugin.acpPermissionReply(inside, [], "/d")), "cancelled");
	assert.equal(chosen(plugin.acpPermissionReply({ kind: "READ", locations: inside.locations }, OPTIONS, "/d")), "no", "kinds are exact");
});

test("acp: an agent's permission request is judged against the folder it runs in", async () => {
	const ask = path => plugin.acpRequest("session/request_permission",
		{ sessionId: "s", toolCall: { toolCallId: "t", kind: "read", locations: [{ path }] }, options: OPTIONS }, "/tmp/zusia-job-1", "Agent");
	assert.equal(chosen(await ask("/Users/me/.ssh/id_ed25519")), "no", "a memory job's empty folder holds nothing to read");
	assert.equal(chosen(await ask("/tmp/zusia-job-1/x")), "once");
});

test("acp: on Windows a permission accepts the folder in any case or slash, and nothing beside it", () => {
	const win = loadWindowsPlugin().plugin;
	const dir = "C:\\Users\\u\\Zotero\\zusia\\papers\\ABC";
	const read = path => chosen(win.acpPermissionReply({ kind: "read", locations: [{ path }] }, OPTIONS, dir));
	for (const path of [dir + "\\paper.txt", "C:/Users/u/Zotero/zusia/papers/ABC/paper.txt", "c:\\users\\u\\zotero\\zusia\\papers\\abc\\paper.txt",
		"text/03.md", dir + "\\text/03.md"]) {
		assert.equal(read(path), "once", path);
	}
	for (const path of [dir + "2\\paper.txt", "C:\\Users\\u\\.ssh\\id_rsa", dir + "\\..\\x", "text\\..\\..\\x", "C:/Users/u/Zotero/zusia/papers/ABC/../x",
		"\\\\server\\share\\paper.txt", "\\Users\\u\\Zotero\\zusia\\papers\\ABC\\paper.txt", "D:\\Users\\u\\Zotero\\zusia\\papers\\ABC\\paper.txt", "C:paper.txt"]) {
		assert.equal(read(path), "no", path);
	}
});

test("acp: a tool call becomes one of the four activity steps", () => {
	assert.deepEqual(plain(plugin.acpStep({ title: "Read paper.txt", kind: "read", rawInput: { path: "/d/paper.txt" } })),
		{ kind: "read", target: "paper.txt", label: "Read paper.txt" });
	assert.deepEqual(plain(plugin.acpStep({ kind: "read", rawInput: { file_path: "C:\\d\\notes\\chapter.md" } })),
		{ kind: "read", target: "chapter.md", label: "Read a file" }, "no title: a short wording instead");
	assert.deepEqual(plain(plugin.acpStep({ kind: "read", rawInput: { AbsolutePath: "/a/metadata.md" } })).target, "metadata.md");
	assert.deepEqual(plain(plugin.acpStep({ kind: "search", title: "Searched for “FFT”" })),
		{ kind: "search", target: "Searched for “FFT”", label: "Searched for “FFT”" });
	assert.deepEqual(plain(plugin.acpStep({ kind: "fetch" })), { kind: "search", target: "fetch", label: "Searched" });
	assert.deepEqual(plain(plugin.acpStep({ kind: "execute", rawInput: { command: "sed -n  1,80p paper.txt" } })),
		{ kind: "run", target: "sed -n 1,80p paper.txt", label: "Ran a command" });
	assert.deepEqual(plain(plugin.acpStep({ kind: "execute" })), { kind: "run", target: "execute", label: "Ran a command" });
	assert.deepEqual(plain(plugin.acpStep({ kind: "think" })), { kind: "tool", target: "think", label: "Used a tool" });
	assert.deepEqual(plain(plugin.acpStep({ title: "Looked at the figures", kind: "other" })),
		{ kind: "tool", target: "Looked at the figures", label: "Looked at the figures" });
	assert.deepEqual(plain(plugin.acpStep({ kind: "edit", rawInput: { path: "/d/paper.txt" } })),
		{ kind: "tool", target: "paper.txt", label: "Used a tool" }, "a change is a tool, and names the file");
});

test("acp: the agent reads the paper folder, by line and limit", async () => {
	const files = new Map([["/d/paper.txt", "one\ntwo\nthree\nfour\n"]]);
	const { plugin: p } = loadPlugin({ files });
	assert.deepEqual(plain(await p.acpReadFile("/d", { path: "paper.txt" })), { content: "one\ntwo\nthree\nfour\n" });
	assert.deepEqual(plain(await p.acpReadFile("/d", { path: "/d/paper.txt" })), { content: "one\ntwo\nthree\nfour\n" },
		"an absolute path inside the folder is fine");
	assert.deepEqual(plain(await p.acpReadFile("/d", { path: "paper.txt", line: 2, limit: 2 })), { content: "two\nthree" });
	assert.deepEqual(plain(await p.acpReadFile("/d", { path: "paper.txt", line: 3 })), { content: "three\nfour\n" });
});

test("acp: a path outside the paper folder is refused", async () => {
	const files = new Map([["/d/sub/inner.txt", "inner"], ["/secrets.txt", "secret"]]);
	const { plugin: p } = loadPlugin({ files });
	for (const path of ["../secrets.txt", "/secrets.txt", "/d/../secrets.txt", "sub/../../secrets.txt"]) {
		await assert.rejects(p.acpReadFile("/d", { path }), (e) => {
			assert.equal(e.code, -32001, path);
			return true;
		});
	}
	assert.deepEqual(plain(await p.acpReadFile("/d", { path: "sub/inner.txt" })), { content: "inner" }, "a subfolder is inside");
	await assert.rejects(p.acpReadFile("/d", {}), (e) => {
		assert.equal(e.code, -32602);
		return true;
	});
});

test("acp: elsewhere than Windows a backslash is part of a name, never a way out", async () => {
	const files = new Map([["/d\\x", "a sibling of the folder"], ["/d/a\\..\\b", "one odd name inside"], ["/dx/y", "next door"]]);
	const { plugin: p } = loadPlugin({ files });
	for (const path of ["/d\\x", "/dx/y"]) {
		await assert.rejects(p.acpReadFile("/d", { path }), e => e.code === -32001, path);
	}
	assert.deepEqual(plain(await p.acpReadFile("/d", { path: "a\\..\\b" })), { content: "one odd name inside" });
	assert.equal(p.acpInside("/d/", "/d/paper.txt"), "/d/paper.txt", "a trailing slash on the folder changes nothing");
	assert.equal(p.acpInside("/d", "/d"), "/d");
});

test("acp: on Windows the agent reads with any slash or case, through a native path, and only in the folder", async () => {
	const env = loadWindowsPlugin();
	const dir = "C:\\Users\\u\\Zotero\\zusia\\papers\\ABC";
	const asked = [];
	env.window.Zotero.File.getContentsAsync = async (path) => {
		asked.push(path);
		return "text";
	};
	for (const [path, native] of [
		["C:/Users/u/Zotero/zusia/papers/ABC/paper.txt", dir + "\\paper.txt"],
		["c:\\users\\u\\zotero\\zusia\\papers\\abc\\paper.txt", "c:\\users\\u\\zotero\\zusia\\papers\\abc\\paper.txt"],
		["text/03.md", dir + "\\text\\03.md"],
		[dir + "\\text/03.md", dir + "\\text\\03.md"],
		["paper.txt", dir + "\\paper.txt"],
	]) {
		asked.length = 0;
		assert.deepEqual(plain(await env.plugin.acpReadFile(dir, { path })), { content: "text" }, path);
		assert.deepEqual(asked, [native], path + " reaches Gecko as a native path");
	}
	asked.length = 0;
	for (const path of [dir + "2\\x", "C:\\Users\\u\\.ssh\\id_rsa", "..\\secrets.txt", "text\\..\\..\\x", "\\\\server\\share\\x", "C:x"]) {
		await assert.rejects(env.plugin.acpReadFile(dir, { path }), e => e.code === -32001, path);
	}
	assert.deepEqual(asked, [], "nothing outside was read");
});

test("acp: a huge file is cut at 400000 characters", async () => {
	const files = new Map([["/d/long.txt", "a".repeat(400001)]]);
	const { plugin: p } = loadPlugin({ files });
	const { content } = await p.acpReadFile("/d", { path: "long.txt" });
	assert.equal(content.length, 400000 + "\n\n[truncated]".length);
	assert.ok(content.endsWith("\n\n[truncated]"));
});

test("acp: the model menu comes from the agent's own config options", () => {
	const options = [
		{ id: "reasoning", name: "Reasoning", category: "thought_level", type: "select", options: [{ value: "high", name: "High" }] },
		{ id: "model", name: "Model", category: "model", type: "select", options: [
			{ value: "cmd-fast", name: "Command Fast", description: "Quick answers" },
			{ value: "cmd-best", name: "Command Best" },
		] },
	];
	assert.deepEqual(plain(plugin.acpModelChoices(options)), [
		{ id: "cmd-fast", label: "Command Fast", desc: "Quick answers" },
		{ id: "cmd-best", label: "Command Best", desc: "" },
	]);
	assert.deepEqual(plain(plugin.acpModelChoices([{ id: "model", options: [{ value: "m", name: "M" }] }])),
		[{ id: "m", label: "M", desc: "" }], "matched by id as well as by category");
	assert.deepEqual(plain(plugin.acpModelChoices(null)), []);
	assert.deepEqual(plain(plugin.acpModelChoices([{ id: "reasoning", category: "thought_level" }])), []);
	assert.deepEqual(plain(plugin.acpModelChoices([{ id: "model", category: "model" }])), [], "a select with no values offers none");
});

test("acp: a model list in groups is offered flat", () => {
	const options = [{ id: "model", name: "Model", category: "model", type: "select", options: [
		{ group: "anthropic", name: "Anthropic", options: [{ value: "a", name: "A" }, { value: "b", name: "B", description: "Bigger" }] },
		{ group: "local", name: "Local", options: [{ value: "c", name: "C" }] },
		{ value: "d", name: "D" },
	] }];
	assert.deepEqual(plain(plugin.acpModelChoices(options)), [
		{ id: "a", label: "A", desc: "" },
		{ id: "b", label: "B", desc: "Bigger" },
		{ id: "c", label: "C", desc: "" },
		{ id: "d", label: "D", desc: "" },
	]);
});

// A connection that answers session/set_config_option and records what it was asked.
function configConnection(reply = params => ({ configOptions: null, params })) {
	const sent = [];
	return {
		sent,
		request: async (method, params) => {
			sent.push([method, params]);
			return reply(params);
		},
	};
}

test("acp: the effort goes to the agent's thought_level option, or to one with the id effort", async () => {
	const reasoning = { id: "reasoning", name: "Reasoning", category: "thought_level", type: "select", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] };
	let connection = configConnection();
	assert.equal(await plugin.applyAcpOptions(connection, "s", [reasoning], "", "high", "Agent"), null);
	assert.deepEqual(plain(connection.sent), [["session/set_config_option", { sessionId: "s", configId: "reasoning", value: "high" }]]);

	connection = configConnection();
	await plugin.applyAcpOptions(connection, "s", [{ id: "effort", name: "Effort", options: [{ value: "low", name: "Low" }] }], "", "low", "Agent");
	assert.deepEqual(plain(connection.sent), [["session/set_config_option", { sessionId: "s", configId: "effort", value: "low" }]]);

	connection = configConnection();
	assert.equal(await plugin.applyAcpOptions(connection, "s", [reasoning], "", "max", "Agent"), null, "an effort the agent lacks is skipped quietly");
	assert.deepEqual(connection.sent, []);
});

test("acp: a model from inside a group is set; one the agent lacks is refused by name", async () => {
	const model = { id: "model", name: "Model", category: "model", type: "select", options: [
		{ group: "fast", name: "Fast", options: [{ value: "a", name: "A" }] },
		{ group: "best", name: "Best", options: [{ value: "b", name: "B" }] },
	] };
	const reasoning = { id: "reasoning", category: "thought_level", options: [{ value: "high" }] };
	// Choosing model b leaves it no reasoning levels, so the effort that follows is not sent.
	const connection = configConnection(() => ({ configOptions: [model] }));
	assert.equal(await plugin.applyAcpOptions(connection, "s", [model, reasoning], "b", "high", "Agent"), null);
	assert.deepEqual(plain(connection.sent), [["session/set_config_option", { sessionId: "s", configId: "model", value: "b" }]]);
	assert.equal(await plugin.applyAcpOptions(configConnection(), "s", [model], "z", "", "Agent"), "Agent does not offer Model “z”.");
	const failing = { request: async () => { throw new Error("model is busy"); } };
	assert.equal(await plugin.applyAcpOptions(failing, "s", [model], "a", "", "Agent"), "Agent could not use a: model is busy");
});

test("acp: attached images travel as image blocks", async () => {
	const bytes = new Uint8Array([137, 80, 78, 71]);
	const { plugin: p } = loadPlugin({ files: new Map([["/d/one.png", bytes]]) });
	const blocks = await p.acpPromptBlocks("Look", ["/d/one.png"]);
	assert.deepEqual(plain(blocks[0]), { type: "text", text: "Look" });
	assert.equal(blocks[1].type, "image");
	assert.equal(blocks[1].mimeType, "image/png");
	assert.equal(blocks[1].data, Buffer.from(bytes).toString("base64"));
});

// ---------------------------------------------------------------- a question through an agent

const KEY = "acp:commandcode";
const question = { ctx: { dir: "/d" }, question: "Why?", history: [], session: null, images: [], files: { metadata: "# T\n", annotations: "" } };
const PERMISSION_OPTIONS = [
	{ optionId: "once", name: "Allow once", kind: "allow_once" },
	{ optionId: "always", name: "Always", kind: "allow_always" },
	{ optionId: "no", name: "Reject", kind: "reject_once" },
];

// The shipped agent, started as `fakes` in turn (one fake or a list), each in its own folder.
function withAgent(fakes, env = loadPlugin()) {
	const p = env.plugin;
	const queue = [].concat(fakes);
	const spawned = [];
	p.findBinary = async () => "/bin/command-code";
	p.getDataDir = () => "/data";
	p.spawnAgent = async (command, args, workdir) => {
		spawned.push(workdir);
		return queue.shift().proc;
	};
	return { env, p, spawned };
}

test("acp: a new session gets the whole prompt, and an agent without loadSession keeps no session", async () => {
	const fake = fakeAgent({ answer: "Because." });
	const { p, spawned } = withAgent(fake);
	const result = await p.runAcp(KEY, { ...question, onProgress: () => {} });
	assert.deepEqual(plain(result), { text: "Because.", truncated: false });
	assert.deepEqual(spawned, ["/d"]);
	assert.deepEqual(fake.messages.filter(m => m.method).map(m => m.method), ["initialize", "session/new", "session/prompt"]);
	assert.equal(fake.sent("session/prompt")[0].params.prompt[0].text, p.sessionPrompt(question));
	assert.equal(fake.proc.stdin.closed, true, "the agent is closed after the answer");
});

test("acp: a stored session is resumed with the question alone, and what the agent replays is not shown", async () => {
	const fake = fakeAgent({
		capabilities: { loadSession: true },
		answer: "Still the FFT.",
		on: {
			"session/load": (m, agent) => {
				agent.say("An old answer, replayed");
				agent.update({ sessionUpdate: "tool_call", toolCallId: "old", title: "Read paper.txt", kind: "read" });
				agent.reply(m, { configOptions: [] });
			},
		},
	});
	const { p } = withAgent(fake);
	const shown = [];
	const session = { id: "s-old", seen: 0 };
	const asked = { ...question, session, history: [{ role: "user", text: "First?" }, { role: "assistant", text: "First." }] };
	const result = await p.runAcp(KEY, { ...asked, onProgress: event => shown.push(event) });
	assert.deepEqual(plain(result), { text: "Still the FFT.", sessionId: "s-old", truncated: false });
	assert.deepEqual(fake.messages.filter(m => m.method).map(m => m.method), ["initialize", "session/load", "session/prompt"]);
	assert.deepEqual(plain(fake.sent("session/load")[0].params), { sessionId: "s-old", cwd: "/d", mcpServers: [] });
	assert.equal(fake.sent("session/prompt")[0].params.prompt[0].text, p.questionPrompt(asked));
	assert.ok(!shown.some(event => JSON.stringify(event).includes("replayed") || event.step), "the replay stays out of the chat");
	assert.equal(shown.filter(event => event.text !== undefined).pop().text, "Still the FFT.");
});

test("acp: a session the agent cannot load fails as resumeFailed, and ask() asks again in a new one", async () => {
	const first = fakeAgent({ capabilities: { loadSession: true }, sessionId: "s-1", answer: "First." });
	const lost = fakeAgent({ capabilities: { loadSession: true }, on: { "session/load": (m, agent) => agent.fail(m, -32002, "Session s-1 not found") } });
	const fresh = fakeAgent({ capabilities: { loadSession: true }, sessionId: "s-2", answer: "Second." });
	const { p } = withAgent([first, lost, fresh]);
	const store = { history: [], sessions: {} };
	p.exportContext = async () => ({ metadata: "# T\n", annotations: "" });
	p.loadHistory = async () => plain(store.history);
	p.appendHistory = async (dir, messages) => { store.history.push(...messages); };
	p.loadSessions = async () => ({ ...store.sessions });
	p.saveSessions = async (dir, saved) => { store.sessions = saved; };
	const pending = () => ({ backend: KEY, partial: "", cancelled: false, progress: () => {} });

	assert.deepEqual(plain(await p.ask({ dir: "/d" }, "First?", pending())), {});
	assert.equal(store.sessions[KEY].id, "s-1");
	const resumed = await p.runAcp(KEY, { ...question, session: store.sessions[KEY] });
	assert.deepEqual(plain(resumed), { text: "", error: "Session s-1 not found", resumeFailed: true });

	const again = fakeAgent({ capabilities: { loadSession: true }, on: { "session/load": (m, agent) => agent.fail(m, -32002, "Session s-1 not found") } });
	withAgent([again, fresh], { plugin: p });
	assert.deepEqual(plain(await p.ask({ dir: "/d" }, "Second?", pending())), {});
	assert.deepEqual(fresh.messages.filter(m => m.method).map(m => m.method), ["initialize", "session/new", "session/prompt"],
		"the retry opens a new session");
	assert.match(fresh.sent("session/prompt")[0].params.prompt[0].text, /First\?/, "and replays the chat into it");
	assert.equal(store.history.pop().text, "Second.");
	assert.equal(store.sessions[KEY].id, "s-2");
});

test("acp: an image goes only to an agent that says it takes images", async () => {
	const files = new Map([["/d/one.png", new Uint8Array([137, 80, 78, 71])]]);
	const blind = fakeAgent();
	let { p } = withAgent(blind, loadPlugin({ files }));
	assert.deepEqual(plain(await p.runAcp(KEY, { ...question, images: ["/d/one.png"] })),
		{ text: "", error: "Command Code does not accept images. Remove the attachment or switch assistant." });
	assert.deepEqual(blind.messages.filter(m => m.method).map(m => m.method), ["initialize"], "no session is opened");

	const seeing = fakeAgent({ capabilities: { promptCapabilities: { image: true } } });
	({ p } = withAgent(seeing, loadPlugin({ files })));
	assert.equal((await p.runAcp(KEY, { ...question, images: ["/d/one.png"] })).text, "It is the FFT.");
	assert.deepEqual(seeing.sent("session/prompt")[0].params.prompt.map(block => block.type), ["text", "image"]);
});

test("acp: the chosen model and effort are set before the prompt, and a model the agent lacks stops the question", async () => {
	const configOptions = [
		{ id: "model", name: "Model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Fast" }, { value: "best", name: "Best" }] },
		{ id: "reasoning", name: "Reasoning", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low" }, { value: "high" }] },
	];
	const willing = fakeAgent({ configOptions });
	let { p } = withAgent(willing);
	assert.equal((await p.runAcp(KEY, { ...question, model: "best", effort: "high" })).text, "It is the FFT.");
	assert.deepEqual(willing.messages.filter(m => m.method)
		.map(m => (m.method === "session/set_config_option" ? m.params.configId + "=" + m.params.value : m.method)),
	["initialize", "session/new", "model=best", "reasoning=high", "session/prompt"]);
	assert.deepEqual(plain(p.getModels(KEY)).map(m => m.id), ["", "fast", "best"], "the session's options feed the model menu");

	const refusing = fakeAgent({ configOptions });
	({ p } = withAgent(refusing));
	assert.deepEqual(plain(await p.runAcp(KEY, { ...question, model: "huge" })), { text: "", error: "Command Code does not offer Model “huge”." });
	assert.equal(refusing.sent("session/prompt").length, 0, "nothing is asked with the wrong model");
});

test("acp: during an answer the agent may read the folder, and nothing else", async () => {
	const files = new Map([["/d/paper.txt", "page one\npage two"]]);
	const replies = [];
	const fake = fakeAgent({
		on: {
			"session/prompt": async (m, agent) => {
				const ask = async (method, params) => replies.push((await agent.ask(method, params)));
				await ask("session/request_permission", { sessionId: "s-1", toolCall: { toolCallId: "t1", kind: "read", locations: [{ path: "/d/paper.txt" }] }, options: PERMISSION_OPTIONS });
				await ask("session/request_permission", { sessionId: "s-1", toolCall: { toolCallId: "t2", kind: "read", locations: [{ path: "/Users/me/.aws/credentials" }] }, options: PERMISSION_OPTIONS });
				await ask("fs/read_text_file", { sessionId: "s-1", path: "/d/paper.txt", line: 2 });
				await ask("fs/read_text_file", { sessionId: "s-1", path: "/Users/me/.aws/credentials" });
				await ask("terminal/create", { sessionId: "s-1", command: "cat" });
				agent.say("Read it.");
				agent.reply(m, { stopReason: "end_turn" });
			},
		},
	});
	const { p } = withAgent(fake, loadPlugin({ files }));
	assert.equal((await p.runAcp(KEY, question)).text, "Read it.");
	assert.deepEqual(plain(replies.map(reply => reply.result || reply.error)), [
		{ outcome: { outcome: "selected", optionId: "once" } },
		{ outcome: { outcome: "selected", optionId: "no" } },
		{ content: "page two" },
		{ code: -32001, message: "Zusia only reads inside the paper folder: /Users/me/.aws/credentials" },
		{ code: -32601, message: "Command Code asked for terminal/create, which Zusia does not provide." },
	]);
});

test("acp: on Windows a live permission accepts the folder written with forward slashes", async () => {
	const dir = "C:\\Users\\u\\Zotero\\zusia\\papers\\ABC";
	let reply;
	const fake = fakeAgent({
		on: {
			"session/prompt": async (m, agent) => {
				reply = await agent.ask("session/request_permission",
					{ sessionId: "s-1", toolCall: { toolCallId: "t", kind: "read", locations: [{ path: "C:/Users/u/Zotero/zusia/papers/ABC/text/03.md" }] }, options: PERMISSION_OPTIONS });
				agent.say("Done.");
				agent.reply(m, { stopReason: "end_turn" });
			},
		},
	});
	const { p } = withAgent(fake, loadWindowsPlugin());
	assert.equal((await p.runAcp(KEY, { ...question, ctx: { dir } })).text, "Done.");
	assert.equal(reply.result.outcome.optionId, "once");
});

test("acp: thinking, tool steps and text reach the chat in order, each step once", async () => {
	const fake = fakeAgent({
		on: {
			"session/prompt": (m, agent) => {
				agent.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hmm." } });
				agent.say("Let me look.");
				agent.update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read paper.txt", kind: "read", rawInput: { path: "/d/paper.txt" } });
				agent.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
				agent.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
				agent.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
				agent.update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "grep FFT", kind: "search" });
				agent.say("It is the FFT.");
				agent.reply(m, { stopReason: "end_turn" });
			},
		},
	});
	const { p } = withAgent(fake);
	const shown = [];
	const result = await p.runAcp(KEY, { ...question, onProgress: event => shown.push(event) });
	assert.equal(result.text, "It is the FFT.", "what came after the last tool is the answer");
	const thinking = shown.filter(event => event.thinking !== undefined);
	assert.deepEqual(thinking.map(event => event.thinking), [true, false]);
	assert.equal(typeof thinking[1].thoughtMs, "number");
	assert.deepEqual(plain(shown.filter(event => event.step).map(event => event.step)), [
		{ kind: "read", target: "paper.txt", label: "Read paper.txt" },
		{ kind: "search", target: "grep FFT", label: "grep FFT" },
	], "a step completed twice shows once; one never completed shows at the end");
	assert.ok(shown.some(event => event.text === ""), "the narration before a tool leaves the bubble");
	assert.ok(shown.some(event => event.status === "reading the paper"));
});

test("acp: when the agent only narrates around its tools, the narration is the answer", async () => {
	const fake = fakeAgent({
		on: {
			"session/prompt": (m, agent) => {
				agent.say("The FFT, on page 3.");
				agent.update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", kind: "read" });
				agent.reply(m, { stopReason: "end_turn" });
			},
		},
	});
	const { p } = withAgent(fake);
	assert.equal((await p.runAcp(KEY, question)).text, "The FFT, on page 3.");
});

test("acp: how the turn ended decides what the reader is told", async () => {
	for (const [stopReason, text, expected] of [
		["refusal", "", { text: "", error: "Command Code declined to answer." }],
		["end_turn", "", { text: "", error: "Command Code returned no text." }],
		["max_tokens", "A long answer", { text: "A long answer", truncated: true }],
	]) {
		const fake = fakeAgent({
			on: {
				"session/prompt": (m, agent) => {
					if (text) {
						agent.say(text);
					}
					agent.reply(m, { stopReason });
				},
			},
		});
		const { p } = withAgent(fake);
		assert.deepEqual(plain(await p.runAcp(KEY, question)), expected, stopReason);
	}
});

test("acp: an agent that dies mid-answer is reported with its exit code and the end of its stderr", async () => {
	const fake = fakeAgent({
		on: {
			"session/prompt": (m, agent) => {
				agent.say("Half an ans");
				agent.stderr("thread main panicked\nError: out of memory\n");
				agent.exit(137);
			},
		},
	});
	const { p } = withAgent(fake);
	assert.deepEqual(plain(await p.runAcp(KEY, question)), {
		text: "",
		error: "Command Code exited with code 137: thread main panicked\nError: out of memory",
		partialText: "Half an ans",
		resumeFailed: false,
	});
});

test("acp: Stop kills the agent mid-answer and keeps what it had written", async () => {
	let started;
	const writing = new Promise(resolve => { started = resolve; });
	const fake = fakeAgent({
		on: {
			"session/prompt": (m, agent) => {
				agent.say("Partial");
				started();
			},
		},
	});
	const { p } = withAgent(fake);
	let proc = null;
	const running = p.runAcp(KEY, { ...question, onSpawn: spawned => { proc = spawned; } });
	await writing;
	await flush();
	proc.kill();
	const result = await running;
	assert.equal(fake.proc.killed, true);
	assert.equal(result.partialText, "Partial");
	assert.equal(result.text, "");
});

test("acp: sign-in tells an agent with no ACP methods to use its CLI, and passes on a refusal", async () => {
	let { p } = withAgent(fakeAgent());
	assert.deepEqual(plain(await p.acpAuthenticate(KEY)),
		{ error: "This agent has no ACP sign-in methods. Sign in with its own CLI in a terminal.", methods: [] });
	const methods = [{ id: "oauth", name: "Google" }];
	({ p } = withAgent(fakeAgent({ auth: methods, on: { authenticate: (m, agent) => agent.fail(m, -32000, "The browser login was cancelled") } })));
	assert.deepEqual(plain(await p.acpAuthenticate(KEY)), { error: "The browser login was cancelled", methods });
});

test("acp: a memory job's agent is refused a read outside its empty folder", async () => {
	let reply;
	const fake = fakeAgent({
		on: {
			"session/prompt": async (m, agent) => {
				reply = await agent.ask("session/request_permission",
					{ sessionId: "s-1", toolCall: { toolCallId: "t", kind: "read", locations: [{ path: "/Users/me/.ssh/id_rsa" }] }, options: PERMISSION_OPTIONS });
				agent.say("{}");
				agent.reply(m, { stopReason: "end_turn" });
			},
		},
	});
	const { env, p } = withAgent(fake);
	p.makeJobDir = async () => "/tmp/zusia-job-1";
	env.window.OS.File.removeDir = async () => {};
	assert.deepEqual(plain(await env.runBackgroundCall.call(p, KEY, "MEMORY TASK")), { text: "{}", error: "", rateLimited: false });
	assert.equal(fake.sent("session/new")[0].params.cwd, "/tmp/zusia-job-1");
	assert.equal(reply.result.outcome.optionId, "no");
});

test("acp: a line split across reads, CRLF endings and a last line without a newline all arrive", async () => {
	const fake = fakeProcess();
	const connection = plugin.createAcpConnection(fake.proc, { label: "Agent" });
	const first = connection.request("initialize", { protocolVersion: 1 });
	const second = connection.request("session/new", { cwd: "/d", mcpServers: [] });
	const third = connection.request("session/prompt", { sessionId: "s", prompt: [] });
	await flush();
	fake.sendRaw('{"jsonrpc":"2.0","id":1,"res');
	fake.sendRaw('ult":{"agentCapabilities":{}}}\r\n');
	fake.sendRaw('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s"}}\r\n{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}');
	fake.stdout.end();
	assert.deepEqual(plain(await first), { agentCapabilities: {} });
	assert.deepEqual(plain(await second), { sessionId: "s" });
	assert.deepEqual(plain(await third), { stopReason: "end_turn" });
	await connection.close();
});
