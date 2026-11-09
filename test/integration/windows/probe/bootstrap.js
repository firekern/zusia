// Asks the real Windows Gecko the questions test/windows-env.mjs answers with a model
// and writes the answers to probe.json next to results.json; check-probe.mjs then
// compares the two, so the unit tests' Windows paths stay true to Zotero itself.
/* global Zotero, PathUtils, IOUtils, ChromeUtils */

// Each call is [function, ...arguments], answered by the real PathUtils or OS.Path.
const CALLS = [
	["PathUtils.join", "C:\\a\\", "b", "c.txt"],
	["PathUtils.join", "C:/a", "x"],
	["PathUtils.join", "/c/Users/u", "x"],
	["PathUtils.join", "relative\\dir", "x"],
	["PathUtils.join", "", "x"],
	["PathUtils.join", "C:\\a", "b\\c"],
	["PathUtils.join", "C:\\a", "b/c"],
	["PathUtils.joinRelative", "C:\\a", "b\\c"],
	["PathUtils.parent", "C:\\a\\b"],
	["PathUtils.parent", "C:\\a"],
	["PathUtils.parent", "C:/a/b.cmd"],
	["PathUtils.filename", "C:\\a\\b.md"],
	["PathUtils.isAbsolute", "C:\\a"],
	["PathUtils.isAbsolute", "C:/a"],
	["PathUtils.isAbsolute", "/c/Users/u"],
	["OS.Path.join", "C:\\a", "b/c"],
	["OS.Path.join", "C:\\a", "b\\c"],
	["OS.Path.join", "C:\\a", "b", "c"],
	["OS.Path.dirname", "C:\\a\\b.cmd"],
];

async function startup() {
	let outDir = Zotero.Prefs.get("extensions.zusia-tester.outDir", true);
	let { OS } = ChromeUtils.importESModule("chrome://zotero/content/osfile.mjs");
	let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
	let scope = { PathUtils, OS };
	let calls = CALLS.map(([name, ...args]) => {
		let [object, ...rest] = name.split(".");
		let fn = rest.reduce((o, key) => o[key], scope[object]);
		try {
			return { name, args, value: fn(...args) };
		}
		catch (e) {
			return { name, args, error: String(e.message || e) };
		}
	});
	let answers = {
		isWin: Zotero.isWin,
		tempDir: PathUtils.tempDir,
		// Mozilla's pathSearch reads environment.PATH; this shows the spelling it gets.
		pathKeys: Object.keys(Subprocess.getEnvironment()).filter(k => k.toUpperCase() === "PATH"),
		calls,
	};
	await IOUtils.writeUTF8(PathUtils.join(outDir, "probe.json"), JSON.stringify(answers, null, 2));
}

function shutdown() {}
function install() {}
function uninstall() {}
