// Use-case scenes recorded in the demo Zotero.
//   node test/videos/zotero/scenes.mjs <name> <out.mp4> [--dry]
// Each scene sets the app up, then records real clicks, real typing and real answers.
import { writeFileSync } from "node:fs";
import { stage, sleep } from "./stage.mjs";

// The papers of the demo library (library.js) by their arXiv number. Their item ids
// depend on the order a library was filled in, so they are looked up before a scene.
const ARXIV = { attention: "1706.03762", resnet: "1512.03385", bert: "1810.04805", vit: "2010.11929", gpt3: "2005.14165", adam: "1412.6980" };
const PAPERS = {};
const LOOK = {
	style: "glass", accent: "#d42a3c", bubble: "accent", background: "background-1.jpg",
	imageVisibility: 32, imageBlur: 1, glassOpacity: 60, glassBlur: 14, glow: true, glowStrength: 40, mascot: "cat",
};
// Zusia's panel at the right edge of the window, and the one chat it holds.
const PANE = "#zusia-dock";
const PANEL_WIDTH = 520;
const ACTIVE = `${PANE} .zs-root`;
const LOG = `doc.querySelector('${ACTIVE} .zs-log')`;

// ---------------------------------------------------------------------------

async function setUp(s, { paper, page = 0, modes = {}, look = LOOK, onboarded = true, effort = "high" } = {}) {
	await s.run(`
		let CS = Zotero.Zusia;
		Zotero.Prefs.set("extensions.zusia.appearance", ${JSON.stringify(JSON.stringify(look))}, true);
		Zotero.Prefs.set("extensions.zusia.onboarded", ${onboarded}, true);
		// The notes for people who update would sit above the chat.
		Zotero.Prefs.set("extensions.zusia.dockTipSeen", true, true);
		Zotero.Prefs.set("extensions.zusia.sideTipSeen", true, true);
		Zotero.Prefs.set("extensions.zusia.backend", "claude", true);
		Zotero.Prefs.set("extensions.zusia.claude.model", "opus", true);
		Zotero.Prefs.set("extensions.zusia.claude.effort", ${JSON.stringify(effort)}, true);
		Zotero.Prefs.set("extensions.zusia.mode.drawing", ${!!modes.drawing}, true);
		Zotero.Prefs.set("extensions.zusia.behaviour", JSON.stringify({ length: "short", level: "student", tone: "neutral" }), true);
		Zotero.Prefs.set("extensions.zusia.mode.latex", ${!!modes.latex}, true);
		Services.wm.getMostRecentWindow("zotero:pref")?.close();
		for (let id of ["post-upgrade-container", "sync-reminder-container", "file-renaming-banner-container"]) {
			let banner = doc.getElementById(id);
			if (banner) banner.hidden = banner.collapsed = true;
		}
		win.resizeTo(1440, 900); win.moveTo(180, 130);
		// One paper on screen at a time.
		for (let tab of [...win.Zotero_Tabs._tabs].filter(t => t.type !== "library")) {
			win.Zotero_Tabs.close(tab.id);
		}
		await Zotero.Promise.delay(600);
		let pdf = Zotero.Items.get(${paper}).getAttachments()[0];
		let reader = await Zotero.Reader.open(pdf, { pageIndex: ${page} });
		await Zotero.Promise.delay(2000);
		reader._internalReader.navigate({ pageIndex: ${page} });
		// The PDF and Zusia's panel, without Zotero's own pane between them.
		if (!win.ZoteroContextPane.collapsed) win.ZoteroContextPane.togglePane();
		CS.setPlacement("right");
		CS.setDockWidth(${PANEL_WIDTH});
		CS.setDockOpen(true);
		let dir = CS.contextDirFor(Zotero.Items.get(${paper}));
		for (let i = 0; i < 60 && CS._views.get(doc.querySelector('${ACTIVE}'))?.ctx.dir !== dir; i++) await Zotero.Promise.delay(150);
		if (CS._views.get(doc.querySelector('${ACTIVE}'))?.ctx.dir !== dir) throw new Error("the panel does not show the paper");
		for (let input of doc.querySelectorAll(".zs-input")) input.value = "";
		await Zotero.Promise.delay(900);
		return true;`);
	await s.front();
	await s.moveTo({ x: 700, y: 620 }, { ms: 300 });
}

const dirOf = paper => `PathUtils.join(Zotero.Zusia.getDataDir(), "1-" + Zotero.Items.get(${paper}).key)`;

// Asks in the background (no camera time) so a scene can start from an existing answer.
async function askOffCamera(s, paper, question, { modes = [], selection = null } = {}) {
	await s.run(`
		let CS = Zotero.Zusia;
		let item = Zotero.Items.get(${paper});
		let ctx = await CS.getContext(item);
		let view = { doc, root: null, ctx, logEl: doc.createElement("div"), input: doc.createElement("textarea"), send() {} };
		let pending = { question: ${JSON.stringify(question)}, images: [], modes: ${JSON.stringify(modes)}, selection: ${JSON.stringify(selection)},
			backend: "claude", model: "opus", effort: "low", startedAt: Date.now(), partial: "", status: "", cancelled: false,
			listeners: new Set(), steps: [], thoughtMs: 0, progress(update) { if (update.text !== undefined) pending.partial = update.text; } };
		if (pending.selection) pending.selection.attachmentID = item.getAttachments()[0];
		let result = await CS.ask(ctx, pending.question, pending);
		return result.error || "ok";`);
}

async function waitForAnswer(s, mark) {
	let sawText = false;
	for (;;) {
		let state = await s.run(`let p = [...Zotero.Zusia._pending.values()][0];
			return p ? { partial: p.partial.length } : null`);
		if (!state) {
			break;
		}
		if (state.partial && !sawText) {
			sawText = true;
			s.mark("writing");
		}
		await sleep(250);
	}
	s.mark(mark || "answered");
	await sleep(1200);
}

// Scrolls the chat the way someone reads it.
async function readAnswer(s, { from = "question", stepPx = 300, pause = 1400 } = {}) {
	// from: "question" starts at the last question, anything else keeps the current scroll.
	let { top, max } = await s.run(`let log = ${LOG};
		let user = [...log.querySelectorAll(".zs-user")].pop();
		let offset = n => n.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop;
		if (${from === "question"}) log.scrollTop = Math.max(0, offset(user) - 8);
		return { top: log.scrollTop, max: log.scrollHeight - log.clientHeight };`);
	await s.moveTo(await s.rect(`${ACTIVE} .zs-log`), { ms: 500, dx: 170 });
	for (let y = top + stepPx; y < max + stepPx; y += stepPx) {
		await s.run(`let log = ${LOG}; let from = log.scrollTop, to = Math.min(${Math.round(y)}, ${max});
			let start = Date.now();
			while (Date.now() - start < 700) { let t = (Date.now() - start) / 700; log.scrollTop = from + (to - from) * (t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2); await new Promise(r => win.requestAnimationFrame(r)); }
			log.scrollTop = to;`);
		await sleep(pause);
	}
}

// Claude through its ACP adapter, as the official registry lists it: the agent runs with the
// Claude Code login already on the Mac. The ACP scenes add it from the registry the way a
// reader would, so they film the adapter's real models and its real permission requests.
const AGENT = "Claude Agent";
const PREFS_WIN = `Services.wm.getMostRecentWindow("zotero:pref")`;

// Off camera: the registry's entry for the agent, added if the demo profile lacks it, with
// its models listed, since a first listing downloads the adapter and can take seconds.
async function addAgent(s) {
	let result = await s.run(`let CS = Zotero.Zusia;
		let config = CS.acpAgents().find(c => c.name === ${JSON.stringify(AGENT)});
		let key = config && CS.acpAgentKey(config.id);
		if (!key) {
			let { presets } = await CS.fetchAcpRegistryPresets();
			let preset = presets.find(p => p.name === ${JSON.stringify(AGENT)} && p.source !== "binary");
			if (!preset) return { error: "the registry lists no npx build of ${AGENT}" };
			let added = CS.addAcpAgent({ name: preset.name, command: preset.command, args: preset.args.join("\\n") });
			if (added.error) return { error: added.error };
			key = added.key;
		}
		await CS.loadLiveModels(key);
		let entry = CS.acpModelEntry(key);
		if (entry.error) return { error: entry.error };
		return { key, models: CS.getModels(key).map(m => ({ id: m.id, label: m.label })) };`);
	if (result.error) {
		throw new Error(AGENT + " is not ready as an ACP agent: " + result.error);
	}
	return result;
}

// The adapter's Opus, at high effort: the strongest answer the demo can give.
function opusOf(agent) {
	let wanted = process.env.ZUSIA_AGENT_MODEL;
	// "opus" is the adapter's alias for the newest Opus; the dated ids below it are older ones.
	let model = agent.models.find(m => m.id === (wanted || "opus") || m.label === wanted);
	if (!model) {
		throw new Error("no Opus among " + AGENT + "'s models: " + agent.models.map(m => m.label).join(", "));
	}
	return model;
}

// On camera: open the model menu, unfold the agent's section, pick Opus, then High effort.
async function pickAgent(s, agent) {
	let model = opusOf(agent);
	await s.click(`${ACTIVE} .zs-model-btn`, { after: 900 });
	s.mark("model menu");
	// The menu opens on the assistant in use: after an earlier scene that is already the
	// agent, whose section a click would fold.
	let listed = await s.run(`return [...doc.querySelectorAll('${ACTIVE} .zs-menu .zs-menu-item')].some(i => i.textContent.includes(${JSON.stringify(model.label)}));`);
	if (!listed) {
		await s.clickText(AGENT, { after: 1100, scope: PANE });
	}
	s.mark("agent open");
	await s.clickText(model.label, { after: 1000, scope: PANE });
	await s.click(`${ACTIVE} .zs-effort-btn`, { after: 900 });
	await s.clickText("High", { after: 1000, scope: PANE });
	s.mark("agent picked");
}

// ---------------------------------------------------------------------------

const SCENES = {
	// Select a sentence in the PDF and let Zusia explain it.
	explain: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.resnet, page: 0 });
			await s.run(`await Zotero.Zusia.saveHistory(${dirOf(PAPERS.resnet)}, []); await Zotero.Zusia.saveSessions(${dirOf(PAPERS.resnet)}, {}); await IOUtils.remove(Zotero.Zusia.memoryPath(${dirOf(PAPERS.resnet)}), { ignoreAbsent: true });
				await Zotero.Zusia.saveClarifications(${dirOf(PAPERS.resnet)}, []);
				let view = Zotero.Zusia._views.get([...doc.querySelectorAll('${ACTIVE}')].find(r => r.getBoundingClientRect().width));
				Zotero.Zusia.renderMessages(view, []);`);
		},
		async run(s) {
			s.mark("start");
			await sleep(1200);
			await s.selectPhrase("Deeper neural networks are more difficult to train");
			s.mark("selected");
			await sleep(900);
			await s.clickText("Explain this", { after: 900 });
			s.mark("explain clicked");
			await waitForAnswer(s);
			await readAnswer(s);
			await sleep(2000);
		},
	},

	// Send the page you are looking at and ask about its figure.
	figure: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.vit, page: 2 });
			await s.run(`await Zotero.Zusia.saveHistory(${dirOf(PAPERS.vit)}, []); await Zotero.Zusia.saveSessions(${dirOf(PAPERS.vit)}, {}); await IOUtils.remove(Zotero.Zusia.memoryPath(${dirOf(PAPERS.vit)}), { ignoreAbsent: true });
				let view = Zotero.Zusia._views.get([...doc.querySelectorAll('${ACTIVE}')].find(r => r.getBoundingClientRect().width));
				Zotero.Zusia.renderMessages(view, []);`);
		},
		async run(s) {
			s.mark("start");
			await sleep(1000);
			await s.click(`${ACTIVE} .zs-attach`, { after: 800 });
			s.mark("attach menu");
			await s.clickText("Current PDF page", { after: 1400, scope: PANE });
			s.mark("page attached");
			await s.click(`${ACTIVE} .zs-input`, { after: 200 });
			await s.type("what does Figure 1 show? Three sentences.", { perChar: 30 });
			await sleep(500);
			await s.click(`${ACTIVE} .zs-send`, { after: 300 });
			s.mark("sent");
			await waitForAnswer(s);
			await readAnswer(s, { stepPx: 260 });
			await sleep(2000);
		},
	},

	// Everything asked about highlighted text is kept, with the passage and the prompt.
	clarifications: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.resnet, page: 0 });
			let count = await s.run(`return (await Zotero.Zusia.loadClarifications(${dirOf(PAPERS.resnet)})).length`);
			if (count < 2) {
				await askOffCamera(s, PAPERS.resnet, "About this passage (p. 1):\n\n> Deeper neural networks are more difficult to train.\n\nWhy exactly are deeper networks harder to train?", {
					selection: { text: "Residual nets with a depth of up to 152 layers are 8x deeper than VGG nets.", pageLabel: "1", position: null },
				});
			}
		},
		async run(s) {
			s.mark("start");
			await sleep(1000);
			await s.click(`${ACTIVE} .zs-clarifications`, { after: 1300 });
			s.mark("panel");
			await s.click(await s.rectOf(`return [...doc.querySelectorAll('${ACTIVE} .zs-clar-item')].find(i => i.textContent.includes("Deeper neural")) || doc.querySelector('${ACTIVE} .zs-clar-item');`), { after: 1500 });
			s.mark("detail");
			await s.run(`let body = doc.querySelector('${ACTIVE} .zs-panel-body'); let start = Date.now();
				while (Date.now() - start < 2600) { let t = (Date.now() - start) / 2600; body.scrollTop = (body.scrollHeight - body.clientHeight) * t; await new Promise(r => win.requestAnimationFrame(r)); }`);
			await sleep(1200);
			await s.run(`let body = doc.querySelector('${ACTIVE} .zs-panel-body'); body.scrollTo({ top: 0, behavior: "smooth" });`);
			await sleep(1200);
			await s.click(`${ACTIVE} .zs-clar-pdf`, { after: 2600 });
			s.mark("back to the pdf");
			await sleep(1500);
		},
	},

	// One search box over the chats of every paper.
	search: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.attention, page: 3 });
		},
		async run(s) {
			s.mark("start");
			await sleep(900);
			await s.click(`${ACTIVE} .zs-search`, { after: 700 });
			s.mark("search open");
			await s.type("residual", { perChar: 120 });
			await sleep(1400);
			s.mark("results");
			let results = await s.run(`return [...doc.querySelectorAll('${ACTIVE} .zs-search-menu .zs-menu-item')].length`);
			for (let i = 0; i < Math.min(3, results); i++) {
				await s.moveTo(await s.rect(`${ACTIVE} .zs-search-menu .zs-menu-item`, { index: i }), { ms: 420 });
				await sleep(500);
			}
			if (results) {
				await s.click(`${ACTIVE} .zs-search-menu .zs-menu-item`, { index: 0, after: 3000 });
			}
			s.mark("opened");
			await sleep(2500);
		},
	},

	// A proof in LaTeX, with links between the statements.
	theorems: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.adam, page: 3, modes: { latex: true }, effort: "high" });
			await s.run(`await Zotero.Zusia.saveHistory(${dirOf(PAPERS.adam)}, []); await Zotero.Zusia.saveSessions(${dirOf(PAPERS.adam)}, {}); await IOUtils.remove(Zotero.Zusia.memoryPath(${dirOf(PAPERS.adam)}), { ignoreAbsent: true });
				let view = Zotero.Zusia._views.get([...doc.querySelectorAll('${ACTIVE}')].find(r => r.getBoundingClientRect().width));
				Zotero.Zusia.renderMessages(view, []);`);
		},
		async run(s) {
			s.mark("start");
			await sleep(900);
			await s.click(`${ACTIVE} .zs-input`, { after: 200 });
			await s.type("State Theorem 4.1 in a theorem box, then sketch its proof as lemmas that refer to each other.", { perChar: 26 });
			await sleep(400);
			await s.click(`${ACTIVE} .zs-send`, { after: 300 });
			s.mark("sent");
			await waitForAnswer(s);
			await readAnswer(s, { stepPx: 320, pause: 1200 });
			s.mark("read");
			let refs = await s.run(`return [...${LOG}.querySelectorAll(".zs-ref-ok")].length`);
			if (refs) {
				await s.click(`${ACTIVE} .zs-log .zs-ref-ok`, { index: refs - 1, after: 2200 });
				s.mark("jumped");
				await s.click(`${ACTIVE} .zs-back`, { after: 2000 });
				s.mark("back");
			}
			await sleep(1500);
		},
	},

	// Too dense? Ask for it again, better.
	explainBetter: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.bert, page: 3 });
			let history = await s.run(`return (await Zotero.Zusia.loadHistory(${dirOf(PAPERS.bert)})).length`);
			if (!history) {
				await askOffCamera(s, PAPERS.bert, "What is the masked language model objective? Answer in one dense sentence.");
			}
			await s.run(`let view = Zotero.Zusia._views.get([...doc.querySelectorAll('${ACTIVE}')].find(r => r.getBoundingClientRect().width));
				Zotero.Zusia.renderMessages(view, await Zotero.Zusia.loadHistory(${dirOf(PAPERS.bert)}));`);
		},
		async run(s) {
			s.mark("start");
			await sleep(1600);
			await s.click(`${ACTIVE} .zs-explain`, { after: 600 });
			s.mark("asked again");
			await waitForAnswer(s);
			await readAnswer(s, { stepPx: 300 });
			await sleep(2000);
		},
	},

	// Keep an answer: save the drawing into a Zotero note.
	note: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.attention, page: 3 });
			// Make the chat holding the drawing the current one again.
			await s.run(`let CS = Zotero.Zusia; let dir = ${dirOf(PAPERS.attention)};
				let current = await CS.loadHistory(dir);
				if (!current.some(m => String(m.text).includes("\`\`\`svg"))) {
					for (let entry of await CS.listArchives(dir)) {
						let history = JSON.parse(await Zotero.File.getContentsAsync(entry.path));
						if (history.some(m => String(m.text).includes("\`\`\`svg"))) {
							await CS.archiveHistory(dir, current);
							await CS.saveHistory(dir, history);
							await IOUtils.remove(entry.path);
							break;
						}
					}
				}
				let view = CS._views.get(doc.querySelector('${ACTIVE}'));
				CS.renderMessages(view, await CS.loadHistory(dir));
				await Zotero.Promise.delay(600);
				return (await CS.loadHistory(dir)).length;`);
			await s.run(`let log = ${LOG}; let fig = log.querySelector(".zs-figure");
				if (fig) log.scrollTop = fig.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - 60;`);
		},
		async run(s) {
			s.mark("start");
			await sleep(1400);
			await s.click(`${ACTIVE} .zs-figure-save`, { after: 900 });
			s.mark("save menu");
			await s.clickText("Add to a note", { after: 2600, scope: PANE });
			s.mark("saved");
			await sleep(1200);
			await s.run(`win.Zotero_Tabs.select("zotero-pane"); await Zotero.Promise.delay(800);
				let paper = Zotero.Items.get(${PAPERS.attention});
				await win.ZoteroPane.selectItem(paper.id);
				await Zotero.Promise.delay(900);
				// Open the paper's row so the new note is visible under it.
				let view = win.ZoteroPane.itemsView;
				let index = view.getRowIndexByID(paper.id);
				if (!view.isContainerOpen(index)) view.toggleOpenState(index);
				await Zotero.Promise.delay(700);
				let notes = paper.getNotes();
				if (notes.length) await win.ZoteroPane.selectItem(notes[notes.length - 1]);
				await Zotero.Promise.delay(900);
				return notes.length;`);
			s.mark("library");
			await sleep(3200);
		},
	},

	// First run: a few visual picks.
	wizard: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.gpt3, page: 0, onboarded: false, look: {} });
			await s.run(`for (let root of doc.querySelectorAll('${ACTIVE}')) {
				if (!root.querySelector(".zs-wizard")) Zotero.Zusia.showWizard(root);
			}`);
		},
		async run(s) {
			s.mark("start");
			await sleep(1400);
			let next = `${ACTIVE} .zs-wizard-next`;
			let tile = value => `${ACTIVE} .zs-wizard .zs-tile[data-value="${value}"]`;
			await s.click(next, { after: 900 });
			s.mark("assistant");
			await s.click(tile("claude"), { after: 900 });
			await s.click(next, { after: 900 });
			s.mark("look");
			await s.click(tile("flat"), { after: 1100 });
			await s.click(tile("glass"), { after: 900 });
			await s.click(`${ACTIVE} .zs-wizard .zs-swatch`, { index: 1, after: 1300 });
			await s.click(next, { after: 900 });
			s.mark("buddy");
			await s.click(tile("owl"), { after: 900 });
			await s.click(tile("cat"), { after: 900 });
			await s.click(tile("math"), { after: 1200 });
			await s.click(next, { after: 900 });
			s.mark("answers");
			await s.click(tile("student"), { after: 900 });
			await s.click(`${ACTIVE} .zs-wizard .zs-tile[title="LaTeX"]`, { after: 1100 });
			await s.click(next, { after: 1100 });
			s.mark("voice");
			// A second preset shows the box refilling; ending on the default shows the
			// presets are only starting points.
			await s.click(tile("tutor"), { after: 2200 });
			await s.click(tile("colleague"), { after: 1400 });
			await s.click(next, { after: 1100 });
			s.mark("done");
			await s.click(next, { after: 2600 });
		},
	},

	// Intro 1: from a hidden panel to a drawing and real maths, without dead time.
	introChat: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.attention, page: 3, modes: {}, effort: "medium" });
			await s.run(`let CS = Zotero.Zusia;
				await CS.saveHistory(${dirOf(PAPERS.attention)}, []);
				await CS.saveSessions(${dirOf(PAPERS.attention)}, {});
				let view = CS._views.get(doc.querySelector('${ACTIVE}'));
				CS.renderMessages(view, []);
				// Start with the panel hidden, so the video shows it appear.
				CS.setDockOpen(false);
				await Zotero.Promise.delay(500);
				return true;`);
			await s.moveTo({ x: 700, y: 700 }, { ms: 250 });
		},
		async run(s) {
			s.mark("start");
			await sleep(900);
			await s.click(`${PANE} .zs-dock-open`, { after: 1100 });
			s.mark("pane");
			await s.click(`${ACTIVE} .zs-mode-drawing`, { after: 350 });
			await s.click(`${ACTIVE} .zs-mode-latex`, { after: 500 });
			s.mark("modes");
			await s.click(`${ACTIVE} .zs-input`, { after: 150 });
			await s.type("draw how Q, K and V flow, and why divide by sqrt(d_k)", { perChar: 22 });
			await sleep(350);
			await s.click(`${ACTIVE} .zs-send`, { after: 250 });
			s.mark("sent");
			await waitForAnswer(s);
			await s.run(`let log = ${LOG}; let fig = log.querySelector(".zs-figure");
				if (fig) log.scrollTo({ top: fig.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - 40, behavior: "smooth" });`);
			await sleep(2200);
			s.mark("drawing");
			await readAnswer(s, { from: "here", stepPx: 340, pause: 1100 });
			await sleep(1600);
			s.mark("end");
		},
	},

	// Intro 2: the look, changed live, in a few seconds.
	introStyle: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.attention, page: 3, look: {} });
			await s.run(`
				let CS = Zotero.Zusia;
				CS._pickBackground = CS._pickBackground || CS.pickBackground;
				CS.pickBackground = async () => {
					let name = "background-" + Date.now() + ".jpg";
					await IOUtils.copy("/Users/Shared/Zusia/night-in-kyoto.jpg", PathUtils.join(CS.getDataDir(), name));
					return name;
				};
				let log = ${LOG}; let fig = log.querySelector(".zs-figure");
				if (fig) log.scrollTop = fig.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - 80;
				Zotero.Utilities.Internal.openPreferences("zusia-prefs");
				for (let i = 0; i < 40 && !Services.wm.getMostRecentWindow("zotero:pref")?.document.querySelector(".zs-prefs"); i++) await Zotero.Promise.delay(150);
				let pw = Services.wm.getMostRecentWindow("zotero:pref");
				pw.resizeTo(760, 820); pw.moveTo(200, 170);
				await Zotero.Promise.delay(700);
				let d = pw.document;
				d.querySelector("#prefs-search")?.blur();
				let card = [...d.querySelectorAll(".zs-card")].find(c => c.querySelector(".zs-card-title").textContent === "Appearance");
				card.scrollIntoView({ block: "start" });
				d.getElementById("prefs-content").scrollTop -= 12;
				pw.focus();
				return true;`);
			await s.front();
			await s.moveTo({ x: 700, y: 620 }, { ms: 250 });
		},
		async run(s) {
			const PREFS = `Services.wm.getMostRecentWindow("zotero:pref")`;
			let control = (label, text) => s.rectOf(`let d = ${PREFS}.document;
				let row = [...d.querySelectorAll(".zs-row")].find(r => r.querySelector(".zs-row-label")?.textContent === ${JSON.stringify(label)});
				let text = ${JSON.stringify("__T__")};
				return [...row.querySelectorAll("button, label")].find(b => (b.title || b.textContent.trim()) === text);`.replace('"__T__"', JSON.stringify(text)));
			let pick = async (label, text, after = 700) => s.click(await control(label, text), { after });
			s.mark("start");
			await sleep(900);
			await pick("Style", "Flat", 1100);
			await pick("Style", "Glass", 800);
			s.mark("style");
			await pick("Buddy", "Owl", 700);
			await pick("Buddy", "Cat", 700);
			await pick("Pattern", "Stars", 900);
			s.mark("buddy");
			await pick("Accent colour", "Teal", 700);
			await pick("Accent colour", "Red", 1100);
			s.mark("accent");
			await pick("Background image", "Choose image…", 2200);
			s.mark("image");
			await pick("Button labels", "Icons + text", 1100);
			await pick("Button labels", "Icons only", 900);
			s.mark("labels");
			await s.run(`${PREFS}.close(); let CS = Zotero.Zusia; if (CS._pickBackground) CS.pickBackground = CS._pickBackground;`);
			await sleep(900);
			await s.front();
			await s.moveTo(await s.rect(`${ACTIVE} .zs-log`), { ms: 500, dx: 150 });
			await s.run(`let log = ${LOG}; let from = log.scrollTop, to = Math.max(0, from - 420), start = Date.now();
				while (Date.now() - start < 1800) { let t = (Date.now() - start) / 1800; log.scrollTop = from + (to - from) * t; await new Promise(r => win.requestAnimationFrame(r)); }`);
			await sleep(2200);
			s.mark("end");
		},
	},

	// Settings → Assistants → ACP agents: fill the form from the official registry and add
	// Claude Agent, whose card then lists the adapter's own models.
	acpRegistry: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.adam, page: 3 });
			await s.run(`let CS = Zotero.Zusia;
				for (let config of CS.acpAgents().filter(c => c.name === ${JSON.stringify(AGENT)})) CS.removeAcpAgent(CS.acpAgentKey(config.id));
				Zotero.Utilities.Internal.openPreferences("zusia-prefs");
				for (let i = 0; i < 40 && !${PREFS_WIN}?.document.querySelector(".zs-prefs"); i++) await Zotero.Promise.delay(150);
				let pw = ${PREFS_WIN};
				pw.resizeTo(760, 820); pw.moveTo(200, 170);
				await Zotero.Promise.delay(700);
				let d = pw.document;
				d.querySelector("#prefs-search")?.blur();
				d.querySelector(".zs-acp-section").scrollIntoView({ block: "start" });
				d.getElementById("prefs-content").scrollTop -= 12;
				pw.focus();
				return true;`);
			await s.front();
			await s.moveTo({ x: 700, y: 620 }, { ms: 250 });
		},
		async run(s) {
			let inPrefs = selector => s.rectOf(`return ${PREFS_WIN}.document.querySelector(${JSON.stringify(selector)});`);
			s.mark("start");
			await sleep(1200);
			await s.click(await inPrefs(".zs-acp-browse"), { after: 400 });
			for (let i = 0; i < 60 && !(await s.run(`return !!${PREFS_WIN}.document.querySelector(".zs-acp-registry-choice select")`)); i++) await sleep(250);
			await sleep(900);
			s.mark("registry");
			// A native drop-down is drawn outside the window, so the film shows the choice made.
			await s.moveTo(await inPrefs(".zs-acp-registry-choice select"), { ms: 500 });
			await s.run(`let select = ${PREFS_WIN}.document.querySelector(".zs-acp-registry-choice select");
				select.selectedIndex = [...select.options].findIndex(o => o.textContent.startsWith(${JSON.stringify(AGENT)}) && !o.textContent.includes("binary"));
				select.dispatchEvent(new Event("change", { bubbles: true }));`);
			await sleep(900);
			await s.click(await inPrefs(".zs-acp-use"), { after: 1600 });
			s.mark("filled");
			await s.run(`${PREFS_WIN}.document.querySelector(".zs-acp-add-button").scrollIntoView({ block: "center", behavior: "smooth" });`);
			await sleep(1200);
			await s.click(await inPrefs(".zs-acp-add-button"), { after: 600 });
			s.mark("added");
			await s.run(`let card = [...${PREFS_WIN}.document.querySelectorAll(".zs-acp-list > *")].pop(); card.scrollIntoView({ block: "center", behavior: "smooth" });`);
			for (let i = 0; i < 240 && (await s.run(`let CS = Zotero.Zusia; let c = CS.acpAgents().find(c => c.name === ${JSON.stringify(AGENT)});
				let e = c && CS.acpModelEntry(CS.acpAgentKey(c.id)); return !e || !!e.promise || (!e.models && !e.error);`)); i++) await sleep(250);
			await sleep(1500);
			s.mark("models");
			await sleep(1500);
			await s.run(`${PREFS_WIN}.close();`);
			await sleep(600);
		},
	},

	// A hard question through Claude Agent, over ACP: the proof of Adam's Theorem 4.1 has a known gap
	// (Reddi et al., 2018), so a right answer can be checked against the literature.
	acpProof: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.adam, page: 3, modes: { latex: true } });
			s.agent = await addAgent(s);
			await s.run(`await Zotero.Zusia.saveHistory(${dirOf(PAPERS.adam)}, []); await Zotero.Zusia.saveSessions(${dirOf(PAPERS.adam)}, {}); await IOUtils.remove(Zotero.Zusia.memoryPath(${dirOf(PAPERS.adam)}), { ignoreAbsent: true });
				let view = Zotero.Zusia._views.get([...doc.querySelectorAll('${ACTIVE}')].find(r => r.getBoundingClientRect().width));
				Zotero.Zusia.renderMessages(view, []);`);
		},
		async run(s) {
			s.mark("start");
			await sleep(900);
			await pickAgent(s, s.agent);
			await s.click(`${ACTIVE} .zs-input`, { after: 200 });
			await s.type("Is the proof of Theorem 4.1 correct? Find the exact step that fails, state it as a lemma, and give a counterexample.", { perChar: 22 });
			await sleep(400);
			await s.click(`${ACTIVE} .zs-send`, { after: 300 });
			s.mark("sent");
			await waitForAnswer(s);
			await readAnswer(s, { stepPx: 300, pause: 1500 });
			s.mark("read");
			await sleep(1500);
		},
	},

	// A derivation with a drawing, through the same agent.
	acpDerive: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.attention, page: 3, modes: { latex: true, drawing: true } });
			s.agent = await addAgent(s);
			await s.run(`await Zotero.Zusia.saveHistory(${dirOf(PAPERS.attention)}, []); await Zotero.Zusia.saveSessions(${dirOf(PAPERS.attention)}, {}); await IOUtils.remove(Zotero.Zusia.memoryPath(${dirOf(PAPERS.attention)}), { ignoreAbsent: true });
				let view = Zotero.Zusia._views.get([...doc.querySelectorAll('${ACTIVE}')].find(r => r.getBoundingClientRect().width));
				Zotero.Zusia.renderMessages(view, []);`);
		},
		async run(s) {
			s.mark("start");
			await sleep(900);
			await pickAgent(s, s.agent);
			await s.click(`${ACTIVE} .zs-input`, { after: 200 });
			await s.type("Derive why q·k grows like √d_k, then draw what the softmax does to its gradient without the scaling.", { perChar: 22 });
			await sleep(400);
			await s.click(`${ACTIVE} .zs-send`, { after: 300 });
			s.mark("sent");
			await waitForAnswer(s);
			await readAnswer(s, { stepPx: 300, pause: 1500 });
			s.mark("read");
			await sleep(1500);
		},
	},

	// What Zusia keeps about a paper: a /remember note, then the Memory sheet with where the
	// reader is, the reading map and the memory a background call wrote from the chat.
	memory: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.adam, page: 3, modes: { latex: true } });
			let dir = dirOf(PAPERS.adam);
			let answers = await s.run(`return (await Zotero.Zusia.loadHistory(${dir})).filter(m => m.role === "assistant").length`);
			if (answers < 2) {
				await askOffCamera(s, PAPERS.adam, "Why does Adam correct the bias of m_t and v_t? Two sentences.");
			}
			// The memory is written by the real background call, not by the scene.
			let filled = await s.run(`let CS = Zotero.Zusia; let dir = ${dir};
				await IOUtils.remove(CS.memoryPath(dir), { ignoreAbsent: true });
				CS.queueConsolidation(dir, { reason: "leave" });
				for (let i = 0; i < 240; i++) {
					let memory = await CS.loadMemory(dir);
					if (memory.summary || (memory.items || []).length) return true;
					await Zotero.Promise.delay(500);
				}
				return false;`);
			if (!filled) {
				throw new Error("the background call wrote no memory for Adam in two minutes");
			}
			await s.run(`let view = Zotero.Zusia._views.get([...doc.querySelectorAll('${ACTIVE}')].find(r => r.getBoundingClientRect().width));
				Zotero.Zusia.renderMessages(view, await Zotero.Zusia.loadHistory(${dir}));`);
		},
		async run(s) {
			s.mark("start");
			await sleep(1000);
			await s.click(`${ACTIVE} .zs-input`, { after: 200 });
			await s.type("/remember I like proofs split into numbered lemmas", { perChar: 24 });
			await sleep(400);
			await s.click(`${ACTIVE} .zs-send`, { after: 1400 });
			s.mark("remembered");
			await s.click(`${ACTIVE} .zs-context-chip`, { after: 1600 });
			s.mark("sheet");
			await s.run(`let body = doc.querySelector('${ACTIVE} .zs-memory-panel .zs-panel-body') || doc.querySelector('${ACTIVE} .zs-panel-body');
				let map = body.querySelector(".zs-memory-map");
				if (map) body.scrollTo({ top: map.offsetTop - 12, behavior: "smooth" });`);
			await sleep(2600);
			s.mark("map");
			await s.run(`let body = doc.querySelector('${ACTIVE} .zs-memory-panel .zs-panel-body') || doc.querySelector('${ACTIVE} .zs-panel-body');
				let items = body.querySelector(".zs-memory-items");
				let start = Date.now(), from = body.scrollTop, to = items ? items.offsetTop - 12 : body.scrollHeight;
				while (Date.now() - start < 1600) { let t = (Date.now() - start) / 1600; body.scrollTop = from + (to - from) * t; await new Promise(r => win.requestAnimationFrame(r)); }`);
			await sleep(3200);
			s.mark("items");
			await sleep(1500);
		},
	},

	// The same sidebar, a different assistant.
	assistants: {
		async setup(s) {
			await setUp(s, { paper: PAPERS.gpt3, page: 5 });
			await s.run(`await Zotero.Zusia.saveHistory(${dirOf(PAPERS.gpt3)}, []); await Zotero.Zusia.saveSessions(${dirOf(PAPERS.gpt3)}, {}); await IOUtils.remove(Zotero.Zusia.memoryPath(${dirOf(PAPERS.gpt3)}), { ignoreAbsent: true });
				let view = Zotero.Zusia._views.get([...doc.querySelectorAll('${ACTIVE}')].find(r => r.getBoundingClientRect().width));
				Zotero.Zusia.renderMessages(view, []);`);
		},
		async run(s) {
			s.mark("start");
			await sleep(1000);
			await s.click(`${ACTIVE} .zs-model-btn`, { after: 1000 });
			s.mark("model menu");
			await s.moveTo(await s.rect(`${ACTIVE} .zs-menu .zs-menu-item`, { index: 1 }), { ms: 500 });
			await sleep(700);
			await s.clickText("Haiku", { after: 1200, scope: PANE });
			s.mark("model picked");
			await s.click(`${ACTIVE} .zs-effort-btn`, { after: 900 });
			await s.clickText("Low", { after: 1200, scope: PANE });
			s.mark("effort picked");
			await s.click(`${ACTIVE} .zs-input`, { after: 200 });
			await s.type("in two sentences: what is in-context learning?", { perChar: 28 });
			await s.click(`${ACTIVE} .zs-send`, { after: 300 });
			s.mark("sent");
			await waitForAnswer(s);
			await readAnswer(s, { stepPx: 260 });
			await sleep(2000);
		},
	},
};

// ---------------------------------------------------------------------------

let [name, out] = process.argv.slice(2);
let dry = process.argv.includes("--dry");
let scene = SCENES[name];
if (!scene) {
	console.error("scenes: " + Object.keys(SCENES).join(", "));
	process.exit(2);
}
let s = await stage();
Object.assign(PAPERS, await s.run(`let items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
	let ids = {};
	for (let [name, arxiv] of Object.entries(${JSON.stringify(ARXIV)})) {
		ids[name] = items.find(item => item.isRegularItem() && item.getField("url").endsWith("/" + arxiv)).id;
	}
	return ids;`));
await scene.setup(s);
await s.front();
await sleep(1000);
if (!dry) {
	await s.record(out);
}
await scene.run(s);
if (dry) {
	s.zotero.close();
	process.exit(0);
}
let marks = await s.stop(out);
writeFileSync(out.replace(/\.\w+$/, ".marks.json"), JSON.stringify(marks, null, 2));
process.exit(0);
