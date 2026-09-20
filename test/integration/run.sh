#!/bin/bash
# Starts a separate, headless Zotero (Flatpak) with a throwaway profile and
# library, loads Zusia straight from src/, and runs tester/bootstrap.js.
# Your normal Zotero profile and library are never touched.
# Results: test/integration/out/results.json and zotero-*.png
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# Must live under $HOME: the Flatpak sandbox cannot see the host's /tmp.
base="$HOME/.cache/zusia-integration"
out="$here/out"

rm -rf "$base" "$out"
mkdir -p "$base/profile/extensions" "$base/data" "$out"
echo "$repo/src" > "$base/profile/extensions/zusia@firekern.github.io"
echo "$here/tester" > "$base/profile/extensions/zusia-tester@firekern.github.io"
cat > "$base/profile/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$base/data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.startupScanScopes", 15);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zusia-tester.outDir", "$out");
user_pref("extensions.zusia-tester.repo", "$repo");
user_pref("extensions.zusia-tester.live", $([ "${LIVE:-0}" = 1 ] && echo true || echo false));
PREFS

# KEYRING=1 lets this test instance (only) reach the Secret Service keyring,
# which Antigravity needs for its login inside the Flatpak sandbox.
keyring=()
[ "${KEYRING:-0}" = 1 ] && keyring=(--talk-name=org.freedesktop.secrets)
timeout "${TIMEOUT:-420}" flatpak run "${keyring[@]}" --env=MOZ_HEADLESS=1 --env=MOZ_HEADLESS_WIDTH=1500 --env=MOZ_HEADLESS_HEIGHT=1400 \
	org.zotero.Zotero -profile "$base/profile" -no-remote -ZoteroDebugText > "$out/zotero-debug.log" 2>&1 || true

if [ ! -f "$out/results.json" ]; then
	echo "No results. Last debug lines:"
	grep -E "zs-tester|zusia|Error" "$out/zotero-debug.log" | tail -30
	exit 1
fi
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
' "$out/results.json"
