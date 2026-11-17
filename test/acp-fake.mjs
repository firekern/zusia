// A scripted ACP agent on fake pipes, for the tests of Zusia's ACP client.
import assert from "node:assert/strict";

export const flush = () => new Promise(resolve => setImmediate(resolve));

// One end of a pipe: the test pushes text, the client reads it as Subprocess's readString would.
export function stream() {
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

// `on[method](message, agent)` answers one of the client's requests in place of the default,
// which answers like a plain agent: initialize with `capabilities`, session/new with
// `sessionId` and `configOptions`, session/prompt with `answer` and end_turn. `messages` holds
// everything the client wrote; `agent.ask` sends a request of the agent's own and resolves
// to the client's reply. The agent exits when its stdin closes, as real ones do.
export function fakeAgent({ answer = "It is the FFT.", sessionId = "s-1", auth = [], configOptions = [], capabilities = {}, on = {} } = {}) {
	const stdout = stream();
	const stderr = stream();
	const messages = [];
	const replies = new Map();
	let nextId = 1000;
	let finish;
	const send = message => stdout.push(JSON.stringify(message) + "\n");
	const agent = {
		messages,
		send,
		reply: (message, result) => send({ jsonrpc: "2.0", id: message.id, result }),
		fail: (message, code, text) => send({ jsonrpc: "2.0", id: message.id, error: { code, message: text } }),
		update: update => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }),
		say: text => agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
		ask: (method, params) => new Promise((resolve) => {
			const id = nextId++;
			replies.set(id, resolve);
			send({ jsonrpc: "2.0", id, method, params });
		}),
		stderr: text => stderr.push(text),
		exit: exitCode => proc.finish(exitCode),
		sent: method => messages.filter(message => message.method === method),
	};
	const defaults = {
		initialize: m => agent.reply(m, { protocolVersion: 1, agentCapabilities: { loadSession: false, ...capabilities }, authMethods: auth }),
		authenticate: m => agent.reply(m, {}),
		"session/new": m => agent.reply(m, { sessionId, configOptions }),
		"session/set_config_option": m => agent.reply(m, { configOptions }),
		"session/prompt": (m) => {
			agent.say(answer);
			agent.reply(m, { stopReason: "end_turn" });
		},
	};
	const proc = {
		stdin: {
			closed: false,
			async write(text) {
				assert.ok(!proc.stdin.closed, "write after stdin was closed");
				const message = JSON.parse(text);
				messages.push(message);
				if (message.method) {
					const handle = on[message.method] || defaults[message.method];
					// Not awaited: the client writes its replies to the agent's own requests
					// through this same pipe, one write at a time.
					Promise.resolve().then(() => handle && handle(message, agent));
				}
				else if (replies.has(message.id)) {
					replies.get(message.id)(message);
					replies.delete(message.id);
				}
			},
			async close() {
				proc.stdin.closed = true;
				proc.finish(0);
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
	agent.proc = proc;
	return agent;
}
