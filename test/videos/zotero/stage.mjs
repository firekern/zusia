// Drives the demo Zotero like a person would: finds elements through the debugger
// connection, moves the real pointer and types with cliclick, and records the screen.
//
// ZUSIA_INSIDE=1 films a scene from inside Zotero instead, without the pointer and the
// screen recorder, which need Accessibility and Screen Recording permission: clicks and
// typing are sent to Zotero as events, at the same points, Zotero draws its own windows
// into the frames (camera.js) and the pointer is drawn into the film afterwards
// (compose.py).
//
// ZUSIA_REHEARSE=<folder> walks a scene the same way without filming it: every mark
// saves what the window shows into the folder. It tells whether a scene still finds its
// way through the interface.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attach } from "./rdp.mjs";

export const WINDOW = { x: 180, y: 130, width: 1440, height: 900 };
export const PORT = 6200;
export const REHEARSE = process.env.ZUSIA_REHEARSE || "";
const INSIDE = !!REHEARSE || process.env.ZUSIA_INSIDE === "1";
// What camera.js leaves in the demo Zotero: the pointer and the pictures of a scene run from inside.
const CAMERA = "Zotero.ZusiaCamera";
// A file of this folder.
const beside = name => fileURLToPath(new URL(name, import.meta.url));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// avfoundation numbers the screen after the cameras, so it moves when one is added.
function screenDevice() {
	let listed;
	try {
		listed = execFileSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], { stdio: ["ignore", "pipe", "pipe"] }).toString();
	}
	catch (error) {
		// Listing devices is all it was asked to do; ffmpeg still exits with an error.
		listed = String(error.stderr);
	}
	let screen = /\[(\d+)\] Capture screen 0/.exec(listed);
	if (!screen) {
		throw new Error("ffmpeg lists no screen to capture:\n" + listed);
	}
	return screen[1];
}

export async function stage() {
	let zotero = await attach(PORT);
	let marks = [];
	let recorder = null;
	let startedAt = 0;
	let pointer = { x: 0, y: 0 };
	// One at a time, in order: a mark does not wait for its picture.
	let shots = Promise.resolve();
	// Where the camera saves its pictures until the film is made from them.
	let film = "";
	if (INSIDE) {
		await zotero.evaluate(`let frame = ${JSON.stringify(WINDOW)};\n` + readFileSync(beside("./camera.js"), "utf8"));
	}

	let api = {
		zotero,
		run: source => zotero.evaluate(source),

		// Screen rectangle (points) of the first element matching a CSS selector in the main window.
		async rect(selector, { index = 0, within = "doc" } = {}) {
			let rect = await zotero.evaluate(`
				let els = [...${within}.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.getBoundingClientRect().width);
				let el = els[${index}];
				if (!el) return null;
				el.scrollIntoView({ block: "nearest" });
				let r = el.getBoundingClientRect();
				let owner = el.ownerGlobal;
				return { x: owner.mozInnerScreenX + r.left, y: owner.mozInnerScreenY + r.top, w: r.width, h: r.height };`);
			if (!rect) {
				throw new Error("not on screen: " + selector);
			}
			return rect;
		},

		// Screen rectangle of the element returned by a function body.
		async rectOf(body) {
			let rect = await zotero.evaluate(`let el = (() => { ${body} })();
				if (!el) return null;
				let r = el.getBoundingClientRect();
				let owner = el.ownerGlobal;
				return { x: owner.mozInnerScreenX + r.left, y: owner.mozInnerScreenY + r.top, w: r.width, h: r.height };`);
			if (!rect) {
				throw new Error("not found: " + body.slice(0, 120));
			}
			return rect;
		},

		async moveTo(target, { dx = 0, dy = 0, ms = 450 } = {}) {
			let point = "w" in target ? { x: target.x + target.w / 2, y: target.y + target.h / 2 } : target;
			pointer = { x: Math.round(point.x + dx), y: Math.round(point.y + dy) };
			if (INSIDE) {
				await zotero.evaluate(`await ${CAMERA}.move(${pointer.x}, ${pointer.y}, ${ms})`);
			}
			else {
				execFileSync("cliclick", ["-e", String(ms), `m:${pointer.x},${pointer.y}`]);
			}
		},

		// A click where the pointer is. From inside, it goes to whatever Zotero has at that
		// point of the screen, so a target that is covered or off screen is still missed.
		async press() {
			if (!INSIDE) {
				execFileSync("cliclick", ["c:."]);
			}
			else if (!(await zotero.evaluate(`return ${CAMERA}.press()`))) {
				throw new Error(`a click at ${pointer.x},${pointer.y} is outside Zotero's windows`);
			}
		},

		async click(selector, options = {}) {
			await api.front();
			let target = typeof selector === "string" ? await api.rect(selector, options) : selector;
			await api.moveTo(target, options);
			await sleep(options.hover ?? 180);
			await api.press();
			await sleep(options.after ?? 500);
		},

		// Drags the pointer, the way a reader selects text.
		async drag(from, to, ms = 900) {
			await api.front();
			if (INSIDE) {
				await api.moveTo(from, { ms: 400 });
				await sleep(200);
				let held = await zotero.evaluate(`return ${CAMERA}.button(true)`);
				await api.moveTo(to, { ms });
				if (!held || !(await zotero.evaluate(`return ${CAMERA}.button(false)`))) {
					throw new Error(`a drag from ${from.x},${from.y} to ${to.x},${to.y} leaves Zotero's windows`);
				}
				await sleep(400);
				return;
			}
			execFileSync("cliclick", ["-e", "400", `m:${Math.round(from.x)},${Math.round(from.y)}`]);
			await sleep(200);
			execFileSync("cliclick", [`dd:${Math.round(from.x)},${Math.round(from.y)}`]);
			execFileSync("cliclick", ["-e", String(ms), `dm:${Math.round(to.x)},${Math.round(to.y)}`]);
			execFileSync("cliclick", [`du:${Math.round(to.x)},${Math.round(to.y)}`]);
			await sleep(400);
		},

		// The window of the PDF viewer inside the reader, where pdf.js draws its text layer.
		pdfWindow: `Zotero.Reader._readers.find(r => r.tabID === win.Zotero_Tabs.selectedID)._iframeWindow.document.querySelector("iframe").contentWindow`,

		// Screen rectangle of a phrase in the PDF, found in pdf.js's text layer.
		async phrase(text) {
			let rect = await zotero.evaluate(`let w = ${api.pdfWindow};
				let spans = [...w.document.querySelectorAll(".textLayer span")];
				let start = spans.findIndex(s => s.textContent.includes(${JSON.stringify("")}) && s.textContent.trim() && ${JSON.stringify(text)}.startsWith(s.textContent.trim().slice(0, 12)) && s.textContent.trim().length > 6);
				if (start < 0) return null;
				let wanted = ${JSON.stringify(text)};
				let seen = "";
				let last = start;
				for (let i = start; i < spans.length && seen.replace(/\\s+/g, " ").trim().length < wanted.length; i++) {
					seen += spans[i].textContent + " ";
					last = i;
				}
				let a = spans[start].getBoundingClientRect();
				let b = spans[last].getBoundingClientRect();
				return { from: { x: w.mozInnerScreenX + a.left + 1, y: w.mozInnerScreenY + a.top + a.height / 2 },
					to: { x: w.mozInnerScreenX + b.right - 1, y: w.mozInnerScreenY + b.top + b.height / 2 },
					text: seen.trim() };`);
			if (!rect) {
				throw new Error("phrase not on the page: " + text);
			}
			return rect;
		},

		// Selects that phrase with a real drag and returns Zotero's selection popup buttons.
		async selectPhrase(text) {
			let { from, to } = await api.phrase(text);
			// The reader only shows its selection popup once the page has been clicked into.
			await api.click({ x: from.x, y: from.y, w: 0, h: 0 }, { after: 500, hover: 120 });
			await api.drag(from, to);
			await sleep(700);
		},

		// Clicks a button by its visible text (menus, the reader's selection popup).
		async clickText(text, { scope = null, after = 500, hover = 180 } = {}) {
			let rect = await api.rectOf(`let scope = ${scope ? JSON.stringify(scope) : "null"};
				let roots = [doc];
				let reader = Zotero.Reader._readers.find(r => r.tabID === win.Zotero_Tabs.selectedID);
				if (reader) roots.push(reader._iframeWindow.document);
				for (let root of roots) {
					let target = [...root.querySelectorAll(scope ? scope + " button, " + scope + " .zs-menu-item" : "button")]
						.filter(b => b.getBoundingClientRect().width)
						.find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}));
					if (target) return target;
				}
				return null;`);
			await api.moveTo(rect, {});
			await sleep(hover);
			await api.press();
			await sleep(after);
		},

		async type(text, { perChar = 45 } = {}) {
			for (let char of text) {
				if (INSIDE) {
					if (!(await zotero.evaluate(`return ${CAMERA}.type(${JSON.stringify(char)})`))) {
						throw new Error("typing with no text field in focus");
					}
				}
				else {
					execFileSync("cliclick", ["t:" + char]);
				}
				await sleep(perChar);
			}
		},

		key(name) {
			if (INSIDE) {
				throw new Error("a scene run from inside has no keyboard: " + name);
			}
			execFileSync("cliclick", ["kp:" + name]);
		},

		// In front of the other apps, or, from inside, looking as if it were.
		async front() {
			if (INSIDE) {
				await zotero.evaluate(`${CAMERA}.front()`);
			}
			else {
				execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${api.pid}) to true`]);
			}
		},

		mark(name) {
			marks.push({ name, t: (Date.now() - startedAt) / 1000 });
			console.log(`  ${marks.at(-1).t.toFixed(1)}s ${name}`);
			if (REHEARSE) {
				// What the recorder's frame would hold, as Zotero draws it. Without the pointer.
				let still = REHEARSE + "/" + String(marks.length).padStart(2, "0") + "-" + name.replace(/\W+/g, "-") + ".png";
				shots = shots.then(() => zotero.evaluate(`await ${CAMERA}.still(${JSON.stringify(still)})`));
			}
		},

		async record(file) {
			startedAt = Date.now();
			if (REHEARSE) {
				return;
			}
			if (INSIDE) {
				film = file.replace(/\.\w+$/, "-frames");
				rmSync(film, { recursive: true, force: true });
				await zotero.evaluate(`await ${CAMERA}.start(${JSON.stringify(film)}, ${startedAt})`);
				return;
			}
			// A crashing scene must not leave the screen recorder running.
			process.on("exit", () => { try { recorder?.kill("SIGINT"); } catch (e) {} });
			for (let signal of ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"]) {
				process.on(signal, (error) => {
					try { recorder?.kill("SIGINT"); } catch (e) {}
					console.error(String(error && error.stack || error));
					process.exit(1);
				});
			}
			let crop = `crop=${WINDOW.width * 2}:${WINDOW.height * 2}:${WINDOW.x * 2}:${WINDOW.y * 2}`;
			recorder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation", "-capture_cursor", "1",
				"-framerate", "30", "-pixel_format", "bgr0", "-i", screenDevice() + ":none", "-vf", crop, "-c:v", "libx264", "-preset", "ultrafast",
				"-crf", "16", "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "inherit", "inherit"] });
			await sleep(1500);
			startedAt = Date.now();
		},

		async stop(file) {
			if (REHEARSE) {
				await shots;
			}
			else if (INSIDE) {
				let { frames, covered } = await zotero.evaluate(`return await ${CAMERA}.stop()`);
				if (covered) {
					console.warn(`  ${covered} of ${frames} pictures found the demo window fully covered: what moves on its own may stutter there`);
				}
				execFileSync("python3", [beside("./compose.py"), film, file], { stdio: "inherit" });
				rmSync(film, { recursive: true });
			}
			else {
				// avfoundation capture ignores "q" on stdin; SIGINT makes ffmpeg finish the file.
				let closed = new Promise(resolve => recorder.on("close", resolve));
				recorder.kill("SIGINT");
				await closed;
			}
			zotero.close();
			return marks;
		},
	};
	api.pid = Number(execFileSync("pgrep", ["-f", "zusia-demo/profile -no-remote"]).toString().trim().split("\n")[0]);
	return api;
}
