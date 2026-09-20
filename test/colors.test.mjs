import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const { plugin } = loadPlugin();
// Zotero's item pane backgrounds and primary text colours (flattened alpha).
const THEMES = {
	light: { bg: "#ffffff", text: "#262626" },
	dark: { bg: "#1e1e1e", text: "#e6e6e6" },
};
const mix = (a, b, weightA) => "#" + [1, 3, 5].map((i) => {
	const v = Math.round(parseInt(a.slice(i, i + 2), 16) * weightA + parseInt(b.slice(i, i + 2), 16) * (1 - weightA));
	return v.toString(16).padStart(2, "0");
}).join("");

for (const { name, color: preset } of plugin.ACCENTS) {
	const color = preset || plugin.ZOTERO_ACCENT;
	test(`accent ${name} ${color}: readable in both themes`, () => {
		// The accent fills only the send button, whose content is an icon: WCAG 1.4.11
		// asks 3:1 for graphical objects.
		const onAccent = plugin.contrast(color, plugin.textOn(color));
		assert.ok(onAccent >= 3, `send icon contrast ${onAccent.toFixed(2)} < 3`);
		for (const [theme, { bg, text }] of Object.entries(THEMES)) {
			// --zs-accent-ink: accent mixed 78% with the text colour (buttons, labels).
			const ink = mix(color, text, 0.78);
			const inkContrast = plugin.contrast(ink, bg);
			assert.ok(inkContrast >= 3, `${theme}: accent ink contrast ${inkContrast.toFixed(2)} < 3`);
			// The send button and focus ring are the raw accent on the pane background.
			const ui = plugin.contrast(color, bg);
			assert.ok(ui >= 1.8, `${theme}: accent vs background ${ui.toFixed(2)} too faint`);
		}
	});
}

test("Zusia's own red is offered as an accent", () => {
	assert.ok(plugin.ACCENTS.some(a => a.name === "Red" && /^#[0-9a-f]{6}$/i.test(a.color)));
});

test("custom colours always get the more readable text colour", () => {
	for (const color of ["#ffff00", "#000080", "#7f7f7f", "#ff00ff", "#00ffff"]) {
		const chosen = plugin.contrast(color, plugin.textOn(color));
		const other = plugin.contrast(color, plugin.textOn(color) === "#ffffff" ? "#1a1a1a" : "#ffffff");
		assert.ok(chosen >= other);
	}
});
