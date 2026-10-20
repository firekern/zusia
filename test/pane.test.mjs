import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const PREFIX = "extensions.zusia.";
const PANE = "zusia-firekern-github-io-zusia-section";

// Zotero's item pane, reduced to the elements the chat view relies on: the side nav,
// item-details with its title bar and sections, and Zusia's section body.
function itemPane(prefs = {}) {
	const env = loadPlugin({ prefs: { [PREFIX + "onboarded"]: true, ...prefs } });
	const { window, document, plugin } = env;
	document.body.innerHTML = `
		<item-pane-sidenav>
			<div class="btn" data-pane="info"></div>
			<div class="btn" data-pane="${PANE}"></div>
			<div class="btn" data-pane="context-notes"></div>
		</item-pane-sidenav>
		<item-details>
			<item-pane-header></item-pane-header>
			<div class="zotero-view-item">
				<info-box data-pane="info"></info-box>
				<item-pane-custom-section data-pane="${PANE}">
					<collapsible-section><div data-type="body"></div></collapsible-section>
				</item-pane-custom-section>
			</div>
		</item-details>`;
	window.MozXULElement = { insertFTLIfNeeded() {} };
	let section;
	window.Zotero.ItemPaneManager = {
		registerSection: (options) => {
			section = options;
			return PANE;
		},
	};
	plugin.stylesheetURL = "zusia.css";
	plugin.addToWindow(window);
	plugin.registerPaneSection();
	const body = document.querySelector('[data-type="body"]');
	section.onInit({ body, doc: document });
	const paper = { isRegularItem: () => true, isFileAttachment: () => false };
	section.onItemChange({ body, item: paper, setEnabled() {} });
	plugin.renderSkeleton(document, body);
	const click = pane => document.querySelector(`item-pane-sidenav [data-pane="${pane}"]`)
		.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
	const view = () => document.documentElement.getAttribute("data-zs-view");
	return { ...env, section, body, click, view, root: body.querySelector(".zs-root") };
}

test("chat view: Zusia's side-nav icon fills the pane, any other icon brings the item details back", () => {
	const { click, view, prefs } = itemPane();
	assert.equal(view(), "details");
	click(PANE);
	assert.equal(view(), "chat");
	assert.equal(prefs[PREFIX + "paneView"], "chat");
	click("context-notes");
	assert.equal(view(), "chat", "the reader's notes pane is a different deck and leaves the view alone");
	click("info");
	assert.equal(view(), "details");
	assert.equal(prefs[PREFIX + "paneView"], "details");
});

test("chat view: the section is tagged for the CSS and opened, and only items Zusia can chat about qualify", () => {
	const { document, section, body, click } = itemPane();
	const custom = document.querySelector("item-pane-custom-section");
	assert.ok(custom.classList.contains("zs-pane"));
	assert.ok(document.querySelector("item-details").hasAttribute("zs-chat-ready"));
	custom.open = false;
	click(PANE);
	assert.equal(custom.open, true);
	// A note has no Zusia section: the item pane must stay as Zotero draws it.
	let enabled;
	section.onItemChange({ body, item: { isRegularItem: () => false, isFileAttachment: () => false }, setEnabled: (v) => { enabled = v; } });
	assert.equal(enabled, false);
	assert.ok(!document.querySelector("item-details").hasAttribute("zs-chat-ready"));
});

test("chat view: the header names the paper and has a visible way in and out", () => {
	const { root, view, plugin } = itemPane();
	const toChat = root.querySelector(".zs-view-chat");
	const toDetails = root.querySelector(".zs-view-details");
	assert.ok(toChat.title && toDetails.title);
	toChat.click();
	assert.equal(view(), "chat");
	toDetails.click();
	assert.equal(view(), "details");
	plugin.renderPaperTitle(root, { title: "Attention Is All You Need", label: "Vaswani et al., 2017" });
	const paper = root.querySelector(".zs-header-paper");
	assert.equal(paper.textContent, "Attention Is All You Need");
	assert.equal(paper.title, "Attention Is All You Need");
	plugin.renderPaperTitle(root, null);
	assert.equal(paper.textContent, "");
});

test("chat view: the remembered view comes back with the window and leaves with the plugin", () => {
	const { window, document, click, view, plugin } = itemPane({ [PREFIX + "paneView"]: "chat" });
	assert.equal(view(), "chat");
	plugin.removeFromWindow(window);
	assert.equal(document.documentElement.hasAttribute("data-zs-view"), false);
	click(PANE);
	assert.equal(view(), null, "the side-nav listener is removed with the window's styles");
});
