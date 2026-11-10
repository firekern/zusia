// Prefs every throwaway test profile starts from, on every platform. run.sh and
// windows/entry.sh append the ones that hold paths, which differ between them.
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.startupScanScopes", 15);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.zotero.sync.autoSync", false);
// The setup wizard would cover the screenshots; its steps are tested in jsdom.
user_pref("extensions.zusia.onboarded", true);
// The note for people who update sits above the chat; the tester shows it on its own.
user_pref("extensions.zusia.dockTipSeen", true);
