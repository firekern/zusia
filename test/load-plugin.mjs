// Loads the real plugin source into a jsdom window with minimal Zotero stubs,
// so rendering can be tested outside Zotero.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

export function loadPlugin({ prefs = {} } = {}) {
	const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only" });
	const { window } = dom;
	window.TextEncoder = TextEncoder;
	window.ChromeUtils = { importESModule: () => ({ OS: { Path: { join: (...p) => p.join("/") } }, Subprocess: {} }) };
	window.Zotero = {
		debug() {},
		Promise: { delay: () => new Promise(() => {}) },
		Prefs: { get: key => prefs[key], set: (key, value) => { prefs[key] = value; } },
		Utilities: { Internal: { copyTextToClipboard() {} } },
		getMainWindow: () => window,
	};
	window.eval(read("src/content/lib/katex.min.js").replace(/^!function\(e,t\)\{/, "!function(e,t){var exports,module,define;"));
	window.Services = { scriptloader: { loadSubScript: (url, scope) => { scope.module.exports = window.katex; } } };
	window.eval("var Zusia;\n" + read("src/content/zusia.js") + "\nwindow.Zusia = Zusia;");
	const plugin = window.Zusia;
	plugin.rootURI = "./";
	return { window, document: window.document, plugin, prefs };
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
