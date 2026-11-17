import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const PREF = "extensions.zusia.acpAgents";
const plain = value => JSON.parse(JSON.stringify(value));
const stored = prefs => JSON.parse(prefs[PREF] || "[]");
const agent = (over = {}) => ({ name: "OpenCode", command: "opencode", args: ["acp"], ...over });
const storedAgent = (over = {}) => ({ id: "opencode", ...agent(), ...over });
// An install starts with the agent src/prefs.js ships, so a store test states its own list.
const fresh = (over = {}) => loadPlugin({ prefs: { [PREF]: "[]", ...over } });

const flush = () => new Promise(resolve => setImmediate(resolve));

function stream() {
	const chunks = [];
	const waiting = [];
	let ended = false;
	return {
		push(chunk) {
			chunks.push(chunk);
			const resolve = waiting.shift();
			if (resolve) {
				resolve();
			}
		},
		end() {
			ended = true;
			for (const resolve of waiting.splice(0)) {
				resolve();
			}
		},
		async readString() {
			while (!chunks.length && !ended) {
				await new Promise(resolve => waiting.push(resolve));
			}
			return chunks.length ? chunks.shift() : "";
		},
	};
}

function fakeAgent({ answer = "It is the FFT.", sessionId = "s-1", auth = [], configOptions = [] } = {}) {
	const stdout = stream();
	const stderr = stream();
	const messages = [];
	let finish;
	const send = message => stdout.push(JSON.stringify(message) + "\n");
	const proc = {
		stdin: {
			closed: false,
			async write(text) {
				assert.ok(!proc.stdin.closed, "write after stdin was closed");
				const message = JSON.parse(text);
				messages.push(message);
				if (message.method === "initialize") {
					send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: auth } });
				}
				else if (message.method === "authenticate") {
					send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
				}
				else if (message.method === "session/new") {
					send({ jsonrpc: "2.0", id: message.id, result: { sessionId, configOptions } });
				}
				else if (message.method === "session/prompt") {
					send({ jsonrpc: "2.0", method: "session/update", params: {
						sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } },
					} });
					send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
				}
			},
			async close() {
				proc.stdin.closed = true;
				proc.finish(0);
			},
		},
		stdout: { readString: () => stdout.readString() },
		stderr: { readString: () => stderr.readString() },
		killed: false,
		wait: () => proc.exit,
	};
	proc.exit = new Promise((resolve) => {
		finish = resolve;
	});
	proc.finish = (exitCode = 0) => {
		stdout.end();
		stderr.end();
		finish({ exitCode });
	};
	proc.kill = () => {
		proc.killed = true;
		proc.finish(1);
	};
	return { proc, messages };
}

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
	p._acpModels["acp:opencode"] = [{ id: "fast-model", label: "Fast", desc: "" }];
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
	assert.equal(p.acpSlug("Opencode", ["opencode"]), "opencode-2");
	assert.equal(p.acpSlug("Opencode", new Set(["opencode", "opencode-2"])), "opencode-3");
	assert.equal(p.acpSlug("x".repeat(40), ["x".repeat(40)]), "x".repeat(38) + "-2", "the suffix fits inside the 40 characters");

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

	p.loadAcpAgents();
	assert.equal(p.BACKENDS["acp:opencode"].command, "opencode");
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

test("loading the stored agents runs once", () => {
	const env = loadPlugin({ prefs: { [PREF]: JSON.stringify([storedAgent()]) } });
	const p = env.plugin;
	p.loadAcpAgents();
	assert.equal(p._acpAgentsLoaded, true);
	assert.equal(p.BACKENDS["acp:opencode"].command, "opencode");
	const observed = p._prefObservers.length;
	assert.equal(p._backendPrefObservers.get("acp:opencode").length, 3, "model, effort and api prefs are watched");

	p.loadAcpAgents();
	assert.equal(p._prefObservers.length, observed, "a second load adds no observers");
	assert.equal(p._backendPrefObservers.get("acp:opencode").length, 3);

	p.saveAcpAgentConfigs([...p.acpAgents(), { id: "later", name: "Later", command: "later", args: [] }]);
	p.loadAcpAgents();
	assert.equal(p.BACKENDS["acp:later"], undefined);
});

test("removing an agent deletes its backend, icon, model cache and prefs", () => {
	const env = fresh();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	p._acpModels[key] = [{ id: "m", label: "M", desc: "" }];
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
	assert.equal(p.acpCommandLine({ command: "C:\\Program Files\\Agent\\agent.exe", args: [] }),
		'"C:\\\\Program Files\\\\Agent\\\\agent.exe"');
	assert.equal(p.acpCommandLine(null), "");
	assert.equal(p.acpCommandLine(agent()), p.acpCommandLine(agent()));
});

test("a custom ACP agent runs its own command and arguments", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	const { key } = p.addAcpAgent({ name: "OpenCode", command: "/opt/opencode/bin/opencode", args: ["acp", "--print-logs"] });
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

	const shown = [];
	const result = await p.runAcp(key, { ...request, onProgress: ({ text }) => { if (text !== undefined) shown.push(text); } });
	await flush();

	assert.deepEqual(plain(result), { text: "The FFT turns 8 samples into 8 frequencies.", sessionId: "s-1", truncated: false });
	assert.deepEqual(lookups, [key], "the agent is looked up under its own backend key");
	assert.deepEqual(spawns, [{ command: "/opt/opencode/bin/opencode", args: ["acp", "--print-logs"], workdir: "/d" }]);
	assert.deepEqual(fake.messages.map(message => message.method), ["initialize", "session/new", "session/prompt"]);
	assert.equal(fake.messages[0].params.clientInfo.name, "Zusia");
	assert.equal(fake.messages[1].params.cwd, "/d");
	assert.match(fake.messages[2].params.prompt[0].text, /Why\?/);
	assert.equal(shown[shown.length - 1], "The FFT turns 8 samples into 8 frequencies.");
});

test("a custom agent that is not signed in gets its own name in the help", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	assert.equal(p.acpSignInHelp(key, "Not authenticated"),
		"OpenCode is not signed in. Sign in with its own CLI in a terminal, then ask again.");
	assert.match(p.acpSignInHelp("acp:commandcode", "Not authenticated"), /Command Code is not signed in/);
	assert.equal(p.acpSignInHelp(key, "Everything is fine"), null);

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

test("a custom agent can name an absolute command", async () => {
	const files = new Map([["/opt/opencode/bin/opencode", "binary"]]);
	const { plugin } = loadPlugin({ files });
	const { key } = plugin.addAcpAgent(agent({ command: "/opt/opencode/bin/opencode" }));
	assert.equal(await plugin.findBinary(key), "/opt/opencode/bin/opencode");
});

test("a configured ACP agent runs a background call with the raw memory prompt", async () => {
	const env = loadPlugin();
	const p = env.plugin;
	const { key } = p.addAcpAgent(agent());
	const fake = fakeAgent({ answer: '{"ok":true}' });
	p.findBinary = async () => "/opt/opencode";
	p.spawnAgent = async () => fake.proc;
	p.makeJobDir = async () => "/tmp/job";

	const result = await env.runBackgroundCall.call(p, key, "MEMORY TASK");
	await flush();
	assert.deepEqual(plain(result), { text: '{"ok":true}', error: "", rateLimited: false });
	assert.equal(fake.messages[1].method, "session/new");
	assert.equal(fake.messages[1].params.cwd, "/tmp/job");
	assert.equal(fake.messages[2].method, "session/prompt");
	assert.equal(fake.messages[2].params.prompt.length, 1);
	assert.equal(fake.messages[2].params.prompt[0].text, "MEMORY TASK", "the raw prompt, not Zusia's system prompt");
});

test("a configured ACP agent can be asked to sign in", async () => {
	const p = loadPlugin().plugin;
	const { key } = p.addAcpAgent(agent());
	const fake = fakeAgent({ auth: [{ id: "oauth", name: "Log in with Google" }, { id: "key", name: "API key" }] });
	p.findBinary = async () => "/opt/opencode";
	p.spawnAgent = async () => fake.proc;
	p.getDataDir = () => "/d";

	const result = await p.acpAuthenticate(key);
	await flush();
	assert.equal(result.method.id, "oauth");
	assert.deepEqual(plain(result.methods), [{ id: "oauth", name: "Log in with Google" }, { id: "key", name: "API key" }]);
	assert.deepEqual(plain(result.result), { ok: true });
	assert.deepEqual(fake.messages.map(message => message.method), ["initialize", "authenticate"]);
	assert.equal(fake.messages[1].params.methodId, "oauth");
});

test("an ACP agent's models are available as soon as it is added", async () => {
	const p = loadPlugin().plugin;
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

test("the shipped agent can be removed like any other and stays removed", () => {
	const env = loadPlugin();
	assert.equal(env.plugin.removeAcpAgent("acp:commandcode"), true);
	assert.deepEqual(stored(env.prefs), [], "the pref no longer holds it");
	const next = loadPlugin({ prefs: env.prefs });
	assert.equal(next.plugin.BACKENDS["acp:commandcode"], undefined);
});
