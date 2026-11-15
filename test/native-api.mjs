// Run the built XPI in a separate Zotero profile against a loopback fixture server.
// No provider, installed model, real API key or personal Zotero data is used.
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test", "out", "native-api-" + Date.now());
const profile = path.join(out, "profile");
await mkdir(path.join(profile, "extensions"), { recursive: true });
await mkdir(path.join(out, "data"));
await copyFile(path.join(root, "zusia.xpi"), path.join(profile, "extensions", "zusia@firekern.github.io.xpi"));
execFileSync(process.platform === "win32" ? "python" : "python3", ["-c",
	"import pathlib,sys,zipfile; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED); [z.write(f,f.relative_to(p).as_posix()) for f in p.rglob('*') if f.is_file()]; z.close()",
	path.join(root, "test", "integration", "api-probe"), path.join(profile, "extensions", "zusia-api-probe@firekern.github.io.xpi")], { windowsHide: true });
const requests = [];
const sockets = new Set();
const server = createServer(async (req, res) => {
	if (req.url === "/v1/models") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ data: [{ id: "smoke-model", loaded: true }] }));
	}
	if (req.url === "/api/inference/status") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ active_model: "smoke-model", loaded: ["smoke-model"] }));
	}
	let data = "";
	for await (const chunk of req) data += chunk;
	const body = JSON.parse(data);
	requests.push(body);
	if (!body.stream) {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ choices: [{ message: { content: "JSON verified" }, finish_reason: "stop" }] }));
	}
	res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
	let event;
	if (body.tools && !body.messages.some(m => m.role === "tool")) {
		event = { choices: [{ delta: { tool_calls: [{ index: 0, id: "native-read", type: "function", function: { name: "read_pages", arguments: '{"pages":[1]}' } }] }, finish_reason: "tool_calls" }] };
	}
	else {
		let text = body.messages.some(m => m.role === "tool") ? "Tool verified (p. 1)" : "Verified café (p. 1)";
		event = { choices: [{ delta: { content: text }, finish_reason: body.model === "cancel-model" ? null : "stop" }] };
	}
	let bytes = Buffer.from("data: " + JSON.stringify(event) + "\r\n\r\n");
	for (let i = 0; i < bytes.length; i += 7) {
		if (res.destroyed) return;
		res.write(bytes.subarray(i, i + 7));
		await new Promise(resolve => setTimeout(resolve, 4));
	}
	if (body.model !== "cancel-model") res.end("data: [DONE]\r\n\r\n");
});
server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const prefs = await readFile(path.join(root, "test", "integration", "profile.js"), "utf8");
const extras = {
	"extensions.zotero.dataDir": path.join(out, "data"),
	"extensions.zusia-api-probe.out": out,
	"extensions.zusia-api-probe.url": `http://127.0.0.1:${server.address().port}/v1`,
	"app.update.enabled": false, "app.update.auto": false,
};
await writeFile(path.join(profile, "user.js"), prefs + "\n" + Object.entries(extras).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"));
const executable = process.env.ZOTERO_BIN || (process.platform === "win32" ? "C:\\Program Files\\Zotero\\zotero.exe" : "/Applications/Zotero.app/Contents/MacOS/zotero");
const appINI = path.join(path.dirname(executable), "app", "application.ini");
const child = spawn(executable, [...(existsSync(appINI) ? ["-app", appINI] : []), "-profile", profile, "-no-remote", "-ZoteroDebugText"], {
	windowsHide: true, env: { ...process.env, MOZ_HEADLESS: "1", MOZ_HEADLESS_WIDTH: "1200", MOZ_HEADLESS_HEIGHT: "900" },
});
const logStream = createWriteStream(path.join(out, "zotero-debug.log"));
child.stdout.on("data", chunk => logStream.write(chunk));
child.stderr.on("data", chunk => logStream.write(chunk));
const stop = () => {
	if (process.platform === "win32" && child.pid) {
		try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
		catch (e) {}
	}
	else child.kill();
};
const timer = setTimeout(stop, 120000);
try {
	await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
	logStream.end();
	const result = JSON.parse(await readFile(path.join(out, "results.json"), "utf8"));
	const tools = requests.find(r => r.messages.some(m => m.role === "tool"));
	result.checks.push({ name: "tool result contains the current paper", ok: tools?.messages.some(m => m.role === "tool" && m.content.includes("Attention uses")) });
	result.checks.push({ name: "Unsloth server tools explicitly disabled", ok: requests.some(r => r.stream === false && r.enable_tools === false && r.enabled_tools?.length === 0) });
	await writeFile(path.join(out, "results.json"), JSON.stringify(result, null, 2));
	for (const check of result.checks) console.log((check.ok ? "PASS " : "FAIL ") + check.name);
	console.log("Results: " + path.join(out, "results.json"));
	if (result.checks.some(c => !c.ok)) process.exitCode = 1;
}
finally {
	clearTimeout(timer);
	if (child.exitCode === null) stop();
	for (const socket of sockets) socket.destroy();
	await new Promise(resolve => server.close(resolve));
}
