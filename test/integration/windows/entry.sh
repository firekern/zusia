#!/bin/bash
# Runs inside the container: a throwaway profile set up as ../run.sh does, with the
# repository mounted at /repo and the results going to /out. Wine shows the Linux
# root as drive Z:, so every path Zotero is given is a Windows path under Z:.
set -euo pipefail
base=/work
rm -rf "$base"
mkdir -p "$base/profile/extensions" "$base/data"
win() { printf 'Z:%s' "${1//\//\\}"; }
# Gecko reads a proxy file as a native path, so each holds the Z: form.
win /repo/src > "$base/profile/extensions/zusia@firekern.github.io"
win /repo/test/integration/tester > "$base/profile/extensions/zusia-tester@firekern.github.io"
win /repo/test/integration/windows/probe > "$base/profile/extensions/zusia-probe@firekern.github.io"
# Prefs take JS strings, so each backslash is doubled.
js() { local p; p="$(win "$1")"; printf '%s' "${p//\\/\\\\}"; }
cp /repo/test/integration/profile.js "$base/profile/user.js"
cat >> "$base/profile/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$(js "$base/data")");
user_pref("extensions.zusia-tester.outDir", "$(js /out)");
user_pref("extensions.zusia-tester.repo", "$(js /repo)");
user_pref("extensions.zusia-tester.live", false);
user_pref("ui.systemUsesDarkTheme", 0);
// Wine under x86 emulation has no GPU and cannot run Gecko's sandboxed content
// processes reliably, so everything renders in software in one process.
user_pref("security.sandbox.content.level", 0);
user_pref("security.sandbox.gpu.level", 0);
user_pref("layers.acceleration.disabled", true);
user_pref("gfx.webrender.software", true);
user_pref("browser.tabs.remote.autostart", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("toolkit.telemetry.enabled", false);
PREFS

# No CLI is installed here, and the model menu shows "Not installed" instead of a
# backend's models when findBinary fails, which ends the tester's sidebar flow. An
# empty file where each native installer puts its .exe is enough for findBinary;
# spawning one fails, as `agy models` then does, so that one check needs a real agy.
home=/wine/drive_c/users/$(id -un)
mkdir -p "$home/.local/bin" "$home/AppData/Local/agy/bin" "$home/AppData/Local/Programs/OpenAI/Codex/bin"
touch "$home/.local/bin/claude.exe" "$home/AppData/Local/agy/bin/agy.exe" "$home/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe"

# Headless Gecko on Windows still creates hidden windows and probes Direct3D, which
# Wine can only do with an X display behind it.
Xvfb :99 -screen 0 1600x1500x24 -nolisten tcp > /dev/null 2>&1 &
export DISPLAY=:99
export MOZ_HEADLESS=1 MOZ_HEADLESS_WIDTH=1500 MOZ_HEADLESS_HEIGHT=1400
export MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GPU_SANDBOX=1 MOZ_DISABLE_RDD_SANDBOX=1
export MOZ_CRASHREPORTER_DISABLE=1
# No Mono or Gecko-for-Wine install prompts.
export WINEDLLOVERRIDES="mscoree=;mshtml="
timeout "${TIMEOUT:-900}" wine /opt/zotero-win/Zotero_win-x64/zotero.exe \
	-profile "$(win "$base/profile")" -no-remote -ZoteroDebugText > /out/zotero-debug.log 2>&1 || echo "zotero exited with $?"
wineserver -k || true
