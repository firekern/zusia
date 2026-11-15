"use strict";

Object.assign(Zusia, {
	// A native Unsloth load changes shared server state. Keep a lease through
	// completion/tool replay: matching model/profile requests may share it, while
	// a different model or Settings reload waits in FIFO order.
	async acquireUnslothConnection(config, model, control, onProgress = () => {}) {
		if (this._apiConnectionsStopped) control.cancelled = true;
		if (control.cancelled) return null;
		let url = this.normalizeAPIURL(config.baseURL);
		let key = JSON.stringify([model, this.apiProfileSettings(config, model)]);
		this._apiConnections = this._apiConnections || new Map();
		let state = this._apiConnections.get(url);
		if (!state) { state = { key: null, active: new Set(), queue: [] }; this._apiConnections.set(url, state); }
		if (state.queue.length || state.active.size && state.key !== key) onProgress({ status: "waiting for the current Unsloth model" });
		return new Promise(resolve => {
			let entry = { key, control, resolve };
			entry.cancel = () => {
				let index = state.queue.indexOf(entry);
				if (index < 0) return;
				state.queue.splice(index, 1);
				if (control.abort === entry.cancel) control.abort = null;
				resolve(null);
				this.pumpAPIConnection(url, state);
			};
			control.abort = entry.cancel;
			state.queue.push(entry);
			if (control.cancelled || this._apiConnectionsStopped) { control.cancelled = true; entry.cancel(); }
			else this.pumpAPIConnection(url, state);
		});
	},

	pumpAPIConnection(url, state) {
		while (state.queue.length) {
			let entry = state.queue[0], control = entry.control;
			if (control.cancelled || this._apiConnectionsStopped) {
				control.cancelled = true; state.queue.shift();
				if (control.abort === entry.cancel) control.abort = null;
				entry.resolve(null); continue;
			}
			if (state.active.size && state.key !== entry.key) break;
			state.queue.shift(); state.key = entry.key; state.active.add(control);
			if (control.abort === entry.cancel) control.abort = null;
			let released = false;
			entry.resolve(() => {
				if (released) return;
				released = true; state.active.delete(control);
				this.pumpAPIConnection(url, state);
			});
		}
		if (!state.active.size && !state.queue.length && this._apiConnections.get(url) === state) this._apiConnections.delete(url);
	},

	stopAPIConnections() {
		this._apiConnectionsStopped = true;
		for (let pending of this._pending.values()) {
			if (!this.isAPIBackend(pending.backend)) continue;
			try { pending.cancel?.(); }
			catch (error) { this.log("Stopping an API chat needs attention"); }
		}
		let controls = new Set(this._apiRequestControls || []);
		for (let state of this._apiConnections?.values() || []) {
			for (let control of state.active) controls.add(control);
			for (let entry of state.queue) controls.add(entry.control);
		}
		for (let control of controls) {
			control.cancelled = true;
			try { control.abort?.(); }
			catch (error) { this.log("Stopping an API request needs attention"); }
		}
	},
});
