// Runs inside the demo Zotero when a scene is filmed or rehearsed without the screen
// (INSIDE=1 or REHEARSE=1 npm run videos). Zotero draws its own windows into every
// frame, and the pointer is one it is told about, not the Mac's, so no permission is
// needed. It leaves a camera at Zotero.ZusiaCamera for stage.mjs to drive.
// The caller defines frame: the rectangle of the screen a recording would hold.
const SCALE = 2;
// At most this many pictures a second, and never less than REST between two: drawing
// the window takes tens of milliseconds of the thread the scene itself runs on.
const PERIOD = 33;
const REST = 20;
// What macOS adds around a window, measured on the first recordings: its corners, and
// the close, minimise and zoom buttons, grey in a window that is not in front.
const RADIUS = 10;
const LIGHTS = ["#ff5f57", "#febc2e", "#28c840"];
const LIGHT_OFF = "#3a3a3c";
const TITLE_BAR = "#303030";

let main = Services.wm.getMostRecentWindow("navigator:browser");
Zotero.ZusiaCamera?.halt();

let camera = Zotero.ZusiaCamera = {
	folder: null,
	startedAt: 0,
	timer: null,
	frames: 0,
	covered: 0,
	error: null,
	// Zotero says when a window was painted, not where: a window is drawn again whole.
	layers: new Map(),
	stale: true,
	writes: new Set(),
	picture: main.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas"),
	pointer: { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2, kind: "arrow", held: false },
	track: [],

	// The windows a scene works in, the one in front last.
	windows() {
		return [main, Services.wm.getMostRecentWindow("zotero:pref")].filter(Boolean);
	},

	// The window in front looks in front whatever app the Mac has there. Zotero only
	// lets a window be raised without the system when it was started with this pref.
	front() {
		if (!Services.prefs.getBoolPref("focusmanager.testmode", false)) {
			throw new Error("this demo Zotero was started to be recorded off the screen: quit it and run again");
		}
		let top = this.windows().at(-1);
		if (Services.focus.activeWindow !== top) {
			Services.focus.activeWindow = top;
		}
	},

	layer(w) {
		let layer = this.layers.get(w);
		if (!layer) {
			layer = { canvas: main.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas"), dirty: true, at: "" };
			layer.onPaint = () => { layer.dirty = true; };
			w.addEventListener("MozAfterPaint", layer.onPaint);
			this.layers.set(w, layer);
		}
		return layer;
	},

	// Draws the windows that were painted since the last picture; true when the picture changed.
	develop(all = false) {
		let windows = this.windows();
		let changed = this.stale;
		for (let [w, layer] of this.layers) {
			if (!windows.includes(w)) {
				this.layers.delete(w);
				changed = true;
			}
		}
		for (let w of windows) {
			let layer = this.layer(w);
			let at = [w.mozInnerScreenX, w.mozInnerScreenY, w.innerWidth, w.innerHeight, Services.focus.activeWindow === w].join();
			if (at !== layer.at) {
				layer.at = at;
				layer.dirty = true;
			}
			// A window nothing of which shows is not painted: no one says when it changes.
			if (w.isFullyOccluded) {
				layer.dirty = true;
				this.covered++;
			}
			if (!layer.dirty && !all) {
				continue;
			}
			layer.canvas.width = w.innerWidth * SCALE;
			layer.canvas.height = w.innerHeight * SCALE;
			let ctx = layer.canvas.getContext("2d");
			ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
			// Before drawing: what drawing itself brings up to date is not a change to come back for.
			layer.dirty = false;
			ctx.drawWindow(w, 0, 0, w.innerWidth, w.innerHeight, "rgb(30,30,30)", ctx.DRAWWINDOW_DRAW_CARET);
			changed = true;
		}
		return changed;
	},

	// The frame a screen recording would hold: the windows where they are on the screen,
	// with what macOS draws around them.
	compose() {
		this.picture.width = frame.width * SCALE;
		this.picture.height = frame.height * SCALE;
		let ctx = this.picture.getContext("2d");
		ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, frame.width, frame.height);
		let windows = this.windows();
		for (let w of windows) {
			let active = Services.focus.activeWindow === w;
			// Zotero draws its tabs in the title bar of its main window; a dialog has the system's.
			let bar = w.mozInnerScreenY - w.screenY;
			let x = w.mozInnerScreenX - frame.x;
			let y = w.mozInnerScreenY - frame.y;
			let outline = () => {
				ctx.beginPath();
				ctx.roundRect(x, y - bar, w.innerWidth, w.innerHeight + bar, RADIUS);
			};
			ctx.save();
			if (w !== windows[0]) {
				// Shadows are in pixels of the canvas, whatever its scale.
				ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
				ctx.shadowBlur = 44 * SCALE;
				ctx.shadowOffsetY = 20 * SCALE;
			}
			outline();
			ctx.fillStyle = TITLE_BAR;
			ctx.fill();
			ctx.restore();

			ctx.save();
			outline();
			ctx.clip();
			ctx.drawImage(this.layers.get(w).canvas, x, y, w.innerWidth, w.innerHeight);
			if (bar) {
				ctx.font = "bold 13px -apple-system, system-ui";
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillStyle = active ? "rgba(255, 255, 255, 0.82)" : "rgba(255, 255, 255, 0.3)";
				ctx.fillText(w.document.title, x + w.innerWidth / 2, y - bar / 2);
			}
			let lights = bar ? { x: x + 14, y: y - bar / 2 } : { x: x + 19, y: y + 18 };
			LIGHTS.forEach((colour, i) => {
				ctx.beginPath();
				ctx.arc(lights.x + i * 20, lights.y, 6, 0, 2 * Math.PI);
				// A dialog cannot be minimised.
				ctx.fillStyle = active && !(bar && i === 1) ? colour : LIGHT_OFF;
				ctx.fill();
			});
			ctx.restore();

			ctx.save();
			ctx.beginPath();
			ctx.roundRect(x + 0.5, y - bar + 0.5, w.innerWidth - 1, w.innerHeight + bar - 1, RADIUS);
			ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
			ctx.lineWidth = 1;
			ctx.stroke();
			ctx.restore();
		}
	},

	save(path, type, quality) {
		let write = new Promise(resolve => this.picture.toBlob(resolve, type, quality))
			.then(async blob => IOUtils.write(path, new Uint8Array(await blob.arrayBuffer())))
			.finally(() => this.writes.delete(write));
		this.writes.add(write);
		return write;
	},

	// One turn of the camera: a picture, if anything was painted and the disk keeps up.
	turn() {
		this.front();
		if (this.writes.size >= 3) {
			return;
		}
		if (!this.develop()) {
			return;
		}
		this.stale = false;
		let t = Date.now() - this.startedAt;
		this.compose();
		this.frames++;
		// A picture that cannot be saved ends the film: stop() reports it.
		this.save(PathUtils.join(this.folder, String(t).padStart(7, "0") + ".jpg"), "image/jpeg", 0.95)
			.catch((error) => { this.error = this.error || error; });
	},

	roll() {
		let began = Date.now();
		try {
			this.turn();
		}
		catch (error) {
			// Kept for stop(), which is where the scene hears about its film.
			this.error = this.error || error;
			return;
		}
		this.timer = main.setTimeout(() => this.roll(), Math.max(REST, PERIOD - (Date.now() - began)));
	},

	// Films into a folder, one JPEG a picture, named by its time in ms since startedAt.
	async start(folder, startedAt) {
		this.halt();
		await IOUtils.makeDirectory(folder);
		Object.assign(this, { folder, startedAt, frames: 0, covered: 0, error: null, stale: true, track: [] });
		this.place(this.pointer.x, this.pointer.y);
		this.roll();
	},

	halt() {
		main.clearTimeout(this.timer);
		this.timer = null;
		for (let [w, layer] of this.layers) {
			w.removeEventListener("MozAfterPaint", layer.onPaint);
		}
		this.layers.clear();
	},

	// Ends the film: the pictures are on disk, and pointer.json beside them says where
	// the pointer was. Returns how many pictures, and how many found a window covered.
	async stop() {
		this.place(this.pointer.x, this.pointer.y);
		this.halt();
		await Promise.allSettled([...this.writes]);
		if (this.error) {
			throw this.error;
		}
		await IOUtils.writeJSON(PathUtils.join(this.folder, "pointer.json"), { frame, scale: SCALE, track: this.track });
		return { frames: this.frames, covered: this.covered };
	},

	// What the frame holds now, as a PNG: a rehearsal keeps one at every mark of a scene.
	async still(path) {
		this.front();
		this.develop(true);
		this.compose();
		await this.save(path, "image/png");
	},

	// The window under a point of the screen, the one in front first, and the point in it.
	under(x, y) {
		for (let w of this.windows().reverse()) {
			let inside = { w, x: x - w.mozInnerScreenX, y: y - w.mozInnerScreenY };
			if (inside.x >= 0 && inside.y >= 0 && inside.x < w.innerWidth && inside.y < w.innerHeight) {
				return inside;
			}
		}
		return null;
	},

	// The pointer macOS would show there: a hand on what can be clicked, a beam on text.
	kind({ w, x, y }) {
		let el = w.document.elementFromPoint(x, y);
		// The page of a PDF is two frames deep.
		while (el?.contentDocument) {
			let box = el.getBoundingClientRect();
			x -= box.left;
			y -= box.top;
			let inner = el.contentDocument.elementFromPoint(x, y);
			if (!inner) {
				break;
			}
			el = inner;
		}
		if (!el) {
			return "arrow";
		}
		let style = el.ownerGlobal.getComputedStyle(el);
		if (style.cursor === "pointer") {
			return "pointer";
		}
		if (style.cursor === "text") {
			return "text";
		}
		if (style.cursor !== "auto" || style.userSelect === "none") {
			return "arrow";
		}
		if (el.matches("textarea, input:not([type=button], [type=checkbox], [type=radio], [type=range], [type=submit])")) {
			return "text";
		}
		// Left to the browser, the beam shows over the letters of text that can be selected.
		for (let node of el.childNodes) {
			if (node.nodeType !== node.TEXT_NODE || !node.data.trim()) {
				continue;
			}
			let range = el.ownerDocument.createRange();
			range.selectNodeContents(node);
			if ([...range.getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) {
				return "text";
			}
		}
		return "arrow";
	},

	// A mouse event at a point of a window, with the button down or not.
	mouse(type, { w, x, y }, held) {
		w.windowUtils.sendMouseEvent(type, x, y, 0, type === "mousemove" ? 0 : 1, 0, false, 0, w.MouseEvent.MOZ_SOURCE_MOUSE, true, false, held ? 1 : 0);
	},

	// Puts the pointer at a point of the screen: Zotero hears it move there.
	place(x, y) {
		Object.assign(this.pointer, { x, y });
		let hit = this.under(x, y);
		if (hit) {
			this.mouse("mousemove", hit, this.pointer.held);
			// What is dragged keeps the pointer it was taken with.
			if (!this.pointer.held) {
				this.pointer.kind = this.kind(hit);
			}
		}
		this.track.push({ t: Date.now() - this.startedAt, x: x - frame.x, y: y - frame.y, kind: this.pointer.kind });
	},

	// Moves the pointer the way a hand does: off slowly, fast in the middle, in slowly.
	async move(x, y, ms) {
		let from = { ...this.pointer };
		let began = Date.now();
		for (let t = 0; t < 1;) {
			t = ms ? Math.min(1, (Date.now() - began) / ms) : 1;
			let eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
			this.place(from.x + (x - from.x) * eased, from.y + (y - from.y) * eased);
			await new Promise(resolve => main.setTimeout(resolve, 16));
		}
	},

	// The button, down or up, where the pointer is: false when no window of Zotero is under it.
	button(held) {
		let hit = this.under(this.pointer.x, this.pointer.y);
		if (!hit) {
			return false;
		}
		this.pointer.held = held;
		this.mouse(held ? "mousedown" : "mouseup", hit, held);
		return true;
	},

	press() {
		return this.button(true) && this.button(false);
	},

	// A character into the field that has the focus, as a key would go: false with none.
	type(char) {
		let field = this.windows().map(w => w.document.activeElement).find(el => el && "selectionStart" in el);
		if (!field) {
			return false;
		}
		field.setRangeText(char, field.selectionStart, field.selectionEnd, "end");
		field.dispatchEvent(new field.ownerGlobal.InputEvent("input", { bubbles: true }));
		return true;
	},
};
return true;
