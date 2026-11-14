// Runs inside the demo Zotero before a recording that follows a rehearsal: the canned
// answers must not be the chats and the memory the videos start from (explainBetter
// keeps the answer it asks to have explained again; the assistant is told the memory).
let CS = Zotero.Zusia;
let items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
let forgotten = 0;
for (let item of items.filter(i => i.isRegularItem())) {
	let dir = CS.contextDirFor(item);
	if (!(await IOUtils.exists(dir))) {
		continue;
	}
	await CS.saveHistory(dir, []);
	await CS.saveSessions(dir, {});
	await IOUtils.remove(CS.memoryPath(dir), { ignoreAbsent: true });
	forgotten++;
}
return forgotten;
