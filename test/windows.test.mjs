// The plugin as it runs on Windows, through windows-env.mjs: native backslash paths,
// Zotero's OS.Path fallback, Mozilla's pathSearch and Windows' own spelling of Path.
// backends.test.mjs covers the same branches with POSIX-style paths ("C:/Users/u")
// and PATH in capitals; these tests are about what that leaves out.
import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";
import {
	loadWindowsPlugin, mixedSeparators, windowsPathUtils,
	HOME, TEMP, NPM, NODE_DIR, NODE_EXE, DATA_DIR, CLAUDE_NATIVE, CLAUDE_NPM_EXE, CODEX_JS, PATHEXT,
} from "./windows-env.mjs";

const PREFIX = "extensions.zusia.";
const PAPER = DATA_DIR + "\\zusia\\1-PAPERKEY";
const base = { ctx: { dir: PAPER }, question: "Why?", history: [], session: null, files: { metadata: "# T\n", annotations: "" } };
const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];
// Values made inside jsdom have its prototypes, which strict deepEqual rejects.
const plain = value => JSON.parse(JSON.stringify(value));
// The variable spelled the way backends.test.mjs has it, which Wine also uses.
const upperPath = (Path = NODE_DIR) => ({ USERPROFILE: HOME, PATH: Path, PATHEXT });
const claudeAnswer = JSON.stringify({ type: "assistant", session_id: "s", message: { content: [{ type: "text", text: "ok" }] } }) + "\n";

test("windows env: the path model refuses what Gecko refuses, so the tests below can trust it", () => {
	const P = windowsPathUtils();
	assert.equal(P.join("C:\\a\\", "b", "c.txt"), "C:\\a\\b\\c.txt");
	assert.equal(P.parent("C:\\a\\b"), "C:\\a");
	assert.equal(P.parent("C:\\a"), "C:", "as Gecko answers under Wine");
	assert.equal(P.filename("C:\\a\\b.md"), "b.md");
	for (const bad of ["C:/a", "/c/Users/u", "relative\\dir"]) {
		assert.throws(() => P.join(bad, "x"), /NS_ERROR_FILE_UNRECOGNIZED_PATH/, bad);
		assert.equal(P.isAbsolute(bad), false, bad);
	}
	assert.throws(() => P.join("", "x"), /empty paths/, "not UNRECOGNIZED, so Zotero's OS.Path.join rethrows it");
	assert.throws(() => P.join("C:\\a", "b\\c"), /UNRECOGNIZED/, "one component, no separator");
	assert.throws(() => P.join("C:\\a", "b/c"), /UNRECOGNIZED/);
	assert.equal(P.joinRelative("C:\\a", "b\\c"), "C:\\a\\b\\c");
	const { window } = loadWindowsPlugin();
	assert.equal(window.OS.Path.join("C:\\a", "b/c"), "C:\\a\\b/c", "Zotero glues what PathUtils refuses");
});

test("windows: the native installers' folders come first on the search path, all under USERPROFILE, joined with ;", () => {
	const { plugin } = loadWindowsPlugin({ environment: { ...upperPath("C:\\Windows\\system32;" + NODE_DIR), ANTHROPIC_API_KEY: "sk", OPENAI_API_KEY: "sk" } });
	const env = plugin.buildChildEnvironment();
	assert.deepEqual(env.PATH.split(";"), [
		HOME + "\\.local\\bin",
		HOME + "\\AppData\\Local\\agy\\bin",
		HOME + "\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin",
		NPM,
		"C:\\Windows\\system32",
		NODE_DIR,
	]);
	assert.ok(!env.PATH.includes("/"), env.PATH);
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.OPENAI_API_KEY, undefined);
});

test("windows: the native claude.exe in .local\\bin is found before npm's shims, as a native path", async () => {
	const { plugin } = loadWindowsPlugin({
		executables: [NPM + "\\claude", NPM + "\\claude.cmd", NPM + "\\claude.ps1", CLAUDE_NPM_EXE, CLAUDE_NATIVE],
	});
	assert.equal(await plugin.findBinary("claude"), CLAUDE_NATIVE);
});

test("windows: npm's claude.cmd resolves to the claude.exe it runs, with backslashes only", async () => {
	const { plugin } = loadWindowsPlugin({ executables: [NPM + "\\claude", NPM + "\\claude.cmd", CLAUDE_NPM_EXE] });
	const found = await plugin.findBinary("claude");
	assert.equal(found, CLAUDE_NPM_EXE);
	assert.ok(!mixedSeparators(found));
});

test("windows: an npm .cmd whose target is missing is refused, never run", async () => {
	for (const backend of ["claude", "codex", "agy"]) {
		const { plugin } = loadWindowsPlugin({ executables: [NPM + "\\" + backend + ".cmd"] });
		await assert.rejects(plugin.findBinary(backend), /will not run batch files.*\\npm\\.*\.cmd/s, backend);
	}
});

test("windows: npm's codex.cmd runs as node.exe codex.js, with node.exe found on PATH", async () => {
	const env = loadWindowsPlugin({ executables: [NPM + "\\codex.cmd", CODEX_JS, NODE_EXE], environment: upperPath() });
	env.cli.stdout = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }) + "\n";
	const result = await env.plugin.runCodex({ ...base, onProgress() {} });
	assert.equal(result.text, "ok");
	const [run] = env.spawns;
	assert.equal(run.command, NODE_EXE);
	assert.deepEqual(run.args.slice(0, 2), [CODEX_JS, "exec"]);
	assert.equal(valueAfter(run.args, "-C"), PAPER);
	assert.equal(run.args[run.args.length - 1], "-", "the prompt comes on stdin");
	assert.ok(run.closed);
});

// Windows names the variable "Path" (cmd's `set` shows Path=...), and
// Subprocess.getEnvironment() keeps that spelling, while buildChildEnvironment
// (src/content/zusia.js:8102) reads and writes env.PATH and Mozilla's pathSearch
// reads environment.PATH only. So the search covers the four extra folders and
// nothing on the user's Path: node.exe in C:\Program Files\nodejs is never found, and
// neither is a CLI installed anywhere else (winget, scoop, a custom folder). The Wine
// run cannot show it: Wine spells the variable PATH.
test("windows: a CLI on the user's Path is found when Windows spells it Path", { todo: "bug: buildChildEnvironment ignores Path, zusia.js:8102" }, async () => {
	const env = loadWindowsPlugin({ executables: [NPM + "\\codex.cmd", CODEX_JS, NODE_EXE, "C:\\tools\\agy.exe"],
		environment: { USERPROFILE: HOME, Path: "C:\\tools;" + NODE_DIR, PATHEXT } });
	assert.equal(await env.plugin.findBinary("agy"), "C:\\tools\\agy.exe");
	await env.plugin.runCodex({ ...base, onProgress() {} });
	assert.equal(env.spawns[0].command, NODE_EXE);
	const child = env.plugin.buildChildEnvironment();
	assert.equal(Object.keys(child).filter(k => k.toUpperCase() === "PATH").length, 1, "one PATH in the child's block: " + Object.keys(child));
});

// Mozilla's pathSearch does not skip a PATH entry PathUtils refuses: it throws, and
// findBinary reads that as "not found". The extra folders come first and are built
// from HOME before USERPROFILE (zusia.js:8100), so a HOME that is not a Windows path,
// as an MSYS-style /c/Users/u, ends every search before the user's own Path.
test("windows: a HOME that is not a Windows path does not hide claude.exe on PATH", { todo: "bug: HOME wins over USERPROFILE on Windows, zusia.js:8100" }, async () => {
	const { plugin } = loadWindowsPlugin({ executables: ["C:\\tools\\claude.exe"], environment: { ...upperPath("C:\\tools"), HOME: "/c/Users/u" } });
	assert.equal(await plugin.findBinary("claude"), "C:\\tools\\claude.exe");
});

// avoidBatchFile takes OS.Path.dirname of the setting, and PathUtils.parent refuses
// "C:/..." on Windows, so the user sees Gecko's NS_ERROR_FILE_UNRECOGNIZED_PATH
// instead of the npm target or the batch-file message (zusia.js:8079).
test("windows: a path setting written with forward slashes still resolves npm's claude.cmd", { todo: "bug: claudePath is not normalised before OS.Path.dirname, zusia.js:8079" }, async () => {
	const { plugin } = loadWindowsPlugin({ executables: [CLAUDE_NPM_EXE], prefs: { [PREFIX + "claudePath"]: "C:/Users/u/AppData/Roaming/npm/claude.cmd" } });
	assert.equal(await plugin.findBinary("claude"), CLAUDE_NPM_EXE);
});

test("windows: a chat run spawns the exe with --setting-sources= as one argument and the prompt on stdin only", async () => {
	const env = loadWindowsPlugin({ executables: [CLAUDE_NATIVE] });
	env.cli.stdout = claudeAnswer;
	const question = 'Q-MARK "x" & y > 0? 100%\n- not a flag';
	const result = await env.plugin.runClaude({ ...base, question, onProgress() {} });
	assert.equal(result.text, "ok");
	const [run] = env.spawns;
	assert.equal(run.command, CLAUDE_NATIVE);
	assert.equal(run.workdir, PAPER);
	assert.ok(run.args.includes("--setting-sources="));
	assert.ok(!run.args.includes(""), "Windows drops an empty argument (#1)");
	assert.ok(!run.args.some(a => a.includes("Q-MARK") || a.includes("\n")), run.args.join(" | "));
	assert.equal(valueAfter(run.args, "--append-system-prompt-file"), PAPER + "\\system.md");
	assert.equal(env.files.get(PAPER + "\\system.md"), env.plugin.systemPrompt());
	assert.ok(run.stdin.join("").startsWith(question));
	assert.ok(run.closed);
});

test("windows: a memory job runs claude.exe in a fresh folder under %TEMP%, prompt on stdin, folder removed", async () => {
	const env = loadWindowsPlugin({ executables: [CLAUDE_NATIVE] });
	env.plugin.runBackgroundCall = env.runBackgroundCall;
	const made = [];
	const removed = [];
	env.window.Zotero.File.createDirectoryIfMissingAsync = async (dir) => { made.push(dir); };
	env.window.OS.File.removeDir = async (dir) => { removed.push(dir); };
	env.cli.stdout = claudeAnswer;
	assert.deepEqual(plain(await env.plugin.runBackgroundCall("claude", "PROMPT\nline two")), { text: "ok", error: "", rateLimited: false });
	const [run] = env.spawns;
	assert.equal(run.command, CLAUDE_NATIVE);
	assert.match(run.workdir, /^C:\\Users\\u\\AppData\\Local\\Temp\\zusia-job-[a-z0-9]+$/);
	assert.ok(run.workdir.startsWith(TEMP + "\\"));
	assert.deepEqual(made, [run.workdir]);
	assert.deepEqual(removed, [run.workdir]);
	assert.ok(run.args.includes("--tools=") && run.args.includes("--setting-sources="));
	assert.ok(!run.args.includes(""));
	assert.deepEqual(run.stdin, ["PROMPT\nline two"]);
});

test("windows: Antigravity's first prompt inlines at most the smaller Windows budget, still with the page on screen", () => {
	const pages = Array.from({ length: 200 }, (_, i) => ("Page " + (i + 1) + " text. ").padEnd(1000, "x"));
	const files = { metadata: "# T\n", annotations: "", fullText: { status: "ok", paged: true, pages }, focus: [120] };
	const sent = plugin => plugin.sessionPaper("agy", files, null).chars;
	const win = loadWindowsPlugin().plugin;
	const mac = loadPlugin().plugin;
	assert.equal(win.inlineFullTextBudget(), win.FULLTEXT_INLINE_CHARS_WINDOWS);
	assert.ok(sent(win) <= win.FULLTEXT_INLINE_CHARS_WINDOWS, "Windows sent " + sent(win));
	assert.ok(sent(mac) > win.FULLTEXT_INLINE_CHARS_WINDOWS, "elsewhere the budget is larger: " + sent(mac));
	const prompt = win.buildAntigravityPrompt({ files, question: "Why?", history: [], session: null });
	assert.match(prompt, /<focus_page>\n--- page 121 ---/);
	assert.ok(prompt.length < loadPlugin().plugin.buildAntigravityPrompt({ files, question: "Why?", history: [], session: null }).length);
});

test("windows: the paper folder and every file written in it are native paths", async () => {
	const env = loadWindowsPlugin();
	const { plugin, window, files } = env;
	const pages = Array.from({ length: 5 }, (_, i) => ("Page " + (i + 1) + " text. ").padEnd(300, "x"));
	window.Zotero.PDFWorker = { getFullText: async () => ({ text: pages.join("\f"), totalPages: pages.length }) };
	const attachment = {
		id: 7, isFileAttachment: () => true, isPDFAttachment: () => true, fileExists: async () => true,
		get attachmentModificationTime() { return Promise.resolve(1); },
		getFilePathAsync: async () => DATA_DIR + "\\storage\\ABCD1234\\paper.pdf",
		getAnnotations: () => [],
	};
	const paperItem = {
		libraryID: 1, key: "PAPERKEY", isAttachment: () => false,
		getField: field => ({ title: "Loss of plasticity" })[field] || "", getCreators: () => [],
	};
	const dir = plugin.contextDirFor(paperItem);
	assert.equal(dir, PAPER);
	await plugin.exportContext({ paperItem, attachmentItem: attachment, dir }, { focus: [2] });
	const written = [...files.keys()].filter(p => p.startsWith(PAPER));
	assert.ok(written.includes(PAPER + "\\fulltext.md"), written.join("\n"));
	assert.ok(written.includes(PAPER + "\\metadata.md"));
	for (const path of written) {
		assert.ok(!path.includes("/"), "forward slash in " + path);
	}
});

test("windows: an attached image is stored relative to the paper folder and resolves back to the same file", async () => {
	const { plugin } = loadWindowsPlugin();
	const history = [];
	plugin.exportContext = async () => base.files;
	plugin.loadHistory = async () => [];
	plugin.appendHistory = async (dir, msgs) => { history.push(...msgs); };
	plugin.loadSessions = async () => ({});
	plugin.saveSessions = async () => {};
	let seen;
	plugin.runBackend = async (backend, request) => { seen = request; return { text: "A cat." }; };
	const image = plugin.attachmentPath(PAPER, "png");
	assert.match(image, /^C:\\Users\\u\\Zotero\\zusia\\1-PAPERKEY\\attachments\\image-\d+-\d+\.png$/);
	const pending = { backend: "codex", partial: "", cancelled: false, images: [image], progress() {} };
	await plugin.ask(base.ctx, "", pending);
	assert.equal(plugin.imagePaths(PAPER, history[0])[0], image);
	assert.ok(plugin.codexArgs({ ...seen, session: null }).includes("--image=" + image));
	assert.equal(plugin.describeTool("Read", { file_path: PAPER + "\\text\\02-signals.md" }).label, "Read 02-signals.md");
});

// The stored name keeps the separator of the machine that wrote it: "attachments\\x.png"
// from Windows (zusia.js:3944), "attachments/x.png" from macOS. A Zotero data folder
// moved from a Mac to Windows then joins to "...\\attachments/x.png", which Gecko's
// file APIs refuse, and the other way round to a name with a backslash in it.
test("windows: a chat written on macOS finds its images on Windows", { todo: "bug: stored image paths use the writer's separator, zusia.js:3944" }, () => {
	const { plugin } = loadWindowsPlugin();
	const path = plugin.imagePaths(PAPER, { images: ["attachments/image-1.png"] })[0];
	assert.equal(path, PAPER + "\\attachments\\image-1.png");
});
