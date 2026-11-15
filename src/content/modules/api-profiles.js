"use strict";

Object.assign(Zusia, {
	apiProfileKey(config, model) {
		return this.normalizeAPIURL(config.baseURL) + "\n" + model;
	},

	// Invalid saved preferences must remain editable. Network paths stay strict.
	safeAPIProfileKey(config, model) {
		try { return this.apiProfileKey(config, model); } catch (e) { return ""; }
	},

	apiProfileSettings(config, model) {
		let entry = config.profiles?.[this.safeAPIProfileKey(config, model)];
		return { mode: entry?.mode === "custom" ? "custom" : "provider",
			overrides: entry?.mode === "custom" ? this.cleanAPIProfileOverrides(entry.overrides) : {} };
	},

	cleanAPIProfileOverrides(values = {}) {
		let result = {};
		for (let [name, min, max, integer] of [
			["contextTokens", 8192, 2097152, true], ["gpuLayers", -1, 1024, true], ["parallelSlots", 1, 64, true],
			["temperature", 0, 2], ["topP", 0, 1], ["topK", 0, 10000, true], ["minP", 0, 1], ["repeatPenalty", 0, 2],
		]) {
			let value = values?.[name];
			if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))) result[name] = value;
		}
		if (/^[\w.+-]{1,80}$/.test(values?.ggufVariant || "")) result.ggufVariant = values.ggufVariant;
		if (["f16", "bf16", "q8_0", "q4_0", "q4_1", "q5_0", "q5_1", "iq4_nl", "f32"].includes(values?.cacheTypeKV)) result.cacheTypeKV = values.cacheTypeKV;
		return result;
	},

	nativeAPIConfig(config, path) {
		let baseURL = this.normalizeAPIURL(config.baseURL);
		if (!baseURL.endsWith("/v1")) throw new Error("The API base URL must end in /v1 to use provider profiles.");
		return { ...config, baseURL: baseURL.slice(0, -3) + path };
	},

	async providerJSON(backend, config, path, { headers, control, body, optional = false } = {}) {
		if (control?.cancelled) return null;
		// Optional profile routes may be absent on an older server. Authentication,
		// connection and malformed-response errors are not silently ignored.
		try {
			let xhr = await this.apiHTTPRequest(backend, config, path, { headers, body,
				onCancel: cancel => { if (control) { control.abort = cancel; if (control.cancelled) cancel(); } },
			});
			try { return JSON.parse(xhr.responseText); }
			catch (e) { throw new Error("The provider returned invalid JSON for its model profile."); }
		}
		catch (e) { if (optional && /^API HTTP (404|405)\./.test(e.message)) return null; throw e; }
	},

	unslothLoadSettings(profile, isGGUF) {
		let load = {};
		// Public model-profile fields mapped to LoadRequest. Raw command-line flags
		// and trust_remote_code are deliberately outside this adapter's contract.
		for (let key of ["load_in_4bit", "engine", "engine_parallelism", "engine_precision", "engine_kv_cache_dtype", "engine_seed", "engine_gpu_memory_utilization",
			"n_parallel", "disable_vision", "chat_template_override", "reasoning_budget", "reasoning_budget_message", "tensor_parallel",
			"speculative_type", "spec_draft_n_max", "spec_draft_model", "mlx_kv_quant", "mlx_int8_prefill", "mlx_ane_prefill", "mlx_fast_verify", "mlx_ple_offload", "mlx_expert_offload"]) {
			if (profile[key] !== undefined && profile[key] !== null) load[key] = profile[key];
		}
		if (profile.kv_cache_dtype) load.cache_type_kv = profile.kv_cache_dtype;
		let context = isGGUF && profile.gpu_memory_mode === "manual" && profile.gpu_layers == null ? profile.custom_context_length || 0 : profile.max_seq_length || profile.custom_context_length;
		if (Number.isInteger(context) && context >= 0) load.max_seq_length = context;
		if (isGGUF) {
			for (let key of ["engine", "engine_parallelism", "engine_precision", "engine_kv_cache_dtype", "engine_seed", "engine_gpu_memory_utilization", "load_in_4bit"]) delete load[key];
			for (let key of ["gpu_memory_mode", "gpu_layers", "gpu_ids", "tensor_split", "n_cpu_moe", "n_batch", "n_ubatch", "load_mode", "spec_draft_cache_type", "ctx_checkpoints", "cache_ram"]) {
				if (profile[key] !== undefined && profile[key] !== null) load[key] = profile[key];
			}
			delete load.spec_draft_model;
			if (load.speculative_type === "eagle3") { delete load.speculative_type; delete load.spec_draft_n_max; }
		}
		else if (["vllm", "sglang"].includes(load.engine)) {
			load.load_in_4bit = false;
			load.engine_parallelism = load.engine_parallelism || "tensor";
			load.engine_precision = load.engine_precision || "auto";
			if (profile.gpu_ids) load.gpu_ids = profile.gpu_ids;
		}
		return load;
	},

	async readUnslothProfile(model, config, { headers, control, status } = {}) {
		headers = headers || await this.apiHeaders("unsloth", config);
		let native = this.nativeAPIConfig(config, "/api");
		status = status || await this.providerJSON("unsloth", native, "/inference/status?model=" + encodeURIComponent(model), { headers, control });
		if (control?.cancelled) return null;
		let ready = status?.loaded?.includes(model) || status?.active_model === model || status?.model_identifier === model;
		let overrides = this.apiProfileSettings(config, model).overrides;
		let variant = overrides.ggufVariant || (ready && status.gguf_variant) || "";
		if (!variant && (/gguf/i.test(model) || status?.is_gguf)) {
			let list = await this.providerJSON("unsloth", config, "/models", { headers, control });
			variant = list?.data?.find(entry => entry.id === model)?.quant || "";
		}
		let query = "?model_id=" + encodeURIComponent(model) + (variant ? "&gguf_variant=" + encodeURIComponent(variant) : "");
		let saved = await this.providerJSON("unsloth", native, "/settings/openai-auto-switch/overrides" + query, { headers, control, optional: true });
		if (control?.cancelled) return null;
		let profile = saved?.resolved || {};
		let isGGUF = /gguf/i.test(model) || !!variant || (ready && status.is_gguf);
		let load = this.unslothLoadSettings(profile, isGGUF);
		if (variant) load.gguf_variant = variant;
		for (let [from, to] of [["contextTokens", "max_seq_length"], ["ggufVariant", "gguf_variant"], ["cacheTypeKV", "cache_type_kv"], ["gpuLayers", "gpu_layers"], ["parallelSlots", "n_parallel"]]) {
			if (overrides[from] !== undefined) load[to] = overrides[from];
		}
		if (overrides.gpuLayers !== undefined) load.gpu_memory_mode = "manual";
		return { status, ready, load, overrides, saved: !!saved, profileKey: saved?.resolved_key || "", variant };
	},

	unslothProfileState(profile) {
		let status = profile.status;
		return JSON.stringify([status.model_identifier, status.active_model, status.context_length, status.requested_context_length,
			status.gguf_variant, status.cache_type_kv, status.parallel_slots, status.gpu_layers, status.gpu_memory_mode,
			status.disable_vision, status.engine, status.speculative_type, status.gpu_ids, status.n_batch, status.n_ubatch]);
	},

	rememberUnslothProfile(model, config, profile) {
		this._unslothAppliedProfiles = this._unslothAppliedProfiles || new Map();
		this._unslothAppliedProfiles.set(this.apiProfileKey(config, model), {
			signature: JSON.stringify([this.apiProfileSettings(config, model).mode, profile.load]),
			runtime: this.unslothProfileState(profile),
		});
	},

	unslothProfileMatches(model, profile, config) {
		if (!profile.ready) return false;
		let status = profile.status, load = profile.load;
		let previous = this._unslothAppliedProfiles?.get(this.apiProfileKey(config, model));
		let signature = JSON.stringify([this.apiProfileSettings(config, model).mode, load]);
		if (previous && previous.signature !== signature) return false;
		// Some backends fit or normalize requested values. Reuse the observed
		// result until either the saved profile or the reported runtime changes.
		if (previous?.signature === signature && previous.runtime === this.unslothProfileState(profile)) return true;
		let fields = { max_seq_length: status.requested_context_length ?? status.context_length,
			gguf_variant: status.gguf_variant, cache_type_kv: status.cache_type_kv,
			n_parallel: status.requested_parallel_slots ?? status.parallel_slots, gpu_layers: status.gpu_layers,
			disable_vision: status.vision_disabled_by_user ?? status.disable_vision, gpu_memory_mode: status.gpu_memory_mode };
		for (let [key, value] of Object.entries(fields)) {
			if (load[key] != null && !(key === "max_seq_length" && load[key] === 0) && value !== load[key]) return false;
		}
		if (Object.keys(load).some(key => !(key in fields))) return false;
		return true;
	},

	async effectiveUnslothProfile(model, config, status, options = {}) {
		this.rememberAPICapabilities("unsloth", model, config, status);
		let props = await this.providerJSON("unsloth", config, "/props", { ...options, optional: true });
		let context = props?.default_generation_settings?.n_ctx;
		if (!Number.isInteger(context) || context <= 0) {
			context = status.context_length;
			if (status.parallel_slots > 1) context = Math.floor(context / status.parallel_slots);
		}
		return this.recordAPIProfile("unsloth", model, config, { contextTokens: context, quantization: status.gguf_variant || "Provider selection",
			cacheTypeKV: status.cache_type_kv || "Provider default", parallelSlots: status.parallel_slots,
				source: "Unsloth profile", savedProfile: status._zusiaProfile?.saved, profileKey: status._zusiaProfile?.profileKey,
				profileContextTokens: status._zusiaProfile?.load?.max_seq_length });
	},

	recordAPIProfile(backend, model, config, runtime) {
		if (!Number.isInteger(runtime.contextTokens) || runtime.contextTokens <= 0) throw new Error("The provider did not report the model's effective context window. Check its profile and server version.");
		this._apiRuntimeProfiles = this._apiRuntimeProfiles || new Map();
		this._apiRuntimeProfiles.set(this.apiProfileKey(config, model), { ...runtime, checkedAt: Date.now() });
		this.publishAPIState(backend, config, model, { loaded: true, actualModel: model, runtime, diagnostic: null });
		return runtime;
	},

	ollamaModelMatches(name, model) {
		let canonical = value => value.split("/").at(-1).includes(":") ? value : value + ":latest";
		return typeof name === "string" && canonical(name) === canonical(model);
	},

	async readOllamaProfile(model, config, { headers, control } = {}) {
		headers = headers || await this.apiHeaders("ollama", config);
		let native = this.nativeAPIConfig(config, "/api");
		let show = await this.providerJSON("ollama", native, "/show", { headers, control, body: { model } });
		if (control?.cancelled) return null;
		this.rememberAPICapabilities("ollama", model, config, show);
		let parameters = {};
		for (let line of (show.parameters || "").split("\n")) {
			let match = line.match(/^\s*(num_ctx|temperature|top_p|top_k|min_p|repeat_penalty)\s+(-?\d+(?:\.\d+)?)\s*$/);
			if (match) parameters[match[1]] = Number(match[2]);
		}
		let overrides = this.apiProfileSettings(config, model).overrides;
		let options = {};
		for (let [from, to] of [["contextTokens", "num_ctx"], ["temperature", "temperature"], ["topP", "top_p"], ["topK", "top_k"], ["minP", "min_p"], ["repeatPenalty", "repeat_penalty"]]) {
			if (overrides[from] !== undefined) options[to] = overrides[from];
		}
		return { native, show, parameters, overrides, options };
	},

	async prepareOllamaModel(model, config, { headers, control, onProgress = () => {} } = {}) {
		headers = headers || await this.apiHeaders("ollama", config);
		let profile = await this.readOllamaProfile(model, config, { headers, control });
		if (control?.cancelled) return null;
		let running = async () => {
			let list = await this.providerJSON("ollama", profile.native, "/ps", { headers, control });
			return list?.models?.find(entry => this.ollamaModelMatches(entry.name || entry.model, model));
		};
		let current = await running(), preloadLoadMs;
		let desired = profile.options.num_ctx || profile.parameters.num_ctx;
		if (!current || !desired || current.context_length !== desired) {
			onProgress({ status: "loading the model in Ollama" });
			let preloaded = await this.providerJSON("ollama", profile.native, "/chat", { headers, control, body: { model, messages: [], stream: false, options: profile.options } });
			preloadLoadMs = this.apiUsage(preloaded || {}, "ollama").loadMs;
			if (control?.cancelled) return null;
			current = await running();
		}
		if (!current) throw new Error("Ollama did not load the selected model.");
		let runtime = this.recordAPIProfile("ollama", model, config, { contextTokens: current.context_length,
			quantization: current.details?.quantization_level || profile.show.details?.quantization_level || "Model tag",
			cacheTypeKV: "Ollama server setting", source: "Ollama model/tag", options: profile.options, preloadLoadMs });
		return runtime;
	},

	async prepareAPIModel(backend, model, config, options = {}) {
		let control = options.control || { cancelled: false, abort: null }, release;
		let standalone = !options.connectionLease;
		this._apiRequestControls = this._apiRequestControls || new Set();
		if (standalone) this._apiRequestControls.add(control);
		try {
			if (this._apiConnectionsStopped) control.cancelled = true;
			if (standalone && backend === "unsloth") release = await this.acquireUnslothConnection(config, model, control, options.onProgress);
			if (control.cancelled) return config;
			options = { ...options, control, headers: options.headers || await this.apiHeaders(backend, config) };
			let runtime;
			if (backend === "unsloth") {
				let status = await this.ensureUnslothModel(model, config, options);
				if (options.control?.cancelled) return config;
				runtime = await this.effectiveUnslothProfile(model, config, status, options);
			}
			else if (backend === "ollama") runtime = await this.prepareOllamaModel(model, config, options);
			else return config;
			if (options.control?.cancelled) return config;
			if (runtime.contextTokens < 8192) throw new Error("The provider is running this model with " + runtime.contextTokens + " context tokens. Increase its profile to at least 8192 tokens, or set a context override in Zusia.");
			return this.applyAPICapabilities(backend, { ...config, contextTokens: Math.min(runtime.contextTokens, 2097152), runtimeProfile: runtime }, model);
		}
		finally { release?.(); if (standalone) this._apiRequestControls.delete(control); }
	},

	async inspectAPIProfile(backend, model, config) {
		let headers = await this.apiHeaders(backend, config);
		if (backend === "unsloth") {
			let profile = await this.readUnslothProfile(model, config, { headers });
			if (profile.ready) profile.status._zusiaProfile = profile;
			let runtime = profile.ready ? await this.effectiveUnslothProfile(model, config, profile.status, { headers }) : {};
			return { ...runtime, profileContextTokens: profile.load.max_seq_length, profileQuantization: profile.variant,
				quantization: runtime.quantization || profile.variant || "Provider selection", savedProfile: profile.saved,
				profileCacheTypeKV: profile.load.cache_type_kv, cacheTypeKV: runtime.cacheTypeKV || "Provider default" };
		}
		let profile = await this.readOllamaProfile(model, config, { headers });
		let list = await this.providerJSON("ollama", profile.native, "/ps", { headers });
		let active = list.models?.find(entry => this.ollamaModelMatches(entry.name || entry.model, model));
		return { contextTokens: active?.context_length, profileContextTokens: profile.options.num_ctx || profile.parameters.num_ctx,
			quantization: profile.show.details?.quantization_level || "Model tag", cacheTypeKV: "Ollama server setting" };
	},
});
