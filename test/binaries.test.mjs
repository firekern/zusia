// How findBinary finds an agent's program on macOS and Linux; the Windows rules are in
// windows.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const PREFIX = "extensions.zusia.";
const HOME = "/home/u";
// What Zotero started from the Dock or a desktop menu inherits: no shell rc ran.
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// Subprocess as Mozilla's subprocess_unix.sys.mjs has it: pathSearch takes a full path as
// given once it is an executable file, and tries a name in each PATH folder in turn.
// `executables` are the executable files on disk.
function loadPosixPlugin({ prefs = {}, executables = [], environment = { HOME, PATH: LAUNCHD_PATH } } = {}) {
	const env = loadPlugin({ prefs });
	const onDisk = new Set(executables);
	env.Subprocess.getEnvironment = () => ({ ...environment });
	env.Subprocess.pathSearch = async (bin, searchEnv) => {
		if (bin.startsWith("/")) {
			if (onDisk.has(bin)) {
				return bin;
			}
			throw new Error("File at path \"" + bin + "\" does not exist, or is not executable");
		}
		// PathUtils.join refuses a component with a "/" in it, and pathSearch does not catch that.
		if (bin.includes("/")) {
			throw new Error("Could not initialize path: NS_ERROR_FILE_UNRECOGNIZED_PATH");
		}
		for (const dir of (searchEnv.PATH || "").split(":")) {
			if (onDisk.has(dir + "/" + bin)) {
				return dir + "/" + bin;
			}
		}
		throw new Error("Executable not found: " + bin);
	};
	return env;
}

// The command an ACP agent was added with, as the add form stores it.
const typedAgent = (command, options = {}) => loadPosixPlugin({ ...options,
	prefs: { [PREFIX + "acpAgents"]: JSON.stringify([{ id: "agent", name: "Agent", command, args: ["acp"] }]), ...options.prefs } }).plugin;

test("findBinary: a bare name is searched in Zusia's extra folders, then on the inherited PATH", async () => {
	assert.equal(await loadPosixPlugin({ executables: ["/opt/homebrew/bin/claude", "/usr/bin/claude"] }).plugin.findBinary("claude"), "/opt/homebrew/bin/claude");
	assert.equal(await loadPosixPlugin({ executables: ["/usr/bin/codex"] }).plugin.findBinary("codex"), "/usr/bin/codex");
	assert.equal(await typedAgent("opencode", { executables: [HOME + "/.local/bin/opencode"] }).findBinary("acp:agent"), HOME + "/.local/bin/opencode");
});

test("findBinary: a ~ command is under HOME", async () => {
	const nvm = HOME + "/.nvm/versions/node/v22.11.0/bin/command-code";
	assert.equal(await typedAgent("~/.nvm/versions/node/v22.11.0/bin/command-code", { executables: [nvm] }).findBinary("acp:agent"), nvm);
});

test("findBinary: a full path is used as given, and only if it is an executable file", async () => {
	assert.equal(await typedAgent("/opt/opencode/bin/opencode", { executables: ["/opt/opencode/bin/opencode"] }).findBinary("acp:agent"), "/opt/opencode/bin/opencode");
	await assert.rejects(typedAgent("/opt/opencode/bin/opencode").findBinary("acp:agent"), /Could not find the '\/opt\/opencode\/bin\/opencode' command/);
});

test("findBinary: a path setting wins over the bare name, takes ~, and is reported when it is missing", async () => {
	const executables = ["/usr/bin/claude", "/opt/claude/claude", HOME + "/bin/claude-beta"];
	assert.equal(await loadPosixPlugin({ executables, prefs: { [PREFIX + "claudePath"]: "/opt/claude/claude" } }).plugin.findBinary("claude"), "/opt/claude/claude");
	assert.equal(await loadPosixPlugin({ executables, prefs: { [PREFIX + "claudePath"]: "~/bin/claude-beta" } }).plugin.findBinary("claude"), HOME + "/bin/claude-beta");
	await assert.rejects(loadPosixPlugin({ executables, prefs: { [PREFIX + "claudePath"]: "/opt/old/claude" } }).plugin.findBinary("claude"), /Could not find the '\/opt\/old\/claude' command/);
});

test("findBinary: a name on none of the paths is reported, and no .exe is tried outside Windows", async () => {
	await assert.rejects(loadPosixPlugin({ executables: ["/usr/bin/claude.exe"] }).plugin.findBinary("claude"), /Could not find the 'claude' command\. Make sure Claude is installed/);
	await assert.rejects(typedAgent("opencode").findBinary("acp:agent"), /Could not find the 'opencode' command\. Make sure Agent is installed/);
});
