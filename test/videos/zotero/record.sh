#!/bin/bash
# Records the README videos in a real Zotero on macOS, with a separate demo profile and
# library (famous arXiv papers), then encodes docs/videos/zusia-*.{gif,mp4}.
#   ZUSIA_BACKGROUND=illustration.jpg npm run videos               # all five
#   ZUSIA_BACKGROUND=illustration.jpg npm run videos -- introChat  # only these scenes
# Needs Zotero, the claude CLI, ffmpeg and cliclick (brew install ffmpeg cliclick), and
# Screen Recording and Accessibility permission for the app the terminal runs in.
# Don't touch the Mac while it records: the scenes move the real pointer.
#
#   REHEARSE=1 ZUSIA_BACKGROUND=illustration.jpg npm run videos
# walks the same scenes without the pointer, the recorder or the assistant, so it needs
# neither permission, and saves what the window shows at every mark of a scene in
# ~/.cache/zusia-demo/rehearsal/<scene>/. Run it after the interface changes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
base="$HOME/.cache/zusia-demo"
raw="$base/raw"
out="$repo/docs/videos"
mkdir -p "$base/pdfs" "$raw" "$out"

# The scenes of the README, in the order they are recorded: introStyle restyles the
# chat introChat leaves behind. For each, the video's name, and the GIF's rate and width.
scenes=("$@")
[ ${#scenes[@]} -gt 0 ] || scenes=(introChat introStyle theorems explainBetter figure)
video_of() {
	case "$1" in
		introChat) echo "zusia-chat 9 860" ;;
		introStyle) echo "zusia-style 10 900" ;;
		theorems) echo "zusia-proof 6 720" ;;
		explainBetter) echo "zusia-explain-better 7 760" ;;
		figure) echo "zusia-figure 10 900" ;;
		*) echo "no README video is made from the scene $1" >&2; return 1 ;;
	esac
}
for scene in "${scenes[@]}"; do video_of "$scene" > /dev/null; done

for id in 1706.03762 1512.03385 1810.04805 2010.11929 2005.14165 1412.6980; do
	[ -s "$base/pdfs/$id.pdf" ] || curl -sL -o "$base/pdfs/$id.pdf" "https://arxiv.org/pdf/$id"
done
mkdir -p /Users/Shared/Zusia
# The copy of an earlier recording can be given again as it is.
[ "${ZUSIA_BACKGROUND:?set ZUSIA_BACKGROUND to the tall illustration}" -ef /Users/Shared/Zusia/night-in-kyoto.jpg ] ||
	cp "$ZUSIA_BACKGROUND" /Users/Shared/Zusia/night-in-kyoto.jpg

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
// The videos are dark, whatever the Mac is set to.
user_pref("ui.systemUsesDarkTheme", 1);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
PREFS
	nohup /Applications/Zotero.app/Contents/MacOS/zotero -profile "$base/profile" -no-remote --start-debugger-server 6200 > "$base/zotero.log" 2>&1 &
	until nc -z 127.0.0.1 6200 2>/dev/null; do sleep 1; done
	sleep 8
fi
cp /Users/Shared/Zusia/night-in-kyoto.jpg "$base/data/zusia/background-1.jpg"
# Runs a file of this folder inside the demo Zotero, after the line that defines what it needs.
inside() {
	node -e '
const { readFileSync } = require("fs");
import(process.argv[1] + "/rdp.mjs").then(async ({ attach }) => {
	const z = await attach(6200);
	console.log(await z.evaluate(process.argv[3] + "\n" + readFileSync(process.argv[1] + "/" + process.argv[2], "utf8")));
	z.close();
	process.exit(0);
});' "$here" "$1" "$2"
}
inside library.js "let pdfDir = $(node -p 'JSON.stringify(process.argv[1])' "$base/pdfs");"

if [ "${REHEARSE:-0}" = 1 ]; then
	inside rehearsal.js "let repo = $(node -p 'JSON.stringify(process.argv[1])' "$repo");"
	for scene in "${scenes[@]}"; do
		shots="$base/rehearsal/$scene"
		rm -rf "$shots"
		mkdir -p "$shots"
		echo "$scene"
		ZUSIA_REHEARSE="$shots" node "$here/scenes.mjs" "$scene" "$shots/$scene.mp4"
	done
	echo "Rehearsed. What each mark showed is in $base/rehearsal/. The demo Zotero is left open, answering with the canned text: quit it before recording."
	exit 0
fi

for scene in "${scenes[@]}"; do
	node "$here/scenes.mjs" "$scene" "$raw/$scene.mp4"
done
python3 "$here/build.py" "${scenes[@]}"

# candidate mp4 -> docs/videos/<name>.{gif,mp4}, the MP4 at the 1280x800 of the first recordings.
for scene in "${scenes[@]}"; do
	read -r name fps width <<< "$(video_of "$scene")"
	candidate="$out/candidates/$scene.mp4"
	ffmpeg -hide_banner -loglevel error -y -i "$candidate" -vf "fps=$fps,scale=$width:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=255:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$out/$name.gif"
	ffmpeg -hide_banner -loglevel error -y -i "$candidate" -vf "scale=1280:800:flags=lanczos" -c:v libx264 -crf 20 -preset slow -pix_fmt yuv420p -movflags +faststart "$out/$name.mp4"
done
ls -la "$out"
