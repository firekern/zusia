"use strict";

Object.assign(Zusia, {
	createAcpConnection(proc, { onNotification, onRequest } = {}) {
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

		let lastStderrLine = () => {
			let lines = stderr.split("\n").map(line => line.trim()).filter(Boolean);
			return lines.length ? lines[lines.length - 1] : "";
		};

		let closedError = () => {
			let why = exited && exitCode !== null ? "The agent exited with code " + exitCode : "The agent closed its output";
			let last = lastStderrLine();
			let error = new Error(why + " before the reply arrived" + (last ? ": " + last : "."));
			error.acpClosed = true;
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

		let notify = (method, params) => write({ jsonrpc: "2.0", method, params });

		let close = () => {
			if (!closing) {
				closing = (async () => {
					ended = true;
					try {
						await proc.stdin.close();
					}
					catch (e) {
					}
					await waitFor(exitPromise, 150);
					let code = exited ? exitCode : null;
					if (!exited) {
						try {
							proc.kill();
						}
						catch (e) {}
					}
					await waitFor(stderrDone, 150);
					rejectPending();
					return { stderr, exitCode: code };
				})().catch(() => ({ stderr, exitCode: exited ? exitCode : null }));
			}
			return closing;
		};

		return { request, notify, close };
	},

	acpPermissionReply(toolCall, options) {
		let kind = String((toolCall && toolCall.kind) || "").toLowerCase();
		let wanted = ["read", "search", "fetch", "think", "other"].includes(kind) ? "allow" : "reject";
		let best = null;
		let bestRank = -1;
		for (let option of options || []) {
			let optionKind = String((option && option.kind) || "").toLowerCase();
			if (!optionKind.startsWith(wanted)) {
				continue;
			}
			let rank = optionKind === wanted + "_always" ? 2 : optionKind === wanted + "_once" ? 1 : 0;
			if (rank > bestRank) {
				bestRank = rank;
				best = option;
			}
		}
		if (!best || !best.optionId) {
			return { outcome: { outcome: "cancelled" } };
		}
		return { outcome: { outcome: "selected", optionId: best.optionId } };
	},

	acpStep({ title, kind, rawInput } = {}) {
		let stepKind = kind === "read" ? "read"
			: kind === "search" || kind === "fetch" ? "search"
			: kind === "execute" ? "run"
			: "tool";
		let raw = rawInput || {};
		let file = raw.file_path || raw.path || raw.AbsolutePath || "";
		let command = String(raw.command || "").replace(/\s+/g, " ").trim();
		let target;
		if (file && ["read", "edit", "delete", "move"].includes(kind)) {
			target = String(file).split(/[\\/]/).pop();
		}
		else if (stepKind === "run" && command) {
			target = command;
		}
		else {
			target = title || kind || stepKind;
		}
		let label = title || { read: "Read a file", search: "Searched", run: "Ran a command", tool: "Used a tool" }[stepKind];
		return { kind: stepKind, target, label };
	},

	async acpReadFile(dir, { path, line, limit } = {}) {
		let fail = (code, message) => {
			let error = new Error(message);
			error.code = code;
			return error;
		};
		if (!path) {
			throw fail(-32602, "fs/read_text_file needs a path");
		}
		let base = String(dir || "").replace(/[\\/]+$/, "");
		let outside = () => fail(-32001, "Zusia only reads inside the paper folder: " + path);
		if (String(path).split(/[\\/]/).includes("..")) {
			throw outside();
		}
		let absolute = /^([\\/]|[A-Za-z]:[\\/])/.test(path);
		let full = absolute ? String(path) : OS.Path.join(dir, path);
		if (!(full === base || full.startsWith(base + "/") || full.startsWith(base + "\\"))) {
			throw outside();
		}

		let text = await Zotero.File.getContentsAsync(full);
		text = typeof text === "string" ? text : String(text || "");
		let lines = text.split("\n");
		let start = Math.max(1, Math.floor(Number(line) || 1)) - 1;
		let count = Math.floor(Number(limit) || 0);
		let content = (count > 0 ? lines.slice(start, start + count) : lines.slice(start)).join("\n");
		if (content.length > 400000) {
			content = content.slice(0, 400000) + "\n\n[truncated]";
		}
		return { content };
	},

	async acpPromptBlocks(text, images) {
		let blocks = [{ type: "text", text }];
		for (let path of images || []) {
			let { data, mimeType } = await this.imageBase64(path);
			blocks.push({ type: "image", data, mimeType });
		}
		return blocks;
	},

	acpModelChoices(configOptions) {
		let option = (configOptions || []).find(o => o && (o.category === "model" || o.id === "model"));
		if (!option || !Array.isArray(option.options)) {
			return [];
		}
		return option.options
			.filter(o => o && o.value !== undefined)
			.map(o => ({ id: o.value, label: o.name || o.value, desc: o.description || "" }));
	},
});
