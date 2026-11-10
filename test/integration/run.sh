#!/bin/bash
# Starts a separate, headless Zotero (/Applications/Zotero.app on macOS; on Linux
# the binary in $ZOTERO_BIN if set, Flatpak otherwise) with a throwaway profile
# and library, loads Zusia straight from src/,
# and runs tester/bootstrap.js. Your normal Zotero profile and library are never
# touched, and a Zotero you have open keeps running: -no-remote keeps them apart.
# Results: test/integration/out/results.json and zotero-*.png, or $OUT if set
#   HEADED=1 bash test/integration/run.sh   # macOS, with a window: also the reader checks
#   XPI=1 bash test/integration/run.sh      # the packaged zusia.xpi, after npm run build
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# Must live under $HOME: the Flatpak sandbox cannot see the host's /tmp.
base="$HOME/.cache/zusia-integration"
out="${OUT:-$here/out}"

rm -rf "$base"
# Emptied rather than removed, since $OUT may be a container bind mount.
mkdir -p "$base/profile/extensions" "$base/data" "$out"
find "$out" -mindepth 1 -delete
# XPI=1 installs the built zusia.xpi, as a user's Zotero has it, instead of pointing at src/.
if [ "${XPI:-0}" = 1 ]; then
	cp "$repo/zusia.xpi" "$base/profile/extensions/zusia@firekern.github.io.xpi"
else
	echo "$repo/src" > "$base/profile/extensions/zusia@firekern.github.io"
fi
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
// The setup wizard would cover the screenshots; its steps are tested in jsdom.
user_pref("extensions.zusia.onboarded", true);
user_pref("ui.systemUsesDarkTheme", $([ "${DARK:-0}" = 1 ] && echo 1 || echo 0));
PREFS

# KEYRING=1 lets this test instance (only) reach the Secret Service keyring,
# which Antigravity needs for its login inside the Flatpak sandbox.
if [ "$(uname)" = Darwin ]; then
	# HEADED=1 opens a real window: the reader and the items tree only work with one,
	# so the tester then also checks that the dock follows them.
	headless=(MOZ_HEADLESS=1 MOZ_HEADLESS_WIDTH=1500 MOZ_HEADLESS_HEIGHT=1400)
	[ "${HEADED:-0}" = 1 ] && headless=(MOZ_HEADED=1)
	# macOS has no timeout(1): a watchdog kills this instance, and only this one, by its pid.
	env "${headless[@]}" \
		"${ZOTERO_APP:-/Applications/Zotero.app}/Contents/MacOS/zotero" -profile "$base/profile" -no-remote -ZoteroDebugText \
		> "$out/zotero-debug.log" 2>&1 &
	pid=$!
	(sleep "${TIMEOUT:-420}"; kill "$pid" 2>/dev/null) &
	watchdog=$!
	wait "$pid" || true
	kill "$watchdog" 2>/dev/null || true
elif [ -n "${ZOTERO_BIN:-}" ]; then
	MOZ_HEADLESS=1 MOZ_HEADLESS_WIDTH=1500 MOZ_HEADLESS_HEIGHT=1400 \
		timeout "${TIMEOUT:-420}" "$ZOTERO_BIN" -profile "$base/profile" -no-remote -ZoteroDebugText \
		> "$out/zotero-debug.log" 2>&1 || true
else
	keyring=()
	[ "${KEYRING:-0}" = 1 ] && keyring=(--talk-name=org.freedesktop.secrets)
	timeout "${TIMEOUT:-420}" flatpak run "${keyring[@]}" --env=MOZ_HEADLESS=1 --env=MOZ_HEADLESS_WIDTH=1500 --env=MOZ_HEADLESS_HEIGHT=1400 \
		org.zotero.Zotero -profile "$base/profile" -no-remote -ZoteroDebugText > "$out/zotero-debug.log" 2>&1 || true
fi

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
