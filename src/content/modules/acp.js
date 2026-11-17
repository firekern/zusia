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

	acpArgs(backend) {
		return this.BACKENDS[backend].acpArgs.slice();
	},

	acpInitialize(connection) {
		return connection.request("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "Zusia", version: this.version },
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
		});
	},

	// One agent process for one exchange: find it, start it, say hello, and close it whatever happens.
	async withAcpConnection(backend, cwd, exchange) {
		let connection = null;
		try {
			let command = await this.findBinary(backend);
			let proc = await this.spawnAgent(command, this.acpArgs(backend), cwd);
			connection = this.createAcpConnection(proc);
			let hello = await this.acpInitialize(connection);
			return await exchange(connection, hello);
		}
		finally {
			if (connection) {
				await connection.close();
			}
		}
	},

	// A failure is kept until the reader asks again from the card, so opening the menu twice
	// does not start an agent twice, and an npx agent is not downloaded again.
	async loadAcpModels(backend, { retry = false } = {}) {
		if (Array.isArray(this._acpModels[backend])) {
			return this._acpModels[backend];
		}
		if (this._acpModelPromises[backend]) {
			return this._acpModelPromises[backend];
		}
		if (!retry && this._acpModelErrors[backend]) {
			return [];
		}
		delete this._acpModelErrors[backend];
		this._acpModelPromises[backend] = (async () => {
			try {
				let opened = await this.withAcpConnection(backend, this.getDataDir(), connection =>
					connection.request("session/new", { cwd: this.getDataDir(), mcpServers: [] }));
				if (!this.BACKENDS[backend]) {
					return [];
				}
				this.rememberAcpConfig(backend, opened.configOptions);
				if (!Array.isArray(this._acpModels[backend])) {
					this._acpModels[backend] = [];
				}
				this.refreshAllSidebars();
				return this._acpModels[backend];
			}
			catch (e) {
				if (this.BACKENDS[backend]) {
					this._acpModelErrors[backend] = String((e && e.message) || e);
				}
				this.log("Could not list " + (this.BACKENDS[backend] ? this.BACKENDS[backend].label : backend) + " models: " + e);
				return [];
			}
			finally {
				delete this._acpModelPromises[backend];
			}
		})();
		return this._acpModelPromises[backend];
	},

	async acpAuthenticate(backend) {
		try {
			return await this.withAcpConnection(backend, this.getDataDir(), async (connection, hello) => {
				let methods = hello.authMethods || [];
				if (!methods.length) {
					return { error: "This agent has no ACP sign-in methods. Sign in with its own CLI in a terminal.", methods: [] };
				}
				let method = methods[0];
				try {
					let result = await connection.request("authenticate", { methodId: method.id });
					return { method, methods, result };
				}
				catch (e) {
					return { error: e.message, methods, method };
				}
			});
		}
		catch (e) {
			return { error: String((e && e.message) || e), methods: [] };
		}
	},
	async runAcp(backend, request) {
		let { ctx, onProgress, onSpawn } = request;
		let label = this.BACKENDS[backend].label;
		let command = await this.findBinary(backend);
		let proc = await this.spawnAgent(command, this.acpArgs(backend), ctx.dir);
		if (onSpawn) {
			onSpawn(proc);
		}

		let state = { text: "", narration: "", thinking: false, thoughtAt: 0, tools: new Map(), emitted: new Set() };
		// Only the prompt produces updates worth reading; a session/load or a config change does not.
		let onUpdate = null;
		let connection = this.createAcpConnection(proc, {
			onNotification: (method, params) => {
				if (method === "session/update" && onUpdate && params && params.update) {
					onUpdate(params.update);
				}
			},
			onRequest: (method, params) => this.acpRequest(method, params, ctx.dir, label),
		});

		let sessionId = null;
		let resumed = false;
		try {
			let hello = await this.acpInitialize(connection);
			if (request.images && request.images.length &&
				!(hello.agentCapabilities && hello.agentCapabilities.promptCapabilities && hello.agentCapabilities.promptCapabilities.image)) {
				return { text: "", error: label + " does not accept images. Remove the attachment or switch assistant." };
			}

			let configOptions = null;
			if (request.session && hello.agentCapabilities && hello.agentCapabilities.loadSession) {
				try {
					let loaded = await connection.request("session/load", {
						sessionId: request.session.id, cwd: ctx.dir, mcpServers: [],
					});
					sessionId = request.session.id;
					configOptions = loaded.configOptions || null;
					resumed = true;
					this.log("acp: session " + sessionId + " resumed");
				}
				catch (e) {
					let help = this.acpSignInHelp(backend, e.message);
					if (help) {
						return { text: "", error: help, sessionId: request.session.id };
					}
					this.log("acp: session " + request.session.id + " could not be loaded (" + e.message + ")");
					return { text: "", error: e.message, sessionId: request.session.id, resumeFailed: true };
				}
			}
			if (!sessionId) {
				let opened;
				try {
					opened = await connection.request("session/new", { cwd: ctx.dir, mcpServers: [] });
				}
				catch (e) {
					return { text: "", error: this.acpSignInHelp(backend, e.message) || e.message };
				}
				sessionId = opened.sessionId;
				configOptions = opened.configOptions || null;
			}

			this.rememberAcpConfig(backend, configOptions);
			let refused = await this.applyAcpOptions(connection, sessionId, configOptions, request.model, request.effort, label);
			if (refused) {
				return { text: "", error: refused, sessionId };
			}

			let prompt = request.raw
				? request.question
				: resumed
					? this.questionPrompt(request)
					: this.sessionPrompt(Object.assign({}, request, { session: null }));
			let blocks = await this.acpPromptBlocks(prompt, request.images);
			onUpdate = update => this.acpProgress(update, state, onProgress);
			let answer = await connection.request("session/prompt", { sessionId, prompt: blocks });
			onUpdate = null;
			this.flushAcpTools(state, onProgress);

			let text = (state.text || state.narration).trim();
			if (!text) {
				return { text: "", error: answer.stopReason === "refusal" ? label + " declined to answer." : label + " returned no text.", sessionId };
			}
			return { text, sessionId, truncated: answer.stopReason === "max_tokens" };
		}
		catch (e) {
			onUpdate = null;
			let { stderr, exitCode } = await connection.close();
			let partialText = (state.text || state.narration).trim();
			let help = this.acpSignInHelp(backend, e.message);
			if (help) {
				return { text: "", error: help, sessionId };
			}
			if (!e.acpClosed) {
				this.logError(label + " ACP", e);
			}
			let why = exitCode === null ? "closed its output" : "exited with code " + exitCode;
			let error = e.acpClosed
				? label + " " + why + (stderr.trim() ? ": " + stderr.trim().slice(-1000) : ".")
				: (e.message || label + " ACP failed.");
			return { text: "", error, sessionId, partialText, resumeFailed: resumed && !partialText };
		}
		finally {
			await connection.close();
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
		let current = configOptions || [];
		let set = async (id, value, required) => {
			if (!value) {
				return null;
			}
			let option = current.find(o => o.id === id || o.category === id);
			if (!option) {
				return null;
			}
			if (!Array.isArray(option.options) || !option.options.some(o => o.value === value)) {
				return required ? label + " does not offer " + (option.name || id) + " “" + value + "”." : null;
			}
			let result;
			try {
				result = await connection.request("session/set_config_option", { sessionId, configId: option.id, value });
			}
			catch (e) {
				return required ? label + " could not use " + value + ": " + e.message : null;
			}
			current = result.configOptions || current;
			return null;
		};
		let refused = await set("model", model, true);
		return refused ? refused : set("effort", effort, false);
	},

	acpSignInHelp(backend, output) {
		if (!/not authenticated|not signed in|authentication required/i.test(output || "")) {
			return null;
		}
		return this.BACKENDS[backend].label + " is not signed in. Sign in with its own CLI in a terminal, then ask again.";
	},

	rememberAcpConfig(backend, configOptions) {
		if (!this.BACKENDS[backend]) {
			return;
		}
		let models = this.acpModelChoices(configOptions);
		if (models.length) {
			this._acpModels[backend] = models;
		}
		delete this._acpModelErrors[backend];
	},
});
