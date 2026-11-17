"use strict";

Object.assign(Zusia, {
	// The JSON-RPC pipe to an agent: one request per id, the agent's notifications and
	// its own requests answered by the caller, and a close that leaves nothing pending.

	createAcpConnection(proc, { label, onNotification, onRequest } = {}) {
		let pending = new Map();
		let nextId = 1;
		let stderr = "";
		let ended = false;
		let closing = null;
		let exited = false;
		let exitCode = null;
		let queue = Promise.resolve();

		let exitPromise = (async () => {
			try {
				let result = await proc.wait();
				exited = true;
				exitCode = result && typeof result.exitCode === "number" ? result.exitCode : null;
			}
			catch (e) {
				// A wait that fails still means the process is gone, only without a code to report.
				exited = true;
			}
		})();

		let stderrDone = (async () => {
			let chunk;
			try {
				while ((chunk = await proc.stderr.readString())) {
					stderr = (stderr + chunk).slice(-4000);
				}
			}
			catch (e) {
				this.log("reading the ACP stderr: " + e);
			}
		})();

		let waitFor = (promise, ms) => new Promise((resolve) => {
			let timer = setTimeout(resolve, ms);
			let done = () => {
				clearTimeout(timer);
				resolve();
			};
			promise.then(done, done);
		});

		// The one account of an agent that went away, for a question, a sign-in or a model
		// list alike: its exit code when it gave one, and the end of its stderr, which is
		// where an agent says why (signed out, a rate limit, a crash).
		let closedError = () => {
			let code = exited ? exitCode : null;
			let tail = stderr.trim().slice(-1000);
			let error = new Error(label + (code === null ? " closed its output" : " exited with code " + code) + (tail ? ": " + tail : "."));
			error.acpClosed = true;
			error.exitCode = code;
			error.stderr = tail;
			return error;
		};

		let rejectPending = () => {
			for (let entry of pending.values()) {
				entry.reject(closedError());
			}
			pending.clear();
		};

		let write = (message) => {
			queue = queue.then(async () => {
				if (ended) {
					return;
				}
				try {
					await proc.stdin.write(JSON.stringify(message) + "\n");
				}
				catch (e) {
					this.logError("writing to the ACP agent", e);
				}
			});
			return queue;
		};

		let handleLine = async (line) => {
			line = line.trim();
			if (!line) {
				return;
			}
			let msg;
			try {
				msg = JSON.parse(line);
			}
			catch (e) {
				this.log("Skipping non-JSON ACP output line: " + line.slice(0, 200));
				return;
			}
			if (!msg || typeof msg !== "object") {
				return;
			}
			let hasId = msg.id !== undefined && msg.id !== null;
			if (hasId && msg.method) {
				let reply = { jsonrpc: "2.0", id: msg.id };
				try {
					if (typeof onRequest !== "function") {
						let missing = new Error("No handler for " + msg.method);
						missing.code = -32601;
						throw missing;
					}
					let result = await onRequest(msg.method, msg.params);
					reply.result = result === undefined ? null : result;
				}
				catch (e) {
					reply.error = { code: e && e.code !== undefined ? e.code : -32603, message: String((e && e.message) || e) };
				}
				await write(reply);
				return;
			}
			if (hasId) {
				let entry = pending.get(msg.id);
				if (!entry) {
					return;
				}
				pending.delete(msg.id);
				if (msg.error) {
					let error = new Error(msg.error.message || ("The agent could not " + entry.method));
					error.code = msg.error.code;
					error.data = msg.error.data;
					entry.reject(error);
				}
				else {
					entry.resolve(msg.result);
				}
				return;
			}
			if (msg.method) {
				try {
					let handling = onNotification && onNotification(msg.method, msg.params);
					if (handling && typeof handling.then === "function") {
						handling.then(null, e => this.logError("handling ACP notification " + msg.method, e));
					}
				}
				catch (e) {
					this.logError("handling ACP notification " + msg.method, e);
				}
			}
		};

		(async () => {
			let buffer = "";
			let chunk;
			try {
				while (!ended && (chunk = await proc.stdout.readString())) {
					buffer += chunk;
					let lines = buffer.split("\n");
					buffer = lines.pop();
					for (let line of lines) {
						await handleLine(line);
					}
				}
				if (!ended && buffer.trim()) {
					await handleLine(buffer);
				}
			}
			catch (e) {
				this.logError("reading the ACP agent", e);
			}
			if (ended) {
				return;
			}
			ended = true;
			await waitFor(exitPromise, 150);
			await waitFor(stderrDone, 150);
			rejectPending();
		})();

		let request = (method, params) => {
			if (ended) {
				return Promise.reject(closedError());
			}
			let id = nextId++;
			let promise = new Promise((resolve, reject) => {
				pending.set(id, { method, resolve, reject });
			});
			write({ jsonrpc: "2.0", id, method, params });
			return promise;
		};

		let close = () => {
			if (!closing) {
				closing = (async () => {
					ended = true;
					// A pipe the agent already closed is not an error on the way out.
					try {
						await proc.stdin.close();
					}
					catch (e) {
						this.log("closing the ACP stdin: " + e);
					}
					await waitFor(exitPromise, 150);
					if (!exited) {
						// The same for a process that has gone away since the last check.
						try {
							proc.kill();
						}
						catch (e) {
							this.log("killing the ACP agent: " + e);
						}
					}
					await waitFor(stderrDone, 150);
					rejectPending();
				})();
			}
			return closing;
		};

		return { request, close };
	},
});
