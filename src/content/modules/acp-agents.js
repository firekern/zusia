"use strict";

Object.assign(Zusia, {

	MAX_ACP_AGENTS: 20,
	ACP_AGENT_ID: /^[a-z0-9][a-z0-9-]{0,39}$/,
	ACP_REGISTRY_URL: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",

	// The registry's platform keys. XPCOMABI is "x86_64-msvc", "aarch64-gcc3" and the like;
	// the registry's musl builds are left to the reader.
	acpPlatform() {
		let os = Zotero.isWin ? "windows" : Zotero.isMac ? "darwin" : "linux";
		return os + "-" + (/^aarch64/i.test(Services.appinfo.XPCOMABI) ? "aarch64" : "x86_64");
	},

	// What fills the add form for one registry entry, or null when the entry cannot run here
	// as the registry states it. The registry is fetched, so every field is checked.
	acpRegistryPreset(agent, platform) {
		if (!agent || typeof agent !== "object" || typeof agent.name !== "string" || !agent.name.trim() ||
			!agent.distribution || typeof agent.distribution !== "object") {
			return null;
		}
		let text = value => (typeof value === "string" && value.trim() ? value.trim() : "");
		let base = { name: agent.name.trim(), repository: text(agent.repository), license: text(agent.license) };
		let usable = item => item && typeof item === "object" &&
			(item.args === undefined || (Array.isArray(item.args) && item.args.every(arg => typeof arg === "string"))) &&
			// Some entries need env to pin their version or to switch ACP on at all, and an
			// agent here runs with Zusia's environment only, so without it the command is not
			// the one the registry gives.
			(item.env === undefined || (item.env && typeof item.env === "object" && !Object.keys(item.env).length));
		let dist = agent.distribution;
		let packaged = () => {
			for (let [runner, source] of [["npx", "npm"], ["uvx", "PyPI"]]) {
				let item = dist[runner];
				if (usable(item) && text(item.package)) {
					return { ...base, source, package: text(item.package), command: runner, args: [text(item.package), ...(item.args || [])] };
				}
			}
			return null;
		};
		let binary = () => {
			let item = dist.binary && typeof dist.binary === "object" ? dist.binary[platform] : null;
			if (!usable(item) || !/^https:\/\//.test(text(item.archive)) || !text(item.cmd) ||
				// Zusia runs no batch file, so a binary that is one could never start.
				/\.(cmd|bat)[. ]*$/i.test(text(item.cmd))) {
				return null;
			}
			return { ...base, source: "binary", archive: text(item.archive), sha256: text(item.sha256), cmd: text(item.cmd), args: item.args || [] };
		};
		// On Windows npx goes through npm's own batch files once it runs the package, so a
		// native build is the sturdier path there.
		return platform.startsWith("windows-") ? binary() || packaged() : packaged() || binary();
	},

	// The presets for this platform, and how many entries the registry listed in all.
	async fetchAcpRegistryPresets(platform = this.acpPlatform()) {
		let response = await Zotero.HTTP.request("GET", this.ACP_REGISTRY_URL, { responseType: "json", timeout: 20000 });
		// A body that is not JSON, such as a captive portal's page, arrives as null.
		let agents = response.response?.agents;
		if (!Array.isArray(agents)) {
			throw new Error("The registry did not answer with a list of agents. Check the connection and try again.");
		}
		return { presets: agents.map(agent => this.acpRegistryPreset(agent, platform)).filter(Boolean), listed: agents.length };
	},

	acpAgents() {
		let stored = this.getJSONPref("acpAgents", null);
		if (!Array.isArray(stored)) {
			return [];
		}
		let configs = [];
		let ids = new Set();
		for (let raw of stored) {
			if (configs.length >= this.MAX_ACP_AGENTS) {
				break;
			}
			let { config } = this.normalizeAcpAgent(raw, raw && raw.id);
			if (!config || ids.has(config.id)) {
				continue;
			}
			ids.add(config.id);
			configs.push(config);
		}
		return configs;
	},

	acpAgentKey(id) {
		return "acp:" + id;
	},

	acpAgentConfig(backend) {
		return this.acpAgents().find(config => this.acpAgentKey(config.id) === backend) || null;
	},

	saveAcpAgentConfigs(configs) {
		this.setPref("acpAgents", JSON.stringify(configs));
	},

	acpSlug(name, taken = new Set()) {
		let base = String(name || "")
			.normalize("NFKD")
			.replace(/\p{M}+/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/g, "") || "agent";
		let id = base;
		for (let n = 2; taken.has(id); n++) {
			let suffix = "-" + n;
			id = base.slice(0, 40 - suffix.length).replace(/-+$/g, "") + suffix;
		}
		return id;
	},

	normalizeAcpAgent(raw, id) {
		if (typeof id !== "string" || !this.ACP_AGENT_ID.test(id)) {
			return { error: "An agent id is up to 40 lowercase letters, digits and hyphens, starting with a letter or digit." };
		}
		let agent = raw && typeof raw === "object" ? raw : {};
		let name = typeof agent.name === "string" ? agent.name.trim() : "";
		if (!name || name.length > 60) {
			return { error: "Give the agent a name of 1 to 60 characters." };
		}
		if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
			return { error: "The agent's name cannot contain line breaks or control characters." };
		}
		// Explorer's "Copy as path" wraps the path in quotes, which no file name starts with.
		let command = typeof agent.command === "string" ? agent.command.trim().replace(/^(["'])(.*)\1$/, "$2").trim() : "";
		if (!command || command.length > 500) {
			return { error: "Give the agent a command of 1 to 500 characters." };
		}
		if (/[\r\n]/.test(command)) {
			return { error: "The agent's command must be a single line." };
		}

		let args;
		if (agent.args === undefined || agent.args === null) {
			args = [];
		}
		else if (typeof agent.args === "string") {
			args = agent.args.split("\n");
		}
		else if (Array.isArray(agent.args)) {
			if (!agent.args.every(arg => typeof arg === "string")) {
				return { error: "The agent's arguments must be text, one per item." };
			}
			args = [];
			for (let arg of agent.args) {
				args.push(...arg.split("\n"));
			}
		}
		else {
			return { error: "The agent's arguments must be a list of text items, or one per line." };
		}
		let cleaned = args
			.map(arg => arg.trim())
			.filter(Boolean)
			.slice(0, 20)
			.map(arg => arg.slice(0, 500));
		let config = { id, name, command, args: cleaned };
		if (agent.background === true) {
			config.background = true;
		}
		return { config };
	},

	setAcpAgentBackground(backend, on) {
		let configs = this.acpAgents();
		let config = configs.find(agent => this.acpAgentKey(agent.id) === backend);
		if (!config) {
			return false;
		}
		if (on) {
			config.background = true;
		}
		else {
			delete config.background;
		}
		this.saveAcpAgentConfigs(configs);
		return true;
	},

	registerAcpAgent(config) {
		let key = this.acpAgentKey(config.id);
		this.BACKENDS[key] = {
			label: config.name,
			fullName: config.name,
			command: config.command,
			kind: "acp",
			acpArgs: config.args,
			models: [{ id: "", label: "Default", desc: "The agent's default model" }],
			efforts: ["", "low", "medium", "high", "max"],
			images: true,
		};
		this.BACKEND_ICONS[key] = "code";
		this.watchBackendPrefs(key);
		return key;
	},

	// Once, from init(): an agent added later registers itself.
	loadAcpAgents() {
		try {
			let configs = this.acpAgents();
			for (let config of configs) {
				this.registerAcpAgent(config);
			}
			this.log("ACP agents loaded: " + configs.length);
		}
		catch (e) {
			this.log("Could not load the ACP agents: " + e);
		}
	},

	addAcpAgent({ name, command, args } = {}) {
		let configs = this.acpAgents();
		if (configs.length >= this.MAX_ACP_AGENTS) {
			return { error: "Zusia runs at most " + this.MAX_ACP_AGENTS + " ACP agents. Remove one before adding another." };
		}
		let wanted = typeof name === "string" ? name.trim() : "";
		if (wanted && configs.some(config => config.name.toLowerCase() === wanted.toLowerCase())) {
			return { error: "An agent called " + wanted + " already exists. Give this one another name." };
		}
		let id = this.acpSlug(wanted, new Set(configs.map(config => config.id)));
		let { config, error } = this.normalizeAcpAgent({ name, command, args }, id);
		if (error) {
			return { error };
		}
		configs.push(config);
		this.saveAcpAgentConfigs(configs);
		let key = this.registerAcpAgent(config);
		this.loadLiveModels(key);
		return { key, config };
	},

	removeAcpAgent(backend) {
		let configs = this.acpAgents();
		let config = configs.find(agent => this.acpAgentKey(agent.id) === backend);
		if (!config) {
			return false;
		}
		this.saveAcpAgentConfigs(configs.filter(agent => agent.id !== config.id));
		delete this.BACKENDS[backend];
		delete this.BACKEND_ICONS[backend];
		delete this._acpModels[backend];
		this.unwatchBackendPrefs(backend);
		for (let name of ["model", "effort", "api"]) {
			Zotero.Prefs.clear(this.PREF_PREFIX + backend + "." + name, true);
		}
		if (this.getPref("backend") === backend) {
			this.setPref("backend", "claude");
		}
		return true;
	},

	// Quoted only where a space or a quote would split it, and only quotes escaped, so a
	// Windows path keeps its backslashes, reads as the reader typed it and can be pasted back.
	acpCommandLine(config) {
		return [config.command, ...config.args]
			.map(part => (/[\s"]/.test(part) ? '"' + part.replace(/"/g, '\\"') + '"' : part)).join(" ");
	},
});
