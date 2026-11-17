import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, openChat } from "./load-plugin.mjs";
import { loadWindowsPlugin } from "./windows-env.mjs";
import { fakeAgent, flush } from "./acp-fake.mjs";

const PREF = "extensions.zusia.acpAgents";
const plain = value => JSON.parse(JSON.stringify(value));
const stored = prefs => JSON.parse(prefs[PREF] || "[]");
const agent = (over = {}) => ({ name: "OpenCode", command: "opencode", args: ["acp"], ...over });
const storedAgent = (over = {}) => ({ id: "opencode", ...agent(), ...over });
// An install starts with the agent src/prefs.js ships, so a store test states its own list.
const fresh = (over = {}) => loadPlugin({ prefs: { [PREF]: "[]", ...over } });

const request = { ctx: { dir: "/d" }, question: "Why?", history: [], session: null, files: { metadata: "# T\n", annotations: "" } };

test("adding an agent registers its backend, writes the pref, sets the icon and feeds the model menu", () => {
	const env = fresh();
	const p = env.plugin;
	const added = p.addAcpAgent(agent());
	assert.equal(added.error, undefined, added.error);
	assert.equal(added.key, "acp:opencode");
	assert.deepEqual(plain(added.config), { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] });
	assert.deepEqual(plain(p.BACKENDS["acp:opencode"]), {
		label: "OpenCode",
		fullName: "OpenCode",
		command: "opencode",
		kind: "acp",
		acpArgs: ["acp"],
		models: [{ id: "", label: "Default", desc: "The agent's default model" }],
		efforts: ["", "low", "medium", "high", "max"],
		images: true,
	});
	assert.equal(p.BACKEND_ICONS["acp:opencode"], "code");
	assert.deepEqual(stored(env.prefs), [{ id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] }]);
	assert.deepEqual(plain(p.acpAgentConfig("acp:opencode")), { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] });
	assert.equal(p.acpAgentConfig("commandcode"), null, "only agents in the pref count");

	assert.deepEqual(plain(p.getModels("acp:opencode")).map(m => m.id), [""]);
	p.acpModelEntry("acp:opencode").models = [{ id: "fast-model", label: "Fast", desc: "" }];
	assert.deepEqual(plain(p.getModels("acp:opencode")), [
		{ id: "", label: "Default", desc: "The agent's default model" },
		{ id: "fast-model", label: "Fast", desc: "" },
	]);
	assert.equal(p.addAcpAgent({ name: "Other", command: "other", args: "acp\n--flag" }).key, "acp:other");
	assert.equal(p.BACKENDS["acp:opencode"].command, "opencode");
	assert.deepEqual(stored(env.prefs).map(c => c.id), ["opencode", "other"]);
});

test("an ACP agent runs memory jobs only once its card allows it", () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	p.setPref("backend", key);
	assert.equal(p.jobBackend(), null, "off by default");
	assert.equal(p.setAcpAgentBackground(key, true), true);
	assert.equal(p.jobBackend(), key, "allowed once the reader turns it on");
	assert.equal(stored(env.prefs)[0].background, true);
	p.setAcpAgentBackground(key, false);
	assert.equal(p.jobBackend(), null);
	assert.equal(stored(env.prefs)[0].background, undefined, "off is the absence of the flag");
});

test("a slug comes from the name, and two names that slug alike get numbered ids", () => {
	const p = loadPlugin().plugin;
	assert.equal(p.acpSlug("OpenCode"), "opencode");
	assert.equal(p.acpSlug("  Open Code!  "), "open-code");
	assert.equal(p.acpSlug("Café — Agent"), "cafe-agent");
	assert.equal(p.acpSlug("日本語"), "agent");
	assert.equal(p.acpSlug(""), "agent");
	assert.equal(p.acpSlug("x".repeat(60), new Set()).length, 40);
	assert.equal(p.acpSlug("Opencode", new Set(["opencode"])), "opencode-2");
	assert.equal(p.acpSlug("Opencode", new Set(["opencode", "opencode-2"])), "opencode-3");
	assert.equal(p.acpSlug("x".repeat(40), new Set(["x".repeat(40)])), "x".repeat(38) + "-2", "the suffix fits inside the 40 characters");

	const first = p.addAcpAgent({ name: "My Agent", command: "my-agent", args: [] });
	const second = p.addAcpAgent({ name: "My-Agent", command: "my-agent", args: [] });
	assert.equal(first.key, "acp:my-agent");
	assert.equal(second.key, "acp:my-agent-2", "two names that slug alike keep distinct ids");
	assert.equal(p.BACKENDS["acp:my-agent"].label, "My Agent");
	assert.equal(p.BACKENDS["acp:my-agent-2"].label, "My-Agent");
});

test("the same name in any case is refused and writes nothing", () => {
	const env = fresh();
	const p = env.plugin;
	p.addAcpAgent(agent());
	const before = env.prefs[PREF];
	for (const name of ["OpenCode", "opencode", "  OPENCODE  "]) {
		const result = p.addAcpAgent(agent({ name, command: "other" }));
		assert.match(result.error, /already exists/, name);
		assert.equal(result.config, undefined);
	}
	assert.equal(env.prefs[PREF], before);
	assert.deepEqual(stored(env.prefs).length, 1);
});

test("invalid names, commands and arguments are refused and write nothing", () => {
	const env = fresh();
	const p = env.plugin;
	for (const [raw, why] of [
		[agent({ name: "" }), "an empty name"],
		[agent({ name: "   " }), "a blank name"],
		[agent({ name: "a".repeat(61) }), "a name over 60 characters"],
		[agent({ name: "Two\nlines" }), "a name with a line break"],
		[agent({ name: "Tab\there" }), "a name with a control character"],
		[agent({ command: "" }), "an empty command"],
		[agent({ command: "x".repeat(501) }), "a command over 500 characters"],
		[agent({ command: "opencode\nacp" }), "a command with a line break"],
		[agent({ args: 42 }), "arguments that are not text"],
		[agent({ args: ["acp", 7] }), "an argument that is not text"],
	]) {
		const result = p.addAcpAgent(raw);
		assert.ok(result.error, why + " should be refused");
		assert.equal(result.key, undefined, why);
	}
	assert.deepEqual(stored(env.prefs), [], "nothing was written");
	assert.deepEqual(Object.keys(p.BACKENDS).sort(), ["agy", "claude", "codex", "ollama", "openai", "unsloth"]);
});

test("arguments keep their inner spaces, split on newlines and drop the empties", () => {
	const p = loadPlugin().plugin;
	let result = p.addAcpAgent({ name: "Spaced", command: "C:\\Program Files\\Agent\\agent.exe", args: "acp\n  --profile my notes  \n\n" });
	assert.deepEqual(plain(result.config.args), ["acp", "--profile my notes"]);
	assert.equal(p.BACKENDS[result.key].command, "C:\\Program Files\\Agent\\agent.exe");
	result = p.addAcpAgent({ name: "Many", command: "many", args: new Array(30).fill("a") });
	assert.equal(result.config.args.length, 20, "twenty arguments at most");
	result = p.addAcpAgent({ name: "Long", command: "long", args: ["y".repeat(600)] });
	assert.equal(result.config.args[0].length, 500, "an argument is cut at 500 characters");
});

test("the twenty-first agent is refused and the stored twenty stay", () => {
	const env = fresh();
	const p = env.plugin;
	for (let i = 0; i < 20; i++) {
		const added = p.addAcpAgent({ name: "Agent " + i, command: "agent" + i, args: ["acp"] });
		assert.ok(added.key, added.error);
	}
	const result = p.addAcpAgent({ name: "One More", command: "more", args: [] });
	assert.match(result.error, /at most 20/);
	assert.equal(result.key, undefined);
	assert.equal(stored(env.prefs).length, 20);
	assert.equal(p.acpAgents().length, 20);
});

test("malformed stored JSON and invalid stored entries are dropped, valid ones load", () => {
	const broken = loadPlugin({ prefs: { [PREF]: "[{\"id\": \"opencode\", " } });
	assert.deepEqual(plain(broken.plugin.acpAgents()), []);
	assert.deepEqual(plain(loadPlugin({ prefs: { [PREF]: "{\"id\":\"x\"}" } }).plugin.acpAgents()), [], "not an array");

	const good = { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] };
	const storedAgents = [
		good,
		null,
		"a string",
		42,
		{ id: "Bad Id", name: "Bad", command: "bad" },
		{ id: "UPPER", name: "Upper", command: "upper" },
		{ id: "nameless", command: "nameless" },
		{ id: "noargs", name: "No command" },
		{ id: "binary", name: "Binary", command: "binary", args: [1] },
		{ id: "opencode", name: "Twin", command: "twin", args: [] },
		{ id: "ok", name: "  Trimmed  ", command: "  ok  ", args: "acp\n--flag" },
	];
	const env = loadPlugin({ prefs: { [PREF]: JSON.stringify(storedAgents) } });
	const p = env.plugin;
	assert.deepEqual(plain(p.acpAgents()), [
		{ id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] },
		{ id: "ok", name: "Trimmed", command: "ok", args: ["acp", "--flag"] },
	], "the duplicate keeps the first entry");
	assert.deepEqual(plain(p.acpAgentConfig("acp:ok")).args, ["acp", "--flag"]);

	assert.equal(p.BACKENDS["acp:opencode"].command, "opencode", "the start registered the valid ones");
	assert.equal(p.BACKENDS["acp:ok"].label, "Trimmed");
	assert.equal(p.BACKEND_ICONS["acp:ok"], "code");
	assert.equal(p.BACKENDS["acp:twin"], undefined, "a duplicate id is not registered twice");
	assert.equal(p.BACKENDS["acp:UPPER"], undefined);
});

test("more than twenty stored agents load only the first twenty", () => {
	const many = [];
	for (let i = 0; i < 25; i++) {
		many.push({ id: "agent-" + i, name: "Agent " + i, command: "agent" + i, args: [] });
	}
	const p = loadPlugin({ prefs: { [PREF]: JSON.stringify(many) } }).plugin;
	assert.equal(p.acpAgents().length, 20);
	assert.equal(p.acpAgents()[0].id, "agent-0");
});

test("the stored agents are registered at start, each with its prefs watched once", () => {
	const env = loadPlugin({ prefs: { [PREF]: JSON.stringify([storedAgent()]) } });
	const p = env.plugin;
	assert.equal(p.BACKENDS["acp:opencode"].command, "opencode");
	assert.equal(p._backendPrefObservers.get("acp:opencode").length, 3, "model, effort and api prefs are watched");
	const observed = p._prefObservers.length;

	const container = env.document.createElement("div");
	p.renderPrefsPane(env.document, container);
	assert.equal(p._prefObservers.length, observed, "Settings registers no agent a second time");
	assert.equal(p._backendPrefObservers.get("acp:opencode").length, 3);
});

test("removing an agent deletes its backend, icon, model cache and prefs", () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	p.acpModelEntry(key).models = [{ id: "m", label: "M", desc: "" }];
	env.prefs["extensions.zusia." + key + ".model"] = "m";
	env.prefs["extensions.zusia." + key + ".effort"] = "high";
	env.prefs["extensions.zusia." + key + ".api"] = "{}";

	assert.equal(p.removeAcpAgent(key), true);
	assert.equal(p.BACKENDS[key], undefined);
	assert.equal(p.BACKEND_ICONS[key], undefined);
	assert.equal(p._acpModels[key], undefined);
	for (const name of ["model", "effort", "api"]) {
		assert.equal(env.prefs["extensions.zusia." + key + "." + name], undefined, name + " pref cleared");
	}
	assert.deepEqual(stored(env.prefs), []);
	assert.equal(p.acpAgents().length, 0);
	assert.equal(p.removeAcpAgent(key), false, "an agent that is no longer stored cannot be removed again");
	assert.equal(p.modelLabel(key, "m"), "m", "a clarification it answered still names its model");
});

test("removing an agent switches the backend only when it pointed at that agent", () => {
	const env = fresh();
	const p = env.plugin;
	const first = p.addAcpAgent(agent());
	const second = p.addAcpAgent({ name: "Other", command: "other", args: [] });

	p.setPref("backend", "claude");
	assert.equal(p.removeAcpAgent(second.key), true);
	assert.equal(p.getPref("backend"), "claude", "a backend pointing elsewhere stays");

	p.setPref("backend", first.key);
	assert.equal(p.removeAcpAgent(first.key), true);
	assert.equal(p.getPref("backend"), "claude", "the removed agent falls back to Claude");
});

test("registering a stored agent replaces the backend of the same id", () => {
	const p = fresh().plugin;
	p.BACKENDS["acp:opencode"] = { label: "Existing", command: "existing", kind: "acp", acpArgs: ["acp"], models: [], efforts: [""] };
	assert.equal(p.registerAcpAgent({ id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] }), "acp:opencode");
	assert.equal(p.BACKENDS["acp:opencode"].label, "OpenCode");
	assert.equal(p.BACKENDS["acp:opencode"].command, "opencode");
	assert.equal(p.BACKEND_ICONS["acp:opencode"], "code");
});

test("the command line quotes only the parts that contain whitespace", () => {
	const p = loadPlugin().plugin;
	assert.equal(p.acpCommandLine({ command: "opencode", args: ["acp"] }), "opencode acp");
	assert.equal(p.acpCommandLine({ command: "/usr/bin/opencode", args: [] }), "/usr/bin/opencode");
	assert.equal(p.acpCommandLine({ command: "opencode", args: ["acp", "--flag=x", "--dir", "/tmp/my papers"] }),
		'opencode acp --flag=x --dir "/tmp/my papers"');
	assert.equal(p.acpCommandLine({ command: "C:\\Program Files\\Agent\\agent.exe", args: ["acp"] }),
		'"C:\\Program Files\\Agent\\agent.exe" acp', "a Windows path keeps its single backslashes");
});

test("a pasted command loses the quotes around it, and only those", () => {
	const p = fresh().plugin;
	for (const [typed, kept] of [
		['"C:\\Program Files\\Agent\\agent.exe"', "C:\\Program Files\\Agent\\agent.exe"],
		['  "C:\\Program Files\\Agent\\agent.exe"  ', "C:\\Program Files\\Agent\\agent.exe"],
		["'/opt/my agent/bin/agent'", "/opt/my agent/bin/agent"],
		['"half', '"half'],
		['"mixed\'', '"mixed\''],
		["opencode", "opencode"],
	]) {
		const { config } = p.normalizeAcpAgent({ name: "A", command: typed }, "a");
		assert.equal(config.command, kept, typed);
	}
	assert.match(p.normalizeAcpAgent({ name: "A", command: '""' }, "a").error, /command of 1 to 500/, "nothing left inside the quotes");
});

test("on Windows a path copied from Explorer, quotes and all, finds the agent", async () => {
	const exe = "C:\\Program Files\\Agent\\agent.exe";
	const { plugin: p } = loadWindowsPlugin({ executables: [exe] });
	const { key } = p.addAcpAgent({ name: "Agent", command: '"' + exe + '"', args: "acp" });
	assert.equal(await p.findBinary(key), exe);
	assert.equal(p.acpCommandLine(p.acpAgentConfig(key)), '"' + exe + '" acp');
});

test("a custom ACP agent runs its own command and arguments", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	const fake = fakeAgent({ answer: "The FFT turns 8 samples into 8 frequencies." });
	const lookups = [];
	const spawns = [];
	p.findBinary = async (backend) => {
		lookups.push(backend);
		return "/opt/opencode/bin/opencode";
	};
	p.spawnAgent = async (command, args, workdir) => {
		spawns.push({ command, args: [...args], workdir });
		return fake.proc;
	};
	const { key } = p.addAcpAgent({ name: "OpenCode", command: "/opt/opencode/bin/opencode", args: ["acp", "--print-logs"] });
	assert.deepEqual(plain(env.modelLoads).map(load => load.backend), [key], "adding it asks for its models, which the harness answers");

	const shown = [];
	const result = await p.runAcp(key, { ...request, onProgress: ({ text }) => { if (text !== undefined) shown.push(text); } });
	await flush();

	assert.deepEqual(plain(result), { text: "The FFT turns 8 samples into 8 frequencies.", truncated: false },
		"no session id: this agent cannot load the session again");
	assert.deepEqual(lookups, [key], "the agent is looked up under its own backend key");
	assert.deepEqual(spawns, [{ command: "/opt/opencode/bin/opencode", args: ["acp", "--print-logs"], workdir: "/d" }]);
	assert.deepEqual(fake.messages.map(message => message.method), ["initialize", "session/new", "session/prompt"]);
	assert.equal(fake.messages[0].params.clientInfo.name, "Zusia");
	assert.equal(fake.messages[1].params.cwd, "/d");
	assert.match(fake.messages[2].params.prompt[0].text, /Why\?/);
	assert.equal(shown[shown.length - 1], "The FFT turns 8 samples into 8 frequencies.");
});

test("only an agent that can load its sessions gets one kept, so a follow-up is sent in full otherwise", async () => {
	for (const [loadSession, sessions] of [[false, {}], [true, { "acp:opencode": "s-7" }]]) {
		const env = fresh();
		const p = env.plugin;
		p.findBinary = async () => "/opt/opencode";
		p.spawnAgent = async () => fakeAgent({ sessionId: "s-7", capabilities: { loadSession } }).proc;
		const { key } = p.addAcpAgent(agent());
		const store = { history: [], sessions: {} };
		p.exportContext = async () => ({ metadata: "# T\n", annotations: "" });
		p.loadHistory = async () => plain(store.history);
		p.appendHistory = async (dir, messages) => { store.history.push(...messages); };
		p.loadSessions = async () => ({ ...store.sessions });
		p.saveSessions = async (dir, saved) => { store.sessions = saved; };
		const pending = { backend: key, partial: "", cancelled: false, progress: () => {} };
		assert.deepEqual(plain(await p.ask({ dir: "/d" }, "Why?", pending)), {});
		assert.deepEqual(Object.fromEntries(Object.entries(store.sessions).map(([k, v]) => [k, v.id])), sessions,
			"loadSession " + loadSession);
	}
});

test("a custom agent that is not signed in gets its own name in the help", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	assert.equal(p.acpSignInHelp("OpenCode", "Error: authentication required"),
		"OpenCode is not signed in. Sign in with its own CLI in a terminal, then ask again.");
	assert.equal(p.acpSignInHelp("OpenCode", "Everything is fine"), null);

	p.findBinary = async () => "/opt/opencode";
	let complaint = "Not authenticated. Run `opencode auth login`.\n";
	const refusing = {
		stdin: { write: async () => {}, close: async () => {} },
		stdout: { readString: async () => "" },
		stderr: { readString: async () => { const out = complaint; complaint = ""; return out; } },
		wait: async () => ({ exitCode: 1 }),
		kill() {},
	};
	p.spawnAgent = async () => refusing;
	const result = await p.runAcp(key, request);
	assert.equal(result.error, "OpenCode is not signed in. Sign in with its own CLI in a terminal, then ask again.");
});

// An agent that writes `complaint` to stderr and exits with `exitCode` before it says anything.
function deadAgent(exitCode, complaint) {
	return {
		stdin: { write: async () => {}, close: async () => {} },
		stdout: { readString: async () => "" },
		stderr: { readString: async () => { const out = complaint; complaint = ""; return out; } },
		wait: async () => ({ exitCode }),
		kill() {},
	};
}

test("an agent that dies is reported alike to a question, a sign-in and a model list", async () => {
	const env = fresh();
	const p = env.plugin;
	p.loadAcpModels = env.loadAcpModels;
	p.getDataDir = () => "/d";
	p.findBinary = async () => "/opt/opencode";
	p.spawnAgent = async () => deadAgent(3, "starting\npanic: out of memory\n");
	const { key } = p.addAcpAgent(agent());
	const said = "OpenCode exited with code 3: starting\npanic: out of memory";
	assert.equal((await p.runAcp(key, request)).error, said);
	assert.equal((await p.acpAuthenticate(key)).error, said);
	await p.loadAcpModels(key);
	assert.equal(p.acpModelEntry(key).error, said);
});

test("a custom agent can name an absolute command", async () => {
	const files = new Map([["/opt/opencode/bin/opencode", "binary"]]);
	const { plugin } = loadPlugin({ files });
	const { key } = plugin.addAcpAgent(agent({ command: "/opt/opencode/bin/opencode" }));
	assert.equal(await plugin.findBinary(key), "/opt/opencode/bin/opencode");
});

test("a configured ACP agent runs a background call with the raw memory prompt", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	const fake = fakeAgent({ answer: '{"ok":true}' });
	p.findBinary = async () => "/opt/opencode";
	p.spawnAgent = async () => fake.proc;
	p.makeJobDir = async () => "/tmp/job";
	const { key } = p.addAcpAgent(agent());

	const result = await env.runBackgroundCall.call(p, key, "MEMORY TASK");
	await flush();
	assert.deepEqual(plain(result), { text: '{"ok":true}', error: "", rateLimited: false });
	assert.equal(fake.messages[1].method, "session/new");
	assert.equal(fake.messages[1].params.cwd, "/tmp/job");
	assert.equal(fake.messages[2].method, "session/prompt");
	assert.equal(fake.messages[2].params.prompt.length, 1);
	assert.equal(fake.messages[2].params.prompt[0].text, "MEMORY TASK", "the raw prompt, not Zusia's system prompt");
});

test("an ACP memory job runs at the model and effort chosen for the agent", async () => {
	const env = fresh();
	const p = env.plugin;
	const fake = fakeAgent({ answer: "{}", configOptions: [
		{ id: "model", category: "model", options: [{ value: "a" }, { value: "fast" }] },
		{ id: "reasoning", category: "thought_level", options: [{ value: "low" }, { value: "high" }] },
	] });
	p.findBinary = async () => "/opt/opencode";
	p.spawnAgent = async () => fake.proc;
	p.makeJobDir = async () => "/tmp/job";
	env.window.OS.File.removeDir = async () => {};
	const { key } = p.addAcpAgent(agent());
	env.prefs["extensions.zusia." + key + ".model"] = "fast";
	env.prefs["extensions.zusia." + key + ".effort"] = "high";

	assert.deepEqual(plain(await env.runBackgroundCall.call(p, key, "MEMORY TASK")), { text: "{}", error: "", rateLimited: false });
	assert.deepEqual(fake.messages.filter(m => m.method)
		.map(m => (m.method === "session/set_config_option" ? m.params.configId + "=" + m.params.value : m.method)),
	["initialize", "session/new", "model=fast", "reasoning=high", "session/prompt"]);
});

test("an ACP memory job that hangs is killed at the deadline and keeps the rate limit its stderr names", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	const fake = fakeAgent();
	let expire;
	env.window.Zotero.Promise.delay = ms => new Promise((resolve) => {
		if (ms === p.JOB_TIMEOUT_MS) {
			expire = resolve;
		}
	});
	const prompted = new Promise((resolve) => {
		const write = fake.proc.stdin.write;
		fake.proc.stdin.write = async (text) => {
			if (JSON.parse(text).method === "session/prompt") {
				fake.stderr("429 Too Many Requests, retrying in 60s\n");
				resolve();
				return;
			}
			return write(text);
		};
	});
	p.findBinary = async () => "/opt/opencode";
	p.spawnAgent = async () => fake.proc;
	p.makeJobDir = async () => "/tmp/job";
	env.window.OS.File.removeDir = async () => {};
	const { key } = p.addAcpAgent(agent());
	const job = { key: "k", proc: null, cancelled: false };
	const running = env.runBackgroundCall.call(p, key, "MEMORY TASK", job);
	await prompted;
	assert.equal(job.proc, fake.proc);
	expire();
	assert.deepEqual(plain(await running), { text: "", error: "no answer within 5 minutes", rateLimited: true });
	assert.equal(fake.proc.killed, true);
});

test("a configured ACP agent can be asked to sign in", async () => {
	const p = loadPlugin().plugin;
	const fake = fakeAgent({ auth: [{ id: "oauth", name: "Log in with Google" }, { id: "key", name: "API key" }] });
	p.findBinary = async () => "/opt/opencode";
	p.spawnAgent = async () => fake.proc;
	p.getDataDir = () => "/d";
	const { key } = p.addAcpAgent(agent());

	const result = await p.acpAuthenticate(key);
	await flush();
	assert.deepEqual(plain(result), { methods: [{ id: "oauth", name: "Log in with Google" }, { id: "key", name: "API key" }] });
	assert.deepEqual(fake.messages.map(message => message.method), ["initialize", "authenticate"]);
	assert.equal(fake.messages[1].params.methodId, "oauth");
});

test("an ACP agent's models are available as soon as it is added", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	p.loadAcpModels = env.loadAcpModels;
	const fake = fakeAgent({ configOptions: [
		{ id: "model", name: "Model", category: "model", options: [{ value: "fast", name: "Fast" }] },
	] });
	p.findBinary = async () => "/opt/opencode";
	p.spawnAgent = async () => fake.proc;
	p.getDataDir = () => "/d";
	const { key } = p.addAcpAgent(agent());

	let models = p.getModels(key);
	for (let i = 0; i < 20 && models.length < 2; i++) {
		await new Promise(resolve => setImmediate(resolve));
		models = p.getModels(key);
	}
	assert.deepEqual(plain(models.map(m => m.id)), ["", "fast"]);
});

// An agent whose session/new answers with `configOptions`, counting how often it was started.
function listingAgent(p, configOptions, { fails = 0 } = {}) {
	const started = { count: 0 };
	p.getDataDir = () => "/d";
	p.findBinary = async () => "/opt/opencode";
	p.spawnAgent = async () => {
		started.count++;
		return started.count <= fails ? deadAgent(1, "npx: network unreachable\n") : fakeAgent({ configOptions }).proc;
	};
	return started;
}
const MODEL = [{ id: "model", name: "Model", category: "model", type: "select", options: [{ value: "fast", name: "Fast" }] }];

test("an agent's model list is asked for once, and kept", async () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	p.loadAcpModels = env.loadAcpModels;
	const started = listingAgent(p, MODEL);
	const first = p.loadAcpModels(key);
	assert.equal(p.loadAcpModels(key), first, "a second ask while the first runs shares it");
	assert.ok(p.acpModelEntry(key).promise, "the listing in flight is on the entry");
	assert.deepEqual(plain(await first), [{ id: "fast", label: "Fast", desc: "" }]);
	assert.deepEqual(plain(p.acpModelEntry(key)), { models: [{ id: "fast", label: "Fast", desc: "" }], error: "", promise: null });
	assert.deepEqual(plain(await p.loadAcpModels(key, { retry: true })).map(m => m.id), ["fast"]);
	assert.equal(started.count, 1, "a listed agent is not started again");
	assert.deepEqual(plain(p.getModels(key)).map(m => m.id), ["", "fast"]);
});

test("an agent that offers no model choice is listed as such, not loading forever", async () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	p.loadAcpModels = env.loadAcpModels;
	listingAgent(p, []);
	assert.deepEqual(plain(await p.loadAcpModels(key)), []);
	assert.deepEqual(plain(p.acpModelEntry(key).models), []);
});

test("a failed model list is kept until the card asks again", async () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	p.loadAcpModels = env.loadAcpModels;
	const started = listingAgent(p, MODEL, { fails: 1 });
	assert.deepEqual(plain(await p.loadAcpModels(key)), []);
	assert.equal(p.acpModelEntry(key).error, "OpenCode exited with code 1: npx: network unreachable");
	assert.equal(p.acpModelEntry(key).models, null);
	await p.loadAcpModels(key);
	assert.equal(started.count, 1, "the menu opened twice does not start the agent twice");
	assert.deepEqual(plain(await p.loadAcpModels(key, { retry: true })).map(m => m.id), ["fast"], "Try again does");
	assert.equal(started.count, 2);
	assert.equal(p.acpModelEntry(key).error, "");
});

test("an agent that never lists its models is stopped after 30 s, and the card can try again", async () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	p.loadAcpModels = env.loadAcpModels;
	let expire;
	const deadlines = [];
	env.window.Zotero.Promise.delay = (ms) => {
		deadlines.push(ms);
		return new Promise(resolve => { expire = resolve; });
	};
	// A CLI started without its ACP argument: it reads stdin, never answers and never exits.
	const silent = fakeAgent();
	silent.proc.stdin.write = async () => {};
	silent.proc.stdin.close = async () => {};
	const started = listingAgent(p, MODEL);
	p.spawnAgent = async () => (++started.count === 1 ? silent.proc : fakeAgent({ configOptions: MODEL }).proc);
	const loading = p.loadAcpModels(key);
	await flush();
	assert.deepEqual(deadlines, [30000]);
	expire();
	assert.deepEqual(plain(await loading), []);
	assert.equal(silent.proc.killed, true, "the agent's process is stopped");
	assert.equal(p.acpModelEntry(key).error, "OpenCode did not answer within 30 s.");
	assert.equal(p.acpModelEntry(key).promise, null, "nothing stays pinned, so Try again starts afresh");
	assert.deepEqual(plain(await p.loadAcpModels(key, { retry: true })).map(m => m.id), ["fast"]);
	assert.equal(started.count, 2);
});

test("a sign-in runs without a deadline, and an answer before the deadline stands", async () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	p.loadAcpModels = env.loadAcpModels;
	const deadlines = [];
	let expire;
	env.window.Zotero.Promise.delay = (ms) => {
		deadlines.push(ms);
		return new Promise(resolve => { expire = resolve; });
	};
	const fake = fakeAgent({ auth: [{ id: "oauth", name: "Google" }] });
	p.getDataDir = () => "/d";
	p.findBinary = async () => "/opt/opencode";
	p.spawnAgent = async () => fake.proc;
	assert.equal((await p.acpAuthenticate(key)).error, undefined);
	assert.deepEqual(deadlines, [], "a sign-in may wait on a browser");

	listingAgent(p, MODEL);
	assert.deepEqual(plain(await p.loadAcpModels(key)).map(m => m.id), ["fast"]);
	expire();
	await flush();
	assert.equal(p.acpModelEntry(key).error, "", "a deadline after the answer changes nothing");
});

test("an agent removed while it lists its models leaves no list behind", async () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	const recordLoads = p.loadAcpModels;
	p.loadAcpModels = env.loadAcpModels;
	p.getDataDir = () => "/d";
	p.findBinary = async () => "/opt/opencode";
	// Removed from Settings while the agent opens the session that carries its list.
	p.spawnAgent = async () => fakeAgent({ on: { "session/new": (m, a) => {
		p.removeAcpAgent(key);
		a.reply(m, { sessionId: "s", configOptions: MODEL });
	} } }).proc;
	await p.loadAcpModels(key);
	assert.equal(p._acpModels[key], undefined);
	assert.ok(!p._logLines.some(line => line.includes("Could not list")), "the listing itself went through");
	// The harness's recorder again, so adding the agent back starts no listing.
	p.loadAcpModels = recordLoads;
	const again = p.addAcpAgent(agent());
	assert.equal(again.key, key, "the same id comes back");
	assert.equal(p.acpModelEntry(key).models, null, "and starts with no list");
});

test("every kind loads its live models through one door that refreshes the chats", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	const asked = [];
	p.loadAgyModels = async () => { asked.push("agy"); return []; };
	p.loadAPIModels = async (backend) => { asked.push(backend); throw new Error("connection refused"); };
	let refreshed = 0;
	p.updateControls = () => { refreshed++; };
	env.document.body.appendChild(Object.assign(env.document.createElement("div"), { className: "zs-root" }));
	for (const backend of ["claude", "codex", "agy", "ollama", "acp:commandcode"]) {
		assert.equal(await p.loadLiveModels(backend, { retry: true }), undefined, backend);
	}
	assert.deepEqual(asked, ["agy", "ollama"], "only Antigravity among the CLIs lists models");
	assert.deepEqual(plain(env.modelLoads), [{ backend: "acp:commandcode", options: { retry: true } }]);
	assert.equal(refreshed, 5, "each load ends with the chats' controls");
	assert.ok(p._logLines.some(line => line.includes("Could not list Ollama models: Error: connection refused")), "an API failure is logged, not thrown");
});

test("the model menu asks only an open agent section for its models, and says how the listing went", () => {
	const env = fresh({ "extensions.zusia.onboarded": true });
	const p = env.plugin;
	const first = p.addAcpAgent(agent());
	const second = p.addAcpAgent({ name: "Other", command: "other", args: [] });
	env.modelLoads.length = 0;
	p.setPref("backend", first.key);
	const { root } = openChat(env);
	root._installed = Object.fromEntries(Object.keys(p.BACKENDS).map(key => [key, "/bin/" + key]));
	p._agyModels = [];
	p.openModelMenu(root, root.querySelector(".zs-model-btn"));
	assert.deepEqual(env.modelLoads.map(load => load.backend), [first.key], "a folded section starts nothing");
	const menu = root.querySelector(".zs-menu");
	assert.match(menu.textContent, /Loading models…/);
	p.acpModelEntry(first.key).error = "OpenCode did not answer within 30 s.";
	menu.refresh();
	assert.match(menu.textContent, /Models could not be loaded\. OpenCode did not answer within 30 s\./);
	[...menu.querySelectorAll(".zs-menu-section-toggle")].find(button => button.textContent.includes("Other")).click();
	assert.deepEqual(env.modelLoads.map(load => load.backend), [first.key, second.key], "opening its section asks the other agent");
	p.acpModelEntry(first.key).models = [{ id: "fast", label: "Fast", desc: "" }];
	menu.refresh();
	assert.match(menu.textContent, /Fast/);
});

test("an agent's card turns its background memory on and off", () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	p.setPref("backend", key);
	const container = env.document.createElement("div");
	p.renderPrefsPane(env.document, container);
	const card = container.querySelector('.zs-acp-list .zs-agent[data-backend="' + key + '"]');
	const toggle = [...card.querySelectorAll(".zs-row")].find(row => row.textContent.includes("Background memory")).querySelector(".zs-switch");
	assert.equal(toggle.getAttribute("aria-checked"), "false");
	toggle.click();
	assert.equal(stored(env.prefs)[0].background, true);
	assert.equal(p.jobBackend(), key);
	toggle.click();
	assert.equal(p.jobBackend(), null);
});

// Settings open on the page with one agent's card, its agent found and every other command
// not. The card stops listening once it leaves the page, so it has to be on one.
function agentCard(env, key) {
	const p = env.plugin;
	p.findBinary = async backend => (backend === key ? "/opt/opencode" : null);
	const container = env.document.body.appendChild(env.document.createElement("div"));
	p.renderPrefsPane(env.document, container);
	const card = container.querySelector('.zs-acp-list .zs-agent[data-backend="' + key + '"]');
	return { container, card, model: card.querySelector(".zs-agent-body > .zs-row select") };
}

// Flushes until `done()` holds; the listing crosses several awaits before the card hears of it.
async function settle(done) {
	for (let i = 0; i < 50 && !done(); i++) {
		await flush();
	}
}

test("a card whose agent could not list its models says why, and Try again lists them", async () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	p.loadAcpModels = env.loadAcpModels;
	p.getDataDir = () => "/d";
	p.spawnAgent = async () => deadAgent(1, "npx: network unreachable\n");
	const { card, model } = agentCard(env, key);
	const hint = card.querySelector(".zs-agent-body > .zs-row-hint");
	assert.equal(hint.textContent, "Loading the model list…");
	await settle(() => hint.querySelector(".zs-acp-retry"));
	assert.equal(hint.textContent, "Models could not be loaded. OpenCode exited with code 1: npx: network unreachable Try again");
	assert.deepEqual([...model.options].map(o => o.value), [""]);

	p.spawnAgent = async () => fakeAgent({ configOptions: MODEL }).proc;
	hint.querySelector(".zs-acp-retry").click();
	assert.equal(hint.textContent, "Loading the model list…");
	await settle(() => !hint.isConnected);
	assert.equal(hint.isConnected, false, "the hint goes once the list is in");
	assert.deepEqual([...model.options].map(o => o.value), ["", "fast"]);
});

test("removing the agent in use from its card hands the chat back to Claude", () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	p.setPref("backend", key);
	const { container, card } = agentCard(env, key);
	card.querySelector(".zs-acp-remove").click();
	assert.equal(p.getPref("backend"), "claude");
	assert.equal(p.BACKENDS[key], undefined);
	assert.deepEqual(stored(env.prefs), []);
	assert.equal(container.querySelector('.zs-agent[data-backend="' + key + '"]'), null, "its card is gone");
	const answerWith = [...container.querySelectorAll(".zs-row")].find(row => row.textContent.startsWith("Answer with")).querySelector("select");
	assert.equal(answerWith.value, "claude");
	assert.ok(![...answerWith.options].some(o => o.value === key), "the backend menu no longer offers it");
	assert.equal(container.querySelector('.zs-agent[data-backend="claude"] .zs-badge').hidden, false, "Claude is marked in use");
});

test("the shipped agent can be removed like any other and stays removed", () => {
	const env = loadPlugin();
	assert.equal(env.plugin.removeAcpAgent("acp:commandcode"), true);
	assert.deepEqual(stored(env.prefs), [], "the pref no longer holds it");
	const next = loadPlugin({ prefs: env.prefs });
	assert.equal(next.plugin.BACKENDS["acp:commandcode"], undefined);
});
