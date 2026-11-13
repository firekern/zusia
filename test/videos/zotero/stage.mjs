// Drives the demo Zotero like a person would: finds elements through the debugger
// connection, moves the real pointer and types with cliclick, and records the screen.
//
// ZUSIA_REHEARSE=<folder> runs a scene without the pointer and without the recorder,
// which need Accessibility and Screen Recording permission: clicks and typing are sent
// to Zotero as events, at the same points, and every mark saves what the window shows
// into the folder. It tells whether a scene still finds its way through the interface.
import { spawn, execFileSync } from "node:child_process";
import { attach } from "./rdp.mjs";

export const WINDOW = { x: 180, y: 130, width: 1440, height: 900 };
export const PORT = 6200;
export const REHEARSE = process.env.ZUSIA_REHEARSE || "";
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The windows a scene works in, the one in front first.
const WINDOWS = `[Services.wm.getMostRecentWindow("zotero:pref"), win].filter(Boolean)`;

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
			if (!REHEARSE) {
				execFileSync("cliclick", ["-e", String(ms), `m:${pointer.x},${pointer.y}`]);
			}
		},

		// A click where the pointer is. Rehearsed, it goes to whatever Zotero has at that
		// point of the screen, so a target that is covered or off screen is still missed.
		async press() {
			if (!REHEARSE) {
				execFileSync("cliclick", ["c:."]);
				return;
			}
			let hit = await zotero.evaluate(`for (let w of ${WINDOWS}) {
					let x = ${pointer.x} - w.mozInnerScreenX, y = ${pointer.y} - w.mozInnerScreenY;
					if (x < 0 || y < 0 || x >= w.innerWidth || y >= w.innerHeight) continue;
					for (let type of ["mousemove", "mousedown", "mouseup"]) w.windowUtils.sendMouseEvent(type, x, y, 0, 1, 0);
					return true;
				}
				return false;`);
			if (!hit) {
				throw new Error(`a click at ${pointer.x},${pointer.y} is outside Zotero's windows`);
			}
		},

		async click(selector, options = {}) {
			api.front();
			let target = typeof selector === "string" ? await api.rect(selector, options) : selector;
			await api.moveTo(target, options);
			await sleep(options.hover ?? 180);
			await api.press();
			await sleep(options.after ?? 500);
		},

		// Drags the pointer, the way a reader selects text.
		async drag(from, to, ms = 900) {
			if (REHEARSE) {
				throw new Error("a rehearsal cannot drag");
			}
			api.front();
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
				if (REHEARSE) {
					// Into the field that has the focus, as a key would go.
					let typed = await zotero.evaluate(`let field = ${WINDOWS}.map(w => w.document.activeElement).find(el => el && "selectionStart" in el);
						if (!field) return false;
						field.setRangeText(${JSON.stringify(char)}, field.selectionStart, field.selectionEnd, "end");
						field.dispatchEvent(new field.ownerGlobal.InputEvent("input", { bubbles: true }));
						return true;`);
					if (!typed) {
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
			if (REHEARSE) {
				throw new Error("a rehearsal has no keyboard: " + name);
			}
			execFileSync("cliclick", ["kp:" + name]);
		},

		front() {
			if (!REHEARSE) {
				execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${api.pid}) to true`]);
			}
		},

		mark(name) {
			marks.push({ name, t: (Date.now() - startedAt) / 1000 });
			console.log(`  ${marks.at(-1).t.toFixed(1)}s ${name}`);
			if (REHEARSE) {
				shots = shots.then(() => api.shot(String(marks.length).padStart(2, "0") + "-" + name.replace(/\W+/g, "-")));
			}
		},

		// What the recorder's frame would hold, as Zotero draws it: the main window with
		// the Settings window over it. Without the pointer, the title bar and the glass blur.
		async shot(name) {
			await zotero.evaluate(`let canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
				canvas.width = ${WINDOW.width * 2}; canvas.height = ${WINDOW.height * 2};
				let ctx = canvas.getContext("2d");
				ctx.scale(2, 2);
				for (let w of ${WINDOWS}.reverse()) {
					ctx.save();
					ctx.translate(w.mozInnerScreenX - ${WINDOW.x}, w.mozInnerScreenY - ${WINDOW.y});
					ctx.drawWindow(w, 0, 0, w.innerWidth, w.innerHeight, "rgb(30,30,30)");
					ctx.restore();
				}
				let blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
				await IOUtils.write(PathUtils.join(${JSON.stringify(REHEARSE)}, ${JSON.stringify(name)} + ".png"), new Uint8Array(await blob.arrayBuffer()));`);
		},

		async record(file) {
			startedAt = Date.now();
			if (REHEARSE) {
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

		async stop() {
			if (REHEARSE) {
				await shots;
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
