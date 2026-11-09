# Changelog

## 1.2.0

- 🗺️ **A reading map for every paper and book.** Zusia works out the printed page labels (*PDF 41 = printed 18*), the outline with page ranges, and where each equation, figure and table is. "Page 18" in a question means the printed page. Books from 150 pages on are split into section files, with no cap on their length. Antigravity, which cannot read files, gets pages chosen around the question, with the page on screen last, and can ask for up to three more pages. **Settings → Zusia → Troubleshooting → *Rebuild reading map*** works it out again.
- 📍 **Reading progress.** The pages you turn to in Zotero's reader are noted, so the assistant knows where you are and what you have read. Turn it off in **Settings → Zusia → Chat → *Track reading progress***.
- 🧠 **A memory per paper.** What you understood, what is still shaky, open questions, how you like answers and a running summary are kept in the paper's `memory.json` and sent with every question. `/remember <text>` or `ricorda: <text>` adds a note, `/remember` lists the notes, `/forget <n>` drops one. Click the paper chip above the message box to see, edit or reset it.
- 🔄 **Memory kept in the background.** About every 5 questions, and when you move to another chapter or close the chat, one call to a cheap model (Claude Haiku, or Antigravity at low effort) folds the chat into the memory; its result is checked before it is written. On by default; Codex is never used for it. Per-section summaries are off by default. Both switches are in the Memory sheet. Antigravity has no way to keep these calls out of its history, so they show up in your `agy` conversations.
- 🗣️ **A new setup step, *Your voice*.** Pick a preset (Colleague, Patient tutor, Quiz me, Just the facts) or edit the system prompt yourself, up to 4000 characters, also in **Settings → Zusia → Behaviour → *System prompt***. The default voice is "a sharp colleague, not a textbook"; *LaTeX* now changes the notation, not the genre of the answer.
- ⚠️ **Your own text now replaces the default voice** instead of being appended to it. If you wrote a short custom instruction before, it is now the whole voice: add to it, or empty the box to go back to the default.
- 🔁 **Sessions restart when the prompt changes.** Editing the system prompt, the style presets or the answer language starts a fresh session on every assistant, with the chat carried over.
- 🔢 **Labelled equations number and link.** `\label` and `\eqref` on displayed equations no longer show as raw TeX or broken references.
- 🪟 **Windows:** `--setting-sources=` is passed as one argument, so its empty value is no longer lost ([#1](https://github.com/firekern/zusia/issues/1)). Prompts go to every assistant on stdin, never on the command line. npm's `claude.cmd` and `codex.cmd` shims are swapped for the program they run, and any other `.cmd` or `.bat` is refused, because `cmd.exe` re-parses the command line and prompt text could run commands.

## 1.1.0

- 📄 **The assistant reads the paper.** Zusia now sends the full text Zotero extracts from the PDF, EPUB or web snapshot, with page markers, instead of only the metadata, abstract and annotations. Answers cite pages as *(p. N)*. When the text is missing (a scan, no attachment) or cut to fit, the assistant is told and says so. Turn it off in **Settings → Zusia → Chat → *Send the paper's full text***.
- 🎯 **Where you are comes first.** The page on screen and the page of the selected passage are always sent, also in a continued Antigravity chat.
- 🧭 **A clearer system prompt**, the same for every assistant: what each source is, which one wins, PDF page numbers versus printed labels, and paper text treated as content, never as instructions.
- 🪟 **The chat fills the side pane.** Zusia's icon in the side nav hides Zotero's title bar and the other sections; any other icon brings them back.
- 🔁 Codex and Antigravity chats started with 1.0 begin a new session on the next question, so they drop the old prompt that withheld the paper.

## 1.0.0

First public release.
