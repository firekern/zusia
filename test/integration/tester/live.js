// The opt-in run of Claude Code itself (LIVE=1), signed in, from inside the throwaway Zotero.
// bootstrap.js loads this file into its own scope, so check(), waitFor(), snapshot() and the
// results are shared.

async function testLive(win, CS) {
	let item = new Zotero.Item("journalArticle");
	item.setField("title", "Live test paper");
	item.setField("abstractNote", "The secret word of this paper is PELICAN.");
	await item.saveTx();
	let itemPane = win.ZoteroPane.itemPane;
	itemPane.data = [item];
	await itemPane.renderItemPane(item);
	let root = await waitFor(() => {
		let r = [...win.document.querySelectorAll(".zs-root")].find(el => el.isConnected);
		return r && CS._views.get(r) && CS._views.get(r).ctx.paperItem.id === item.id && r;
	}, 30000, "live sidebar");
	let view = CS._views.get(root);
	CS.setPref("backend", "claude");
	CS.setPref("claude.model", "haiku");
	CS.setPref("claude.effort", "low");

	let type = (text) => {
		view.input.value = text;
		view.input.dispatchEvent(new win.Event("input", { bubbles: true }));
	};
	type("What is the secret word in metadata.md? Reply with only that word.");
	check("live: Send is enabled once text is typed", !root.querySelector(".zs-send").disabled);
	root.querySelector(".zs-send").click();
	check("live: Send turns into Stop while running", root.querySelector(".zs-send").classList.contains("zs-stop"));
	let history = await waitFor(async () => {
		if (CS._pending.has(view.ctx.dir)) return null;
		return CS.loadHistory(view.ctx.dir);
	}, 180000, "live answer");
	let answer = history[history.length - 1] || {};
	check("live: Claude answers through the sidebar with the chosen model and effort",
		/pelican/i.test(answer.text || "") && answer.model === "haiku" && answer.effort === "low",
		{ text: (answer.text || "").slice(0, 80), model: answer.model, effort: answer.effort,
			error: root.querySelector(".zs-error")?.textContent });
	let steps = (answer.activity && answer.activity.steps) || [];
	check("live: Claude's file reads are recorded as activity", steps.some(st => st.kind === "read"),
		{ steps: steps.map(st => st.label), thoughtMs: answer.activity && answer.activity.thoughtMs });
	await waitFor(() => root.querySelector(".zs-turn.zs-last .zs-activity"), 5000, "activity line").catch(() => null);
	check("live: activity line shows above the answer", !!root.querySelector(".zs-turn.zs-last .zs-activity"),
		root.querySelector(".zs-turn.zs-last .zs-activity-summary")?.textContent);
	let logText = await IOUtils.readUTF8(CS.getLogPath()).catch(() => "");
	check("live: CLI was called with --model haiku --effort low", /'--model' 'haiku'.*'--effort' 'low'/.test(logText));

	type("List the secret word 400 times, numbered 1 to 400, one per line, no other text.");
	root.querySelector(".zs-send").click();
	check("live: second run started", CS._pending.has(view.ctx.dir));
	// Stop only once the answer is visibly streaming.
	let streaming = await waitFor(() => {
		let p = CS._pending.get(view.ctx.dir);
		return p && p.partial.length > 60 ? p : null;
	}, 90000, "streamed text").catch(() => null);
	check("live: answer streams into the sidebar before it finishes", !!streaming);
	check("live: streamed text is rendered live", !!root.querySelector(".zs-live-content")?.textContent.trim());
	let started = Date.now();
	root.querySelector(".zs-send").click();
	await waitFor(() => !CS._pending.has(view.ctx.dir), 20000, "stop to finish");
	check("live: Stop ends the run quickly", Date.now() - started < 15000, Date.now() - started);
	await Zotero.Promise.delay(500);
	check("live: stop shows no error", !root.querySelector(".zs-error"), root.querySelector(".zs-error")?.textContent);
	let afterStop = await CS.loadHistory(view.ctx.dir);
	let last = afterStop[afterStop.length - 1] || {};
	check("live: stopped run keeps the partial answer or returns the question",
		(last.stopped === true && last.text.length > 0) || view.input.value.includes("400 times"),
		{ stopped: last.stopped, chars: (last.text || "").length, input: view.input.value.slice(0, 40) });
	await snapshot(win, "zotero-live", (() => {
		let r = win.document.getElementById("zotero-item-pane").getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	})());
}
