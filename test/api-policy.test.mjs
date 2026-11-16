import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./load-plugin.mjs";

const prefix = "extensions.zusia.", endpoint = "https://custom.example/v1";
const config = { baseURL: endpoint, auth: "none", stream: false };
function setup(backend = "openai", saved = config) {
	const e = loadPlugin({ prefs: { [prefix + "backend"]: backend, [prefix + backend + ".model"]: "model",
		[prefix + backend + ".api"]: JSON.stringify(saved), [prefix + "memory.gists"]: true } });
	e.plugin.runBackgroundCall = e.runBackgroundCall;
	return e;
}

test("unencrypted API transport is restricted to literal loopback and localhost", () => {
	const e = setup(), p = e.plugin;
	for (const url of ["http://127.0.0.1:8888/v1", "http://localhost:11434/v1", "http://[::1]:8080/v1", "https://custom.example/v1"]) {
		assert.equal(p.normalizeAPIURL(url), url);
	}
	for (const host of ["custom.example", "192.168.1.2", "0.0.0.0", "localhost.example", "127.0.0.1.example", "[2001:db8::1]"]) {
		assert.throws(() => p.normalizeAPIURL("http://" + host + "/v1"), /HTTPS/i, host);
	}
	e.window.close();
});

test("unsafe saved endpoints are rejected before accessing a key or sending paper text", async () => {
	const e = setup(), p = e.plugin;
	let keys = 0, requests = 0;
	p.getAPIKey = async () => { keys++; return "synthetic-key"; };
	e.window.Zotero.HTTP = { request: async () => { requests++; throw new Error("Unexpected network request"); } };
	await assert.rejects(p.apiHTTPRequest("openai", { ...config, auth: "bearer", baseURL: "http://custom.example/v1" }, "/chat/completions", {
		body: { messages: [{ role: "user", content: "Synthetic paper text" }] },
	}), /HTTPS/i);
	assert.equal(keys, 0);
	assert.equal(requests, 0);
	e.window.close();
});

test("custom background calls require endpoint consent even when memory and gists are enabled", async () => {
	const e = setup(), p = e.plugin;
	assert.equal(p.consolidating(), true, "the existing memory preference does not grant API consent");
	assert.equal(p.jobBackend(), null);
	assert.equal(p.memoryJobsAvailable(), false);
	let requests = 0;
	p.runAPIBackend = async () => { requests++; return { text: "unexpected" }; };
	const result = await p.runBackgroundCall("openai", "Update memory");
	assert.equal(requests, 0, "the direct runner also enforces consent");
	assert.equal(result.cancelled, true);
	e.window.close();
});

test("background consent enables its exact custom endpoint and cannot follow a changed endpoint", async () => {
	const saved = { ...config, background: true, backgroundURL: endpoint };
	const e = setup("openai", saved), p = e.plugin;
	assert.equal(p.jobBackend(), "openai");
	let requests = 0;
	p.runAPIBackend = async () => { requests++; return { text: "updated" }; };
	assert.equal((await p.runBackgroundCall("openai", "Update memory")).text, "updated");
	p.setPref("openai.api", JSON.stringify({ ...saved, baseURL: "https://another.example/v1" }));
	assert.equal(p.jobBackend(), null);
	await p.runBackgroundCall("openai", "Update memory");
	assert.equal(requests, 1);
	e.window.close();
});

test("native local providers retain their existing automatic memory behavior", () => {
	for (const backend of ["ollama", "unsloth"]) {
		const e = setup(backend, { ...config, baseURL: "http://127.0.0.1:8888/v1" });
		assert.equal(e.plugin.jobBackend(), backend);
		assert.equal(e.plugin.memoryJobsAvailable(), true);
		e.window.close();
	}
});

test("the custom endpoint exposes opt-in background calls and revokes consent on URL edits", () => {
	const e = setup(), p = e.plugin;
	const panel = p.buildAPIAssistant(e.document, "openai");
	e.document.body.append(panel);
	const toggle = panel.querySelector('[aria-label="Allow background calls"]');
	assert.ok(toggle, "the cost-bearing behavior has a visible control");
	assert.equal(toggle.getAttribute("aria-checked"), "false");
	toggle.click();
	assert.equal(p.jobBackend(), "openai");
	const url = [...panel.querySelectorAll(".zs-row")].find(row => row.querySelector("label")?.textContent === "API base URL").querySelector("input");
	url.value = "https://another.example/v1";
	url.dispatchEvent(new e.window.Event("change"));
	assert.equal(p.jobBackend(), null);
	assert.equal(toggle.getAttribute("aria-checked"), "false");
	e.window.close();
});
