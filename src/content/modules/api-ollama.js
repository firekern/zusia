"use strict";

Object.assign(Zusia, {
	// Native chat is needed for num_ctx and other runtime overrides. Adapt its
	// NDJSON and messages to the same bounded document-tool loop as other APIs.
	ollamaMessages(messages) {
		let names = new Map();
		return messages.map(message => {
			let result = { role: message.role, content: typeof message.content === "string" ? message.content : "" };
			if (Array.isArray(message.content)) {
				result.content = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
				result.images = message.content.filter(part => part.type === "image_url").map(part => {
					let match = part.image_url?.url?.match(/^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/);
					if (!match) throw new Error("Ollama image input must contain a supported attached image.");
					return match[1];
				});
			}
			if (message.reasoning_content) result.thinking = message.reasoning_content;
			if (message.tool_calls) result.tool_calls = message.tool_calls.map(call => {
				names.set(call.id, call.function.name);
				let args;
				try { args = JSON.parse(call.function.arguments); } catch (e) { args = {}; }
				return { type: "function", function: { name: call.function.name, arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {} } };
			});
			if (message.role === "tool") result.tool_name = names.get(message.tool_call_id) || "";
			return result;
		});
	},

	async ollamaCompletion(config, body, headers, control, onProgress = () => {}) {
		let payload = { model: body.model, messages: this.ollamaMessages(body.messages), stream: body.stream,
			options: { ...config.runtimeProfile?.options, num_predict: config.outputTokens } };
		if (body.tools) payload.tools = body.tools;
		if (body.think !== undefined) payload.think = body.think;
		let text = "", reasoning = "", finish = null, calls = [], metrics = {}, startedAt = Date.now(), actualModel;
		let accept = value => {
			if (value.error) throw this.apiError(200, JSON.stringify({ error: { message: value.error } }), headers);
			metrics = { ...metrics, ...this.apiUsage(value, "ollama") };
			if (typeof value.model === "string") actualModel = value.model;
			if ((value.message?.content || value.message?.thinking) && metrics.firstTokenMs === undefined) metrics.firstTokenMs = Date.now() - startedAt;
			if (typeof value.message?.content === "string") {
				text += value.message.content;
				onProgress({ text, status: "writing", thinking: false });
			}
			if (typeof value.message?.thinking === "string") {
				reasoning += value.message.thinking;
				if (reasoning.length > 1024 * 1024) throw new Error("Ollama reasoning exceeded its limit.");
				onProgress({ status: "thinking", thinking: true });
			}
			for (let call of value.message?.tool_calls || []) {
				let args = JSON.stringify(call.function?.arguments || {});
				if (calls.length >= 8 || args.length > 16000) throw new Error("Ollama tool call exceeded its limit.");
				this._apiToolSerial = (this._apiToolSerial || 0) + 1;
				calls.push({ id: "ollama-" + this._apiToolSerial, type: "function", function: { name: call.function?.name || "", arguments: args } });
			}
			if (value.done) finish = value.done_reason || "stop";
		};
		let buffer = "";
		let consume = chunk => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				let line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
				if (line.length > 1024 * 1024) throw new Error("Ollama stream line exceeded its limit.");
				if (line) accept(JSON.parse(line));
			}
			if (buffer.length > 1024 * 1024) throw new Error("Ollama stream buffer exceeded its limit.");
		};
		let xhr = await this.apiHTTPRequest("ollama", this.nativeAPIConfig(config, "/api"), "/chat", { body: payload, headers,
			onChunk: body.stream ? consume : null,
			onCancel: cancel => { control.abort = cancel; if (control.cancelled) cancel(); },
		});
		let remaining = !body.stream ? xhr.responseText : buffer.trim();
		if (remaining) {
			let value;
			try { value = JSON.parse(remaining); }
			catch (e) { throw new Error("Invalid Ollama chat response. Check the model and server version."); }
			accept(value);
		}
		if (!finish) throw new Error("The Ollama response ended before a complete answer. Retry the question.");
		if (finish === "length") throw new Error("The model reached its output or context limit. Increase the output budget or shorten the question.");
		metrics.responseMs = Date.now() - startedAt;
		return { text, reasoning, calls, finish, metrics, actualModel };
	},
});
