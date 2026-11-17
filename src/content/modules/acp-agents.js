"use strict";

Object.assign(Zusia, {

	MAX_ACP_AGENTS: 20,
	ACP_AGENT_ID: /^[a-z0-9][a-z0-9-]{0,39}$/,
	ACP_REGISTRY_URL: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
	acpPlatform() {
		let os = Zotero.isWin ? "windows" : Zotero.isMac ? "darwin" : "linux";
		let abi = (Services.appinfo && Services.appinfo.XPCOMABI) || "";
		return os + "-" + (/aarch64|arm64/i.test(abi) ? "aarch64" : "x86_64");
	},
	acpRegistryPreset(agent, platform = this.acpPlatform()) {
		if (!agent || typeof agent !== "object" || !agent.distribution) {
			return null;
		}
		let dist = agent.distribution;
		let base = { id: agent.id, name: agent.name, description: agent.description || "" };
		for (let runner of ["npx", "uvx"]) {
			let item = dist[runner];
			if (item && item.package) {
				return {
					...base,
					command: runner,
					args: [item.package].concat(Array.isArray(item.args) ? item.args : []),
					source: runner,
				};
			}
		}
		let binary = dist.binary && dist.binary[platform];
		if (binary && binary.archive) {
			return {
				...base,
				command: "",
				args: Array.isArray(binary.args) ? binary.args.slice() : [],
				source: "binary",
				archive: binary.archive,
				cmd: binary.cmd || "",
			};
		}
		return null;
	},
	acpRegistryPresets(payload) {
		let agents = payload && Array.isArray(payload.agents) ? payload.agents : [];
		return agents.map(agent => this.acpRegistryPreset(agent)).filter(Boolean);
	},
	_acpAgentsLoaded: false,

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
		this.setPref("acpAgents", JSON.stringify(configs || []));
	},

	acpSlug(name, taken) {
		let base = String(name || "")
			.normalize("NFKD")
			.replace(/\p{M}+/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/g, "") || "agent";
		let ids = taken && typeof taken.has === "function" ? taken : new Set(Array.isArray(taken) ? taken : []);
		let id = base;
		for (let n = 2; ids.has(id); n++) {
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
		let command = typeof agent.command === "string" ? agent.command.trim() : "";
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
		return { config: { id, name, command, args: cleaned } };
	},

	registerAcpAgent(config) {
		let key = this.acpAgentKey(config.id);
		this.BACKENDS[key] = {
			label: config.name,
			fullName: config.name,
			command: config.command,
			acp: true,
			acpArgs: Array.isArray(config.args) ? config.args.slice() : [],
			models: [{ id: "", label: "Default", desc: "The agent's default model" }],
			efforts: ["", "low", "medium", "high", "max"],
			images: true,
		};
		this.BACKEND_ICONS[key] = "code";
		this.watchBackendPrefs(key);
		return key;
	},

	loadAcpAgents() {
		if (this._acpAgentsLoaded) {
			return;
		}
		this._acpAgentsLoaded = true;
		try {
			let configs = this.acpAgents();
			for (let config of configs) {
				this.registerAcpAgent(config);
			}
			this.log("Custom ACP agents loaded: " + configs.length);
		}
		catch (e) {
			this.log("Could not load the custom ACP agents: " + e);
		}
	},

	addAcpAgent({ name, command, args } = {}) {
		let configs = this.acpAgents();
		if (configs.length >= this.MAX_ACP_AGENTS) {
			return { error: "Zusia runs at most " + this.MAX_ACP_AGENTS + " custom ACP agents. Remove one before adding another." };
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
		this.loadAcpModels(key).catch(() => {});
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
		delete this._acpModelPromises[backend];
		delete this._acpModelErrors[backend];
		this.unwatchBackendPrefs(backend);
		for (let name of ["model", "effort", "api"]) {
			Zotero.Prefs.clear(this.PREF_PREFIX + backend + "." + name, true);
		}
		if (this.getPref("backend") === backend) {
			this.setPref("backend", "claude");
		}
		return true;
	},

	acpCommandLine(config) {
		if (!config) {
			return "";
		}
		let show = (part) => {
			let text = String(part === undefined || part === null ? "" : part);
			return /\s/.test(text) ? JSON.stringify(text) : text;
		};
		let args = Array.isArray(config.args) ? config.args : [];
		return [config.command].concat(args).map(show).join(" ");
	},
});
