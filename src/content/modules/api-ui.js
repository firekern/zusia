"use strict";

Object.assign(Zusia, {
	apiState(config, model) {
		return this._apiStates?.get(this.safeAPIProfileKey(config, model));
	},

	publishAPIState(backend, config, model, value) {
		this._apiStates = this._apiStates || new Map();
		let key = this.apiProfileKey(config, model);
		let state = { ...this._apiStates.get(key), ...value, checkedAt: Date.now() };
		this._apiStates.set(key, state);
		for (let root of this.allRoots()) this.updateControls(root);
		return state;
	},

	async refreshAPIRuntime(backend = this.getBackend(), { force = false } = {}) {
		if (!["unsloth", "ollama"].includes(backend)) return;
		let config = this.getAPIConfig(backend), model = this.getModel(backend);
		if (!model) return;
		if (!this.safeAPIProfileKey(config, model)) return;
		let key = this.apiProfileKey(config, model), previous = this.apiState(config, model);
		if (!force && previous && Date.now() - previous.checkedAt < 10000) return previous;
		// A read must never switch or reload a model, and must not contend with a
		// request currently preparing this connection.
		if ([...this._pending.values()].some(p => p.backend === backend && p.apiConfig?.baseURL === config.baseURL)) return previous;
		this._apiStatusReads = this._apiStatusReads || new Map();
		if (this._apiStatusReads.has(key)) return this._apiStatusReads.get(key);
		let control = { cancelled: false, abort: null };
		this._apiMonitorControls = this._apiMonitorControls || new Set();
		this._apiMonitorControls.add(control);
		let read = async () => {
			try {
				let headers = await this.apiHeaders(backend, config), actualModel, loaded, runtime = {};
				if (control.cancelled) return;
				if (backend === "unsloth") {
					let status = await this.providerJSON(backend, this.nativeAPIConfig(config, "/api/inference"), "/status?model=" + encodeURIComponent(model), { headers, control });
					if (!status || control.cancelled) return;
					loaded = this.unslothModelReady(status, model);
					actualModel = loaded ? model : status.model_identifier || status.active_model || status.loaded?.[0] || "";
					if (loaded) runtime = await this.effectiveUnslothProfile(model, config, status, { headers, control });
				}
				else {
					let profile = await this.readOllamaProfile(model, config, { headers, control });
					if (!profile || control.cancelled) return;
					let list = await this.providerJSON(backend, profile.native, "/ps", { headers, control });
					let active = list?.models?.find(m => this.ollamaModelMatches(m.name || m.model, model));
					loaded = !!active;
					actualModel = active?.name || active?.model || list?.models?.[0]?.name || list?.models?.[0]?.model || "";
					if (active) runtime = { contextTokens: active.context_length, quantization: active.details?.quantization_level || profile.show.details?.quantization_level };
				}
				if (control.cancelled) return;
				return this.publishAPIState(backend, config, model, { loaded: !!loaded, actualModel, runtime: loaded ? runtime : null, diagnostic: null });
			}
			catch (error) {
				if (!control.cancelled) return this.publishAPIState(backend, config, model, { loaded: null, diagnostic: this.apiDiagnostic(error) });
			}
			finally { this._apiStatusReads.delete(key); this._apiMonitorControls.delete(control); }
		};
		let promise = read();
		this._apiStatusReads.set(key, promise);
		return promise;
	},

	startAPIMonitoring(win = Zotero.getMainWindow()) {
		if (this._apiMonitorTimer && !this._apiMonitorWindow?.closed) return;
		if (!win) return;
		this._apiMonitorWindow = win;
		let tick = async () => {
			try {
				// Only Ollama and Unsloth have a status to read: nothing is measured for anyone else.
				let visible = ["unsloth", "ollama"].includes(this.getBackend()) &&
					[...this.allRoots()].some(root => root.isConnected && !root.hidden && root.getClientRects().length);
				if (visible) await this.refreshAPIRuntime();
			}
			catch (error) { this.log("API status refresh needs attention"); }
			finally { if (this._apiMonitorWindow === win && !win.closed) this._apiMonitorTimer = win.setTimeout(tick, 12000); }
		};
		this._apiMonitorTimer = win.setTimeout(tick, 500);
	},

	stopAPIMonitoring() {
		this._apiMonitorWindow?.clearTimeout(this._apiMonitorTimer);
		this._apiMonitorTimer = null; this._apiMonitorWindow = null;
		for (let control of this._apiMonitorControls || []) { control.cancelled = true; control.abort?.(); }
	},

	renderAPIRuntime(root) {
		let holder = root.querySelector(".zs-api-runtime");
		if (!holder) return;
		let backend = this.getBackend(), native = ["unsloth", "ollama"].includes(backend);
		holder.hidden = !native;
		if (!native) return;
		let model = this.getModel(backend), config = this.getAPIConfig(backend), state = this.apiState(config, model);
		let summary = holder.querySelector("summary"), detail = holder.querySelector(".zs-api-runtime-detail");
		let runtime = state?.runtime;
		let displayModel = this.modelLabel(backend, state?.actualModel || model);
		if (displayModel.length > 52) displayModel = displayModel.split("/").at(-1);
		if (displayModel.length > 52) displayModel = displayModel.slice(0, 49) + "…";
		let invalidURL = !this.safeAPIProfileKey(config, model);
		let parts = invalidURL ? ["Correct the API URL in Settings"] : !model ? ["Choose a model in Settings"] : state?.diagnostic ? [state.diagnostic.title] : !state ? ["Not checked", displayModel] :
			[state.loaded ? Date.now() - state.checkedAt > 30000 ? "Last seen loaded" : "Loaded" : "Not loaded", displayModel,
				runtime?.quantization, runtime?.contextTokens ? runtime.contextTokens.toLocaleString() + " context" : ""];
		summary.textContent = parts.filter(Boolean).join(" · ");
		detail.textContent = ["Selected: " + (model || "none"), state?.actualModel ? "Running: " + state.actualModel : "",
			state?.checkedAt ? "Checked: " + new Date(state.checkedAt).toLocaleTimeString() : "",
			state?.diagnostic ? state.diagnostic.help : "Status checks do not load or switch models."].filter(Boolean).join("\n");
		summary.title = detail.textContent;
	},

	renderAPIMetrics(doc, metrics) {
		let number = key => typeof metrics[key] === "number" && Number.isFinite(metrics[key]) && metrics[key] >= 0 ? metrics[key] : null;
		let format = key => number(key)?.toLocaleString(undefined, { maximumFractionDigits: 1 });
		let box = this.el(doc, "details", "zs-api-metrics");
		let summary = [], rows = [];
		if (number("promptTokens") !== null) summary.push(format("promptTokens") + " input tokens");
		if (number("completionTokens") !== null) summary.push(format("completionTokens") + " output tokens");
		if (number("generationMs") > 0 && number("completionTokens") !== null) summary.push((metrics.completionTokens / (metrics.generationMs / 1000)).toLocaleString(undefined, { maximumFractionDigits: 1 }) + " tokens/s");
		else if (number("responseMs") > 0 && number("completionTokens") !== null) summary.push((metrics.completionTokens / (metrics.responseMs / 1000)).toLocaleString(undefined, { maximumFractionDigits: 1 }) + " tokens/s (request average)");
		if (!summary.length) summary.push("Request details");
		if (number("lastInputTokens") !== null && number("contextTokens") !== null) rows.push("Context input: " + format("lastInputTokens") + " / " + format("contextTokens") + " tokens (" + (metrics.budgetSource === "provider tokenizer" ? "provider tokenizer" : "conservative estimate") + ")");
		if (number("outputBudget") !== null) rows.push("Reserved output: " + format("outputBudget") + " tokens");
		if (number("cachedTokens") !== null) rows.push("Cached input: " + format("cachedTokens") + " tokens");
		for (let [key, label] of [["firstTokenMs", "First generation token"], ["loadMs", "Provider load"], ["promptMs", "Provider prompt processing"], ["generationMs", "Provider generation"], ["responseMs", "Generation requests (client)"], ["preparationMs", "Model preparation"], ["totalMs", "Total request"]]) {
			if (number(key) !== null) rows.push(label + ": " + (metrics[key] / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " s");
		}
		if (number("rounds") !== null) rows.push("Generation rounds: " + format("rounds"));
		if (typeof metrics.tokenizerFallback === "string") rows.push(metrics.tokenizerFallback.slice(0, 200));
		box.append(this.el(doc, "summary", null, summary.join(" · ")), this.el(doc, "div", "zs-api-metrics-detail", rows.join("\n")));
		return box;
	},
});
