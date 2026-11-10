"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Running the agent CLIs: one process per question, its events read per backend
	// ---------------------------------------------------------------------

	// The prompt travels on stdin, never in argv: Windows caps a command line at 32k
	// characters, and a prompt starting with "-" would be read as a flag.
	async runProcess(command, args, workdir, onEvent, onSpawn, stdinText) {
		let environment = this.buildChildEnvironment();
		// findBinary resolves npm's codex.cmd to the codex.js it runs with node.
		if (Zotero.isWin && /\.js$/i.test(command)) {
			args = [command, ...args];
			command = await Subprocess.pathSearch("node.exe", environment).catch((e) => {
				throw new Error("Could not find node.exe, which the npm install of " + args[0] + " needs.", { cause: e });
			});
		}
		this.log("Spawning: " + command + " " + args.map(a => "'" + a.slice(0, 60) + "'").join(" ") +
			(stdinText ? " with " + stdinText.length + " characters on stdin" : ""));
		let proc = await Subprocess.call({
			command,
			arguments: args,
			environment,
			workdir,
			stderr: "pipe",
		});
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

	codexPrompt(request) {
		return (request.session ? "" : this.systemPrompt() + "\n\n---\n\n") + this.questionPrompt(request);
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
});
