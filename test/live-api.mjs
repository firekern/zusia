// Opt-in real-provider checks. Uses synthetic data and its own Zotero profile.
// ZUSIA_LIVE_BACKEND=ollama|unsloth ZUSIA_LIVE_URL=http://localhost:11434/v1
// ZUSIA_LIVE_MODEL=<exact-id> [ZUSIA_LIVE_KEY=<key>] node test/live-api.mjs
// Unsloth must already have the requested model/profile loaded: no reconfiguration.
import { spawn, execFileSync } from "node:child_process";
import { mkdir, copyFile, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const backend = process.env.ZUSIA_LIVE_BACKEND;
const url = new URL(process.env.ZUSIA_LIVE_URL);
const model = process.env.ZUSIA_LIVE_MODEL;
if (!["ollama", "unsloth"].includes(backend) || !model || url.username || url.password || !["http:", "https:"].includes(url.protocol)) {
	throw new Error("Set ZUSIA_LIVE_BACKEND, ZUSIA_LIVE_URL and ZUSIA_LIVE_MODEL. Credentials belong only in ZUSIA_LIVE_KEY.");
}
const contextTokens = Number(process.env.ZUSIA_LIVE_CONTEXT_TOKENS || 0);
const outputTokens = Number(process.env.ZUSIA_LIVE_OUTPUT_TOKENS || 1024);
if (process.env.ZUSIA_LIVE_CONTEXT_TOKENS && (backend !== "ollama" || !Number.isInteger(contextTokens) || contextTokens < 8192 || contextTokens > 2097152)) {
	throw new Error("ZUSIA_LIVE_CONTEXT_TOKENS is an explicit Ollama override (8192-2097152).");
}
if (!Number.isInteger(outputTokens) || outputTokens < 256 || outputTokens > 65536) throw new Error("Invalid ZUSIA_LIVE_OUTPUT_TOKENS (256-65536).");
const out = path.resolve(process.env.ZUSIA_LIVE_OUT || path.join(root, "test", "out", "live-api-" + Date.now()));
if (existsSync(out) && (await readdir(out)).length) throw new Error("Live probe output must be a new or empty directory.");
const profile = path.join(out, "profile");
await mkdir(path.join(profile, "extensions"), { recursive: true });
await mkdir(path.join(out, "data"));
await copyFile(path.join(root, "zusia.xpi"), path.join(profile, "extensions", "zusia@firekern.github.io.xpi"));
execFileSync(process.platform === "win32" ? "python" : "python3", ["-c",
	"import pathlib,sys,zipfile; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED); [z.write(f,f.relative_to(p).as_posix()) for f in p.rglob('*') if f.is_file()]; z.close()",
	path.join(root, "test", "integration", "live-api-probe"), path.join(profile, "extensions", "zusia-live-api-probe@firekern.github.io.xpi")], { windowsHide: true });
const prefs = await readFile(path.join(root, "test", "integration", "profile.js"), "utf8");
const extras = {
	"extensions.zotero.dataDir": path.join(out, "data"),
	"extensions.zusia-live-api-probe.out": out,
	"extensions.zusia-live-api-probe.backend": backend,
	"extensions.zusia-live-api-probe.url": url.href.replace(/\/$/, ""),
	"extensions.zusia-live-api-probe.model": model,
	"extensions.zusia-live-api-probe.image": process.env.ZUSIA_LIVE_IMAGE || "",
	"extensions.zusia-live-api-probe.contextTokens": contextTokens,
	"extensions.zusia-live-api-probe.outputTokens": outputTokens,
	"app.update.enabled": false, "app.update.auto": false,
};
const executable = process.env.ZOTERO_BIN || (process.platform === "win32" ? "C:\\Program Files\\Zotero\\zotero.exe" : "/Applications/Zotero.app/Contents/MacOS/zotero");
const appINI = path.join(path.dirname(executable), "app", "application.ini");
const log = createWriteStream(path.join(out, "zotero-debug.log"));
let child, timedOut = false;
function stop() {
	if (!child || child.exitCode !== null) return;
	if (process.platform === "win32") {
		try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch (e) {}
	}
	else child.kill();
}
const timer = setTimeout(() => { timedOut = true; stop(); }, Number(process.env.ZUSIA_LIVE_TIMEOUT || 300000));
const reports = [];
try {
	for (const phase of ["run", "restart"]) {
		await writeFile(path.join(profile, "user.js"), prefs + "\n" + Object.entries({ ...extras, "extensions.zusia-live-api-probe.phase": phase })
			.map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"));
		child = spawn(executable, [...(existsSync(appINI) ? ["-app", appINI] : []), "-profile", profile, "-no-remote"], {
			windowsHide: true, env: { ...process.env, MOZ_HEADLESS: "1", MOZ_HEADLESS_WIDTH: "1200", MOZ_HEADLESS_HEIGHT: "900" },
		});
		child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
		await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
		if (timedOut) throw new Error("Isolated live probe timed out");
		const report = JSON.parse(await readFile(path.join(out, phase + "-results.json"), "utf8"));
		reports.push(report);
		if (report.error || report.checks.some(check => !check.ok)) break;
	}
	const result = { backend, model, reports, checks: reports.flatMap(r => r.checks) };
	await writeFile(path.join(out, "results.json"), JSON.stringify(result, null, 2));
	for (const check of result.checks) console.log((check.ok ? "PASS " : "FAIL ") + check.name);
	for (const report of reports) if (report.error) console.log("FAIL " + report.error);
	console.log("Results: " + path.join(out, "results.json"));
	if (reports.some(r => r.error) || result.checks.some(c => !c.ok)) process.exitCode = 1;
}
finally { clearTimeout(timer); stop(); log.end(); }
