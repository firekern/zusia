// Compares what the real Windows Gecko answered (probe.json from probe/bootstrap.js)
// with the model in test/windows-env.mjs. A mismatch means the unit tests' idea of
// Windows paths is wrong and must be fixed before trusting them.
import { readFileSync } from "node:fs";
import { windowsPathUtils, windowsOSPath } from "../../windows-env.mjs";

const probe = JSON.parse(readFileSync(process.argv[2], "utf8"));
const PathUtils = windowsPathUtils();
const scope = { PathUtils, OS: { Path: windowsOSPath(PathUtils) } };
let mismatches = 0;
for (const { name, args, value, error } of probe.calls) {
	const [object, ...rest] = name.split(".");
	const fn = rest.reduce((o, key) => o[key], scope[object]);
	let model;
	try {
		model = { value: fn(...args) };
	}
	catch (e) {
		model = { error: e.message };
	}
	const real = error === undefined ? { value } : { error };
	// Error texts differ; what matters is that both refuse, or both give the same path.
	const same = "error" in real ? "error" in model : model.value === real.value;
	mismatches += !same;
	console.log((same ? "  ✔ " : "  ✖ ") + name + "(" + args.map(a => JSON.stringify(a)).join(", ") + ") → " +
		JSON.stringify(real) + (same ? "" : "  model: " + JSON.stringify(model)));
}
console.log("  Gecko's PATH spelling under Wine: " + JSON.stringify(probe.pathKeys) + " (Windows itself has \"Path\")");
console.log(mismatches ? mismatches + " path model mismatches" : "path model matches Gecko on all " + probe.calls.length + " calls");
process.exit(mismatches ? 1 : 0);
