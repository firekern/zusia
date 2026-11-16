"""Reuse a task-owned isolated profile for recording the real Windows UI.

ZUSIA_DEMO_PROFILE must identify an existing native live-probe profile, not the
personal Zotero profile. The helper seeds synthetic data and a session-only key.
"""
from pathlib import Path
import json, os, zipfile, shutil

root = Path(__file__).resolve().parents[3]
profile = Path(os.environ["ZUSIA_DEMO_PROFILE"]).resolve()
task_root = (root / "test/out").resolve()
if not profile.is_relative_to(task_root) or profile.name != "profile":
    raise RuntimeError("Use only a task-owned profile under test/out")
helper = profile / "extensions/zusia-live-api-probe@firekern.github.io.xpi"
if not helper.is_file() or not (profile / "prefs.js").is_file():
    raise RuntimeError("Expected an existing isolated live-probe profile")
shutil.copy2(root / "zusia.xpi", profile / "extensions/zusia@firekern.github.io.xpi")
manifest = {"manifest_version": 2, "name": "Zusia documentation setup", "version": "2.0.0", "applications": {"zotero": {
    "id": "zusia-live-api-probe@firekern.github.io", "update_url": "https://example.invalid/none.json", "strict_min_version": "6.999", "strict_max_version": "10.*"}}}
with zipfile.ZipFile(helper, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("manifest.json", json.dumps(manifest))
    z.write(root / "test/videos/api/demo-bootstrap.js", "bootstrap.js")
prefs = {
    "extensions.zotero.useDataDir": True,
    "extensions.zotero.dataDir": str(profile.parent / "data"),
    "extensions.zotero.sync.autoSync": False,
    "extensions.zotero.httpServer.enabled": False,
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 15,
    "extensions.startupScanScopes": 15,
    "extensions.zusia.onboarded": True,
    "extensions.zusia.dockTipSeen": True,
    "extensions.zusia.sideTipSeen": True,
    "extensions.zusia-demo.pdf": str(root / "test/out/pr-media/api-backends/study-note.pdf"),
    "intl.locale.requested": "en-US",
    "ui.systemUsesDarkTheme": 1,
    "app.update.enabled": False,
    "app.update.auto": False,
}
(profile / "user.js").write_text("\n".join("user_pref(" + json.dumps(k) + ", " + json.dumps(v) + ");" for k, v in prefs.items()) + "\n", encoding="utf-8")
xul = profile / "xulstore.json"
geometry = json.loads(xul.read_text(encoding="utf-8")) if xul.exists() else {}
geometry.setdefault("chrome://zotero/content/zoteroPane.xhtml", {})["main-window"] = {
    "screenX": "30", "screenY": "30", "width": "1440", "height": "1000", "sizemode": "normal"}
xul.write_text(json.dumps(geometry), encoding="utf-8")
print("Documentation profile prepared; personal profile not accessed.")
