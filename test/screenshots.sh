#!/bin/bash
# Renders harness scenarios in headless Firefox (Gecko, the engine Zotero runs on),
# in light and dark mode, into test/out/<scheme>-<name>.png.
#   bash test/screenshots.sh                 # default set
#   bash test/screenshots.sh "chat&fixture=tables.md" ...
set -euo pipefail
cd "$(dirname "$0")"
node build-fixtures.mjs
mkdir -p out

SCENARIOS=("$@")
if [ ${#SCENARIOS[@]} -eq 0 ]; then
	SCENARIOS=(
		"chat&fixture=fft-real.md&zoom=2"
		"chat&fixture=tables.md&zoom=2"
		"chat&fixture=latex.md&zoom=2"
		"chat&fixture=markdown.md&zoom=2"
		"empty&zoom=2"
		"streaming&fixture=latex.md&zoom=2"
		"error&fixture=markdown.md&zoom=2"
		"pairs&zoom=2&width=340"
		"chat&fixture=latex.md&zoom=2&width=280&model=opus&effort=xhigh"
		"long&fixture=fft-real.md&zoom=2"
		"menu-model&fixture=markdown.md&zoom=2&model=opus&effort=high"
		"menu-effort&fixture=markdown.md&zoom=2&model=opus&effort=high"
		"menu-more&fixture=markdown.md&zoom=2"
		"menu-history&fixture=markdown.md&zoom=2"
		"prefs&width=660&zoom=1.4"
	)
fi

for scheme in light dark; do
	profile=$(mktemp -d)
	# content-override: 0 = dark, 1 = light
	override=$([ "$scheme" = dark ] && echo 0 || echo 1)
	cat > "$profile/user.js" <<PREFS
user_pref("layout.css.prefers-color-scheme.content-override", $override);
user_pref("ui.systemUsesDarkTheme", $([ "$scheme" = dark ] && echo 1 || echo 0));
user_pref("layout.css.devPixelsPerPx", "1.5");
user_pref("svg.context-properties.content.enabled", true);
user_pref("security.fileuri.strict_origin_policy", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
PREFS
	for scenario in "${SCENARIOS[@]}"; do
		name=$(echo "$scenario" | sed -E 's/fixture=//; s/\.md//; s/&(zoom|width)=[0-9.]+//g; s/&(model|effort)=[a-z]+//g; s/[^a-zA-Z0-9]+/-/g')
		out="$PWD/out/$scheme-$name.png"
		timeout 60 firefox --headless --no-remote --profile "$profile" \
			--window-size=${WIDTH:-940},4000 --screenshot "$out" \
			"file://$PWD/harness.html?scenario=$scenario" >/dev/null 2>&1 || echo "failed: $scenario"
		echo "$out"
	done
	rm -rf "$profile"
done

# Crop each shot to its content so the images stay small.
python3 - "$PWD/out" <<'PY'
import sys, glob
from PIL import Image
for path in glob.glob(sys.argv[1] + "/*.png"):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    bg = px[w - 1, h - 1]
    bottom = h
    for y in range(h - 1, 0, -8):
        if any(px[x, y] != bg for x in range(0, w, 6)):
            bottom = min(h, y + 24)
            break
    im.crop((0, 0, w, bottom)).save(path)
PY
