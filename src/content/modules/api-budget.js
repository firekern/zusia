"use strict";

Object.assign(Zusia, {
	async measureAPIInput(backend, config, model, messages, tools, { headers, control, effort } = {}) {
		let estimate = { tokens: this.apiInputSize(messages) + (tools.length ? this.apiInputSize(tools) : 0), source: "conservative estimate" };
		if (backend !== "unsloth") return { ...estimate, fallback: "This provider has no supported prompt-token counting endpoint." };
		if (messages.some(m => Array.isArray(m.content))) return { ...estimate, fallback: "Image token costs are estimated; the server tokenizer counts text only." };
		let key = this.apiProfileKey(config, model), unavailable = this._apiTokenizerUnavailable?.get(key);
		if (unavailable && Date.now() - unavailable < 300000) return { ...estimate, fallback: "The server version does not expose prompt-token counting." };
		try {
			let value = await this.providerJSON(backend, config, "/chat/count_tokens", { headers, control, body: {
				model, messages, ...(tools.length ? { tools } : {}), enable_tools: false, enabled_tools: [],
				...this.apiReasoningFields(backend, config, model, effort),
			} });
			if (control?.cancelled) return estimate;
			if (value?.model && value.model !== model) throw this.apiFailure("model_changed", "The provider changed models while counting the prompt. No completion was sent.");
			if (!Number.isInteger(value?.input_tokens) || value.input_tokens < 1) return { ...estimate, fallback: "The tokenizer returned no valid count." };
			return { tokens: value.input_tokens, source: "provider tokenizer" };
		}
		catch (error) {
			if (error.code === "model_changed" || error.status === 401 || error.status === 403) throw error;
			if ([404, 405, 501].includes(error.status)) {
				this._apiTokenizerUnavailable = this._apiTokenizerUnavailable || new Map();
				this._apiTokenizerUnavailable.set(key, Date.now());
			}
			return { ...estimate, fallback: "Prompt-token counting is unavailable; the conservative budget is active." };
		}
	},

	async prepareAPIMessages(backend, request, config, tools, options) {
		let messages = request.messages || this.buildAPIMessages(request, config);
		let measured = await this.measureAPIInput(backend, config, request.model, messages, tools, options);
		// Use a measured sample to give the document more room, then count the
		// complete candidate again. A failed recount always restores the baseline.
		if (!request.messages && !request.images?.length && measured.source === "provider tokenizer" && !options.control?.cancelled) {
			let scale = Math.min(6, this.apiInputSize(messages) / measured.tokens * 0.8);
			if (scale > 1.25) {
				for (let attempt = 0; attempt < 2; attempt++) {
					let candidate = this.buildAPIMessages(request, { ...config, budgetScale: scale });
					let count = await this.measureAPIInput(backend, config, request.model, candidate, tools, options);
					if (count.source !== "provider tokenizer" || options.control?.cancelled) break;
					if (count.tokens + config.outputTokens + 512 <= config.contextTokens) { messages = candidate; measured = count; break; }
					scale *= Math.max(0.1, (config.contextTokens - config.outputTokens - 1000) / count.tokens * 0.8);
					if (scale <= 1) break;
				}
			}
		}
		return { messages, measured };
	},

	apiUsage(value, backend) {
		let stats = {}, usage = value.usage || {};
		let fields = backend === "ollama" ? { promptTokens: value.prompt_eval_count, completionTokens: value.eval_count, cachedTokens: value.prompt_eval_cached_count,
			loadMs: value.load_duration == null ? undefined : value.load_duration / 1e6, generationMs: value.eval_duration == null ? undefined : value.eval_duration / 1e6 } :
			{ promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, cachedTokens: usage.prompt_tokens_details?.cached_tokens,
				generationMs: value.timings?.predicted_ms, promptMs: value.timings?.prompt_ms };
		for (let [key, number] of Object.entries(fields)) if (typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1e12) stats[key] = number;
		return stats;
	},

	mergeAPIUsage(total, round) {
		for (let key of ["promptTokens", "completionTokens", "cachedTokens", "loadMs", "generationMs", "promptMs", "responseMs"]) {
			if (round[key] !== undefined) total[key] = (total[key] || 0) + round[key];
		}
		if (total.firstTokenMs === undefined && round.firstTokenMs !== undefined) total.firstTokenMs = round.firstTokenMs;
		return total;
	},
});
