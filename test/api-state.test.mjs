import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, openChat } from "./load-plugin.mjs";

const P = "extensions.zusia.";
const baseURL = "http://localhost:8888/proxy/v1";
const model = "org/model-GGUF";
function env(backend = "unsloth", extra = {}) {
	return loadPlugin({ prefs: { [P + "backend"]: backend, [P + backend + ".model"]: model,
		[P + backend + ".api"]: JSON.stringify({ baseURL, auth: "none", ...extra }) } });
}

test("startup migrates endpoint selections and restores them across upgrade/restart without credentials in prefs", async () => {
	const e = env();
	await e.plugin.setAPIKey("unsloth", e.plugin.getAPIConfig("unsloth"), "secret-session-key");
	e.plugin.initializeAPIConnections();
	const saved = JSON.parse(e.prefs[P + "unsloth.api"]);
	assert.equal(saved.selectedModels[baseURL], model);
	assert.equal(saved.selectionVersion, 1);
	assert.ok(!JSON.stringify(e.prefs).includes("secret-session-key"));
	// A compatibility scalar can be missing after an update; the scoped selection survives.
	e.prefs[P + "unsloth.model"] = "";
	const restarted = loadPlugin({ prefs: { ...e.prefs } });
	restarted.plugin.initializeAPIConnections();
	assert.equal(restarted.plugin.getModel("unsloth"), model);
});

test("switching endpoints restores each server's selection and never borrows another server's model", () => {
	const { plugin: p } = env();
	p.initializeAPIConnections();
	let config = p.getAPIConfig("unsloth");
	p.setPref("unsloth.api", JSON.stringify({ ...config, baseURL: "http://other.example/v1" }));
	assert.equal(p.getModel("unsloth"), "");
	p.setAPIModel("unsloth", "other-model");
	p.setPref("unsloth.api", JSON.stringify({ ...config, baseURL }));
	assert.equal(p.getModel("unsloth"), model);
	p.setPref("unsloth.api", JSON.stringify({ ...config, baseURL: "http://other.example/v1" }));
	assert.equal(p.getModel("unsloth"), "other-model");
});

test("invalid model drafts preserve the last valid selection and block the settings action", () => {
	const e = env();
	const panel = e.plugin.buildAPIAssistant(e.document, "unsloth");
	const input = [...panel.querySelectorAll("input")].find(x => x.getAttribute("list"));
	input.value = " "; input.dispatchEvent(new e.window.Event("change"));
	assert.equal(e.plugin.getModel("unsloth"), model);
	assert.equal(input.checkValidity(), false);
	assert.match(panel.textContent, /previous selection has been kept/);
	input.value = "new-model"; input.dispatchEvent(new e.window.Event("change"));
	assert.equal(input.checkValidity(), true);
	assert.equal(e.plugin.getModel("unsloth"), "new-model");
});

test("native capabilities are discovered per endpoint/model with explicit overrides", () => {
	const { plugin: p } = env();
	let config = p.getAPIConfig("unsloth");
	p.rememberAPICapabilities("unsloth", model, config, { supports_tools: true, is_vision: false, supports_reasoning: true,
		reasoning_style: "enable_thinking", reasoning_always_on: false });
	config = p.getAPIConfig("unsloth");
	assert.equal(config.tools, true); assert.equal(config.vision, false); assert.equal(config.reasoning, true);
	assert.equal(p.applyAPICapabilities("unsloth", config, "another").tools, false);
	assert.equal(p.applyAPICapabilities("unsloth", { ...config, baseURL: "http://other/v1" }, model).tools, false);
	const key = p.apiProfileKey(config, model);
	p.setPref("unsloth.api", JSON.stringify({ ...config, capabilities: { [key]: { tools: "off", vision: "on", reasoning: "auto" } } }));
	config = p.getAPIConfig("unsloth");
	assert.equal(config.tools, false); assert.equal(config.vision, true); assert.equal(config.reasoning, true);
});

test("saving an auto-detected capability never promotes it to a forced override", () => {
	const { plugin: p } = env();
	let config = p.getAPIConfig("unsloth");
	p.rememberAPICapabilities("unsloth", model, config, { supports_tools: true });
	config = p.getAPIConfig("unsloth");
	p.setPref("unsloth.api", JSON.stringify({ ...config, outputTokens: 1024 }));
	p.rememberAPICapabilities("unsloth", model, config, { supports_tools: false });
	assert.equal(p.getAPIConfig("unsloth").tools, false);
});

test("Ollama reasoning uses declared booleans and model-defined strings, rejecting unknown choices", () => {
	const { plugin: p } = env("ollama");
	let config = p.getAPIConfig("ollama");
	p.rememberAPICapabilities("ollama", model, config, { capabilities: ["completion", "vision", "tools", "thinking"], thinking: { values: [false, true, "deep"], default: true } });
	config = p.getAPIConfig("ollama");
	assert.equal(config.tools, true); assert.equal(config.vision, true);
	assert.equal(p.apiReasoningFields("ollama", config, model, "thinking:false").think, false);
	assert.equal(p.apiReasoningFields("ollama", config, model, "deep").think, "deep");
	assert.equal(Object.keys(p.apiReasoningFields("ollama", config, model, "high")).length, 0);
	p.setPref("ollama.effort", "deep"); assert.equal(p.getEffort("ollama"), "deep");
	p.rememberAPICapabilities("ollama", model, config, { capabilities: ["completion"], thinking: { values: [false], default: false } });
	assert.equal(p.getAPIConfig("ollama").reasoning, false);
	assert.equal(p.getEffort("ollama"), "");
});

test("Unsloth boolean thinking and combined effort controls use their native fields", () => {
	const { plugin: p } = env();
	let config = p.getAPIConfig("unsloth");
	p.rememberAPICapabilities("unsloth", model, config, { supports_reasoning: true, reasoning_style: "enable_thinking_effort", reasoning_effort_levels: ["high", "max"] });
	config = p.getAPIConfig("unsloth");
	assert.equal(p.apiReasoningFields("unsloth", config, model, "thinking:false").enable_thinking, false);
	assert.equal(p.apiReasoningFields("unsloth", config, model, "max").reasoning_effort, "max");
	assert.equal(Object.keys(p.apiReasoningFields("unsloth", config, model, "low")).length, 0);
	p.rememberAPICapabilities("unsloth", model, config, { supports_reasoning: true, reasoning_style: "enable_thinking", reasoning_always_on: true });
	assert.ok(!p.apiReasoningChoices("unsloth").some(x => x.id === "thinking:false"));
});

test("an empty model fails before credential access and before any network request", async () => {
	const { plugin: p } = env();
	let touched = false;
	p.getAPIKey = async () => { touched = true; throw new Error("should not access key store"); };
	const result = await p.runAPIBackend("unsloth", { model: "", apiConfig: { baseURL, auth: "bearer" } });
	assert.match(result.error, /Choose an exact API model/);
	assert.equal(touched, false);
});

test("a malformed saved endpoint remains editable and cannot enable capabilities or start a status request", async () => {
	const e = env("unsloth", { baseURL: "not a valid URL" });
	e.plugin.initializeAPIConnections();
	let panel;
	assert.doesNotThrow(() => { panel = e.plugin.buildAPIAssistant(e.document, "unsloth"); });
	assert.equal(panel.querySelector('select[aria-label="Document tools"]').disabled, true);
	assert.equal(e.plugin.getAPIConfig("unsloth").tools, false);
	assert.equal(await e.plugin.refreshAPIRuntime("unsloth", { force: true }), undefined);
	const input = panel.querySelector('input[type="text"]');
	input.value = baseURL; input.dispatchEvent(new e.window.Event("change"));
	assert.equal(e.plugin.getAPIConfig("unsloth").baseURL, baseURL);
	assert.equal(panel.querySelector('select[aria-label="Document tools"]').disabled, true);
	const modelInput = panel.querySelector('input[list]'); modelInput.value = model; modelInput.dispatchEvent(new e.window.Event("change"));
	assert.equal(panel.querySelector('select[aria-label="Document tools"]').disabled, false);
});

test("the model-menu setup placeholder opens Settings without clearing a valid API selection", () => {
	const e = env(); const p = e.plugin;
	e.prefs[P + "onboarded"] = true;
	const { root } = openChat(e);
	root._installed = Object.fromEntries(Object.keys(p.BACKENDS).map(k => [k, k === "unsloth" ? baseURL : null]));
	p._agyModels = [];
	let opened = 0; p.openSettings = () => opened++;
	p.openModelMenu(root, root.querySelector(".zs-model-btn"));
	const setup = [...root.querySelectorAll(".zs-menu-item")].find(el => el.textContent.includes("Choose a model"));
	assert.ok(setup); setup.click();
	assert.equal(opened, 1); assert.equal(p.getModel("unsloth"), model);
});

test("an open Settings panel keeps overrides bound to its visible model after a chat-model change", () => {
	const e = env(), p = e.plugin;
	const panel = p.buildAPIAssistant(e.document, "unsloth");
	p.setAPIModel("unsloth", "chosen-in-chat");
	const vision = panel.querySelector('select[aria-label="Image input"]');
	vision.value = "on"; vision.dispatchEvent(new e.window.Event("change"));
	const mode = panel.querySelector('.zs-api-profile select'); mode.value = "custom"; mode.dispatchEvent(new e.window.Event("change"));
	const context = panel.querySelector('.zs-api-profile-overrides input'); context.value = "16384"; context.dispatchEvent(new e.window.Event("change"));
	const saved = p.getJSONPref("unsloth.api", {}), key = p.apiProfileKey({ baseURL }, model);
	assert.equal(saved.capabilities[key].vision, "on"); assert.equal(saved.profiles[key].overrides.contextTokens, 16384);
	assert.equal(p.getModel("unsloth"), "chosen-in-chat"); assert.equal(p.getAPIConfig("unsloth").vision, false);
});

test("Load model selects the model visible in Settings even if another window changed the selection", async () => {
	const e = env(), p = e.plugin;
	const panel = p.buildAPIAssistant(e.document, "unsloth");
	p.setAPIModel("unsloth", "chosen-in-chat");
	let prepared;
	p.prepareAPIModel = async (_backend, target) => { prepared = target; };
	p.loadAPIModels = async () => [{ id: model, loaded: true }];
	[...panel.querySelectorAll('button')].find(button => button.textContent === "Load model").click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(prepared, model); assert.equal(p.getModel("unsloth"), model);
});

test("a cold-start request keeps the saved reasoning choice until native capabilities are known", async () => {
	const { plugin: p } = env();
	p.setPref("unsloth.effort", "thinking:false");
	p.initializeAPIConnections();
	assert.equal(p.getEffort("unsloth"), "", "the menu cannot claim support before discovery");
	assert.equal(p.getEffort("unsloth", { deferCapabilities: true }), "thinking:false", "the pending request retains the saved intent");
	let config = p.getAPIConfig("unsloth");
	p.rememberAPICapabilities("unsloth", model, config, { supports_reasoning: true, reasoning_style: "enable_thinking" });
	config = p.applyAPICapabilities("unsloth", config, model);
	assert.equal(p.apiReasoningFields("unsloth", config, model, p.getEffort("unsloth", { deferCapabilities: true })).enable_thinking, false);
	assert.equal(Object.keys(p.apiReasoningFields("unsloth", { ...config, baseURL: "http://different/v1" }, model, "thinking:false")).length, 0);
	assert.equal(Object.keys(p.apiReasoningFields("unsloth", config, "different-model", "thinking:false")).length, 0);
});
