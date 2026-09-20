import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const PREFIX = "extensions.zusia.";

function pane(prefs = {}) {
	const env = loadPlugin({ prefs });
	const container = env.document.createElement("div");
	env.document.body.appendChild(container);
	env.plugin.renderPrefsPane(env.document, container);
	return { ...env, container };
}
const card = (container, title) => [...container.querySelectorAll(".zs-card")]
	.find(c => c.querySelector(".zs-card-title").textContent === title);
const change = (window, el, value) => {
	el.value = value;
	el.dispatchEvent(new window.Event("change"));
};

test("settings pane renders its cards", () => {
	const { container } = pane();
	assert.deepEqual([...container.querySelectorAll(".zs-card-title")].map(h => h.textContent),
		["Assistants", "Chat", "Appearance", "Behaviour", "Troubleshooting"]);
	assert.equal(container.querySelectorAll(".zs-agent").length, 3);
});

test("assistant, default model and effort are saved per backend", () => {
	const { container, prefs, window } = pane();
	const assistants = card(container, "Assistants");
	change(window, assistants.querySelector(".zs-select"), "agy");
	assert.equal(prefs[PREFIX + "backend"], "agy");
	assert.equal(assistants.querySelector('[data-backend="agy"] .zs-badge').hidden, false);
	assert.equal(assistants.querySelector('[data-backend="claude"] .zs-badge').hidden, true);

	const claude = assistants.querySelector('[data-backend="claude"]');
	const [model, effort] = claude.querySelectorAll(".zs-select");
	change(window, model, "opus");
	change(window, effort, "max");
	assert.equal(prefs[PREFIX + "claude.model"], "opus");
	assert.equal(prefs[PREFIX + "claude.effort"], "max");
	assert.deepEqual([...effort.options].map(o => o.value), ["", "low", "medium", "high", "xhigh", "max"]);
});

test("extra Codex models appear in its model list", () => {
	const { container, window, plugin } = pane();
	const codex = card(container, "Assistants").querySelector('[data-backend="codex"]');
	change(window, codex.querySelector('input[type="text"]'), "gpt-5.5, gpt-5.5-mini");
	assert.deepEqual([...codex.querySelector(".zs-select").options].map(o => o.value), ["", "gpt-5.5", "gpt-5.5-mini"]);
	assert.deepEqual([...plugin.getModels("codex").map(m => m.id)], ["", "gpt-5.5", "gpt-5.5-mini"]);
});

test("Claude user-settings switch toggles the pref", () => {
	const { container, prefs } = pane();
	const toggle = card(container, "Assistants").querySelector('[data-backend="claude"] .zs-switch');
	toggle.click();
	assert.equal(prefs[PREFIX + "useClaudeUserSettings"], true);
	assert.equal(toggle.getAttribute("aria-checked"), "true");
});

const rowControl = (cardEl, label) => [...cardEl.querySelectorAll(".zs-row")]
	.find(r => r.querySelector(".zs-row-label").textContent === label);
const choose = (cardEl, label, option) => [...rowControl(cardEl, label).querySelectorAll(".zs-segmented button")]
	.find(b => b.textContent === option).click();

test("accent, style, message style, text size, corners, spacing and font are saved", () => {
	const { container, prefs } = pane();
	const appearance = card(container, "Appearance");
	appearance.querySelector('.zs-swatch[aria-label="Violet"]').click();
	choose(appearance, "Style", "Flat");
	choose(appearance, "Your messages", "Tinted");
	choose(appearance, "Text size", "Large");
	choose(appearance, "Corners", "Square");
	choose(appearance, "Spacing", "Compact");
	choose(appearance, "Font", "Serif");
	assert.deepEqual(JSON.parse(prefs[PREFIX + "appearance"]), {
		accent: "#6d4fd6", style: "flat", bubble: "accent", size: "large", corners: "square", density: "compact", font: "serif",
		background: "", imageVisibility: 55, imageBlur: 0, glassOpacity: 55, glassBlur: 18, glow: true, glowStrength: 60,
		mascot: "cat", pattern: "none", labels: "icons",
	});
	assert.equal(appearance.querySelector('.zs-swatch[aria-label="Violet"]').getAttribute("aria-checked"), "true");
	assert.equal(appearance.querySelector('.zs-swatch[aria-label="Zotero"]').getAttribute("aria-checked"), "false");
	appearance.querySelector('.zs-swatch[aria-label="Zotero"]').click();
	assert.equal(JSON.parse(prefs[PREFIX + "appearance"]).accent, "");
});

test("glass sliders and glow apply to the preview; glass rows hide for flat, image rows without an image", () => {
	const { container, prefs, window } = pane();
	const appearance = card(container, "Appearance");
	const root = container.querySelector(".zs-prefs");
	const slide = (label, value) => {
		const input = rowControl(appearance, label).querySelector('input[type="range"]');
		input.value = String(value);
		input.dispatchEvent(new window.Event("input"));
	};
	assert.equal(root.dataset.corners, "round", "glass defaults to round corners");
	slide("Glass opacity", 80);
	slide("Glass blur", 30);
	assert.equal(root.style.getPropertyValue("--zs-glass-pct"), "80%");
	assert.equal(root.style.getPropertyValue("--zs-blur"), "30px");
	assert.equal(rowControl(appearance, "Glass opacity").querySelector(".zs-range-value").textContent, "80%");
	rowControl(appearance, "Background glow").querySelector(".zs-switch").click();
	assert.equal(root.style.getPropertyValue("--zs-glow-strength"), "0%");
	assert.equal(rowControl(appearance, "Glow intensity").hidden, true);
	assert.equal(rowControl(appearance, "Image visibility").hidden, true);
	choose(appearance, "Style", "Flat");
	assert.equal(rowControl(appearance, "Glass opacity").hidden, true);
	assert.equal(root.dataset.corners, "rounded", "flat defaults to rounded corners");
	assert.equal(JSON.parse(prefs[PREFIX + "appearance"]).glassOpacity, 80);
});

test("a saved background image is applied with its veil and blur; bad values fall back", () => {
	const { plugin, document } = loadPlugin({ prefs: {
		[PREFIX + "appearance"]: JSON.stringify({ background: "background-1700000000000.png", imageVisibility: 70, imageBlur: 6, glassOpacity: 500, font: "comic" }),
	} });
	const root = document.createElement("div");
	root.innerHTML = '<div class="zs-backdrop"><div class="zs-backdrop-image"></div></div>';
	const image = root.querySelector(".zs-backdrop-image");
	plugin.applyAppearance(root);
	assert.equal(root.dataset.bg, "image");
	assert.match(image.style.backgroundImage, /background-1700000000000\.png/);
	assert.equal(root.style.getPropertyValue("--zs-bg-veil"), "30%");
	assert.equal(root.style.getPropertyValue("--zs-bg-blur"), "6px");
	assert.equal(root.style.getPropertyValue("--zs-glass-pct"), "95%");
	// Glow fades as the image is turned up: 60% intensity → 30%, times 1 − 0.7.
	assert.equal(root.style.getPropertyValue("--zs-glow-strength"), "9%");
	assert.equal(root.dataset.font, "zotero");
	plugin.applyAppearance(root, { ...plugin.getAppearance(), background: "" });
	assert.equal(root.dataset.bg, undefined);
	assert.equal(image.style.backgroundImage, "");
	assert.equal(plugin.getAppearance.call(Object.assign(Object.create(plugin), { getJSONPref: () => ({ background: "../../etc/passwd" }) })).background, "");
});

test("quick prompts can be added, edited, reordered and removed", () => {
	const { container, prefs, window } = pane();
	const chat = card(container, "Chat");
	const saved = () => JSON.parse(prefs[PREFIX + "prompts"]);
	[...chat.querySelectorAll("button")].find(b => b.textContent === "Add prompt").click();
	let rows = chat.querySelectorAll(".zs-prompt-row");
	assert.equal(rows.length, 5);
	const last = rows[4];
	last.querySelector("input").value = "Datasets";
	last.querySelector("input").dispatchEvent(new window.Event("input"));
	last.querySelector("textarea").value = "Which datasets are used?";
	last.querySelector("textarea").dispatchEvent(new window.Event("input"));
	assert.deepEqual(saved()[4], { label: "Datasets", prompt: "Which datasets are used?" });
	last.querySelector('[title="Move up"]').click();
	assert.equal(saved()[3].label, "Datasets");
	chat.querySelectorAll(".zs-prompt-row")[0].querySelector('[title="Remove"]').click();
	assert.deepEqual(saved().map(p => p.label), ["Key points", "Methodology", "Datasets", "Limitations"]);
});

test("explain-better request is editable and restorable", () => {
	const { container, prefs, plugin, window } = pane();
	const chat = card(container, "Chat");
	const text = [...chat.querySelectorAll("textarea")].pop();
	text.value = "Explain like I'm new to this.";
	text.dispatchEvent(new window.Event("input"));
	assert.equal(plugin.getExplainPrompt(), "Explain like I'm new to this.");
	[...chat.querySelectorAll("button")].find(b => b.textContent === "Restore default").click();
	assert.equal(prefs[PREFIX + "explainPrompt"], "");
	assert.equal(plugin.getExplainPrompt(), plugin.DEFAULT_EXPLAIN_PROMPT);
});

test("chat settings choose which mode buttons the message box shows", () => {
	const { container, prefs } = pane();
	const chat = card(container, "Chat");
	const drawingRow = rowControl(chat, "“Drawing” button");
	assert.equal(drawingRow.querySelector(".zs-switch").getAttribute("aria-checked"), "true");
	drawingRow.querySelector(".zs-switch").click();
	assert.deepEqual(JSON.parse(prefs[PREFIX + "modeButtons"]), { drawing: false, latex: true });
});

test("answer language: saved from Chat settings and used in every prompt", () => {
	const { container, prefs, window, plugin } = pane();
	const chat = card(container, "Chat");
	const select = rowControl(chat, "Answer language").querySelector("select");
	assert.equal(select.value, "");
	assert.match(plugin.systemPrompt(), /Reply in the language the user writes in\./);
	change(window, select, "Italiano");
	assert.equal(prefs[PREFIX + "language"], "Italiano");
	assert.match(plugin.systemPrompt(), /Always reply in Italiano, whatever language the user writes in\./);
	assert.match(plugin.formattingReminder(), /Reply in Italiano\.\)$/);
	assert.match(plugin.buildAntigravityPrompt({ files: { metadata: "# T\n", annotations: "" }, question: "Why?", history: [], session: null }), /Always reply in Italiano/);
	prefs[PREFIX + "language"] = "Klingon";
	assert.equal(plugin.getLanguage(), "", "unknown values fall back to the question's language");
});

test("tiles: a visual radio group of icon cards", () => {
	const { plugin, document } = pane();
	let picked = null;
	const tiles = plugin.tiles(document, [
		{ value: "cat", icon: "mascot-cat", label: "Cat" },
		{ value: "owl", icon: "mascot-owl", label: "Owl" },
	], "cat", v => (picked = v));
	assert.equal(tiles.getAttribute("role"), "radiogroup");
	const [cat, owl] = tiles.querySelectorAll(".zs-tile");
	assert.equal(cat.getAttribute("aria-checked"), "true");
	assert.equal(owl.title, "Owl");
	assert.ok(owl.querySelector(".zs-i[data-icon='mascot-owl']"));
	owl.click();
	assert.equal(picked, "owl");
	assert.equal(owl.getAttribute("aria-checked"), "true");
	assert.equal(cat.getAttribute("aria-checked"), "false");
});

test("appearance: buddy, pattern and labels are chosen visually and saved", () => {
	const { container, prefs } = pane();
	const appearance = card(container, "Appearance");
	const tile = (label, title) => [...rowControl(appearance, label).querySelectorAll(".zs-tile")].find(t => t.title === title);
	tile("Buddy", "Owl").click();
	tile("Pattern", "Maths").click();
	choose(appearance, "Button labels", "Icons + text");
	const saved = JSON.parse(prefs[PREFIX + "appearance"]);
	assert.equal(saved.mascot, "owl");
	assert.equal(saved.pattern, "math");
	assert.equal(saved.labels, "text");
});

test("behaviour: defaults, validation and the instructions sent to the assistant", () => {
	const { plugin, prefs } = pane();
	assert.deepEqual({ ...plugin.getBehaviour() }, {
		length: "balanced", level: "student", tone: "neutral", custom: "",
		sendKey: "enter", autoScroll: true, showSteps: true, showQuick: true,
	});
	prefs[PREFIX + "behaviour"] = JSON.stringify({ length: "short", level: "expert", tone: "friendly", custom: "Use SI units.", sendKey: "mod-enter", autoScroll: false, level2: 1, tone2: "x" });
	const b = plugin.getBehaviour();
	assert.equal(b.length, "short");
	assert.equal(b.sendKey, "mod-enter");
	assert.equal(b.autoScroll, false);
	const text = plugin.behaviourInstructions();
	assert.match(text, /Keep answers short/);
	assert.match(text, /expert/);
	assert.match(text, /warm, encouraging/);
	assert.match(text, /User's own instructions: Use SI units\./);
	assert.match(plugin.systemPrompt(), /Keep answers short/);
	assert.match(plugin.buildAntigravityPrompt({ files: { metadata: "# T\n", annotations: "" }, question: "Q", history: [], session: null }), /Use SI units/);
	prefs[PREFIX + "behaviour"] = JSON.stringify({ length: "epic", custom: "x".repeat(5000) });
	assert.equal(plugin.getBehaviour().length, "balanced");
	assert.equal(plugin.getBehaviour().custom.length, 2000);
});

test("behaviour card: tiles, switches and custom instructions are saved", () => {
	const { container, prefs, window } = pane();
	const behaviour = card(container, "Behaviour");
	assert.ok(behaviour, "Behaviour card exists");
	const tile = (label, title) => [...rowControl(behaviour, label).querySelectorAll(".zs-tile")].find(t => t.title === title);
	tile("Answer length", "Detailed").click();
	tile("Level", "Beginner").click();
	tile("Tone", "Formal").click();
	choose(behaviour, "Send with", "⌘/Ctrl + Enter");
	rowControl(behaviour, "Follow the answer").querySelector(".zs-switch").click();
	rowControl(behaviour, "Thinking steps").querySelector(".zs-switch").click();
	rowControl(behaviour, "Quick prompts").querySelector(".zs-switch").click();
	const custom = rowControl(behaviour, "Your instructions").querySelector("textarea");
	custom.value = "Always cite the page.";
	custom.dispatchEvent(new window.Event("input"));
	assert.deepEqual(JSON.parse(prefs[PREFIX + "behaviour"]), {
		length: "detailed", level: "beginner", tone: "formal", custom: "Always cite the page.",
		sendKey: "mod-enter", autoScroll: false, showSteps: false, showQuick: false,
	});
});

test("settings can start the setup wizard again", () => {
	const { container, prefs } = pane({ [PREFIX + "onboarded"]: true });
	const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Run setup again");
	assert.ok(button);
	button.click();
	assert.equal(prefs[PREFIX + "onboarded"], false);
});

test("clarifications file: records are appended to clarifications.json in the paper folder", async () => {
	const { plugin, window } = pane();
	const files = {};
	window.Zotero.File = {
		getContentsAsync: async path => files[path],
		putContentsAsync: async (path, text) => { files[path] = text; },
	};
	window.OS = { Path: { join: (...p) => p.join("/") }, File: { exists: async path => path in files } };
	assert.deepEqual([...await plugin.loadClarifications("/d")], []);
	await plugin.appendClarification("/d", { id: "a", passage: "one" });
	await plugin.appendClarification("/d", { id: "b", passage: "two" });
	assert.deepEqual(JSON.parse(files["/d/clarifications.json"]).map(r => r.id), ["a", "b"]);
	files["/d/clarifications.json"] = "{broken";
	assert.deepEqual([...await plugin.loadClarifications("/d")], [], "a damaged file does not break the panel");
});
