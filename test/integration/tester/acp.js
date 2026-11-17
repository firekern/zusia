// The ACP agents in a real Zotero. Every run where Zotero finds node drives a stub agent,
// ../assets/acp-stub.mjs, through the dock, so Zotero's own Subprocess, file reads and
// process kill are exercised with no model. ACP=1 adds the real Command Code and OpenCode,
// which need their logins and a paid model. bootstrap.js loads this file into its own
// scope, so check(), waitFor(), snapshot(), showInDock() and the results are shared.

var { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
var GREEN_PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfUlEQVR4nNXOQREAMAjAsK7+hSFrInhwjYI8hjSJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkzivA1sf848BSJ0/9OcAAAAASUVORK5CYII=";

async function testAcp(win, CS, realBackgroundCall) {
	let live = Zotero.Prefs.get("extensions.zusia-tester.acp", true);
	if (!live) {
		// run.sh empties the list: Settings would otherwise start the shipped Command Code,
		// under your login, to list its models.
		check("ACP: the default run has no agent configured, and none was started to list its models",
			CS.acpAgents().length === 0 && Object.keys(CS._acpModels).length === 0,
			{ agents: CS.acpAgents().map(a => a.name), listed: Object.keys(CS._acpModels) });
	}
	await testStubAcpAgent(win, CS);
	if (live) {
		await testPreconfiguredAcpAgent(win, CS);
		await testConfiguredAcpAgent(win, CS, realBackgroundCall);
	}
}

// The stub added as a user adds an agent, then chosen in the menus, asked twice, stopped
// and removed in Settings. It reads the secret word from the paper folder and tries a
// folder beside it, and records what it got, which the checks read back.
async function testStubAcpAgent(win, CS) {
	let node = await Subprocess.pathSearch(Zotero.isWin ? "node.exe" : "node", CS.buildChildEnvironment()).catch(() => null);
	if (!node) {
		// Zotero's Flatpak and the Windows container have no node.
		let reason = "node is not on the PATH Zotero sees";
		results.checks.push({ name: "ACP stub: an agent answers through the sidebar", ok: true, detail: null, skipped: reason });
		Zotero.debug("[zs-tester] SKIP ACP stub: " + reason);
		return;
	}
	let paper = new Zotero.Item("journalArticle");
	paper.setField("title", "ACP stub paper");
	paper.setField("abstractNote", "The secret word of this paper is OSPREY.");
	await paper.saveTx();
	let recordPath = PathUtils.join(outDir, "acp-stub.jsonl");
	let recorded = async () => (await IOUtils.readUTF8(recordPath)).trim().split("\n").map(line => JSON.parse(line));
	let added = CS.addAcpAgent({ name: "Stub Agent", command: node,
		args: [PathUtils.join(repo, "test", "integration", "assets", "acp-stub.mjs"), recordPath] });
	let key = added.key;
	check("ACP stub: added the way Settings adds an agent, it becomes a backend", key === "acp:stub-agent" && !!CS.BACKENDS[key], added);

	let root = await showInDock(win, CS, paper);
	let view = CS._views.get(root);
	let dir = view.ctx.dir;
	let decoy = dir + "-other";
	await IOUtils.makeDirectory(decoy, { createAncestors: true });
	await IOUtils.writeUTF8(PathUtils.join(decoy, "metadata.md"), "The secret word of this paper is DECOY.");
	let menuItem = label => [...root.querySelectorAll(".zs-menu .zs-menu-item")].find(i => i.querySelector(".zs-menu-label")?.textContent === label);

	root.querySelector(".zs-model-btn").click();
	let menu = await waitFor(() => root.querySelector(".zs-menu"), 5000, "model menu");
	[...menu.querySelectorAll(".zs-menu-section")].find(s => s.textContent.includes("Stub Agent")).click();
	let listed = await waitFor(() => {
		let section = [...root.querySelectorAll(".zs-menu .zs-menu-section")].find(s => s.textContent.includes("Stub Agent"));
		let labels = [];
		for (let el = section.nextElementSibling; el && !el.classList.contains("zs-menu-section"); el = el.nextElementSibling) {
			if (el.classList.contains("zs-menu-item")) {
				labels.push(el.querySelector(".zs-menu-label").textContent);
			}
		}
		return labels.includes("Stub Deep") && labels;
	}, 15000, "the stub's models in the menu").catch(() => null);
	check("ACP stub: the model menu lists the models the agent offers", !!listed && listed.includes("Stub Fast"), listed);
	menuItem("Stub Deep").click();
	root.querySelector(".zs-effort-btn").click();
	await waitFor(() => root.querySelector(".zs-menu .zs-menu-section")?.textContent.includes("Stub Agent"), 5000, "the stub's effort menu");
	menuItem("Low").click();
	check("ACP stub: the composer shows the agent and the model and effort chosen in its menus",
		CS.getBackend() === key && root.querySelector(".zs-model-btn").textContent.includes("Stub Deep") && CS.getEffort(key) === "low",
		[CS.getBackend(), root.querySelector(".zs-model-btn").textContent, CS.getEffort(key)]);
	check("ACP stub: with its Background memory switch off, the agent runs no memory jobs", CS.jobBackend() === null, CS.jobBackend());

	let send = (text) => {
		view.input.value = text;
		view.input.dispatchEvent(new win.Event("input", { bubbles: true }));
		root.querySelector(".zs-send").click();
	};
	let answered = turns => waitFor(async () => {
		if (CS._pending.has(dir)) return null;
		let history = await CS.loadHistory(dir);
		return history.length >= turns ? history : null;
	}, 30000, "the stub's answer").catch(() => []);
	send("What is the secret word in metadata.md?");
	let answer = (await answered(2))[1] || {};
	let first = (await recorded()).filter(e => e.method === "session/prompt")[0] || {};
	check("ACP stub: the answer arrives with the word the agent read in the paper folder",
		/OSPREY/.test(answer.text || "") && answer.backend === key && answer.model === "stub-deep" && answer.effort === "low",
		{ text: answer.text, backend: answer.backend, model: answer.model, effort: answer.effort, error: root.querySelector(".zs-error")?.textContent });
	check("ACP stub: the model and the thinking level chosen reach the agent",
		first.model === "stub-deep" && first.thinking === "low", { model: first.model, thinking: first.thinking });
	check("ACP stub: Zusia allows a read in the paper folder once and rejects one beside it",
		first.permissions?.inside?.optionId === "allow-once" && first.permissions?.outside?.optionId === "reject-once", first.permissions);
	check("ACP stub: Zotero reads the paper folder's file for the agent and refuses the one beside it",
		/OSPREY/.test(first.reads?.inside?.result?.content || "") && first.reads?.outside?.error?.code === -32001 && !/DECOY/.test(answer.text || ""),
		first.reads);
	check("ACP stub: the agent's thought and its read show as the answer's activity",
		(answer.activity?.steps || []).some(s => s.kind === "read" && s.label === "Read metadata.md") && answer.activity.thoughtMs > 0,
		answer.activity);

	send("Which word did you find?");
	let follow = (await answered(4))[3] || {};
	let entries = await recorded();
	let second = entries.filter(e => e.method === "session/prompt")[1] || {};
	let load = entries.find(e => e.method === "session/load") || {};
	check("ACP stub: the follow-up resumes the session over session/load, with the question alone and without the turns it replays",
		/OSPREY/.test(follow.text || "") && !/REPLAYED/.test(follow.text || "") && load.known && load.sessionId === first.sessionId &&
			second.loaded && second.sessionId === first.sessionId && second.chars < first.chars &&
			CS._logLines.some(l => l.includes("acp: session " + first.sessionId + " resumed")),
		{ text: follow.text, load, first: [first.sessionId, first.chars], second: [second.sessionId, second.loaded, second.chars] });

	// The stub holds this turn open after its first words, so only a kill ends it.
	send("STUB-HOLD: keep writing until I press Stop.");
	let running = await waitFor(() => {
		let pending = CS._pending.get(dir);
		return pending && pending.proc && pending.partial ? pending : null;
	}, 20000, "the stub's held answer");
	root.querySelector(".zs-send").click();
	await waitFor(() => !CS._pending.has(dir), 10000, "Stop to end the run");
	let exit = await Promise.race([running.proc.wait(), Zotero.Promise.delay(5000).then(() => null)]);
	let stopped = (await CS.loadHistory(dir))[5] || {};
	check("ACP stub: Stop ends the agent's process and keeps what it had written",
		!!exit && stopped.stopped === true && /Still working/.test(stopped.text || ""),
		{ exitCode: exit && exit.exitCode, stopped: stopped.stopped, text: stopped.text });
	await Zotero.Promise.delay(300);
	let dockRect = win.document.getElementById("zusia-dock").getBoundingClientRect();
	await snapshot(win, "zotero-acp-stub", { x: dockRect.x, y: dockRect.y, width: dockRect.width + 4, height: dockRect.height });

	let prefsWin = Zotero.Utilities.Internal.openPreferences(CS.PREFS_PANE_ID);
	await waitFor(() => prefsWin.document && prefsWin.document.readyState === "complete", 20000, "settings window");
	let prefs = await waitFor(() => prefsWin.document.querySelector(".zs-prefs"), 20000, "settings pane content");
	let card = await waitFor(() => prefs.querySelector('.zs-acp-list .zs-agent[data-backend="' + key + '"]'), 10000, "the stub's card");
	card.open = true;
	let status = card.querySelector(".zs-agent-status");
	await waitFor(() => status.textContent !== "Checking…", 10000, "the stub's command looked up").catch(() => null);
	check("ACP stub: Settings shows its card, with its command and the node it runs on",
		card.querySelector(".zs-acp-command").textContent.includes("acp-stub.mjs") && status.textContent === node,
		{ command: card.querySelector(".zs-acp-command").textContent, status: status.textContent });
	let background = card.querySelector(".zs-switch");
	background.click();
	let allowed = CS.jobBackend();
	background.click();
	check("ACP stub: its Background memory switch lets it run the memory jobs, and takes that back",
		allowed === key && CS.jobBackend() === null, { on: allowed, off: CS.jobBackend() });
	card.querySelector(".zs-acp-remove").click();
	// Only the stub's own entry: under ACP=1 the shipped agents stay configured.
	check("ACP stub: Remove takes away the agent, its backend, its model list and its card, and puts Claude back in use",
		!CS.BACKENDS[key] && !CS.acpAgents().some(a => CS.acpAgentKey(a.id) === key) && !(key in CS._acpModels) &&
			CS.getBackend() === "claude" && !prefs.querySelector('.zs-acp-list .zs-agent[data-backend="' + key + '"]'),
		{ agents: CS.acpAgents().map(a => a.id), backend: CS.getBackend(), listed: Object.keys(CS._acpModels) });
	prefsWin.close();

	root.querySelector(".zs-model-btn").click();
	menu = await waitFor(() => root.querySelector(".zs-menu"), 5000, "model menu");
	let sections = [...menu.querySelectorAll(".zs-menu-section")].map(s => s.textContent);
	check("ACP stub: once removed, the model menu no longer offers it", !sections.some(s => s.includes("Stub Agent")), sections);
	CS.closeMenu(root);
	await IOUtils.remove(decoy, { recursive: true });
}

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
