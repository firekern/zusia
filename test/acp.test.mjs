import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

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
	connection.notify("session/cancel", { sessionId: "s" });
	connection.notify("session/update", {});
	await flush();
	assert.deepEqual(order, ["start session/cancel"], "nothing is written while the first write is in flight");
	releaseFirst();
	await flush();
	assert.deepEqual(order, ["start session/cancel", "end session/cancel", "start session/update", "end session/update"]);
	assert.deepEqual(fake.messages().map(message => message.method), ["session/cancel", "session/update"]);
	assert.ok(fake.messages().every(message => message.id === undefined), "a notification carries no id");
	fake.finish(0);
	await connection.close();
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
	await connection.notify("session/cancel", { sessionId: "s" });
	assert.deepEqual(fake.writes, []);
});

test("acp: permissions allow reading, refuse changes, and cancel when no option fits", () => {
	const allowing = [
		{ optionId: "once", name: "Allow once", kind: "allow_once" },
		{ optionId: "always", name: "Always allow", kind: "allow_always" },
		{ optionId: "never", name: "Reject", kind: "reject_once" },
	];
	const refusing = [
		{ optionId: "no", name: "No", kind: "reject_once" },
		{ optionId: "never", name: "Never", kind: "reject_always" },
	];
	for (const kind of ["read", "search", "fetch", "think", "other"]) {
		assert.deepEqual(plain(plugin.acpPermissionReply({ kind }, allowing)),
			{ outcome: { outcome: "selected", optionId: "always" } }, "allow_always is preferred for " + kind);
	}
	assert.deepEqual(plain(plugin.acpPermissionReply({ kind: "read" }, [allowing[0], allowing[2]])),
		{ outcome: { outcome: "selected", optionId: "once" } }, "allow_once when there is no allow_always");
	for (const kind of ["edit", "delete", "move", "execute"]) {
		assert.deepEqual(plain(plugin.acpPermissionReply({ kind }, refusing)),
			{ outcome: { outcome: "selected", optionId: "never" } }, "refused for " + kind);
	}
	assert.deepEqual(plain(plugin.acpPermissionReply({ kind: "execute" }, [allowing[0], allowing[1]])),
		{ outcome: { outcome: "cancelled" } }, "no reject option offered: nothing is chosen");
	assert.deepEqual(plain(plugin.acpPermissionReply({ kind: "read" }, [])), { outcome: { outcome: "cancelled" } });
	assert.deepEqual(plain(plugin.acpPermissionReply({ kind: "read" }, [{ name: "Allow", kind: "allow_once" }])),
		{ outcome: { outcome: "cancelled" } });
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

test("acp: a huge file is cut at 400000 characters", async () => {
	const files = new Map([["/d/long.txt", "a".repeat(400001)]]);
	const { plugin: p } = loadPlugin({ files });
	const { content } = await p.acpReadFile("/d", { path: "long.txt" });
	assert.equal(content.length, 400000 + "\n\n[truncated]".length);
	assert.ok(content.endsWith("\n\n[truncated]"));
});

test("acp: the model menu comes from the agent's own config options", () => {
	const options = [
		{ id: "effort", name: "Effort", category: "effort", options: [{ value: "high", name: "High" }] },
		{ id: "model", name: "Model", category: "model", options: [
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
	assert.deepEqual(plain(plugin.acpModelChoices([{ id: "effort", category: "effort" }])), []);
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
