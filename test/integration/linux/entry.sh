#!/bin/bash
# Both suites run the same packaged plugin, in separate disposable profiles.
set -euo pipefail
bash /zusia/test/integration/run.sh
if [ "${NATIVE_API:-0}" = 1 ]; then
	ZUSIA_API_OUT="$OUT/api" node /zusia/test/native-api.mjs
fi
