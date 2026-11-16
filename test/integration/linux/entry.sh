#!/bin/bash
# Both suites run the same packaged plugin, in separate disposable profiles.
set -euo pipefail
bash /zusia/test/integration/run.sh
if [ "${NATIVE_API:-0}" = 1 ]; then
	# Keep the private Gecko profile outside the exported results. Its cache has
	# restrictive permissions and must never be traversed by upload-artifact.
	api_run="$(mktemp -d)"
	collect_api_results() {
		mkdir -p "$OUT/api"
		find "$api_run" -maxdepth 1 -type f \( -name '*.json' -o -name '*.log' \) -exec install -m 644 -t "$OUT/api" {} +
		rm -rf "$api_run"
	}
	trap collect_api_results EXIT
	ZUSIA_API_OUT="$api_run" node /zusia/test/native-api.mjs
fi
