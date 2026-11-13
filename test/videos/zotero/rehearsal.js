// Runs inside the demo Zotero for a rehearsal (REHEARSE=1 npm run videos): no assistant
// is called. Every question gets the same canned answer, written out over a few seconds
// the way Claude Code streams one, with what the scenes look for: a drawing, theorem
// boxes with references between them, and enough maths to scroll.
// The caller defines repo.
let CS = Zotero.Zusia;
let fixture = name => IOUtils.readUTF8(PathUtils.join(repo, "test", "fixtures", name));
let answer = [await fixture("drawing.md"), await fixture("theorems.md"), await fixture("fft-real.md")].join("\n\n");
CS.findBinary = async () => "/usr/bin/true";
CS.runProcess = async (command, args, workdir, onEvent) => {
	for (let at = 0; at < answer.length; at += 400) {
		onEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: answer.slice(at, at + 400) } } });
		await Zotero.Promise.delay(120);
	}
	return { stdout: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: answer }] } }) + "\n", stderr: "", exitCode: 0 };
};
return answer.length;
