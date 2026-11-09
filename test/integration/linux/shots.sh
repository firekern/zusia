#!/bin/bash
# Runs test/screenshots.sh (npm run shots) in a container with Firefox ESR and
# Pillow, for machines that have neither. Shots land in test/out/ as usual.
#   bash test/integration/linux/shots.sh
#   bash test/integration/linux/shots.sh "chat&fixture=tables.md"
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
image="zusia-shots:latest"

docker build --quiet --target shots -t "$image" "$here" > /dev/null

# Read-write: screenshots.sh writes test/fixtures.generated.js and test/out/.
docker run --rm --init -v "$repo:/zusia" -e WIDTH \
	"$image" bash /zusia/test/screenshots.sh "$@"
