#!/bin/bash
# Runs the integration tester (../tester) in the official Windows build of Zotero,
# under Wine in a linux/amd64 container: the plugin's Windows branches (Zotero.isWin,
# backslash paths, Mozilla's Windows Subprocess) run in a real Gecko without a
# Windows machine. On Apple Silicon Docker runs it under Rosetta; a run takes ~20 s
# once the image is built. No CLI is installed in the container, so the check
# "Antigravity models are listed from `agy models`" fails here by design.
# probe/ records how the real PathUtils and OS.Path answer, and check-probe.mjs
# compares that with the path model the unit tests use (test/windows-env.mjs).
# Results: test/integration/out-windows/results.json, probe.json and zotero-*.png
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="$repo/test/integration/out-windows"
image=zusia-zotero-windows

docker build -q --platform linux/amd64 -t "$image" "$here" > /dev/null
rm -rf "$out"
mkdir -p "$out"
docker run --rm --platform linux/amd64 \
	-e TIMEOUT="${TIMEOUT:-900}" \
	-v "$repo:/repo:ro" -v "$out:/out" -v "$here/entry.sh:/entry.sh:ro" \
	"$image"

if [ ! -f "$out/results.json" ]; then
	echo "No results. Last debug lines:"
	grep -E "zs-tester|zusia|Error" "$out/zotero-debug.log" | tail -30
	exit 1
fi
node "$here/check-probe.mjs" "$out/probe.json" || probe_failed=1
node -e '
const r = require(process.argv[1]);
let failed = 0;
for (const c of r.checks) {
	console.log((c.ok ? "  ✔ " : "  ✖ ") + c.name + (c.ok || c.detail === null ? "" : "  → " + JSON.stringify(c.detail)));
	failed += !c.ok;
}
for (const e of r.errors) { console.log("  ERROR " + e); failed++; }
console.log(failed ? failed + " failed" : "all " + r.checks.length + " checks passed");
process.exit(failed ? 1 : 0);
' "$out/results.json" || exit 1
exit "${probe_failed:-0}"
