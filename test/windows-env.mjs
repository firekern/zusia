// Loads the plugin as Zotero on Windows runs it. load-plugin.mjs stubs paths and
// Subprocess the POSIX way, which hides the Windows failure modes: Gecko's PathUtils
// takes only native paths there (a drive or \\server, backslashes, no "/"), Zotero's
// OS.Path falls back to gluing strings with "\" when PathUtils refuses, Mozilla's
// pathSearch reads PATH and PATHEXT case-sensitively, and Windows itself spells the
// variable "Path". The models below follow these sources, so a test here passes or
// fails for the reasons the real thing would; test/integration/windows/run.sh checks
// the path model against the real Windows Gecko under Wine:
//   PathUtils: xpcom/io/nsLocalFileWin.cpp (InitWithPath, AppendInternal)
//   OS.Path:   chrome://zotero/content/osfile.mjs (Zotero 10.0.8)
//   Subprocess: resource://gre/modules/subprocess/subprocess_win.sys.mjs (Zotero 10.0.8)
import { loadPlugin } from "./load-plugin.mjs";

export const HOME = "C:\\Users\\u";
export const TEMP = HOME + "\\AppData\\Local\\Temp";
export const NPM = HOME + "\\AppData\\Roaming\\npm";
export const NODE_DIR = "C:\\Program Files\\nodejs";
export const DATA_DIR = HOME + "\\Zotero";
export const CLAUDE_NATIVE = HOME + "\\.local\\bin\\claude.exe";
export const CLAUDE_NPM_EXE = NPM + "\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
export const CODEX_JS = NPM + "\\node_modules\\@openai\\codex\\bin\\codex.js";
export const NODE_EXE = NODE_DIR + "\\node.exe";
export const PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

// The message Gecko's errors carry, which Zotero's OS.Path.join looks for.
const unrecognized = path => new Error("Could not initialize path: NS_ERROR_FILE_UNRECOGNIZED_PATH: " + JSON.stringify(path));

function native(path) {
	if (path === "") {
		throw new Error("PathUtils does not support empty paths");
	}
	if (typeof path !== "string" || path.includes("/") || !/^([A-Za-z]:(\\|$)|\\\\)/.test(path)) {
		throw unrecognized(path);
	}
	// nsIFile drops trailing separators, except the one after a drive.
	return /^[A-Za-z]:\\$/.test(path) ? path : path.replace(/\\+$/, "");
}

function append(base, component, multiple) {
	if (component === "") {
		return base;
	}
	if (component.startsWith("\\") || component.includes("/") || component === ".." ||
		(multiple ? component.split("\\").includes("..") : component.includes("\\"))) {
		throw unrecognized(component);
	}
	return base.endsWith("\\") ? base + component : base + "\\" + component;
}

export function windowsPathUtils() {
	return {
		tempDir: TEMP,
		isAbsolute(path) {
			try {
				native(path);
				return true;
			}
			catch {
				return false;
			}
		},
		join(base, ...components) {
			return components.reduce((path, c) => append(path, c, false), native(base));
		},
		joinRelative(base, relative) {
			return append(native(base), relative, true);
		},
		// Gecko answers "C:" for the parent of "C:\\a", and nothing above a drive.
		parent(path) {
			let p = native(path);
			return /^[A-Za-z]:\\?$/.test(p) ? null : p.slice(0, p.lastIndexOf("\\"));
		},
		filename(path) {
			let p = native(path);
			return p.slice(p.lastIndexOf("\\") + 1);
		},
	};
}

// Zotero's OS.Path on WINNT, line for line.
export function windowsOSPath(PathUtils) {
	return {
		join(path, ...args) {
			try {
				if (args.length == 0) {
					return path;
				}
				if (args.length == 1 && args[0].includes("\\")) {
					return PathUtils.joinRelative(path, ...args);
				}
				return PathUtils.join(path, ...args);
			}
			catch (e) {
				if (e.message.includes("NS_ERROR_FILE_UNRECOGNIZED_PATH")) {
					return [path, ...args].join("\\");
				}
				throw e;
			}
		},
		dirname: path => PathUtils.parent(path),
		basename: path => PathUtils.filename(path),
	};
}

// `environment` is what Subprocess.getEnvironment() returns: Windows keeps each
// variable's own spelling, and a stock install has "Path".
export function loadWindowsPlugin({ prefs = {}, executables = [], environment } = {}) {
	const files = new Map(executables.map(path => [path, ""]));
	const env = loadPlugin({ prefs, files });
	const { window, Subprocess } = env;
	// The loader exposes OS only because the plugin declares it with a top-level var.
	if (!window.OS) {
		throw new Error("windows-env: the plugin no longer leaves OS on window; adjust how this helper reaches it");
	}
	const PathUtils = windowsPathUtils();
	window.PathUtils = PathUtils;
	window.OS.Path = windowsOSPath(PathUtils);
	window.Zotero.isWin = true;
	window.Zotero.isMac = false;
	window.Zotero.isLinux = false;
	window.Zotero.DataDirectory = { dir: DATA_DIR };

	const base = environment || { USERPROFILE: HOME, Path: "C:\\Windows\\system32;C:\\Windows;" + NODE_DIR, PATHEXT };
	Subprocess.getEnvironment = () => ({ ...base });
	const isExecutableFile = async path => PathUtils.isAbsolute(path) && files.has(path);
	Subprocess.pathSearch = async (bin, environment) => {
		if (PathUtils.isAbsolute(bin)) {
			if (await isExecutableFile(bin)) {
				return bin;
			}
			throw new Error("File at path \"" + bin + "\" does not exist, or is not a normal file");
		}
		let dirs = environment.PATH ? environment.PATH.split(";") : [];
		let exts = environment.PATHEXT ? environment.PATHEXT.split(";") : [];
		for (let dir of dirs) {
			// Not guarded in Mozilla either: a PATH entry PathUtils refuses ends the search.
			let path = PathUtils.join(dir, bin);
			if (await isExecutableFile(path)) {
				return path;
			}
			for (let ext of exts) {
				if (await isExecutableFile(path + ext)) {
					return path + ext;
				}
			}
		}
		throw new Error("Executable not found: " + bin);
	};

	// Records each spawn and answers `cli.stdout`; like Subprocess.call, refuses a
	// command that is not an existing file at a native absolute path.
	const spawns = [];
	const cli = { stdout: "" };
	Subprocess.call = async (options) => {
		if (!(await isExecutableFile(options.command))) {
			throw new Error("File at path \"" + options.command + "\" does not exist, or is not executable");
		}
		const run = { command: options.command, args: [...options.arguments], workdir: options.workdir, environment: options.environment, stdin: [], closed: false };
		spawns.push(run);
		let stdout = cli.stdout;
		return {
			stdin: {
				write: async (s) => { run.stdin.push(s); },
				close: async () => { run.closed = true; },
			},
			stdout: { readString: async () => { const out = stdout; stdout = ""; return out; } },
			stderr: { readString: async () => "" },
			wait: async () => ({ exitCode: 0 }),
		};
	};
	return { ...env, files, spawns, cli, PathUtils };
}

// A path Windows would see as two styles at once, or that Gecko would refuse.
export const mixedSeparators = path => path.includes("/") && path.includes("\\");
