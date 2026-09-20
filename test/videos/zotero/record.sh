#!/bin/bash
# Records the README videos in a real Zotero on macOS, with a separate demo profile and
# library (famous arXiv papers), then encodes docs/videos/zusia-*.{gif,mp4}.
# Needs Zotero, the claude CLI, ffmpeg and cliclick (brew install ffmpeg cliclick), and
# Screen Recording and Accessibility permission for the terminal.
# Don't touch the Mac while it records: the scenes move the real pointer.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
base="$HOME/.cache/zusia-demo"
raw="$base/raw"
out="$repo/docs/videos"
mkdir -p "$base/pdfs" "$raw" "$out"

for id in 1706.03762 1512.03385 1810.04805 2010.11929 2005.14165 1412.6980; do
	[ -s "$base/pdfs/$id.pdf" ] || curl -sL -o "$base/pdfs/$id.pdf" "https://arxiv.org/pdf/$id"
done
mkdir -p /Users/Shared/Zusia
cp "${ZUSIA_BACKGROUND:?set ZUSIA_BACKGROUND to the tall illustration}" /Users/Shared/Zusia/night-in-kyoto.jpg

if ! nc -z 127.0.0.1 6200 2>/dev/null; then
	mkdir -p "$base/profile/extensions" "$base/data/zusia"
	echo "$repo/src" > "$base/profile/extensions/zusia@firekern.github.io"
	cat > "$base/profile/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$base/data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
PREFS
	nohup /Applications/Zotero.app/Contents/MacOS/zotero -profile "$base/profile" -no-remote --start-debugger-server 6200 > "$base/zotero.log" 2>&1 &
	until nc -z 127.0.0.1 6200 2>/dev/null; do sleep 1; done
	sleep 8
fi
cp /Users/Shared/Zusia/night-in-kyoto.jpg "$base/data/zusia/background-1.jpg"
node -e '
const { readFileSync } = require("fs");
import(process.argv[1] + "/rdp.mjs").then(async ({ attach }) => {
	const z = await attach(6200);
	console.log(await z.evaluate("let pdfDir = " + JSON.stringify(process.argv[2]) + ";\n" + readFileSync(process.argv[1] + "/library.js", "utf8")));
	z.close();
	process.exit(0);
});' "$here" "$base/pdfs"

# The two README videos: a real question with a real answer, and the live restyling.
node "$here/scenes.mjs" introChat "$raw/introChat.mp4"
node "$here/scenes.mjs" introStyle "$raw/introStyle.mp4"
python3 "$here/build.py" introChat introStyle

encode() {  # candidate mp4 -> docs/videos/<name>.{gif,mp4}
	ffmpeg -hide_banner -loglevel error -y -i "$1" -vf "fps=$3,scale=$4:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=255:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$out/$2.gif"
	cp "$1" "$out/$2.mp4"
}
encode "$out/candidates/introChat.mp4" zusia-chat 9 860
encode "$out/candidates/introStyle.mp4" zusia-style 10 900
ls -la "$out"
