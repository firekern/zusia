"use strict";

Object.assign(Zusia, {
	// Uses the same disclosure, rows and fields as the CLI cards. Configuration is
	// local; testing an endpoint only lists models and never starts an inference.
	buildAPIAssistant(doc, backend) {
		let info = this.BACKENDS[backend];
		let config = this.getAPIConfig(backend);
		let toggles = {};
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
					save({ baseURL, tools: false, vision: false, reasoning: false });
					for (let prop of ["tools", "vision", "reasoning"]) toggles[prop]?.setAttribute("aria-checked", "false");
				}
				input.value = baseURL; input.setCustomValidity(""); message.textContent = "";
			}
			catch (e) { input.setCustomValidity(e.message); message.textContent = e.message; }
		}, "Include /v1. Requests go directly to this endpoint; no CLI login is used.");
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
			if (value !== this.getModel(backend)) {
				this.setPref(backend + ".model", value);
				save({ tools: false, vision: false, reasoning: false, capabilityModel: value });
				for (let prop of ["tools", "vision", "reasoning"]) toggles[prop]?.setAttribute("aria-checked", "false");
			}
		};
		let model = field("Model ID", this.getModel(backend), setModel,
			"Use the exact ID from the server. A downloaded Unsloth model may need to be loaded in Studio first.");
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
			choose.refill([["", "Choose a discovered model"], ...models.map(m => [m.id, m.id + (m.loaded ? " · loaded" : "")])], this.getModel(backend));
		};
		refill(this.getModels(backend).filter(m => m.id));
		body.appendChild(this.row(doc, "Server models", choose));
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
			}
			catch (e) { details.dataset.found = "false"; status.textContent = "Connection check failed"; message.textContent = e.message; }
			finally { check.disabled = false; }
		});
		body.appendChild(this.row(doc, "Connection", [check, message], null, { stack: true }));
		for (let [label, prop, min, max, hint] of [
			["Context window (tokens)", "contextTokens", 8192, 2097152, "Set this to the context actually configured on your server. Zusia uses a conservative input estimate."],
			["Maximum output (tokens)", "outputTokens", 256, 65536, "Space reserved for the response, including reasoning on models that count it."],
		]) {
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
			let toggle = this.switchControl(doc, config[prop], value => save({ [prop]: value, capabilityModel: this.getModel(backend) }));
			toggles[prop] = toggle;
			toggle.setAttribute("aria-label", label);
			body.appendChild(this.row(doc, label, toggle, hint));
		}
		details.append(summary, body);
		return details;
	},
});
