// A stand-in ACP agent for the integration run: newline-delimited JSON-RPC on stdio, with
// no model and no network, so the sidebar's ACP path runs in a real Zotero wherever node
// does. Each turn asks Zusia for what a real agent asks for: permission to read, then a
// file in the paper folder and one beside it. What it receives and what Zusia answers is
// appended, one JSON object per line, to the file named by its argument, for the tester.
//   node acp-stub.mjs <record.jsonl>
import { appendFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const recordPath = process.argv[2];
if (!recordPath) {
	process.stderr.write("usage: node acp-stub.mjs <record.jsonl>\n");
	process.exit(2);
}
const record = entry => appendFileSync(recordPath, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const say = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
const text = value => ({ type: "text", text: value });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The stub's own requests to Zusia, resolved with {result} or {error} as it answered.
const answers = new Map();
let nextId = 1;
const ask = (method, params) => new Promise((resolve) => {
	const id = nextId++;
	answers.set(id, resolve);
	send({ id, method, params });
});

const fail = (code, message) => Object.assign(new Error(message), { code });

// Every turn is a new process, so the session, its folder and its options start afresh.
let cwd = "";
let loaded = false;
const chosen = { model: "stub-fast", thinking: "medium" };
const configOptions = () => [
	{ id: "model", name: "Model", category: "model", type: "select", currentValue: chosen.model, options: [
		{ value: "stub-fast", name: "Stub Fast", description: "Answers at once" },
		{ value: "stub-deep", name: "Stub Deep", description: "Thinks first" },
	] },
	// Not called "effort": Zusia has to find it by the spec's category.
	{ id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: chosen.thinking,
		options: ["low", "medium", "high"].map(value => ({ value, name: value })) },
];

// A session can be loaded only if an earlier process created it.
const known = sessionId => readFileSync(recordPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
	.some(entry => entry.method === "session/new" && entry.sessionId === sessionId);

const PERMISSION_OPTIONS = [
	{ optionId: "allow-once", name: "Allow", kind: "allow_once" },
	{ optionId: "allow-always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

async function prompt({ sessionId, prompt: blocks }) {
	const question = blocks.filter(block => block.type === "text").map(block => block.text).join("\n");
	const paths = {
		inside: join(cwd, "metadata.md"),
		// Its name starts with the paper folder's, which a bare prefix test would let through.
		outside: join(cwd + "-other", "metadata.md"),
	};
	const readCall = where => ({ toolCallId: "read-" + where, title: "Read " + basename(paths[where]), kind: "read",
		locations: [{ path: paths[where] }], rawInput: { path: paths[where] } });

	say(sessionId, { sessionUpdate: "agent_thought_chunk", content: text("Looking for the secret word.") });
	// Long enough for the sidebar to time the thought.
	await sleep(50);
	const permissions = {};
	for (const where of ["inside", "outside"]) {
		const { result, error } = await ask("session/request_permission",
			{ sessionId, toolCall: readCall(where), options: PERMISSION_OPTIONS });
		permissions[where] = result ? result.outcome : { error };
	}
	say(sessionId, { sessionUpdate: "tool_call", status: "pending", ...readCall("inside") });
	const reads = {};
	for (const where of ["inside", "outside"]) {
		reads[where] = await ask("fs/read_text_file", { sessionId, path: paths[where] });
	}
	say(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "read-inside", status: "completed" });
	record({ method: "session/prompt", sessionId, loaded, model: chosen.model, thinking: chosen.thinking,
		chars: question.length, permissions, reads });

	// A marker no prompt of Zusia's contains: this turn stays open until Zusia stops the process.
	if (question.includes("STUB-HOLD")) {
		say(sessionId, { sessionUpdate: "agent_message_chunk", content: text("Still working on it.") });
		return new Promise(() => {});
	}
	const word = /secret word of this paper is (\w+)/i.exec((reads.inside.result && reads.inside.result.content) || "");
	for (const part of ["The secret word ", "is " + (word ? word[1] : "not in the file I could read") + "."]) {
		say(sessionId, { sessionUpdate: "agent_message_chunk", content: text(part) });
	}
	return { stopReason: "end_turn" };
}

const handlers = {
	initialize: () => ({
		protocolVersion: 1,
		agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
		authMethods: [],
	}),
	"session/new": (params) => {
		cwd = params.cwd;
		const sessionId = "stub-" + process.pid + "-" + Date.now();
		record({ method: "session/new", sessionId, cwd });
		return { sessionId, configOptions: configOptions() };
	},
	"session/load": (params) => {
		const ok = known(params.sessionId);
		record({ method: "session/load", sessionId: params.sessionId, known: ok });
		if (!ok) {
			throw fail(-32002, "Unknown session " + params.sessionId);
		}
		cwd = params.cwd;
		loaded = true;
		// The spec replays the conversation as updates before the reply; Zusia must not show them.
		say(params.sessionId, { sessionUpdate: "agent_message_chunk", content: text("REPLAYED: an answer from an earlier turn.") });
		return { configOptions: configOptions() };
	},
	"session/set_config_option": ({ configId, value }) => {
		if (!Object.hasOwn(chosen, configId)) {
			throw fail(-32602, "No option " + configId);
		}
		chosen[configId] = value;
		record({ method: "session/set_config_option", configId, value });
		return { configOptions: configOptions() };
	},
	"session/prompt": prompt,
};

createInterface({ input: process.stdin }).on("line", async (line) => {
	if (!line.trim()) {
		return;
	}
	const message = JSON.parse(line);
	if (message.method === undefined) {
		answers.get(message.id)({ result: message.result, error: message.error });
		answers.delete(message.id);
		return;
	}
	// A notification, session/cancel among them, needs no reply.
	if (message.id === undefined) {
		return;
	}
	const handler = handlers[message.method];
	try {
		if (!handler) {
			throw fail(-32601, "Method not found: " + message.method);
		}
		send({ id: message.id, result: await handler(message.params || {}) });
	}
	catch (e) {
		send({ id: message.id, error: { code: e.code === undefined ? -32603 : e.code, message: e.message } });
	}
}).on("close", () => process.exit(0));
