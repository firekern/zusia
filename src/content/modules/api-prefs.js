"use strict";

Object.assign(Zusia, {
	// Uses the same disclosure, rows and fields as the CLI cards. Configuration is
	// local; connection checks only list models. Loading is a separate explicit
	// action, also performed automatically before an Unsloth chat request.
	buildAPIAssistant(doc, backend) {
		let info = this.BACKENDS[backend];
		let config = this.getAPIConfig(backend);
		let toggles = {};
		let capabilityHints = {};
		let displayedModel = () => model.checkValidity() ? model.value.trim() : "";
		let refreshCapabilities = () => {
			let current = this.applyAPICapabilities(backend, config, displayedModel());
			for (let [prop, hint] of Object.entries(capabilityHints)) {
				let declared = current.detectedCapabilities?.[prop];
				hint.textContent = declared === true ? "Provider reports support." : declared === false ? "Provider reports no support. Enable only if you have verified compatibility." : "Support is unknown. Load the model or read its provider profile to detect it.";
				let key = this.safeAPIProfileKey(config, displayedModel());
				toggles[prop].value = current.capabilities[key]?.[prop] || "auto";
				toggles[prop].disabled = !key || !displayedModel();
			}
		};
		let syncProfiles = () => {};
		let details = this.el(doc, "details", "zs-agent");
		details.dataset.backend = backend;
		let summary = this.el(doc, "summary");
		let name = this.el(doc, "span", "zs-agent-name");
		let status = this.el(doc, "span", "zs-agent-status", this.getModel(backend) ? "Configured · connection not checked" : "Add your API connection");
		name.append(this.el(doc, "strong", null, info.fullName), status);
		let badge = this.el(doc, "span", "zs-badge", "In use");
		badge.hidden = backend !== this.getBackend();
		summary.append(this.el(doc, "span", "zs-agent-dot"), name, badge, this.svgIcon(doc, "chevron", "zs-agent-chevron"));
		let body = this.el(doc, "div", "zs-agent-body");
		let message = this.el(doc, "div", "zs-row-hint");
		message.setAttribute("role", "status");
		message.setAttribute("aria-live", "polite");
		let save = changes => {
			config = { ...config, ...changes };
			this.setPref(backend + ".api", JSON.stringify(config));
			status.textContent = "Configuration changed · check connection";
			details.dataset.found = "false";
			syncProfiles();
			refreshCapabilities();
		};
		let field = (label, value, change, hint, type = "text") => {
			let input = this.el(doc, "input", "zs-field");
			input.type = type;
			input.value = String(value);
			input.addEventListener("change", () => change(input.value, input));
			body.appendChild(this.row(doc, label, input, hint));
			return input;
		};
		let urlField = field("API base URL", config.baseURL, (value, input) => {
			try {
				let baseURL = this.normalizeAPIURL(value);
				if (baseURL !== config.baseURL) {
					save({ baseURL, tools: false, vision: false, reasoning: false, background: false, backgroundURL: "" });
					toggles.background?.setAttribute("aria-checked", "false");
					for (let prop of ["tools", "vision", "reasoning"]) toggles[prop]?.setAttribute("aria-checked", "false");
				}
				input.value = baseURL; input.setCustomValidity(""); message.textContent = "";
					model.value = this.getModel(backend);
					model.setCustomValidity(""); syncProfiles(); refreshCapabilities();
			}
			catch (e) { input.setCustomValidity(e.message); message.textContent = e.message; }
		}, "Include /v1. Remote servers require HTTPS; HTTP is allowed only on loopback. No CLI login is used.");
		let auth = this.select(doc, [["none", "No authentication"], ["bearer", "API key (Bearer)"]], config.auth, value => {
			save({ auth: value }); keyRow.hidden = value !== "bearer";
		});
		body.appendChild(this.row(doc, "Authentication", auth));
		let key = this.el(doc, "input", "zs-field");
		key.type = "password";
		key.autocomplete = "off";
		key.placeholder = "Enter a key to save or replace it";
		let keyStatus = this.el(doc, "div", "zs-row-hint", "Keys are stored separately from preferences. Older Zotero versions keep them for this session only.");
		let keyActions = this.el(doc, "div", "zs-api-actions");
		let button = (label, action) => {
			let b = this.el(doc, "button", "zs-button", label);
			b.type = "button";
			b.addEventListener("click", action);
			return b;
		};
		let saveKey = button("Save key", async () => {
			if (!key.value.trim()) { keyStatus.textContent = "Enter a key first, or choose Remove key."; return; }
			saveKey.disabled = true;
			try { keyStatus.textContent = await this.setAPIKey(backend, config, key.value); key.value = ""; }
			catch (e) { keyStatus.textContent = "Could not save the key. Check the OS key store, then try again."; }
			finally { saveKey.disabled = false; }
		});
		let removeKey = button("Remove key", async () => {
			try { keyStatus.textContent = await this.setAPIKey(backend, config, ""); key.value = ""; }
			catch (e) { keyStatus.textContent = "Could not remove the saved key."; }
		});
		keyActions.append(saveKey, removeKey);
		let keyRow = this.row(doc, "API key", [key, keyActions, keyStatus], null, { stack: true });
		keyRow.hidden = config.auth !== "bearer";
		body.appendChild(keyRow);

		let setModel = value => {
			value = value.trim();
			let previous = this.getModel(backend);
			try { this.setAPIModel(backend, value); model.setCustomValidity(""); }
			catch (e) { model.setCustomValidity(e.message); message.textContent = e.message; syncProfiles(); refreshCapabilities(); return; }
			if (value !== previous) {
				save({ tools: false, vision: false, reasoning: false, capabilityModel: value });
				for (let prop of ["tools", "vision", "reasoning"]) toggles[prop]?.setAttribute("aria-checked", "false");
			}
		};
		let model = field("Model ID", this.getModel(backend), setModel,
			backend === "unsloth" ? "Use the exact ID from the server. Zusia loads downloaded models automatically before answering." :
				"Use the exact ID from the server.");
		model.setAttribute("list", "zs-api-models-" + backend);
		let choices = this.el(doc, "datalist");
		choices.id = "zs-api-models-" + backend;
		body.appendChild(choices);
		let choose = this.select(doc, [["", "Choose a discovered model"]], "", value => {
			if (value) { model.value = value; setModel(value); }
		});
		let refill = models => {
			choices.textContent = "";
			for (let m of models) {
				let option = this.el(doc, "option"); option.value = m.id; choices.appendChild(option);
			}
			choose.refill([["", "Choose a discovered model"], ...models.map(m => [m.id, m.id + (m.loaded ? " · loaded" : backend === "unsloth" && m.loaded === false ? " · loads on send" : "")])], displayedModel());
		};
		refill(this.getModels(backend).filter(m => m.id));
		body.appendChild(this.row(doc, "Server models", choose));
		let nativeProfiles = backend === "unsloth" || backend === "ollama";
		if (nativeProfiles) {
			let controls = this.buildAPIProfileControls(doc, backend, () => config, save, refreshCapabilities, displayedModel);
			body.appendChild(controls.panel);
			syncProfiles = controls.refresh;
		}
		let check = button("Check connection and list models", async () => {
			if (!urlField.reportValidity()) return;
			let checkedURL = this.normalizeAPIURL(config.baseURL);
			check.disabled = true; status.textContent = "Checking connection…"; message.textContent = "";
			try {
				let models = await this.loadAPIModels(backend);
				if (checkedURL !== this.normalizeAPIURL(config.baseURL)) return;
				refill(models); details.dataset.found = "true";
				status.textContent = "Connected · " + models.length + " model" + (models.length === 1 ? "" : "s");
				message.textContent = models.length ? "Select a model above. Connection check completed without generating an answer." : "The server returned no models. Load a chat model in your server.";
				if (nativeProfiles && models.some(m => m.id === displayedModel())) {
					await this.inspectAPIProfile(backend, displayedModel(), config);
					if (checkedURL === this.normalizeAPIURL(config.baseURL)) { syncProfiles(); refreshCapabilities(); }
				}
			}
			catch (e) { details.dataset.found = "false"; status.textContent = "Connection check failed"; message.textContent = e.message; }
			finally { check.disabled = false; }
		});
		let connectionActions = this.el(doc, "div", "zs-api-actions");
		connectionActions.appendChild(check);
		if (nativeProfiles) {
			let loading = null;
			let load = button("Load model", async () => {
				if (loading) { loading.cancelled = true; loading.abort?.(); return; }
				if (!urlField.reportValidity()) return;
				if (![...body.querySelectorAll("input")].filter(input => !input.closest("[hidden]")).every(input => input.reportValidity())) return;
				let target = model.value.trim();
				try { this.setAPIModel(backend, target); }
				catch (error) {
					let text = target ? error.message : "Choose an exact model ID before loading.";
					model.setCustomValidity(text); message.textContent = text; model.reportValidity(); return;
				}
				let snapshot = { ...config };
				let current = () => model.value.trim() === target && config.baseURL === snapshot.baseURL;
				let control = loading = { cancelled: false, abort: null };
				load.textContent = "Stop loading";
				status.textContent = "Preparing model…";
				message.textContent = "";
				try {
					await this.prepareAPIModel(backend, target, snapshot, { control, onProgress: update => {
						if (current()) message.textContent = /^loading/.test(update.status) ? "Loading " + target + "…" : "";
					} });
					if (!current()) return;
					if (control.cancelled) { status.textContent = "Model loading cancelled"; message.textContent = ""; return; }
					status.textContent = "Model ready";
					message.textContent = target + " is loaded. You can ask about your paper.";
					syncProfiles();
					refreshCapabilities();
					details.dataset.found = "true";
					let models = await this.loadAPIModels(backend);
					if (current()) refill(models);
				}
				catch (e) {
					if (current()) {
						status.textContent = control.cancelled ? "Model loading cancelled" : "Could not load model";
						message.textContent = control.cancelled ? "" : e.message;
					}
				}
				finally { loading = null; load.textContent = "Load model"; }
			});
			connectionActions.appendChild(load);
		}
		body.appendChild(this.row(doc, "Connection", [connectionActions, message], null, { stack: true }));
		for (let [label, prop, min, max, hint] of [
			["Context window (tokens)", "contextTokens", 8192, 2097152, "Set this to the context actually configured on your server. Zusia uses a conservative input estimate."],
			["Maximum output (tokens)", "outputTokens", 256, 65536, "Space reserved for the response, including reasoning on models that count it."],
		]) {
			if (nativeProfiles && prop === "contextTokens") continue;
			let number = field(label, config[prop], (value, input) => {
				let n = Number(value);
				if (Number.isInteger(n) && n >= min && n <= max) { save({ [prop]: n }); input.setCustomValidity(""); }
				else { input.setCustomValidity("Enter a whole number from " + min + " to " + max + "."); input.reportValidity(); }
			}, hint, "number");
			number.min = min; number.max = max; number.step = 1;
		}
		for (let [label, prop, hint] of [
			["Stream answers", "stream", "Turn off for endpoints or proxies that buffer server-sent events."],
			["Document tools", "tools", "Enable only for a model with tool calling. Zusia can search and read this document, with at most four tool rounds."],
			["Image input", "vision", "Enable only for a vision model. Attached images are sent to this API."],
			["Reasoning effort", "reasoning", "Enable only if this model accepts reasoning_effort (low, medium, high). Otherwise Zusia omits it."],
		]) {
			if (nativeProfiles && prop !== "stream") {
				let key = this.safeAPIProfileKey(config, displayedModel());
				let select = this.select(doc, [["auto", "Detect from provider"], ["on", "Enable explicitly"], ["off", "Disable"]], config.capabilities[key]?.[prop] || "auto", value => {
					let key = this.safeAPIProfileKey(config, displayedModel());
					if (!key || !displayedModel()) return;
					save({ capabilities: { ...config.capabilities, [key]: { ...config.capabilities[key], [prop]: value } } });
				});
				select.setAttribute("aria-label", label);
				toggles[prop] = select;
				let hint = capabilityHints[prop] = this.el(doc, "div", "zs-row-hint");
				body.appendChild(this.row(doc, label, [select, hint], null, { stack: true }));
				continue;
			}
			let toggle = this.switchControl(doc, config[prop], value => save({ [prop]: value, capabilityModel: this.getModel(backend) }));
			toggles[prop] = toggle;
			toggle.setAttribute("aria-label", label);
			body.appendChild(this.row(doc, label, toggle, hint));
		}
		refreshCapabilities();
		if (backend === "openai") {
			let toggle = this.switchControl(doc, config.background, value => save({ background: value, backgroundURL: value ? config.baseURL : "" }));
			toggles.background = toggle;
			toggle.setAttribute("aria-label", "Allow background calls");
			body.appendChild(this.row(doc, "Allow background calls", toggle,
				"Off by default. Allow reading-memory updates and section summaries on this endpoint. These extra calls can cost money."));
		}
		details.append(summary, body);
		return details;
	},

	buildAPIProfileControls(doc, backend, getConfig, save, onRead = () => {}, getModel = () => this.getModel(backend)) {
		let panel = this.el(doc, "div", "zs-api-profile");
		let extra = this.el(doc, "div", "zs-api-profile-overrides");
		let fields = {};
		let current = () => this.apiProfileSettings(getConfig(), getModel());
		let update = changes => {
			let config = getConfig(), key = this.safeAPIProfileKey(config, getModel());
			if (!key || !getModel()) return;
			let previous = config.profiles[key] || {};
			save({ profiles: { ...config.profiles, [key]: { ...previous, ...changes } } });
		};
		let mode = this.select(doc, [["provider", "Use provider profile"], ["custom", "Customize in Zusia"]], current().mode, value => update({ mode: value }));
		panel.appendChild(this.row(doc, "Model settings", mode, "Saved separately for each endpoint and model. Empty overrides keep the provider's settings."));
		let info = this.el(doc, "div", "zs-row-hint", "Read the provider profile to see its settings. The effective context is checked before each answer.");
		info.setAttribute("role", "status");
		info.setAttribute("aria-live", "polite");
		let show = profile => {
			info.textContent = [profile.profileContextTokens ? "Profile: " + profile.profileContextTokens.toLocaleString() + " context tokens" : "Provider automatic context",
				profile.profileQuantization && profile.profileQuantization !== profile.quantization ? "Profile weights: " + profile.profileQuantization : "",
				profile.contextTokens ? "Running: " + profile.contextTokens.toLocaleString() + " tokens per request" : "Not loaded",
				profile.parallelSlots ? "Parallel slots: " + profile.parallelSlots : "",
				"Weights: " + (profile.quantization || "Unknown"), "KV cache: " + (profile.cacheTypeKV || "Provider default"),
				profile.profileCacheTypeKV && profile.profileCacheTypeKV !== profile.cacheTypeKV ? "Profile KV: " + profile.profileCacheTypeKV : "",
				profile.savedProfile === false ? "Saved presets are not exposed by this server version" : ""].filter(Boolean).join(" · ");
		};
		let inspect = this.el(doc, "button", "zs-button", "Read provider profile");
		inspect.type = "button";
		inspect.addEventListener("click", async () => {
			let config = getConfig(), model = getModel();
			if (!model) { info.textContent = "Choose a model first."; return; }
			inspect.disabled = true; info.textContent = "Reading provider profile…";
			try {
				let profile = await this.inspectAPIProfile(backend, model, config);
				if (model === getModel() && config.baseURL === getConfig().baseURL) { show(profile); onRead(); }
			}
			catch (e) { if (model === getModel() && config.baseURL === getConfig().baseURL) info.textContent = e.message; }
			finally { inspect.disabled = false; }
		});
		panel.appendChild(this.row(doc, "Provider profile", [inspect, info], null, { stack: true }));
		let field = (label, prop, min, max, step = "1") => {
			let input = this.el(doc, "input", "zs-field");
			input.type = min === null ? "text" : "number";
			input.placeholder = "Provider profile";
			if (min !== null) { input.min = min; input.max = max; input.step = step; }
			input.addEventListener("change", () => {
				let values = { ...current().overrides }, text = input.value.trim();
				if (text === "") delete values[prop];
				else {
					let value = min === null ? text : Number(text);
					let cleaned = this.cleanAPIProfileOverrides({ [prop]: value });
					if (cleaned[prop] === undefined) { input.setCustomValidity("Enter a valid value, or leave empty to follow the provider."); input.reportValidity(); return; }
					values[prop] = cleaned[prop];
				}
				input.setCustomValidity(""); update({ overrides: values });
			});
			fields[prop] = input;
			extra.appendChild(this.row(doc, label, input));
		};
		field("Context override (tokens)", "contextTokens", 8192, 2097152);
		if (backend === "unsloth") {
			field("GGUF variant", "ggufVariant", null, null);
			let choices = [["", "Provider profile"], ...["f16", "bf16", "q8_0", "q4_0", "q4_1", "q5_0", "q5_1", "iq4_nl", "f32"].map(value => [value, value])];
			fields.cacheTypeKV = this.select(doc, choices, "", value => { let values = { ...current().overrides }; if (value) values.cacheTypeKV = value; else delete values.cacheTypeKV; update({ overrides: values }); });
			extra.appendChild(this.row(doc, "KV cache quantization", fields.cacheTypeKV));
			field("GPU layers (-1 = automatic)", "gpuLayers", -1, 1024);
			field("Parallel slots", "parallelSlots", 1, 64);
		}
		else extra.appendChild(this.row(doc, "Weight quantization", this.el(doc, "div", "zs-row-hint", "Follows the selected Ollama model/tag. GPU and KV cache settings stay in Ollama.")));
		for (let args of [["Temperature", "temperature", 0, 2, "0.01"], ["Top P", "topP", 0, 1, "0.01"], ["Top K", "topK", 0, 10000], ["Min P", "minP", 0, 1, "0.01"], ["Repetition penalty", "repeatPenalty", 0, 2, "0.01"]]) field(...args);
		panel.appendChild(extra);
		let refresh = () => {
			let profile = current();
			mode.value = profile.mode; mode.disabled = !getModel() || !this.safeAPIProfileKey(getConfig(), getModel());
			inspect.disabled = mode.disabled;
			extra.hidden = profile.mode !== "custom";
			for (let [prop, input] of Object.entries(fields)) { input.value = profile.overrides[prop] ?? ""; input.setCustomValidity?.(""); }
			let runtime = this._apiRuntimeProfiles?.get(this.safeAPIProfileKey(getConfig(), getModel()));
			if (runtime) show(runtime);
			else info.textContent = "Read the provider profile to see its settings. The effective context is checked before each answer.";
		};
		refresh();
		return { panel, refresh };
	},
});
