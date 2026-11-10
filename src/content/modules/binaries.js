"use strict";

Object.assign(Zusia, {
	// ---------------------------------------------------------------------
	// Finding the agent CLIs, and the environment they are run in
	// ---------------------------------------------------------------------

	extraSearchPaths(home) {
		if (Zotero.isWin) {
			// The native installers' folders (Claude, Antigravity, Codex) come before npm's,
			// so their .exe is found before an npm shim.
			return [
				OS.Path.join(home, ".local", "bin"),
				OS.Path.join(home, "AppData", "Local", "agy", "bin"),
				OS.Path.join(home, "AppData", "Local", "Programs", "OpenAI", "Codex", "bin"),
				OS.Path.join(home, "AppData", "Roaming", "npm"),
			];
		}
		return [
			"/usr/local/bin",
			"/opt/homebrew/bin",
			"/opt/local/bin",
			OS.Path.join(home, ".local", "bin"),
			OS.Path.join(home, ".claude", "local"),
			OS.Path.join(home, ".npm-global", "bin"),
			OS.Path.join(home, "bin"),
		];
	},

	async findBinary(backend) {
		let { label, command, pathPref } = this.BACKENDS[backend];
		let override = this.getPref(pathPref);
		if (override) {
			// Windows itself takes C:/…, but Gecko's path functions refuse a forward slash.
			return this.avoidBatchFile(backend, Zotero.isWin ? override.replace(/\//g, "\\") : override);
		}

		let searchEnv = this.buildChildEnvironment();
		// Windows: Mozilla tries the bare name before PATHEXT, and npm puts an extensionless
		// sh shim next to its .cmd, which CreateProcess cannot start. So ask for the .exe,
		// and only then for an npm .cmd shim to resolve.
		let names = Zotero.isWin ? [command + ".exe", command + ".cmd"] : [command];
		for (let name of names) {
			// pathSearch rejects when the name is on none of the paths.
			let found = await Subprocess.pathSearch(name, searchEnv).catch(() => null);
			if (found) {
				return this.avoidBatchFile(backend, found);
			}
		}
		throw new Error(
			"Could not find the '" + command + "' command. Make sure the " + label + " CLI is " +
			"installed and on your PATH, or set " + this.PREF_PREFIX + pathPref + " (Zotero " +
			"Settings → Advanced → Config Editor) to its full path."
		);
	},

	// Mozilla runs a .cmd/.bat through cmd.exe, which re-parses the prompt: a newline ends
	// the command and a quote followed by & runs whatever comes next, and the prompt holds
	// the paper's text. So an npm shim is swapped for what it launches, and nothing else
	// batch-like runs at all (Node and Rust refuse them too: CVE-2024-27980, CVE-2024-24576).
	// Windows drops trailing dots and spaces from a file name, so "claude.bat." is a batch file.
	async avoidBatchFile(backend, path) {
		if (!/\.(cmd|bat)[. ]*$/i.test(path)) {
			return path;
		}
		// What npm's cmd-shim runs: claude.exe since Claude Code 2.1.113, node codex.js for Codex.
		let target = {
			claude: ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
			codex: ["node_modules", "@openai", "codex", "bin", "codex.js"],
		}[backend];
		if (/\.cmd[. ]*$/i.test(path) && target) {
			let resolved = OS.Path.join(OS.Path.dirname(path), ...target);
			if (await OS.File.exists(resolved)) {
				return resolved;
			}
		}
		let { label, pathPref } = this.BACKENDS[backend];
		throw new Error(
			"Zusia will not run batch files (.cmd/.bat) such as " + path + ": Windows hands their " +
			"arguments to cmd.exe, which can cut the prompt short or run commands hidden in it. " +
			"Install or update the " + label + " CLI so it provides an .exe, or set " +
			this.PREF_PREFIX + pathPref + " (Zotero Settings → Advanced → Config Editor) to the .exe."
		);
	},

	buildChildEnvironment() {
		let env = Subprocess.getEnvironment();
		// Force subscription logins instead of pay-per-token API keys.
		delete env.ANTHROPIC_API_KEY;
		delete env.ANTHROPIC_AUTH_TOKEN;
		delete env.OPENAI_API_KEY;

		if (!Zotero.isWin) {
			let home = env.HOME || env.USERPROFILE || "";
			env.PATH = this.extraSearchPaths(home).join(":") + (env.PATH ? ":" + env.PATH : "");
			return env;
		}
		// Windows spells the variable "Path", while Mozilla's pathSearch reads only PATH and
		// getEnvironment keeps the name as it finds it. Left alone, only our own folders
		// would be searched and the child would get the variable twice.
		let own = "";
		for (let name of Object.keys(env)) {
			if (name.toUpperCase() === "PATH") {
				own = own || env[name];
				delete env[name];
			}
		}
		// A HOME from Git Bash or MSYS (/c/Users/…) is not a path Windows programs can use.
		let home = env.USERPROFILE || env.HOME || "";
		// pathSearch gives up on the first folder Gecko refuses, so only native absolute ones stay.
		env.PATH = [...this.extraSearchPaths(home), ...own.split(";")]
			.map(dir => dir.replace(/\//g, "\\"))
			.filter(dir => /^([A-Za-z]:\\|\\\\)/.test(dir))
			.join(";");
		return env;
	},
});
