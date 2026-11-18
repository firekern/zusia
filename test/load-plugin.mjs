// Loads the real plugin source into a jsdom window with minimal Zotero stubs,
// so rendering can be tested outside Zotero.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

// The ACP agents a fresh install starts with live in src/prefs.js, so a test that renders
// Settings or the model menu sees the same list a user does.
const shipped = read("src/prefs.js").match(/pref\("extensions\.zusia\.acpAgents", "(.*)"\);/);
if (!shipped) {
	throw new Error("src/prefs.js no longer declares extensions.zusia.acpAgents");
}
const SHIPPED_ACP_AGENTS = JSON.parse(shipped[1].replace(/\\"/g, "\""));

export function loadPlugin({ prefs = {}, files = new Map() } = {}) {
	prefs = { "extensions.zusia.acpAgents": JSON.stringify(SHIPPED_ACP_AGENTS), ...prefs };
	const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only" });
	const { window } = dom;
	window.TextEncoder = TextEncoder;
	// OS.File and Zotero.File share one in-memory store, returned as `files`.
	const OS = {
		Path: { join: (...p) => p.join("/"), dirname: p => p.replace(/[\\/][^\\/]*$/, ""), basename: p => p.replace(/^.*[\\/]/, "") },
		File: {
			exists: async p => files.has(p),
			read: async (p) => {
				if (!files.has(p)) {
					throw new Error("read: no such file " + p);
				}
				let value = files.get(p);
				return value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
			},
			remove: async (p) => { files.delete(p); },
			// Real OS.File.move replaces the target, which is what makes writeAtomic atomic.
			move: async (from, to) => {
				if (!files.has(from)) {
					throw new Error("move: no such file " + from);
				}
				files.set(to, files.get(from));
				files.delete(from);
			},
			stat: async p => ({ isDir: false, size: String(files.get(p) ?? "").length }),
		},
	};
	// Tests replace its methods (call, pathSearch, getEnvironment) to fake child processes.
	const Subprocess = {};
	window.ChromeUtils = { importESModule: () => ({ OS, Subprocess }) };
	window.Zotero = {
		debug() {},
		Promise: { delay: () => new Promise(() => {}) },
		Prefs: {
			get: key => prefs[key],
			set: (key, value) => { prefs[key] = value; },
			clear: (key) => { delete prefs[key]; },
			registerObserver: () => "observer",
			unregisterObserver() {},
		},
		// No test reaches the network: one that needs a response, as the registry browser does, replaces this.
		HTTP: { request: async () => { throw new Error("no HTTP in tests"); } },
		Utilities: { Internal: { copyTextToClipboard() {} } },
		File: {
			putContentsAsync: async (p, data) => { files.set(p, data); },
			getContentsAsync: async (p) => {
				if (!files.has(p)) {
					throw new Error("getContentsAsync: no such file " + p);
				}
				return files.get(p);
			},
			createDirectoryIfMissingAsync: async () => {},
		},
		getMainWindow: () => window,
		// As in Zotero, a window closed by the test is no longer one of them.
		getMainWindows: () => (window.document ? [window] : []),
	};
	window.eval(read("src/content/lib/katex.min.js").replace(/^!function\(e,t\)\{/, "!function(e,t){var exports,module,define;"));
	window.Services = { appinfo: { XPCOMABI: "x86_64-gcc3" }, scriptloader: { loadSubScript: (url, scope) => {
		if (url.endsWith("eventsource-parser.js")) {
			window.eval(read("src/content/lib/eventsource-parser.js"));
			scope.ZusiaEventSource = window.ZusiaEventSource;
		}
		else scope.module.exports = window.katex;
	} } };
	// bootstrap.js loads the reading map first, into the same scope as zusia.js.
	window.eval(read("src/content/readingmap.js") + "\nwindow.ZusiaMap = ZusiaMap;");
	window.eval("var Zusia;\n" + read("src/content/zusia.js") + "\nwindow.Zusia = Zusia;");
	const plugin = window.Zusia;
	for (const name of plugin.MODULES) {
		window.eval(read("src/content/modules/" + name + ".js"));
	}
	plugin.rootURI = "./";
	// What init() does on a real start: the stored ACP agents become backends a chat can pick.
	plugin.loadAcpAgents();
	// Memory jobs start on their own after answers, New chat and page turns, so no test
	// reaches a CLI through them by accident: each call is recorded and gets no answer.
	// Tests of the runner itself put `runBackgroundCall` back.
	const backgroundCalls = [];
	const runBackgroundCall = plugin.runBackgroundCall;
	plugin.runBackgroundCall = async (backend, prompt) => {
		backgroundCalls.push({ backend, prompt });
		return { text: "", error: "no model in tests", rateLimited: false };
	};
	// An agent's model list loads on its own once the agent is added, its Settings card
	// renders or its menu section opens, which would start the agent's program. The same
	// holds: each call is recorded and lists nothing. Tests of the loader put
	// `loadAcpModels` back.
	const modelLoads = [];
	const loadAcpModels = plugin.loadAcpModels;
	plugin.loadAcpModels = async (backend, options) => {
		modelLoads.push({ backend, options });
		return [];
	};
	return { window, document: window.document, plugin, map: window.ZusiaMap, prefs, files, Subprocess, backgroundCalls, runBackgroundCall,
		modelLoads, loadAcpModels };
}

// A chat rendered in the page, with the view the plugin keeps for it: what Zotero's
// pane or the dock sets up before a test can type, send or read messages.
export function openChat(env, { ctx = { dir: "/d" }, className = "" } = {}) {
	const { plugin, document } = env;
	const body = document.createElement("div");
	body.className = className;
	document.body.appendChild(body);
	plugin.renderSkeleton(document, body);
	const root = body.querySelector(".zs-root");
	const view = { doc: document, root, ctx, logEl: root.querySelector(".zs-log"), input: root.querySelector(".zs-input") };
	plugin._views.set(root, view);
	return { body, root, view };
}

export function fixture(name) {
	return read("test/fixtures/" + name);
}

export function render(env, text) {
	const container = env.document.createElement("div");
	env.plugin.renderMarkdown(env.document, container, text);
	return container;
}

// Text that escaped rendering: raw Markdown/LaTeX markers left in visible text.
export function leftoverMarkup(container) {
	const problems = [];
	const walker = container.ownerDocument.createTreeWalker(container, 4 /* SHOW_TEXT */);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.parentElement.closest("code, pre, math, annotation")) {
			continue;
		}
		const text = node.textContent;
		for (const [label, re] of [
			["unrendered $", /(^|[^\\])\$(?!\d)/],
			["\\begin/\\end", /\\(begin|end)\{/],
			["LaTeX command", /\\[a-zA-Z]{2,}/],
			["table separator", /\|\s*:?-{3,}/],
			["table row pipe", /^\s*\|.*\|\s*$/],
			["bold marker", /\*\*/],
			["heading marker", /^#{1,6}\s/],
			["quote marker", /^>\s/],
		]) {
			if (re.test(text)) {
				problems.push(label + ": " + JSON.stringify(text.slice(0, 80)));
			}
		}
	}
	return problems;
}
