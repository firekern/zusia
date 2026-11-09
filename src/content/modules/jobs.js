"use strict";

Object.assign(Zusia, {
	// --------------------------------------------------------------- background memory

	consolidating() {
		return this.getPref("memory.consolidate") !== false;
	},

	gisting() {
		return this.getPref("memory.gists") === true;
	},

	// The CLI that runs memory jobs: the assistant in use, when it can run with nothing to
	// read. Codex cannot: its read-only sandbox still reads the whole home folder.
	jobBackend() {
		let backend = this.getBackend();
		return backend === "claude" || backend === "agy" ? backend : null;
	},

	memoryJobsAvailable() {
		return this.consolidating() && this.jobBackend() !== null;
	},

	// Queued unless the same job is already waiting; one running is not enough, as turns
	// may have come in after it read them. `run(job)` resolves to {called, rateLimited}
	// or nothing.
	queueJob(job) {
		if (this._jobsStopped || this._jobs.some(j => j.key === job.key)) {
			return false;
		}
		this._jobs.push(Object.assign({ proc: null, cancelled: false }, job));
		this.pumpJobs();
		return true;
	},

	// Starts the next job: one at a time, never while a question runs (the CLI and the
	// subscription are the user's first), and not while a rate limit pauses them. Returns
	// the job's promise, which never rejects.
	pumpJobs() {
		if (this._job || this._jobsStopped || !this._jobs.length || this._pending.size) {
			return null;
		}
		let wait = this._jobBackoff.until - Date.now();
		if (wait > 0) {
			if (!this._jobBackoff.wake) {
				this._jobBackoff.wake = true;
				Zotero.Promise.delay(wait).then(() => {
					this._jobBackoff.wake = false;
					this.pumpJobs();
				});
			}
			return null;
		}
		let job = this._jobs.shift();
		this._job = job;
		this.refreshReadingChips(job.dir);
		job.promise = Promise.resolve()
			.then(() => job.run(job))
			.then((outcome) => {
				if (outcome && outcome.rateLimited) {
					let delay = Math.min(this._jobBackoff.delay ? this._jobBackoff.delay * 2 : this.JOB_BACKOFF_MS, this.JOB_BACKOFF_MAX_MS);
					this._jobBackoff = { delay, until: Date.now() + delay, wake: false };
					this.log("Memory jobs paused for " + Math.round(delay / 60000) + " minutes: the assistant reported a rate limit");
					if (!job.cancelled && !this._jobs.some(j => j.key === job.key)) {
						this._jobs.unshift(job);
					}
				}
				else if (outcome && outcome.called) {
					this._jobBackoff = { delay: 0, until: 0, wake: false };
				}
			}, e => this.logError("memory job " + job.key, e))
			.finally(() => {
				this._job = null;
				this.refreshReadingChips(job.dir);
				this.pumpJobs();
			});
		return job.promise;
	},

	// Resolves once no job is running.
	async jobsIdle() {
		while (this._job) {
			await this._job.promise;
		}
	},

	// At shutdown nothing new starts and a running call is stopped. What it would have
	// written is dropped: its turns stay unconsolidated, the chat's after coveredThrough and
	// a put-away chat's in memory.json's pendingArchives, so the next start takes them up.
	stopJobs() {
		this._jobsStopped = true;
		this._jobs = [];
		if (this._job) {
			this._job.cancelled = true;
			try {
				this._job.proc?.kill();
			}
			catch (e) {
				this.logError("stopping a memory job", e);
			}
		}
	},

	isRateLimited(text) {
		return /\b429\b|rate[ _-]?limit|usage limit|quota|resource[ _]?exhausted|too many requests/i.test(text || "");
	},

	// Stateless and with nothing to use: no session kept, no MCP servers or tools.
	// "--tools=" is one argument whose empty value Claude reads as no tools at all (an
	// empty argument of its own would be dropped on Windows, #1). The user's settings are
	// left out as for the chat, unless the chat uses them: a login or endpoint set there
	// (apiKeyHelper, ANTHROPIC_BASE_URL) is needed by the jobs too, and tools stay off.
	// agy has no flag that keeps a conversation from being stored, so each job is one in
	// its history (not checked yet: whether "agy --continue" elsewhere could resume one).
	backgroundArgs(backend) {
		if (backend === "claude") {
			let args = ["-p", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--tools=",
				"--strict-mcp-config", "--no-session-persistence"];
			if (!this.getPref("useClaudeUserSettings")) {
				args.push("--setting-sources=");
			}
			return args;
		}
		return ["--output-format", "stream-json", "--sandbox", "--effort", "low"];
	},

	// A new empty folder per call, so a backend that can list or read files finds nothing.
	async makeJobDir() {
		let dir = OS.Path.join(PathUtils.tempDir, "zusia-job-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
		await Zotero.File.createDirectoryIfMissingAsync(dir);
		return dir;
	},

	// One prompt on stdin, no session, in an empty folder. Resolves to {text, error,
	// rateLimited}; `job`, when given, can stop the call. A CLI that cannot be found or
	// started is an error like one that answered nothing, so the failure counts apply.
	async runBackgroundCall(backend, prompt, job = null) {
		let command;
		try {
			command = await this.findBinary(backend);
		}
		catch (e) {
			this.logError("starting a memory job", e);
			return { text: "", error: e.message, rateLimited: false };
		}
		let cwd = await this.makeJobDir();
		let proc = null;
		let finished = false;
		let timedOut = false;
		Zotero.Promise.delay(this.JOB_TIMEOUT_MS).then(() => {
			if (!finished && proc) {
				timedOut = true;
				proc.kill();
			}
		});
		try {
			let run;
			try {
				run = await this.runProcess(command, this.backgroundArgs(backend), cwd, null, (p) => {
					proc = p;
					if (job) {
						job.proc = p;
						if (job.cancelled) {
							p.kill();
						}
					}
				}, prompt);
			}
			catch (e) {
				this.logError("running a memory job", e);
				return { text: "", error: e.message, rateLimited: false };
			}
			let { stdout, stderr, exitCode } = run;
			let events = this.parseJsonLines(stdout);
			let text = "";
			let error = "";
			if (backend === "claude") {
				({ text, error = "" } = this.parseClaudeEvents(events));
			}
			else {
				let { final } = this.parseAntigravityEvents(events);
				text = final && final.status === "SUCCESS" ? (final.response || "").trim() : "";
				error = (final && final.error) || "";
			}
			if (timedOut) {
				error = "no answer within " + Math.round(this.JOB_TIMEOUT_MS / 60000) + " minutes";
			}
			else if (exitCode !== 0 || !text) {
				error = error || stderr.trim() || backend + " exited with code " + exitCode;
			}
			if (error) {
				return { text: "", error, rateLimited: this.isRateLimited(stderr + "\n" + error) };
			}
			return { text, error: "", rateLimited: false };
		}
		finally {
			finished = true;
			if (job) {
				job.proc = null;
			}
			// A just-stopped CLI can still hold the folder on Windows; the call's outcome
			// (a rate limit above all) matters more than a leftover empty folder.
			try {
				await OS.File.removeDir(cwd);
			}
			catch (e) {
				this.logError("removing a job folder", e);
			}
		}
	},
});
