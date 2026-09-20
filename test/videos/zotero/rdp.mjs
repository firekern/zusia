// A minimal client for the Firefox Remote Debugging Protocol, enough to run JavaScript
// in Zotero's main process (started with --start-debugger-server <port>).
import { connect } from "node:net";

export async function attach(port = 6200) {
	let socket = connect(port, "127.0.0.1");
	let buffer = Buffer.alloc(0);
	let waiters = [];
	let listeners = new Set();
	let stash = [];

	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			let colon = buffer.indexOf(":");
			if (colon < 0) {
				return;
			}
			let length = Number(buffer.subarray(0, colon).toString());
			if (buffer.length < colon + 1 + length) {
				return;
			}
			let packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString());
			buffer = buffer.subarray(colon + 1 + length);
			for (let listener of listeners) {
				listener(packet);
			}
			let index = waiters.findIndex(w => w.match(packet));
			if (index >= 0) {
				waiters.splice(index, 1)[0].resolve(packet);
			}
			else if (packet.type === "evaluationResult") {
				// A result can arrive in the same chunk as the reply naming it, before anyone waits for it.
				stash.push(packet);
			}
		}
	});
	await new Promise((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});

	let next = match => new Promise((resolve) => {
		let index = stash.findIndex(match);
		if (index >= 0) {
			resolve(stash.splice(index, 1)[0]);
		}
		else {
			waiters.push({ match, resolve });
		}
	});
	// Actors also emit notifications; only a packet without a type (or an evaluation's
	// immediate reply, which carries its resultID) answers a request.
	let send = (packet) => {
		let reply = next(p => p.from === packet.to && (packet.type === "evaluateJSAsync" ? "resultID" in p && p.type !== "evaluationResult" : !p.type || p.type === packet.type));
		let json = Buffer.from(JSON.stringify(packet));
		socket.write(json.length + ":");
		socket.write(json);
		return reply;
	};

	await next(p => p.from === "root");
	let { processDescriptor } = await send({ to: "root", type: "getProcess", id: 0 });
	let target = await send({ to: processDescriptor.actor, type: "getTarget" });
	let consoleActor = target.process.consoleActor;

	let grip = async (value) => {
		if (value && value.type === "longString") {
			let full = await send({ to: value.actor, type: "substring", start: 0, end: value.length });
			return full.substring;
		}
		return value && typeof value === "object" && "type" in value ? undefined : value;
	};

	// Evaluates an async body and waits for its result through a global slot.
	async function evaluate(source) {
		let id = "r" + Math.random().toString(36).slice(2);
		let text = `(() => { let slot = (globalThis.__zusia = globalThis.__zusia || {});
			let win = Services.wm.getMostRecentWindow("navigator:browser"); let doc = win.document;
			let Zotero = win.Zotero;
			slot[${JSON.stringify(id)}] = { pending: true };
			(async () => { ${source} })().then(
				v => { slot[${JSON.stringify(id)}] = { done: JSON.stringify(v === undefined ? null : v) }; },
				e => { slot[${JSON.stringify(id)}] = { error: String(e) + " @ " + (e && e.stack) }; });
			return "started"; })()`;
		let started = await send({ to: consoleActor, type: "evaluateJSAsync", text });
		let first = await next(p => p.type === "evaluationResult" && p.resultID === started.resultID);
		if (first.exceptionMessage) {
			throw new Error(first.exceptionMessage);
		}
		for (;;) {
			let { resultID } = await send({ to: consoleActor, type: "evaluateJSAsync",
				text: `(() => { let s = globalThis.__zusia[${JSON.stringify(id)}]; if (!s.pending) delete globalThis.__zusia[${JSON.stringify(id)}]; return JSON.stringify(s); })()` });
			let poll = await next(p => p.type === "evaluationResult" && p.resultID === resultID);
			let state = JSON.parse(await grip(poll.result));
			if (state.error) {
				throw new Error(state.error);
			}
			if (!state.pending) {
				return JSON.parse(state.done);
			}
			await new Promise(resolve => setTimeout(resolve, 60));
		}
	}

	return { evaluate, close: () => socket.end() };
}
