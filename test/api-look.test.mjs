// Someone who never connects an API sees the Zusia they had before: the API
// assistants show up in the chat once they are set up, and in Settings always.
import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, openChat } from "./load-plugin.mjs";

const P = "extensions.zusia.";
const env = (prefs = {}) => loadPlugin({ prefs: { [P + "onboarded"]: true, ...prefs } });
const ollama = { [P + "ollama.model"]: "qwen3:4b" };
const clis = ["Claude Code", "OpenAI Codex", "Google Antigravity", "Command Code"];

function menuSections(e) {
	const p = e.plugin, { root } = openChat(e);
	root._installed = Object.fromEntries(Object.keys(p.BACKENDS).map(key => [key, p.isAPIBackend(key) ? null : "/bin/" + key]));
	p._agyModels = [];
	p.updateControls(root);
	p.openModelMenu(root, root.querySelector(".zs-model-btn"));
	return { sections: [...root.querySelectorAll(".zs-menu-section")].map(n => n.textContent), text: root.querySelector(".zs-menu").textContent };
}

test("the model button carries no icon, whichever assistant answers", () => {
	for (const prefs of [{}, { ...ollama, [P + "backend"]: "ollama" }]) {
		const e = env(prefs), { root } = openChat(e);
		assert.equal(root.querySelector(".zs-model-btn .zs-model-icon"), null);
		assert.equal(root.querySelectorAll(".zs-model-btn .zs-i").length, 1, "only its chevron");
		e.window.close();
	}
});

test("the model menu names an API assistant only once it is set up", () => {
	let e = env(), menu = menuSections(e);
	assert.deepEqual(menu.sections, clis);
	assert.ok(!menu.text.includes("Set the API URL"));
	e.window.close();
	e = env(ollama);
	assert.deepEqual(menuSections(e).sections, [...clis, "Ollama API"], "the agent sits with the CLIs, before the API");
	e.window.close();
});

test("the wizard offers the CLIs, says where local models are, and adds one that is set up", () => {
	const tiles = e => {
		const { root } = openChat(e);
		e.plugin.showWizard(root);
		const wizard = root.querySelector(".zs-wizard");
		wizard.querySelector(".zs-wizard-next").click();
		assert.equal(wizard.dataset.step, "assistant");
		return { labels: [...wizard.querySelectorAll(".zs-tile-label")].map(n => n.textContent), text: wizard.textContent };
	};
	let e = env(), step = tiles(e);
	assert.deepEqual(step.labels, ["Claude", "Codex", "Antigravity"]);
	assert.match(step.text, /ACP agents instead/);
	assert.match(step.text, /A local model instead/);
	assert.match(step.text, /Settings → Zusia → Assistants/);
	e.window.close();
	e = env(ollama);
	assert.deepEqual(tiles(e).labels, ["Claude", "Codex", "Antigravity", "Ollama"]);
	e.window.close();
});

test("Settings still says no API key is needed, and sets the optional assistants apart", () => {
	const e = env(), card = e.plugin.buildAssistantsCard(e.document);
	assert.match(card.querySelector(".zs-card-desc").textContent, /no API key is needed/);
	const first = card.querySelector('details[data-backend="ollama"]');
	assert.equal(first.previousElementSibling.className, "zs-card-subhead");
	assert.match(first.previousElementSibling.textContent, /optional/i);
	assert.equal(card.querySelectorAll("details.zs-agent").length, Object.keys(e.plugin.BACKENDS).length, "all of them can be set up here");
	e.window.close();
});
