#!/bin/bash
# Runs the integration tester (../tester) in the official Windows build of Zotero,
# under Wine in a linux/amd64 container: the plugin's Windows branches (Zotero.isWin,
# backslash paths, Mozilla's Windows Subprocess) run in a real Gecko without a
# Windows machine. On Apple Silicon Docker runs it under Rosetta; a run takes ~20 s
# once the image is built. No child process can be started here: a real .exe in a
# CLI's place (tried, a compiled stand-in) kills Zotero at the spawn with an
# assertion in the x86 emulator. So the one check that needs `agy models` answered
# is reported as not runnable here and does not fail the run.
# probe/ records how the real PathUtils and OS.Path answer, and check-probe.mjs
# compares that with the path model the unit tests use (test/windows-env.mjs).
# Results: test/integration/out-windows/results.json, probe.json and zotero-*.png
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="$repo/test/integration/out-windows"
image=zusia-zotero-windows

docker build -q --platform linux/amd64 -t "$image" "$here" > /dev/null
# Gecko's software compositor sometimes dies under Wine on emulated x86 before the
# tester has finished, which says nothing about the plugin: such a run is repeated.
for attempt in 1 2 3; do
	# Emptied, not removed: Docker Desktop can mount a folder that was just deleted and
	# made again as the deleted one, and the container then has no /out to write to.
	mkdir -p "$out"
	find "$out" -mindepth 1 -delete
	docker run --rm --platform linux/amd64 \
		-e TIMEOUT="${TIMEOUT:-900}" \
		-v "$repo:/repo:ro" -v "$out:/out" -v "$here/entry.sh:/entry.sh:ro" \
		"$image"
	[ -f "$out/results.json" ] && break
	echo "Zotero stopped before the tester finished (attempt $attempt of 3)." >&2
done

if [ ! -f "$out/results.json" ]; then
	echo "No results. Last debug lines:"
	grep -E "zs-tester|zusia|Error" "$out/zotero-debug.log" | tail -30
	exit 1
fi
node "$here/check-probe.mjs" "$out/probe.json" || probe_failed=1
node -e '
const r = require(process.argv[1]);
const cannotRunHere = new Set(["Antigravity models are listed from `agy models`"]);
let failed = 0;
for (const c of r.checks) {
	if (!c.ok && cannotRunHere.has(c.name)) {
		console.log("  – " + c.name + "  (needs a child process, which this emulated Windows cannot start)");
		continue;
	}
	console.log((c.ok ? "  ✔ " : "  ✖ ") + c.name + (c.ok || c.detail === null ? "" : "  → " + JSON.stringify(c.detail)));
	failed += !c.ok;
}
for (const e of r.errors) { console.log("  ERROR " + e); failed++; }
console.log(failed ? failed + " failed" : "all " + (r.checks.length - cannotRunHere.size) + " runnable checks passed");
process.exit(failed ? 1 : 0);
' "$out/results.json" || exit 1
exit "${probe_failed:-0}"
