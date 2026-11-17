"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Running the agent CLIs: one process per question, its events read per backend
	// ---------------------------------------------------------------------

	async spawnAgent(command, args, workdir, stdinChars = 0) {
		let environment = this.buildChildEnvironment();
		// findBinary resolves npm's shim to the .js or .mjs it runs with node.
		if (Zotero.isWin && /\.(m?js)$/i.test(command)) {
			args = [command, ...args];
			command = await Subprocess.pathSearch("node.exe", environment).catch((e) => {
				throw new Error("Could not find node.exe, which the npm install of " + args[0] + " needs.", { cause: e });
			});
		}
		this.log("Spawning: " + command + " " + args.map(a => "'" + a.slice(0, 60) + "'").join(" ") +
			(stdinChars ? " with " + stdinChars + " characters on stdin" : ""));
		return Subprocess.call({
			command,
			arguments: args,
			environment,
			workdir,
			stderr: "pipe",
		});
	},

	// The prompt travels on stdin, never in argv: Windows caps a command line at 32k
	// characters, and a prompt starting with "-" would be read as a flag.
	async runProcess(command, args, workdir, onEvent, onSpawn, stdinText) {
		let proc = await this.spawnAgent(command, args, workdir, stdinText ? stdinText.length : 0);
		// Not awaited before the readers start: a child that writes while we are still
		// writing a long prompt would otherwise fill its stdout pipe and both would block.
		// Closing stdin, also when there is nothing to send, keeps the CLI from waiting.
		let writing = (async () => {
			if (stdinText) {
				await proc.stdin.write(stdinText);
			}
			await proc.stdin.close();
		})().catch((e) => {
			// A CLI that exits early (bad flag, signed out) closes the pipe under us; its
			// exit code and stderr say why better than this error does. With nothing to
			// send, our close merely lost a race with a CLI that had already finished.
			if (stdinText) {
				this.logError("writing stdin of " + command, e);
			}
			else {
				this.log("stdin of " + command + " was closed before we closed it: " + e);
			}
		});
		if (onSpawn) {
			onSpawn(proc);
		}

		let emit = (line) => {
			line = line.trim();
			if (!line || !onEvent) {
				return;
			}
			try {
				onEvent(JSON.parse(line));
			}
			catch (e) {
				if (!(e instanceof SyntaxError)) {
					this.logError("stream event handler", e);
				}
			}
		};
		let readStdout = (async () => {
			let out = "";
			let buffer = "";
			let chunk;
			while ((chunk = await proc.stdout.readString())) {
				out += chunk;
				buffer += chunk;
				let lines = buffer.split("\n");
				buffer = lines.pop();
				lines.forEach(emit);
			}
			emit(buffer);
			return out;
		})();
		let readStderr = (async () => {
			let out = "";
			let chunk;
			while ((chunk = await proc.stderr.readString())) {
				out += chunk;
			}
			return out;
		})();

		let [stdout, stderr] = await Promise.all([readStdout, readStderr, writing]);
		let { exitCode } = await proc.wait();
		this.log(command + " exited with code " + exitCode + (stderr ? ("; stderr: " + stderr.slice(0, 2000)) : ""));
		return { stdout, stderr, exitCode };
	},

	parseJsonLines(stdout) {
		let events = [];
		for (let line of stdout.split("\n")) {
			line = line.trim();
			if (!line) {
				continue;
			}
			try {
				events.push(JSON.parse(line));
			}
			catch (e) {
				this.log("Skipping non-JSON output line: " + line.slice(0, 200));
			}
		}
		return events;
	},

	runBackend(backend, request) {
		let kind = this.BACKENDS[backend].kind;
		return this[this.KINDS[kind].run](backend, request);
	},

	runCliBackend(backend, request) {
		switch (backend) {
			case "codex":
				return this.runCodex(request);
			case "agy":
				return this.runAntigravity(request);
			default:
				return this.runClaude(request);
		}
	},

	// One activity line for a tool call, in the same words for every backend.
	describeTool(name, input = {}) {
		let file = input.file_path || input.AbsolutePath || input.path || input.TargetFile || "";
		let base = file ? String(file).split(/[\\/]/).pop() : "";
		if (/read|view/i.test(name)) {
			return { kind: "read", target: base || "a file", label: "Read " + (base || "a file") };
		}
		if (/grep|search/i.test(name)) {
			let pattern = input.pattern || input.Query || input.query || "";
			let where = base ? " in " + base : "";
			return { kind: "search", target: pattern, label: pattern ? "Searched for “" + String(pattern).slice(0, 60) + "”" + where : "Searched" + where };
		}
		if (/glob|find|list/i.test(name)) {
			return { kind: "search", target: input.pattern || "", label: "Looked for files" + (input.pattern ? " matching " + input.pattern : "") };
		}
		if (/command|shell|bash|exec/i.test(name)) {
			let command = String(input.command || "").replace(/\s+/g, " ").trim();
			return { kind: "run", target: command, label: command ? "Ran " + command.slice(0, 60) : "Ran a command" };
		}
		return { kind: "tool", target: name, label: "Used " + name };
	},

	toolStatus(name) {
		if (/read|view/i.test(name)) {
			return "reading the paper";
		}
		if (/grep|glob|find|search/i.test(name)) {
			return "searching the paper";
		}
		return "using " + name;
	},

	claudeSystemPromptPath(ctx) {
		return OS.Path.join(ctx.dir, "system.md");
	},

	// Flags shared by every run of a backend: model, effort and anything else
	// chosen in the composer. Kept separate so tests can check them.
	// "-p" with no positional prompt reads the prompt from stdin; given both, Claude
	// would send them joined.
	claudeArgs({ ctx, session, model, effort }) {
		let args = [
			"-p",
			"--output-format", "stream-json",
			"--verbose",
			"--include-partial-messages",
			"--tools", "Read,Grep,Glob",
			"--allowedTools", "Read,Grep,Glob",
			"--strict-mcp-config",
			"--append-system-prompt-file", this.claudeSystemPromptPath(ctx),
		];
		if (model) {
			args.push("--model", model);
		}
		if (effort) {
			args.push("--effort", effort);
		}
		// By default the sidebar ignores ~/.claude settings and CLAUDE.md, whose
		// instructions (artifacts, diagrams, output styles) do not fit a sidebar.
		// One "--flag=" argument, never "--flag" "": Windows drops an empty argument (#1).
		if (!this.getPref("useClaudeUserSettings")) {
			args.push("--setting-sources=");
		}
		if (session) {
			args.push("--resume", session.id);
		}
		return args;
	},

	codexArgs({ ctx, session, model, effort, images = [] }) {
		let args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-C", ctx.dir];
		if (model) {
			args.push("-m", model);
		}
		if (effort) {
			args.push("-c", "model_reasoning_effort=\"" + effort + "\"");
		}
		// "--image=<path>": the flag takes several values, so a bare path could swallow "resume".
		for (let image of images) {
			args.push("--image=" + image);
		}
		if (session) {
			args.push("resume", session.id);
		}
		// "-" reads the prompt from stdin, after "resume <id>" as well.
		args.push("-");
		return args;
	},

	sessionPrompt(request) {
		return this.systemPrompt() + "\n\n---\n\n" + this.questionPrompt(request);
	},

	codexPrompt(request) {
		return request.session ? this.questionPrompt(request) : this.sessionPrompt(request);
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

	async loadAcpModels(backend) {
		if (Array.isArray(this._acpModels[backend])) {
			return this._acpModels[backend];
		}
		if (this._acpModelPromises[backend]) {
			return this._acpModelPromises[backend];
		}
		delete this._acpModelErrors[backend];
		this._acpModelPromises[backend] = (async () => {
			let connection = null;
			try {
				let command = await this.findBinary(backend);
				let proc = await this.spawnAgent(command, this.acpArgs(backend), this.getDataDir());
				connection = this.createAcpConnection(proc);
				await this.acpInitialize(connection);
				let opened = await connection.request("session/new", { cwd: this.getDataDir(), mcpServers: [] });
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
				if (connection) {
					await connection.close();
				}
			}
		})();
		return this._acpModelPromises[backend];
	},

	async acpAuthenticate(backend) {
		let connection = null;
		try {
			let command = await this.findBinary(backend);
			let proc = await this.spawnAgent(command, this.acpArgs(backend), this.getDataDir());
			connection = this.createAcpConnection(proc);
			let hello = await this.acpInitialize(connection);
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
		}
		catch (e) {
			return { error: String((e && e.message) || e), methods: [] };
		}
		finally {
			if (connection) {
				await connection.close();
			}
		}
	},

	antigravityArgs(request) {
		let args = ["--output-format", "stream-json", "--sandbox"];
		if (request.model) {
			args.push("--model", request.model);
		}
		if (request.effort) {
			args.push("--effort", request.effort);
		}
		if (request.session) {
			args.push("--conversation", request.session.id);
		}
		// No -p: with a piped stdin agy runs in print mode on it, while a bare -p would take
		// the next token as the prompt.
		return args;
	},

	async runClaude(request) {
		let { ctx, onProgress, onSpawn } = request;
		let command = await this.findBinary("claude");
		let args = this.claudeArgs(request);

		let text = "";
		let blocks = new Map();
		let onEvent = (event) => {
			if (event.type !== "stream_event" || !event.event) {
				return;
			}
			let ev = event.event;
			if (ev.type === "content_block_start" && ev.content_block) {
				let block = { type: ev.content_block.type, name: ev.content_block.name, json: "", started: Date.now() };
				blocks.set(ev.index, block);
				if (block.type === "text" && text) {
					text += "\n\n";
				}
				if (block.type === "tool_use") {
					// What was written so far was narration; the answer comes after the tools.
					if (text) {
						text = "";
						onProgress({ text });
					}
					onProgress({ status: this.toolStatus(block.name) });
				}
				if (block.type === "thinking") {
					onProgress({ status: "thinking", thinking: true });
				}
			}
			if (ev.type === "content_block_delta" && ev.delta) {
				if (ev.delta.type === "text_delta") {
					text += ev.delta.text;
					onProgress({ text, status: "writing" });
				}
				else if (ev.delta.type === "input_json_delta" && blocks.has(ev.index)) {
					blocks.get(ev.index).json += ev.delta.partial_json || "";
				}
			}
			if (ev.type === "content_block_stop" && blocks.has(ev.index)) {
				let block = blocks.get(ev.index);
				blocks.delete(ev.index);
				if (block.type === "tool_use") {
					let input = {};
					try {
						input = JSON.parse(block.json || "{}");
					}
					// A tool call cut short by an abort has half a JSON blob; the step
					// line is still worth showing without its arguments.
					catch (e) {}
					onProgress({ step: this.describeTool(block.name, input) });
				}
				if (block.type === "thinking") {
					onProgress({ thinking: false, thoughtMs: Date.now() - block.started });
				}
			}
		};

		// Rewritten on every run so an edited system prompt reaches the next new session.
		await Zotero.File.putContentsAsync(this.claudeSystemPromptPath(ctx), this.systemPrompt());
		let { stdout, stderr, exitCode } = await this.runProcess(command, args, ctx.dir, onEvent, onSpawn,
			this.questionPrompt(request));
		if (exitCode !== 0) {
			return {
				text: "",
				error: stderr.trim() || this.parseClaudeEvents(this.parseJsonLines(stdout)).error ||
					("claude exited with code " + exitCode),
				resumeFailed: true,
			};
		}
		return this.parseClaudeEvents(this.parseJsonLines(stdout));
	},

	parseClaudeEvents(events) {
		let sessionId = null;
		let textParts = [];
		let narration = [];
		let errorText = "";

		for (let event of events) {
			if (event.session_id) {
				sessionId = event.session_id;
			}
			if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
				for (let block of event.message.content) {
					if (block.type === "text" && block.text) {
						textParts.push(block.text);
					}
					// Text before a tool call is narration ("Let me check the page"), not the answer.
					if (block.type === "tool_use" && textParts.length) {
						narration = narration.concat(textParts);
						textParts = [];
					}
				}
			}
			if (event.type === "result" && event.is_error) {
				errorText = event.result || (event.errors || []).join("\n") || "Claude reported an error.";
			}
		}

		if (!textParts.length) {
			textParts = narration;
		}
		if (errorText && !textParts.length) {
			return { text: "", error: errorText, sessionId };
		}
		return { text: textParts.join("\n\n").trim(), sessionId };
	},

	async runCodex(request) {
		let { ctx, onProgress, onSpawn } = request;
		let command = await this.findBinary("codex");
		let args = this.codexArgs(request);

		let onEvent = (event) => {
			let item = event.item;
			if (event.type === "item.completed" && item && item.type === "agent_message" && item.text) {
				onProgress({ text: item.text, status: "writing" });
			}
			else if (event.type === "item.started" && item && item.type === "command_execution") {
				onProgress({ status: "reading the paper" });
			}
			else if (event.type === "item.completed" && item && item.type === "command_execution") {
				let command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
				onProgress({ step: this.describeTool("exec", { command }) });
			}
			else if (event.msg && event.msg.type === "agent_message" && event.msg.message) {
				onProgress({ text: event.msg.message, status: "writing" });
			}
		};

		let { stdout, stderr, exitCode } = await this.runProcess(command, args, ctx.dir, onEvent, onSpawn,
			this.codexPrompt(request));
		let result = this.parseCodexEvents(this.parseJsonLines(stdout));
		if (exitCode !== 0 && !result.text) {
			return {
				text: "",
				error: result.error || stderr.trim() || ("codex exited with code " + exitCode),
				sessionId: result.sessionId,
				resumeFailed: true,
			};
		}
		return result;
	},

	// Handles both the current `codex exec --json` events (thread.started,
	// item.completed) and the older { msg: { type } } envelope.
	parseCodexEvents(events) {
		let sessionId = null;
		let messages = [];
		let errorText = "";

		for (let event of events) {
			if (event.thread_id) {
				sessionId = event.thread_id;
			}
			if (event.type === "item.completed" && event.item && event.item.type === "agent_message" && event.item.text) {
				messages.push(event.item.text);
			}
			if (event.type === "turn.failed" && event.error) {
				errorText = event.error.message || JSON.stringify(event.error);
			}
			if (event.type === "error" && event.message) {
				errorText = event.message;
			}
			let msg = event.msg;
			if (msg) {
				if (msg.type === "session_configured" && msg.session_id) {
					sessionId = msg.session_id;
				}
				if (msg.type === "agent_message" && msg.message) {
					messages.push(msg.message);
				}
				if (msg.type === "error" && msg.message) {
					errorText = msg.message;
				}
			}
		}

		// Codex narrates progress in intermediate messages; the last one is the answer.
		let text = messages.length ? messages[messages.length - 1].trim() : "";
		return { text, error: text ? "" : errorText, sessionId };
	},

	// Antigravity cannot be granted read-only file access in headless mode, so it gets the
	// text in the prompt: a new session the metadata, chosen pages and annotations, a
	// resumed one only the pages it has not seen. Stable blocks come first and the page
	// the user is on last, right before the question, where long prompts are read best.
	// With `needPages`, the pages it asked for and the question once more.
	buildAntigravityPrompt({ files, question, history, session, needPages = null }) {
		let block = (tag, body) => this.contextBlock(tag, body);
		let reminder = this.formattingReminder();
		if (needPages) {
			let cap = Math.floor(this.inlineFullTextBudget() / Math.max(1, needPages.length));
			let text = needPages.map(page => this.renderInlinePage(files, { page, ahead: false }, cap)).join("\n\n");
			return block("paper_fulltext", text) +
				"Here are the pages you asked for. Answer the question now from these and the pages you already have; " +
				"more pages cannot be sent this time.\n\n" + question +
				this.contextNote(files, { resumed: true, earlier: session.paper || null, added: needPages }, { withFiles: false }) + reminder;
		}
		let reading = this.readingBlocks(files, session, { withFiles: false });
		let inline = this.inlinePages(files, session);
		let support = "";
		let focus = "";
		let coverage = null;
		if (inline) {
			support = inline.support.map(p => this.renderInlinePage(files, p, inline.cap)).join("\n\n");
			focus = inline.focus.map(p => this.renderInlinePage(files, p, inline.cap)).join("\n\n");
			let added = [...inline.support, ...inline.focus].map(p => p.page).sort((a, b) => a - b);
			coverage = session
				? { resumed: true, earlier: session.paper || null, added, focusBlock: !!focus }
				: { name: "<paper_fulltext>", paged: true, complete: inline.complete, kept: added, total: inline.total, focusBlock: !!focus };
		}
		else if (!session) {
			let paper = this.antigravityPaper(files);
			support = paper ? paper.text : "";
			coverage = paper && Object.assign({ name: "<paper_fulltext>" }, paper);
		}
		else {
			coverage = { resumed: true, earlier: session.paper || null, added: [] };
		}
		let head = !session && inline && !inline.complete
			? "[Partial text: " + (inline.support.length + inline.focus.length) + " of " + inline.total +
				" pages, chosen for this question; the page the user is on comes separately, right before the question.]\n\n"
			: "";
		let tail = this.transcriptFor(history, session, files.memory || null) + (focus ? block("focus_page", focus) : "") + question +
			this.contextNote(files, coverage, { withFiles: false }) + reminder;
		if (session) {
			return reading + (support ? block("paper_fulltext", support) : "") + tail;
		}
		return (
			this.systemPrompt({ inline: true }) + "\n\n" +
			block("paper_metadata", files.metadata) +
			reading +
			(support ? block("paper_fulltext", head + support) : "") +
			(files.annotations ? block("user_annotations", files.annotations) : "") +
			"---\n\n" + tail
		);
	},

	// The conversation id and the final result event of an agy stream-json run.
	parseAntigravityEvents(events) {
		let sessionId = null;
		let final = null;
		for (let event of events) {
			if (event.conversation_id) {
				sessionId = event.conversation_id;
			}
			if (event.event === "result" && event.result) {
				final = event.result;
				sessionId = final.conversation_id || sessionId;
			}
		}
		return { sessionId, final };
	},

	async runAntigravity(request) {
		let { onProgress, onSpawn } = request;
		let command = await this.findBinary("agy");
		let args = this.antigravityArgs(request);

		let onEvent = (event) => {
			let step = event.step_update;
			if (event.event === "step_update" && step && step.state === "ACTIVE") {
				onProgress({ status: step.step_type === "tool" ? this.toolStatus(step.tool_name || "a tool") : "thinking" });
			}
			if (event.event === "step_update" && step && step.state === "DONE" && step.step_type === "tool") {
				onProgress({ step: this.describeTool(step.tool_name || "tool", (step.tool_info && step.tool_info.parameters) || {}) });
			}
		};

		let { stdout, stderr, exitCode } = await this.runProcess(command, args, request.ctx.dir, onEvent, onSpawn,
			this.buildAntigravityPrompt(request));
		let { sessionId, final } = this.parseAntigravityEvents(this.parseJsonLines(stdout));

		if (final && final.status === "SUCCESS" && (final.response || "").trim()) {
			return { text: final.response.trim(), sessionId };
		}
		let error = this.agySignInHelp(stderr) || (final && final.error) || stderr.trim() ||
			(final ? "Antigravity finished with status " + final.status + "." : "agy exited with code " + exitCode);
		return { text: "", error, sessionId, resumeFailed: exitCode !== 0 || !final || final.status === "ERROR" };
	},

	async runAcp(backend, request) {
		let { ctx, onProgress, onSpawn } = request;
		let label = this.BACKENDS[backend].label;
		let command = await this.findBinary(backend);
		let proc = await this.spawnAgent(command, this.acpArgs(backend), ctx.dir);
		if (onSpawn) {
			onSpawn(proc);
		}

		let state = { text: "", narration: "", thinking: false, thoughtAt: 0, tools: new Map(), emitted: new Set(), asking: false };
		let connection = this.createAcpConnection(proc, {
			onNotification: (method, params) => {
				if (method === "session/update" && state.asking && params && params.update) {
					this.acpProgress(params.update, state, onProgress);
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
			state.asking = true;
			let answer = await connection.request("session/prompt", { sessionId, prompt: blocks });
			state.asking = false;
			this.flushAcpTools(state, onProgress);

			let text = (state.text || state.narration).trim();
			if (answer.stopReason === "cancelled") {
				return { text: "", error: label + " stopped the answer.", sessionId, partialText: text };
			}
			if (!text) {
				return { text: "", error: answer.stopReason === "refusal" ? label + " declined to answer." : label + " returned no text.", sessionId };
			}
			return { text, sessionId, truncated: answer.stopReason === "max_tokens" };
		}
		catch (e) {
			state.asking = false;
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
			return this.acpPermissionReply(params.toolCall || {}, params.options || []);
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
});
