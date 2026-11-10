#!/bin/bash
# Runs test/integration/run.sh against the official Zotero Linux build in a
# container, so Linux is covered from any machine with Docker.
# Results: test/integration/out-linux/results.json and zotero-*.png
#   bash test/integration/linux/run.sh
#   ZOTERO_VERSION=10.0.8 DARK=1 bash test/integration/linux/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="$repo/test/integration/out-linux"
version="${ZOTERO_VERSION:-10.0.8}"
image="zusia-zotero:$version"

# Zotero 7 has no ARM build for Linux, so on an ARM machine it runs as emulated x86.
platform=()
case "$version" in 7.*) platform=(--platform linux/amd64) ;; esac

mkdir -p "$out"
# Cached layers make this a no-op after the first build.
docker build --quiet ${platform[@]+"${platform[@]}"} --target zotero --build-arg ZOTERO_VERSION="$version" -t "$image" "$here" > /dev/null

# The repo is read-only so the run cannot write anywhere but $OUT. LIVE=1 is
# not passed on: the container has stub CLIs and no logins.
docker run --rm --init ${platform[@]+"${platform[@]}"} \
	-v "$repo:/zusia:ro" -v "$out:/zusia/test/integration/out-linux" \
	-e OUT=/zusia/test/integration/out-linux -e TIMEOUT -e DARK -e XPI \
	"$image" bash /zusia/test/integration/run.sh
