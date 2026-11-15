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
let ollamaContext = 16384;
let raceModel = "race-A";
const server = createServer(async (req, res) => {
	if (req.url.startsWith("/race/")) {
		let data = ""; for await (const chunk of req) data += chunk;
		let body = data ? JSON.parse(data) : null, pathname = req.url.slice(5).split("?")[0], value, status = 200;
		if (pathname === "/api/inference/status") value = { active_model: raceModel, loaded: [raceModel], context_length: 8192 };
		else if (pathname === "/api/settings/openai-auto-switch/overrides") value = { resolved: {} };
		else if (pathname === "/api/inference/load") { raceModel = body.model_path; value = {}; }
		else if (pathname === "/v1/props") value = { default_generation_settings: { n_ctx: 8192 } };
		else if (pathname === "/v1/chat/count_tokens") value = { model: raceModel, input_tokens: 10 };
		else if (pathname === "/v1/chat/completions") {
			await new Promise(resolve => setTimeout(resolve, 30));
			status = body.model === raceModel ? 200 : 409;
			value = status === 200 ? { choices: [{ message: { content: "Answer " + body.model }, finish_reason: "stop" }] } : { detail: "Requested model is not loaded" };
		}
		else { status = 404; value = { detail: "Unknown race fixture route" }; }
		res.writeHead(status, { "content-type": "application/json" }); return res.end(JSON.stringify(value));
	}
	if (req.url === "/api/ps") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ models: [{ name: "smoke-model:latest", context_length: ollamaContext, details: { quantization_level: "Q4_K_M" } },
			{ name: "small-context-model:latest", context_length: 8192, details: { quantization_level: "Q4_K_M" } }] }));
	}
	if (req.url === "/v1/models") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ data: [{ id: "smoke-model", loaded: true }] }));
	}
	if (req.url.split("?")[0] === "/api/inference/status") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ active_model: "smoke-model", loaded: ["smoke-model"], context_length: 32768,
			supports_tools: true, is_vision: false, supports_reasoning: true, reasoning_style: "enable_thinking" }));
	}
	if (req.url.startsWith("/api/settings/openai-auto-switch/overrides") || req.url === "/v1/props") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(req.url === "/v1/props" ? { default_generation_settings: { n_ctx: 32768 } } : { resolved: {} }));
    }
	let data = "";
	for await (const chunk of req) data += chunk;
	const body = JSON.parse(data);
	if (body.messages?.some(m => m.content === "Expired capability probe") && body.enable_thinking !== false) {
		res.writeHead(400, { "content-type": "application/json" });
		return res.end(JSON.stringify({ detail: "Prepared Thinking off must survive discovery-cache expiry" }));
	}
	if (req.url === "/v1/chat/count_tokens") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ model: body.model, input_tokens: Math.ceil(JSON.stringify(body.messages).length / 4) }));
	}
	if (req.url === "/api/show") {
		if (body.model === "small-context-model") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ parameters: "num_ctx 8192", capabilities: ["completion"] }));
		}
		if (body.model === "memory-error-model") {
			res.writeHead(500, { "content-type": "application/json" });
			return res.end(JSON.stringify({ error: "model requires more system memory (16 GiB) than is available (8 GiB)" }));
		}
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ parameters: "num_ctx 16384\ntemperature 0.7", details: { quantization_level: "Q4_K_M" },
			capabilities: ["completion", "tools", "thinking"], thinking: { values: [false, true, "deep"], default: true } }));
	}
	requests.push(body);
	if (req.url === "/api/chat") {
		if (!body.messages.length) {
			ollamaContext = body.options?.num_ctx || 16384;
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ done: true }));
		}
		let prompt = body.messages.at(-1)?.content || "";
		if ((prompt === "Ollama cold reasoning probe" && body.think !== "deep") || (body.model === "small-context-model" && Buffer.byteLength(JSON.stringify(body.messages)) + 512 + 2048 > 8192)) {
			res.writeHead(400, { "content-type": "application/json" });
			return res.end(JSON.stringify({ error: "Fixture rejected an invalid reasoning choice or background context budget" }));
		}
		res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
		let value = body.tools && !body.messages.some(m => m.role === "tool") ?
			{ message: { tool_calls: [{ function: { name: "read_pages", arguments: { pages: [1] } } }] }, done: true } :
			{ message: { content: "Profilo caffè verificato" }, done: true };
		if (prompt.includes("<conversation_turns>")) value.message = { content: '{"summary":"Native memory updated."}' };
		else if (prompt.includes("<section_text>") || prompt.includes("<section_gists>")) value.message = { content: "Native section summary." };
		Object.assign(value, { model: body.model, prompt_eval_count: 100, eval_count: 20, prompt_eval_cached_count: 0, eval_duration: 500000000, load_duration: 1000000 });
		let bytes = Buffer.from(JSON.stringify(value) + "\n");
		for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)); await new Promise(resolve => setTimeout(resolve, 2)); }
		return res.end();
	}
	if (body.messages.some(m => m.content === "Restart probe") && body.enable_thinking !== false) {
		res.writeHead(400, { "content-type": "application/json" });
		return res.end(JSON.stringify({ detail: "Fixture requires the saved cold-start thinking:false choice" }));
	}
	if (!body.stream) {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: "JSON verified" }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 10 } }));
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
	if (body.model !== "cancel-model") res.end('data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":0}}}\r\n\r\ndata: [DONE]\r\n\r\n');
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
const logStream = createWriteStream(path.join(out, "zotero-debug.log"));
function launch() {
	let proc = spawn(executable, [...(existsSync(appINI) ? ["-app", appINI] : []), "-profile", profile, "-no-remote", "-ZoteroDebugText"], {
		windowsHide: true, env: { ...globalThis.process.env, MOZ_HEADLESS: "1", MOZ_HEADLESS_WIDTH: "1200", MOZ_HEADLESS_HEIGHT: "900" },
	});
	proc.stdout.on("data", chunk => logStream.write(chunk));
	proc.stderr.on("data", chunk => logStream.write(chunk));
	return proc;
}
let child = launch();
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
	const result = JSON.parse(await readFile(path.join(out, "results.json"), "utf8"));
	if (result.checks.every(c => c.ok)) {
		await writeFile(path.join(profile, "user.js"), prefs + "\n" + Object.entries({ ...extras, "extensions.zusia-api-probe.phase": "restart" }).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"));
		child = launch();
		await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
		const restarted = JSON.parse(await readFile(path.join(out, "restart-results.json"), "utf8"));
		result.checks.push(...restarted.checks);
	}
	logStream.end();
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
