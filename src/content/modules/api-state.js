"use strict";

Object.assign(Zusia, {
	// Selections live with their endpoint. The legacy scalar is retained for older
	// versions, but cannot silently select a model on a different server.
	apiSelectionURL(backend, saved) {
		return this.normalizeAPIURL(saved.baseURL || this.BACKENDS[backend].baseURL);
	},

	apiSelectedModel(backend) {
		let saved = this.getJSONPref(backend + ".api", {}) || {};
		let valid = value => typeof value === "string" && value.trim() && value.length <= 512 && !/[\r\n\x00-\x1f]/.test(value) ? value.trim() : "";
		if (saved.selectionVersion !== 1) return valid(this.getPref(backend + ".model"));
		try { return valid(saved.selectedModels?.[this.apiSelectionURL(backend, saved)]); }
		catch (e) { return ""; }
	},

	mergeAPISelections(backend, value) {
		let next = JSON.parse(value), old = this.getJSONPref(backend + ".api", {}) || {};
		let selectedModels = { ...(next.selectedModels || {}), ...(old.selectedModels || {}) };
		let legacy = this.getPref(backend + ".model");
		if (old.selectionVersion !== 1 && legacy) {
			try { selectedModels[this.apiSelectionURL(backend, old)] = legacy; } catch (e) {}
		}
		return JSON.stringify({ ...next, selectionVersion: 1, selectedModels });
	},

	rememberAPISelection(backend, value) {
		if (!value?.trim()) return;
		let saved = this.getJSONPref(backend + ".api", {}) || {};
		let selectedModels = { ...saved.selectedModels, [this.apiSelectionURL(backend, saved)]: value.trim() };
		Zotero.Prefs.set(this.PREF_PREFIX + backend + ".api", JSON.stringify({ ...saved, selectionVersion: 1, selectedModels }), true);
	},

	initializeAPIConnections() {
		for (let backend of Object.keys(this.BACKENDS).filter(key => this.isAPIBackend(key))) {
			try {
				let saved = this.getJSONPref(backend + ".api", {}) || {};
				if (saved.selectionVersion !== 1) {
					this.setPref(backend + ".api", JSON.stringify(saved));
				}
			}
			catch (e) { this.log("API settings need attention for " + backend); }
		}
	},

	setAPIModel(backend, value) {
		let model = String(value || "").trim();
		if (!model || model.length > 512 || /[\r\n\x00-\x1f]/.test(model)) {
			throw new Error("Choose an exact model ID. The previous selection has been kept.");
		}
		this.setPref(backend + ".model", model);
		return model;
	},

	rememberAPICapabilities(backend, model, config, metadata) {
		let bool = value => typeof value === "boolean" ? value : null;
		let values = [], result;
		if (backend === "ollama") {
			let declared = Array.isArray(metadata.capabilities) ? metadata.capabilities : null;
			values = Array.isArray(metadata.thinking?.values) ? metadata.thinking.values : [];
			result = { tools: declared ? declared.includes("tools") : null, vision: declared ? declared.includes("vision") : null,
				reasoning: values.length ? values.some(v => v !== false) : declared ? declared.includes("thinking") : null,
				reasoningStyle: "think", reasoningDefault: metadata.thinking?.default };
		}
		else {
			let style = metadata.reasoning_style;
			values = Array.isArray(metadata.reasoning_effort_levels) ? metadata.reasoning_effort_levels : [];
			if (metadata.supports_reasoning && style === "reasoning_effort" && !values.length) values = ["low", "medium", "high"];
			if (metadata.supports_reasoning && ["enable_thinking", "enable_thinking_effort"].includes(style)) {
				values = [...(metadata.reasoning_always_on ? [] : [false]), true, ...values];
			}
			result = { tools: bool(metadata.supports_tools), vision: bool(metadata.is_vision), reasoning: bool(metadata.supports_reasoning), reasoningStyle: style };
		}
		result.reasoningValues = [...new Set(values.filter(v => typeof v === "boolean" || typeof v === "string" && /^[\w.-]{1,40}$/.test(v)))].slice(0, 20);
		result.checkedAt = Date.now();
		result.scope = this.apiProfileKey(config, model);
		this._apiCapabilities = this._apiCapabilities || new Map();
		this._apiCapabilities.set(this.apiProfileKey(config, model), result);
		return result;
	},

	getAPICapabilities(config, model) {
		let value = this._apiCapabilities?.get(this.safeAPIProfileKey(config, model));
		return value && Date.now() - value.checkedAt < 600000 ? value : null;
	},

	applyAPICapabilities(backend, config, model) {
		if (!["unsloth", "ollama"].includes(backend)) return config;
		let detected = this.getAPICapabilities(config, model);
		let key = this.safeAPIProfileKey(config, model);
		if (!key) return { ...config, tools: false, vision: false, reasoning: false, detectedCapabilities: null };
		let overrides = config.capabilities?.[key] || {}, modes = {};
		let result = { ...config, detectedCapabilities: detected };
		for (let prop of ["tools", "vision", "reasoning"]) {
			let mode = overrides[prop] || (!Object.keys(config.capabilities || {}).length && config.capabilityModel === model && (config.capabilityPreferences || config)[prop] === true ? "on" : "auto");
			modes[prop] = ["on", "off"].includes(mode) ? mode : "auto";
			result[prop] = mode === "on" || mode === "auto" && detected?.[prop] === true;
		}
		result.capabilities = { ...config.capabilities, [key]: modes };
		return result;
	},

	apiReasoningChoices(backend, config = this.getAPIConfig(backend), model = this.getModel(backend)) {
		let choices = [{ id: "", label: "Provider default", desc: "Use the model's own reasoning setting" }];
		if (!config.reasoning) return choices;
		let values = ["unsloth", "ollama"].includes(backend) ? this.apiReasoningCapabilities(config, model)?.reasoningValues || [] : ["low", "medium", "high"];
		for (let value of values) choices.push({ id: typeof value === "boolean" ? "thinking:" + value : value,
			value, label: value === true ? "Thinking on" : value === false ? "Thinking off" : value[0].toUpperCase() + value.slice(1),
			desc: "Declared by the selected model" });
		return choices;
	},

	apiReasoningCapabilities(config, model) {
		// Preparation captures the model contract for this whole request. Its
		// reasoning fields must not change when the UI discovery cache expires or
		// another request refreshes it. Reusing a different endpoint/model is denied.
		let snapshot = config.detectedCapabilities;
		return snapshot?.scope === this.safeAPIProfileKey(config, model) ? snapshot : this.getAPICapabilities(config, model);
	},

	apiReasoningFields(backend, config, model, effort) {
		if (!effort || !config.reasoning) return {};
		let choice = this.apiReasoningChoices(backend, config, model).find(item => item.id === effort);
		if (!choice || choice.value === undefined) return {};
		if (backend === "ollama") return { think: choice.value };
		if (backend === "unsloth" && typeof choice.value === "boolean") return { enable_thinking: choice.value };
		if (backend === "unsloth" && this.apiReasoningCapabilities(config, model)?.reasoningStyle === "enable_thinking_effort") return { enable_thinking: true, reasoning_effort: choice.value };
		return { reasoning_effort: choice.value };
	},
});
