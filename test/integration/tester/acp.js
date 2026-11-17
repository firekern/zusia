// The opt-in ACP agents (ACP=1): the real Command Code and OpenCode, signed in, from inside
// the throwaway Zotero. bootstrap.js loads this file into its own scope, so check(),
// waitFor(), snapshot() and the results are shared.

var GREEN_PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfUlEQVR4nNXOQREAMAjAsK7+hSFrInhwjYI8hjSJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkzivA1sf848BSJ0/9OcAAAAASUVORK5CYII=";

async function testPreconfiguredAcpAgent(win, CS) {
	let item = new Zotero.Item("journalArticle");
	item.setField("title", "ACP test paper");
	item.setField("abstractNote", "The secret word of this paper is PELICAN.");
	await item.saveTx();
	let itemPane = win.ZoteroPane.itemPane;
	itemPane.data = [item];
	await itemPane.renderItemPane(item);
	let root = await waitFor(() => {
		let r = [...win.document.querySelectorAll(".zs-root")].find(el => el.isConnected);
		return r && CS._views.get(r) && CS._views.get(r).ctx.paperItem.id === item.id && r;
	}, 30000, "ACP sidebar");
	let view = CS._views.get(root);
	CS.setPref("backend", "acp:commandcode");
	CS.setPref("acp:commandcode.model", "deepseek/deepseek-v4.1-flash");
	CS.setPref("acp:commandcode.effort", "low");

	let ask = async (text) => {
		view.input.value = text;
		view.input.dispatchEvent(new win.Event("input", { bubbles: true }));
		root.querySelector(".zs-send").click();
	};
	await ask("What is the secret word in metadata.md? Reply with only that word.");
	let history = await waitFor(async () => {
		if (CS._pending.has(view.ctx.dir)) return null;
		return CS.loadHistory(view.ctx.dir);
	}, 240000, "ACP answer");
	let answer = history[history.length - 1] || {};
	check("ACP: a real answer arrives through the sidebar",
		/pelican/i.test(answer.text || "") && answer.backend === "acp:commandcode" &&
		answer.model === "deepseek/deepseek-v4.1-flash" && answer.effort === "low",
		{ text: (answer.text || "").slice(0, 120), backend: answer.backend, model: answer.model, effort: answer.effort,
			error: root.querySelector(".zs-error")?.textContent });

	await ask("Which word did you just find? Reply with only that word.");
	let second = await waitFor(async () => {
		if (CS._pending.has(view.ctx.dir)) return null;
		let h = await CS.loadHistory(view.ctx.dir);
		return h.length >= 4 ? h : null;
	}, 240000, "ACP follow-up");
	let follow = second[second.length - 1] || {};
	let debugLog = await IOUtils.readUTF8(CS.getLogPath()).catch(() => "");
	check("ACP: the conversation resumes over session/load",
		/pelican/i.test(follow.text || "") && /acp: session \S+ resumed/.test(debugLog),
		{ text: (follow.text || "").slice(0, 120), error: root.querySelector(".zs-error")?.textContent, resumed: /resumed/.test(debugLog) });

	let imagePath = PathUtils.join(view.ctx.dir, "attachments", "green.png");
	await IOUtils.makeDirectory(PathUtils.join(view.ctx.dir, "attachments"), { createAncestors: true });
	await IOUtils.write(imagePath, Uint8Array.from(win.atob(GREEN_PNG), c => c.charCodeAt(0)));
	CS.startRequest(view, "What colour is this image? Reply with one word.", [imagePath]);
	let third = await waitFor(async () => {
		if (CS._pending.has(view.ctx.dir)) return null;
		let h = await CS.loadHistory(view.ctx.dir);
		return h.length >= 6 ? h : null;
	}, 240000, "ACP image answer");
	let imageAnswer = third[third.length - 1] || {};
	check("ACP: an attached image reaches the agent", /green/i.test(imageAnswer.text || ""),
		{ text: (imageAnswer.text || "").slice(0, 120), error: root.querySelector(".zs-error")?.textContent });

	await waitFor(() => root.querySelector(".zs-turn.zs-last .zs-msg"), 5000, "the last answer").catch(() => null);
	// The thumbnail reads its bytes after the turn is built, and this shot is the evidence it did.
	await waitFor(() => {
		let img = [...root.querySelectorAll(".zs-user .zs-thumb img")].pop();
		return img && img.complete && img.naturalWidth > 0;
	}, 5000, "the attached image on screen");
	let rect = root.getBoundingClientRect();
	await snapshot(win, "zotero-acp", { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
}

async function testConfiguredAcpAgent(win, CS, realBackgroundCall) {
	let added = CS.addAcpAgent({ name: "OpenCode", command: "opencode", args: ["acp"] });
	check("acp agents: an agent added in Settings becomes a backend",
		!!added && !added.error && added.key === "acp:opencode", { added });
	if (!added || added.error) {
		return;
	}

	let item = new Zotero.Item("journalArticle");
	item.setField("title", "OpenCode test paper");
	item.setField("abstractNote", "The secret word of this paper is PELICAN.");
	await item.saveTx();
	let itemPane = win.ZoteroPane.itemPane;
	itemPane.data = [item];
	await itemPane.renderItemPane(item);
	let root = await waitFor(() => {
		let r = [...win.document.querySelectorAll(".zs-root")].find(el => el.isConnected);
		return r && CS._views.get(r) && CS._views.get(r).ctx.paperItem.id === item.id && r;
	}, 30000, "configured ACP sidebar");
	let view = CS._views.get(root);
	CS.setPref("backend", "acp:opencode");
	CS.setPref("acp:opencode.model", "");
	CS.setPref("acp:opencode.effort", "low");

	root.querySelector(".zs-model-btn").click();
	let menu = await waitFor(() => root.querySelector(".zs-menu"), 5000, "model menu");
	let opencodeItems = await waitFor(() => {
		let section = [...menu.querySelectorAll(".zs-menu-section")].find(s => s.textContent === "OpenCode");
		if (!section) {
			return null;
		}
		let items = [];
		for (let node = section.nextElementSibling; node && !node.classList.contains("zs-menu-section"); node = node.nextElementSibling) {
			if (node.classList.contains("zs-menu-item")) {
				items.push(node);
			}
		}
		return items.length > 1 ? items : null;
	}, 15000, "OpenCode models").catch(() => null);
	check("acp agents: the picker lists the agent's models before the first answer",
		!!opencodeItems, { items: opencodeItems ? opencodeItems.slice(0, 4).map(i => i.textContent.slice(0, 48)) : [] });
	let opencodeSection = [...menu.querySelectorAll(".zs-menu-section")].find(s => s.textContent === "OpenCode");
	opencodeSection?.scrollIntoView({ block: "start" });
	await Zotero.Promise.delay(400);
	let menuRect = menu.getBoundingClientRect();
	let menuTop = Math.max(0, menuRect.y);
	await snapshot(win, "zotero-acp-model-picker", {
		x: menuRect.x, y: menuTop, width: menuRect.width,
		height: Math.min(menuRect.height, win.innerHeight - menuTop),
	});
	root.querySelector(".zs-model-btn").click();

	view.input.value = "Reply with exactly: pong";
	view.input.dispatchEvent(new win.Event("input", { bubbles: true }));
	root.querySelector(".zs-send").click();
	let history = await waitFor(async () => {
		if (CS._pending.has(view.ctx.dir)) return null;
		return CS.loadHistory(view.ctx.dir);
	}, 240000, "configured ACP answer");
	let answer = history[history.length - 1] || {};
	check("acp agents: the added agent answers through the sidebar",
		/pong/i.test(answer.text || "") && answer.backend === "acp:opencode",
		{ text: (answer.text || "").slice(0, 120), backend: answer.backend,
			error: root.querySelector(".zs-error")?.textContent });

	let background = await realBackgroundCall.call(CS, "acp:opencode", "Reply with exactly: pong");
	check("acp agents: the added agent runs a background memory call",
		/pong/i.test(background.text || ""), { text: background.text, error: background.error });

	await waitFor(() => root.querySelector(".zs-turn.zs-last .zs-msg"), 5000, "the last answer").catch(() => null);
	let rect = root.getBoundingClientRect();
	await snapshot(win, "zotero-acp-agent", { x: rect.x, y: rect.y, width: rect.width, height: rect.height });

	let prefsWin = Zotero.Utilities.Internal.openPreferences(CS.PREFS_PANE_ID);
	await waitFor(() => prefsWin.document && prefsWin.document.readyState === "complete", 20000, "settings window");
	let prefs = await waitFor(() => prefsWin.document.querySelector(".zs-prefs"), 20000, "settings pane content");
	prefsWin.resizeTo(1000, 1500);
	let agent = await waitFor(() =>
		prefs.querySelector('.zs-acp-list .zs-agent[data-backend="acp:opencode"]'), 10000, "the added agent in Settings");
	check("acp agents: Settings lists the added agent and its ACP command",
		/openCode/i.test(agent.textContent) && /opencode\s+acp/.test(agent.textContent),
		{ text: agent.textContent.slice(0, 160) });
	let commandCode = prefs.querySelector('.zs-acp-list .zs-agent[data-backend="acp:commandcode"]');
	if (commandCode) {
		commandCode.open = true;
	}
	check("acp agents: every ACP card offers Sign in and Remove",
		[...prefs.querySelectorAll(".zs-acp-list .zs-agent")].every(card =>
			!!card.querySelector(".zs-acp-signin") && !!card.querySelector(".zs-acp-remove")),
		[...prefs.querySelectorAll(".zs-acp-list .zs-agent")].map(card => ({
			backend: card.dataset.backend,
			signIn: !!card.querySelector(".zs-acp-signin"),
			remove: !!card.querySelector(".zs-acp-remove"),
		})));
	agent.open = true;
	prefs.querySelector(".zs-acp-section").scrollIntoView({ block: "start" });
	await Zotero.Promise.delay(500);
	await snapshot(prefsWin, "zotero-acp-agents");
	prefsWin.close();
}
