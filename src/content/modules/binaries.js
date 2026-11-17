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

	// An ACP agent's card shows its command but cannot edit it, so the way to another
	// program is to add the agent again.
	commandFixHint(backend) {
		return this.BACKENDS[backend].pathPref
			? "To run a copy that is not on your PATH, enter its full path as Command path in Zotero Settings → Zusia → Assistants."
			: "Check its command in Zotero Settings → Zusia → Assistants. To change it, remove the agent and add it again with the program's full path.";
	},

	missingBinaryMessage(backend, command) {
		return "Could not find the '" + command + "' command. Make sure " + this.BACKENDS[backend].label + " is installed. " +
			this.commandFixHint(backend);
	},

	async findBinary(backend) {
		let { command, pathPref } = this.BACKENDS[backend];
		let env = this.buildChildEnvironment();
		let wanted = (pathPref && this.getPref(pathPref)) || command;
		// Windows itself takes C:/…, but Gecko's path functions refuse a forward slash.
		if (Zotero.isWin) {
			wanted = wanted.replace(/\//g, "\\");
		}
		if (/^~[\\/]/.test(wanted)) {
			wanted = OS.Path.join(this.homeFolder(env), wanted.slice(2));
		}
		// Windows: Mozilla tries the bare name before PATHEXT, and npm puts an extensionless
		// sh shim next to its .cmd, which CreateProcess cannot start. So a name without an
		// extension is asked for as an .exe, and only then as an npm .cmd shim to resolve.
		let names = Zotero.isWin && !/\.[^.\\]+[. ]*$/.test(wanted) ? [wanted + ".exe", wanted + ".cmd"] : [wanted];
		for (let name of names) {
			// pathSearch takes a full path as given once it is an executable file, and
			// rejects a name that is on none of the paths.
			let found = await Subprocess.pathSearch(name, env).catch(() => null);
			if (found) {
				return this.avoidBatchFile(backend, found);
			}
		}
		// Marked, so Settings and the menu can tell a missing program from one found but refused.
		throw Object.assign(new Error(this.missingBinaryMessage(backend, wanted)), { notFound: true });
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
		// What npm's cmd-shim runs: claude.exe since Claude Code 2.1.113, node codex.js for
		// Codex, node index.mjs for Command Code. Looked up by the shim's own name, because
		// the program decides what it runs, while an ACP agent's id comes from the name the
		// reader gave it.
		let target = {
			"claude.cmd": ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
			"codex.cmd": ["node_modules", "@openai", "codex", "bin", "codex.js"],
			"command-code.cmd": ["node_modules", "command-code", "dist", "index.mjs"],
		}[OS.Path.basename(path).replace(/[. ]+$/, "").toLowerCase()];
		if (target) {
			let resolved = OS.Path.join(OS.Path.dirname(path), ...target);
			if (await OS.File.exists(resolved)) {
				return resolved;
			}
		}
		throw new Error(
			"Zusia will not run batch files (.cmd/.bat) such as " + path + ": Windows hands their " +
			"arguments to cmd.exe, which can cut the prompt short or run commands hidden in it. " +
			"Install or update " + this.BACKENDS[backend].label + " so it provides a native program. " +
			this.commandFixHint(backend)
		);
	},

	buildChildEnvironment() {
		let env = Subprocess.getEnvironment();
		// Force subscription logins instead of pay-per-token API keys.
		delete env.ANTHROPIC_API_KEY;
		delete env.ANTHROPIC_AUTH_TOKEN;
		delete env.OPENAI_API_KEY;

		if (!Zotero.isWin) {
			env.PATH = this.extraSearchPaths(this.homeFolder(env)).join(":") + (env.PATH ? ":" + env.PATH : "");
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
		// pathSearch gives up on the first folder Gecko refuses, so only native absolute ones stay.
		env.PATH = [...this.extraSearchPaths(this.homeFolder(env)), ...own.split(";")]
			.map(dir => dir.replace(/\//g, "\\"))
			.filter(dir => /^([A-Za-z]:\\|\\\\)/.test(dir))
			.join(";");
		return env;
	},

	// A HOME from Git Bash or MSYS (/c/Users/…) is not a path Windows programs can use, so
	// there USERPROFILE comes first.
	homeFolder(env) {
		return Zotero.isWin ? (env.USERPROFILE || env.HOME || "") : (env.HOME || env.USERPROFILE || "");
	},
});
