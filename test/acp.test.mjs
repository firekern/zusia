import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";
import { loadWindowsPlugin } from "./windows-env.mjs";

const { plugin } = loadPlugin();

const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function stream() {
	const chunks = [];
	const waiting = [];
	let ended = false;
	return {
		push(chunk) {
			chunks.push(chunk);
			const resolve = waiting.shift();
			if (resolve) {
				resolve();
			}
		},
		end() {
			ended = true;
			for (const resolve of waiting.splice(0)) {
				resolve();
			}
		},
		async readString() {
			while (!chunks.length && !ended) {
				await new Promise(resolve => waiting.push(resolve));
			}
			return chunks.length ? chunks.shift() : "";
		},
	};
}

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

test("acp: when the pipe ends, a pending request rejects with acpClosed and why", async () => {
	const fake = fakeProcess();
	const connection = plugin.createAcpConnection(fake.proc);
	const pending = connection.request("session/prompt", { sessionId: "s", prompt: [] });
	await flush();
	fake.stderr.push("booting\nNot authenticated. Run `cmd login` in a terminal first.\n");
	fake.finish(1);
	await assert.rejects(pending, (e) => {
		assert.equal(e.acpClosed, true);
		assert.match(e.message, /exited with code 1/);
		assert.match(e.message, /Not authenticated/);
		return true;
	});
	const { stderr, exitCode } = await connection.close();
	assert.equal(exitCode, 1);
	assert.match(stderr, /Not authenticated/);
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
	const connection = plugin.createAcpConnection(fake.proc);
	fake.stderr.push("y".repeat(5000) + "\nwarning: slow\n");
	await flush();
	const first = await connection.close();
	assert.equal(fake.proc.stdin.closed, true);
	assert.equal(fake.proc.killed, true);
	assert.equal(first.exitCode, null, "a process we had to kill has no exit code to report");
	assert.equal(first.stderr.length, 4000, "only the tail of stderr is kept");
	assert.match(first.stderr, /warning: slow/);
	const second = await connection.close();
	assert.deepEqual(second, first, "closing twice reports the same end");
	await assert.rejects(connection.request("session/prompt", { sessionId: "s" }), (e) => {
		assert.equal(e.acpClosed, true);
		return true;
	});
	assert.deepEqual(fake.writes, [], "a closed pipe writes nothing more");
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
