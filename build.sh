#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
rm -f zusia.xpi
cd src
if command -v zip >/dev/null; then
	zip -r ../zusia.xpi * -x ".*"
else
	python3 -c "import os, zipfile
with zipfile.ZipFile(\"../zusia.xpi\", \"w\", zipfile.ZIP_DEFLATED) as z:
    for r, d, f in os.walk(\".\"):
        d[:] = [x for x in d if not x.startswith(\".\")]
        [z.write(os.path.join(r, n), os.path.relpath(os.path.join(r, n))) for n in f if not n.startswith(\".\")]"
fi
cd ..
echo "Built zusia.xpi"
