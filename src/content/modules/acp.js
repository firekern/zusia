"use strict";

Object.assign(Zusia, {

	// Zusia answers the agent's permission prompts itself. Thinking is allowed, and so is a
	// read or a search whose every named path lies in the folder; anything else (a change,
	// a command, the network, a path elsewhere or none at all) is refused. This binds only
	// an agent that asks: one that reads with its own tools unasked is beyond Zusia's reach,
	// which is why an agent runs memory jobs only once its card allows it.
	acpPermissionReply(toolCall, options, dir) {
		let raw = toolCall.rawInput || {};
		let named = list => list.filter(path => typeof path === "string" && path);
		let paths = named((Array.isArray(toolCall.locations) ? toolCall.locations : []).map(location => location && location.path));
		if (!paths.length) {
			paths = named([raw.path, raw.file_path, raw.AbsolutePath]);
		}
		let allow = toolCall.kind === "think" ||
			(["read", "search"].includes(toolCall.kind) && paths.length > 0 && paths.every(path => this.acpInside(dir, path)));
		let find = kind => options.find(option => option && option.kind === kind && option.optionId);
		// Never allow_always: the agent would remember it and skip this check for later paths.
		let pick = (allow && find("allow_once")) || find("reject_once") || find("reject_always");
		if (!pick) {
			return { outcome: { outcome: "cancelled" } };
		}
		return { outcome: { outcome: "selected", optionId: pick.optionId } };
	},

	// The native full path `path` names when it is `dir` or lies under it, else null. Gecko on
	// Windows takes only "\" and Windows compares names without case; elsewhere only "/"
	// separates, so a "\" is part of a name.
	acpInside(dir, path) {
		let win = Zotero.isWin;
		let sep = win ? "\\" : "/";
		let native = text => (win ? text.replace(/\//g, "\\") : text);
		let fold = text => (win ? text.toLowerCase() : text);
		let base = native(dir).replace(win ? /\\+$/ : /\/+$/, "");
		let given = native(path);
		if (given.split(sep).includes("..")) {
			return null;
		}
		// A drive, even "C:x", or a leading "\" (a \\server share among them) is never
		// joined onto the folder.
		let absolute = win ? /^([A-Za-z]:|\\)/.test(given) : given.startsWith("/");
		let full = absolute ? given : OS.Path.join(base, given);
		return fold(full) === fold(base) || fold(full).startsWith(fold(base) + sep) ? full : null;
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
		if (typeof path !== "string" || !path) {
			throw fail(-32602, "fs/read_text_file needs a path");
		}
		let full = this.acpInside(dir, path);
		if (!full) {
			throw fail(-32001, "Zusia only reads inside the paper folder: " + path);
		}

		let text = await Zotero.File.getContentsAsync(full);
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
		for (let path of images) {
			let { data, mimeType } = await this.imageBase64(path);
			blocks.push({ type: "image", data, mimeType });
		}
		return blocks;
	},

	// The agent's option for "model" or "effort": found by the spec's category (a reasoning
	// level is "thought_level"), or by the id agents used before there were categories.
	acpConfigOption(configOptions, which) {
		let category = which === "effort" ? "thought_level" : which;
		return (Array.isArray(configOptions) ? configOptions : []).find(o => o && (o.category === category || o.id === which)) || null;
	},

	// A select's values, flat: the spec lets an agent group them as { group, name, options }.
	acpSelectValues(option) {
		return (Array.isArray(option.options) ? option.options : [])
			.flatMap(o => (o && Array.isArray(o.options) ? o.options : [o]))
			.filter(o => o && o.value !== undefined);
	},

	acpModelChoices(configOptions) {
		let option = this.acpConfigOption(configOptions, "model");
		return option
			? this.acpSelectValues(option).map(o => ({ id: o.value, label: o.name || o.value, desc: o.description || "" }))
			: [];
	},

	acpArgs(backend) {
		return this.BACKENDS[backend].acpArgs;
	},

	acpInitialize(connection) {
		return connection.request("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "Zusia", version: this.version },
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
		});
	},

	// Each exchange starts the agent afresh and closes it whatever happens, so no agent
	// outlives the question, the sign-in or the model list that needed it.
	async withAcpConnection(backend, cwd, { onSpawn, onNotification, onRequest, timeoutMs = 0 }, exchange) {
		let label = this.BACKENDS[backend].label;
		let connection = null;
		let done = false;
		let timedOut = false;
		try {
			let command = await this.findBinary(backend);
			let proc = await this.spawnAgent(command, this.acpArgs(backend), cwd);
			if (onSpawn) {
				onSpawn(proc);
			}
			connection = this.createAcpConnection(proc, { label, onNotification, onRequest });
			if (timeoutMs) {
				// Closing kills the agent and rejects what it still owes, which ends the exchange.
				Zotero.Promise.delay(timeoutMs).then(() => {
					if (!done) {
						timedOut = true;
						connection.close();
					}
				});
			}
			let hello = await this.acpInitialize(connection);
			return await exchange(connection, hello);
		}
		catch (e) {
			if (timedOut) {
				throw new Error(label + " did not answer within " + Math.round(timeoutMs / 1000) + " s.", { cause: e });
			}
			throw e;
		}
		finally {
			done = true;
			if (connection) {
				await connection.close();
			}
		}
	},

	// An agent's models: null until it has listed them, then the list; why the last listing
	// failed; and the listing in flight.
	acpModelEntry(backend) {
		return this._acpModels[backend] ??= { models: null, error: "", promise: null };
	},

	// A failure is kept until the reader asks again from the card, so opening the menu twice
	// does not start an agent twice, and an npx agent is not downloaded again. Resolves to
	// the list, empty when it failed, and never rejects.
	loadAcpModels(backend, { retry = false } = {}) {
		let entry = this.acpModelEntry(backend);
		if (entry.promise) {
			return entry.promise;
		}
		if (entry.models || (entry.error && !retry)) {
			return Promise.resolve(entry.models || []);
		}
		let label = this.BACKENDS[backend].label;
		entry.error = "";
		entry.promise = (async () => {
			try {
				let opened = await this.withAcpConnection(backend, this.getDataDir(), { timeoutMs: this.ACP_MODELS_TIMEOUT_MS }, connection =>
					connection.request("session/new", { cwd: this.getDataDir(), mcpServers: [] }));
				this.rememberAcpConfig(backend, opened.configOptions);
				// Listed, even when the agent offers no choice of model.
				entry.models = entry.models || [];
			}
			catch (e) {
				entry.error = e.message;
				this.log("Could not list " + label + " models: " + e);
			}
			finally {
				entry.promise = null;
			}
			return entry.models || [];
		})();
		return entry.promise;
	},

	// Resolves to {methods} once the agent took the first sign-in method, or {error, methods};
	// never rejects.
	async acpAuthenticate(backend) {
		try {
			return await this.withAcpConnection(backend, this.getDataDir(), {}, async (connection, hello) => {
				let methods = hello.authMethods || [];
				if (!methods.length) {
					return { error: "This agent has no ACP sign-in methods. Sign in with its own CLI in a terminal.", methods: [] };
				}
				try {
					await connection.request("authenticate", { methodId: methods[0].id });
					return { methods };
				}
				catch (e) {
					return { error: e.message, methods };
				}
			});
		}
		catch (e) {
			return { error: e.message, methods: [] };
		}
	},

	// A chat question. A resumed session already holds the paper and the instructions, so it
	// gets the question alone; a new one gets the whole prompt with the chat so far.
	runAcp(backend, request) {
		return this.acpTurn(backend, {
			...request,
			cwd: request.ctx.dir,
			prompt: resumed => (resumed ? this.questionPrompt(request) : this.sessionPrompt({ ...request, session: null })),
		});
	},

	// One prompt, `prompt(resumed)`, through a fresh agent process: `session` resumed when the
	// agent can load it, else a new one, the model and effort applied, and the answer streamed
	// to onProgress. Resolves to {text, error, sessionId, partialText, truncated, resumeFailed},
	// with a sessionId only from an agent that can load it again.
	async acpTurn(backend, { cwd, prompt, session = null, images = [], model, effort, onProgress = () => {}, onSpawn }) {
		let label = this.BACKENDS[backend].label;
		let state = { text: "", narration: "", thinking: false, thoughtAt: 0, tools: new Map(), emitted: new Set() };
		// Only the prompt produces updates worth reading; the turns a session/load replays and
		// a config change do not.
		let onUpdate = null;
		let sessionId = null;
		let resumable = false;
		let resumed = false;
		// Only a session the agent can load again is worth keeping: ask() would otherwise take
		// the next question for a follow-up and record no instructions for what it sends.
		let kept = () => (resumable && sessionId ? { sessionId } : {});
		try {
			return await this.withAcpConnection(backend, cwd, {
				onSpawn,
				onNotification: (method, params) => {
					if (method === "session/update" && onUpdate && params && params.update) {
						onUpdate(params.update);
					}
				},
				onRequest: (method, params) => this.acpRequest(method, params, cwd, label),
			}, async (connection, hello) => {
				let capabilities = hello.agentCapabilities || {};
				resumable = !!capabilities.loadSession;
				if (images.length && !(capabilities.promptCapabilities && capabilities.promptCapabilities.image)) {
					return { text: "", error: label + " does not accept images. Remove the attachment or switch assistant." };
				}

				let configOptions = null;
				if (session && resumable) {
					try {
						let loaded = await connection.request("session/load", { sessionId: session.id, cwd, mcpServers: [] });
						sessionId = session.id;
						configOptions = loaded.configOptions || null;
						resumed = true;
						this.log("acp: session " + sessionId + " resumed");
					}
					catch (e) {
						let help = this.acpSignInHelp(label, e.message);
						if (help) {
							return { text: "", error: help };
						}
						this.log("acp: session " + session.id + " could not be loaded (" + e.message + ")");
						return { text: "", error: e.message, resumeFailed: true };
					}
				}
				if (!sessionId) {
					let opened;
					try {
						opened = await connection.request("session/new", { cwd, mcpServers: [] });
					}
					catch (e) {
						return { text: "", error: this.acpSignInHelp(label, e.message) || e.message };
					}
					sessionId = opened.sessionId;
					configOptions = opened.configOptions || null;
				}

				this.rememberAcpConfig(backend, configOptions);
				let refused = await this.applyAcpOptions(connection, sessionId, configOptions, model, effort, label);
				if (refused) {
					return { text: "", error: refused, ...kept() };
				}

				let blocks = await this.acpPromptBlocks(prompt(resumed), images);
				onUpdate = update => this.acpProgress(update, state, onProgress);
				let answer = await connection.request("session/prompt", { sessionId, prompt: blocks });
				onUpdate = null;
				this.flushAcpTools(state, onProgress);

				let text = (state.text || state.narration).trim();
				if (!text) {
					return { text: "", error: answer.stopReason === "refusal" ? label + " declined to answer." : label + " returned no text.", ...kept() };
				}
				return { text, ...kept(), truncated: answer.stopReason === "max_tokens" };
			});
		}
		catch (e) {
			onUpdate = null;
			let partialText = (state.text || state.narration).trim();
			let help = this.acpSignInHelp(label, e.message);
			if (help) {
				return { text: "", error: help, ...kept() };
			}
			if (!e.acpClosed) {
				this.logError(label + " ACP", e);
			}
			return { text: "", error: e.message, ...kept(), partialText, resumeFailed: resumed && !partialText };
		}
	},

	acpProgress(update, state, onProgress) {
		let textOf = (block) => block && block.type === "text" && block.text ? block.text : "";
		if (update.sessionUpdate === "agent_message_chunk") {
			let text = textOf(update.content);
			if (!text) {
				return;
			}
			if (state.thinking) {
				state.thinking = false;
				onProgress({ thinking: false, thoughtMs: Date.now() - state.thoughtAt });
			}
			state.text += text;
			onProgress({ text: state.text, status: "writing" });
			return;
		}
		if (update.sessionUpdate === "agent_thought_chunk") {
			if (!textOf(update.content)) {
				return;
			}
			if (!state.thinking) {
				state.thinking = true;
				state.thoughtAt = Date.now();
			}
			onProgress({ status: "thinking", thinking: true });
			return;
		}
		if (update.sessionUpdate === "tool_call") {
			let call = { title: update.title, kind: update.kind, rawInput: update.rawInput };
			state.tools.set(update.toolCallId, call);
			if (state.thinking) {
				state.thinking = false;
				onProgress({ thinking: false, thoughtMs: Date.now() - state.thoughtAt });
			}
			if (state.text) {
				state.narration += (state.narration ? "\n\n" : "") + state.text;
				state.text = "";
				onProgress({ text: "" });
			}
			onProgress({ status: this.acpToolStatus(call) });
			return;
		}
		if (update.sessionUpdate === "tool_call_update") {
			let call = state.tools.get(update.toolCallId) || { title: update.title, kind: update.kind, rawInput: {} };
			if (update.title) {
				call.title = update.title;
			}
			state.tools.set(update.toolCallId, call);
			if (update.status === "completed" || update.status === "failed") {
				this.emitAcpTool(update.toolCallId, call, state, onProgress);
			}
			else if (update.status === "in_progress") {
				onProgress({ status: this.acpToolStatus(call) });
			}
		}
	},

	acpToolStatus(call) {
		if (call.kind === "read") {
			return "reading the paper";
		}
		if (call.kind === "search" || call.kind === "fetch") {
			return "searching the paper";
		}
		return "using " + (call.title || call.kind || "a tool");
	},

	emitAcpTool(id, call, state, onProgress) {
		if (state.emitted.has(id)) {
			return;
		}
		state.emitted.add(id);
		onProgress({ step: this.acpStep(call) });
	},

	flushAcpTools(state, onProgress) {
		for (let [id, call] of state.tools) {
			this.emitAcpTool(id, call, state, onProgress);
		}
	},

	async acpRequest(method, params, dir, label) {
		if (method === "session/request_permission") {
			return this.acpPermissionReply(params.toolCall || {}, params.options || [], dir);
		}
		if (method === "fs/read_text_file") {
			return this.acpReadFile(dir, params || {});
		}
		let error = new Error(label + " asked for " + method + ", which Zusia does not provide.");
		error.code = -32601;
		throw error;
	},

	async applyAcpOptions(connection, sessionId, configOptions, model, effort, label) {
		let current = configOptions;
		let set = async (which, value, required) => {
			if (!value) {
				return null;
			}
			let option = this.acpConfigOption(current, which);
			if (!option) {
				return null;
			}
			if (!this.acpSelectValues(option).some(o => o.value === value)) {
				return required ? label + " does not offer " + (option.name || which) + " “" + value + "”." : null;
			}
			let result;
			try {
				result = await connection.request("session/set_config_option", { sessionId, configId: option.id, value });
			}
			catch (e) {
				return required ? label + " could not use " + value + ": " + e.message : null;
			}
			// A change can reshape the other options, the efforts a model offers above all.
			current = Array.isArray(result && result.configOptions) ? result.configOptions : current;
			return null;
		};
		let refused = await set("model", model, true);
		return refused ? refused : set("effort", effort, false);
	},

	// Takes the label, not the backend: the agent may have been removed while it answered.
	acpSignInHelp(label, output) {
		if (!/not authenticated|not signed in|authentication required/i.test(output)) {
			return null;
		}
		return label + " is not signed in. Sign in with its own CLI in a terminal, then ask again.";
	},

	rememberAcpConfig(backend, configOptions) {
		// An agent removed while it answered leaves no list behind for a later one of its id.
		if (!this.BACKENDS[backend]) {
			return;
		}
		let entry = this.acpModelEntry(backend);
		let models = this.acpModelChoices(configOptions);
		// A session/load may come back without options; that keeps the list it had.
		if (models.length) {
			entry.models = models;
		}
		entry.error = "";
	},
});
