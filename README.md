<p align="center"><img src="docs/zusia-hero.jpg" alt="Zusia: a girl in a red hoodie studying the ResNet paper at night" width="100%"></p>

<h1 align="center">Zusia</h1>

<p align="center"><b>Your study buddy inside Zotero.</b><br>Ask about the paper you're reading. Get maths, drawings and proofs back.</p>

<p align="center">
  <a href="https://github.com/firekern/zusia/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/firekern/zusia/ci.yml?branch=main&label=tests&color=d42a3c&labelColor=111111" alt="Tests"></a>
  <a href="https://github.com/firekern/zusia/releases/latest"><img src="https://img.shields.io/github/v/release/firekern/zusia?label=release&color=b85a38&labelColor=111111" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/Zotero-7%20%E2%80%93%2010-c03a64?labelColor=111111" alt="Zotero 7 to 10">
  <img src="https://img.shields.io/badge/Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Antigravity-6d4fd6?labelColor=111111" alt="Works with Claude Code, Codex and Antigravity">
  <img src="https://img.shields.io/badge/no%20API%20keys-0d7f78?labelColor=111111" alt="No API keys">
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-2d7d46?labelColor=111111" alt="MIT licence"></a>
  <a href="https://github.com/sponsors/firekern"><img src="https://img.shields.io/badge/sponsor-a%20breakfast-b8862b?labelColor=111111&logo=githubsponsors&logoColor=white" alt="Sponsor a breakfast"></a>
</p>

<p align="center"><img src="docs/rule.svg" alt="" width="100%"></p>

**TL;DR**

- 💬 A chat **next to the PDF** that reads the **whole paper**, in its own panel at the side of the window.
- ✏️ Answers with **LaTeX**, **drawings** and numbered **theorem boxes**.
- 🔑 Uses **Claude Code, Codex or Antigravity** with your own login. No API keys.
- 🖥️ Optionally connect **Ollama, Unsloth or a custom API**: [connect a local model](#connect-a-local-model).
- ⏱️ Install in 2 minutes: [jump to Install](#install).

<p align="center"><img src="docs/rule.svg" alt="" width="100%"></p>

## 1. Ask about the paper

> **Open a paper and ask.** Zusia is the panel on the right of the window, beside your library and the PDF. It follows the paper you select or open; drag its edge to resize it, and **⌥Z** (Alt+Z) hides it and brings it back. Turn on *Drawing* and *LaTeX* for a diagram and real maths.
>
> Recorded in a real Zotero on a Mac: *Attention Is All You Need*, a live answer from Claude. 22 seconds, with the wait sped up.

<p align="center"><img src="docs/videos/zusia-chat.gif" alt="In Zotero, open Zusia's panel beside Attention Is All You Need, turn on Drawing and LaTeX, ask how Q, K and V flow and why attention divides by the square root of d_k, and read Claude's answer with its diagram and lemmas" width="100%"></p>

<p align="center"><a href="docs/videos/zusia-chat.mp4">▶ Watch in full quality (MP4)</a></p>

## 2. Make it yours

> **Settings → Zusia → Appearance → *Layout*.** Four ways to see the chat. *Minimal*: the conversation and the message box. *Standard*: the tools as icons, one click away. *Rich*: a card for the paper with your reading progress, the tools by name. *Visual*: your buddy beside each answer, bubbles, prompt cards and colour. The setup wizard asks on first run.

<p align="center"><img src="docs/layouts.png" alt="The same short chat in the four layouts, Minimal, Standard, Rich and Visual, in Zotero's light theme above and its dark theme below" width="100%"></p>

> **Then everything else in Settings → Zusia.** Style, buddy, pattern, accent colour, background image and button labels, all updating live in the chat. Glass, corners, font, answer length, level, tone and the system prompt are there too.

<p align="center"><img src="docs/videos/zusia-style.gif" alt="In Zotero Settings, switch glass and flat, buddy and pattern, pick the red accent and a background illustration while the panel beside it updates live to red and black" width="100%"></p>

<p align="center"><a href="docs/videos/zusia-style.mp4">▶ Watch in full quality (MP4)</a></p>

<p align="center"><img src="docs/palette.svg" alt="The eight accent colours: Zotero, Red, Clay, Rose, Violet, Teal, Forest and Graphite" width="560"></p>

<p align="center"><sub>Eight accents. Red on black is the one in every video here.</sub></p>

## 3. Follow a proof

> **Turn on *LaTeX*.** Definitions, lemmas and theorems come back as numbered boxes, and every `\ref` is a link: click to jump, **Back** (⌥←) to return.

<p align="center"><img src="docs/videos/zusia-proof.gif" alt="In Zotero on the Adam paper, ask for Theorem 4.1 in a theorem box and its proof as lemmas; the answer arrives as a numbered theorem and lemmas that link to each other, clicking a link jumps to its lemma and Back returns" width="100%"></p>

<p align="center"><a href="docs/videos/zusia-proof.mp4">▶ Watch in full quality (MP4)</a></p>

## 4. Didn't click? Ask again, better

> **One button under every answer.** It comes back with the intuition first, then the steps, an example and the usual trap.

<p align="center"><img src="docs/videos/zusia-explain-better.gif" alt="In Zotero on the BERT paper, a dense answer about the masked language model, then the Explain better button produces the intuition, the steps and a worked example" width="100%"></p>

<p align="center"><a href="docs/videos/zusia-explain-better.mp4">▶ Watch in full quality (MP4)</a></p>

## 5. Ask about a figure

> **📎 → *Current PDF page*.** The page you are looking at goes with the question, so figures and tables can be asked about. Upload, paste, drop or screenshot work too.

<p align="center"><img src="docs/videos/zusia-figure.gif" alt="In Zotero on the Vision Transformer paper, attach the current PDF page and ask what Figure 1 shows" width="100%"></p>

<p align="center"><a href="docs/videos/zusia-figure.mp4">▶ Watch in full quality (MP4)</a></p>

<p align="center"><img src="docs/rule.svg" alt="" width="100%"></p>

## Everything else, in one line each

| | Feature | How |
|:--:|---|---|
| 🔴 | **Explain a passage** | Select text in the PDF → *Explain this* |
| 🟠 | **Ask about a passage** | Select text → *Ask your assistant about this*, then add your question |
| 🩷 | **Clarifications** | Every Ask and Explain is saved: highlighter icon → passage, prompt, answer |
| 🟣 | **Notes** | Save any answer or drawing as a Zotero note under the paper |
| 🔵 | **Search** | 🔍 searches the chats of every paper |
| 🟢 | **Models** | Pick assistant, model and reasoning effort from the message box |
| 🟤 | **Memory** | `/remember` a note, `/forget` one; click the paper chip above the message box to see, edit or reset what Zusia keeps |
| 🟡 | **Printed pages** | Ask about "page 18" and the assistant reads the page printed 18, whatever its PDF number |
| ⚫ | **Setup** | A visual wizard on first run, including the assistant's voice: a preset or your own system prompt |
| ⚪ | **Side panel** | ⌥Z / Alt+Z shows and hides it; drag its edge to resize, double-click the edge to reset; put it on the left, the right or in the item pane in Settings |

## Install

1. **Choose an assistant:** install and sign in to [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex) or Antigravity (`agy`).
2. **Download `zusia.xpi`** from the [latest release](https://github.com/firekern/zusia/releases/latest).
3. **In Zotero:** Tools → Plugins → ⚙ → *Install Plugin From File…* → pick the `.xpi`. Restart if asked.
4. **Open a paper.** Zusia appears in a panel on the right and starts the setup wizard. To have it on the left or in Zotero's item pane instead, choose **Settings → Zusia → Chat → *Where the chat is***.

Updates arrive on their own after that: Zotero checks the release feed.

### Connect a local model

CLI assistants remain the default and need no API key. Optionally, start Ollama or Unsloth, open **Settings → Zusia → Assistants**, enter its `/v1` URL, check the connection and select an exact server model. Ollama defaults to `http://127.0.0.1:11434/v1`; Unsloth uses `http://127.0.0.1:8888/v1` and its Studio API key.

Provider profiles are inherited by default. Remote endpoints require HTTPS; custom endpoints require an explicit opt-in for extra background calls. See [API setup and provider settings](docs/api-backends.md) for authentication, profiles, capabilities and troubleshooting.

## What the assistant reads

- 📄 **The paper's full text**, as Zotero extracts it from the PDF (split by page), EPUB or web snapshot. Answers cite pages as *(p. N)*.
- 🎯 **Where you are.** The page on screen and the passage you selected come first, with the pages you have turned to so far. Antigravity, which cannot read files, gets the pages that fit, chosen around that page and the question, and can ask for a few more.
- 🗺️ **A reading map**: the printed page labels, the outline with page ranges, and where each equation, figure and table is. A book is split into section files, whatever its length.
- 🧠 **What it remembers about this paper**: what you understood, what is still unclear, how you like answers, your `/remember` notes and a running summary. Every few questions a short call brings it up to date (Claude Haiku, Antigravity, or the selected API model). Custom API endpoints require an explicit opt-in for these extra calls. Codex does not run background memory jobs.
- 🏷️ **Metadata and your annotations**: title, authors, abstract, highlights and comments.
- 🚫 **No text, no guessing.** For a scanned PDF with no text layer, the assistant says it cannot read the paper instead of answering from the abstract.

## Privacy

- 🖥️ CLI assistants run **on your computer** with your own login. Zusia has no relay server. API backends connect directly to the URL you configure, using its own authentication.
- 📄 They get the paper's **full text, metadata and your annotations**, its reading map, your reading progress and its memory, plus any image you attach. The CLI sends them to its provider (Anthropic, OpenAI or Google), as it does with anything you type into it.
- API backends send selected document excerpts, reading context, conversation and optional images to the configured endpoint. A local URL can still route to a cloud model if the server is configured that way. Zusia never silently falls back to another provider.
- 🔕 To send only the metadata, abstract and annotations, turn off **Settings → Zusia → Chat → *Send the paper's full text***. *Track reading progress* in the same card stops noting the pages you turn to.
- 🧠 Keeping the memory takes extra calls to the same assistant or API, in the background. API memory uses the selected model and can consume its quota or keep a local GPU busy. Extra background calls to custom endpoints are off until you enable them in that endpoint's assistant card. Turn jobs off in the Memory sheet (click the paper chip). Antigravity stores each of its background calls in your `agy` conversation history.
- 📁 Chats, clarifications, images, the reading map, your reading progress and the memory stay in `zusia/` inside Zotero's data folder.

<p align="center"><img src="docs/rule.svg" alt="" width="100%"></p>

<details>
<summary><b>For developers: build, test, release, record the videos</b></summary>

## Build

```sh
npm ci
npm run build        # packages the committed browser bundle into zusia.xpi
npm run vendor       # regenerate the bundled SSE parser after updating its dependencies
```

## Test

```sh
npm test             # unit tests (jsdom): rendering, settings, wizard, backends, repo checks
npm run test:api:zotero       # built XPI in an isolated Zotero profile, against a loopback fixture API (ZOTERO_BIN to override; Python needed)
npm run test:api:live         # opt-in real provider checks; configuration below
npm run shots        # screenshots of the UI in headless Firefox (optional)
npm run test:zotero          # the checks inside a real, headless Zotero (macOS app, or Flatpak on Linux)
npm run test:zotero:linux    # the same in Docker, against the official Linux build
npm run test:zotero:windows  # the same in the Windows build under Wine, in Docker
ZUSIA_BACKGROUND=path/to/illustration.jpg npm run videos   # re-records the README videos (macOS)
INSIDE=1 ZUSIA_BACKGROUND=path/to/illustration.jpg npm run videos     # the same, filmed from inside Zotero: no permissions
REHEARSE=1 ZUSIA_BACKGROUND=path/to/illustration.jpg npm run videos   # walks the same scenes without recording
```

CI runs both the general and API fixture suites in official Zotero 7, 8, 9 and 10 Linux builds. To include the API suite locally, use `NATIVE_API=1 npm run test:zotero:linux`. The native fixture suite also accepts `ZUSIA_API_UPGRADE_XPI=/path/to/previous.xpi` to check an actual package upgrade, including encrypted-key persistence when Zotero exposes its OS key store, model/profile selection and synthetic history.

Real-provider checks are separate from fixtures and require an explicit endpoint and installed model. Set `ZUSIA_LIVE_BACKEND` (`ollama` or `unsloth`), `ZUSIA_LIVE_URL` (including `/v1`) and `ZUSIA_LIVE_MODEL` (exact ID). If authentication is needed, pass `ZUSIA_LIVE_KEY` through the process environment; the probe keeps it only in memory. Optional `ZUSIA_LIVE_IMAGE` points to a synthetic green PNG for vision verification. `ZUSIA_LIVE_CONTEXT_TOKENS` explicitly applies an Ollama context override; `ZUSIA_LIVE_OUTPUT_TOKENS` changes the default 1024-token output budget. The probe checks streaming, usage, profiles, non-streaming, tools and reasoning when declared, Stop and a Zotero restart. It uses a new profile and synthetic document; Unsloth must already have the selected model and saved profile loaded, otherwise a read-only guard stops the run. Ollama may load its selected local model. It never downloads models or silently changes providers. Responses are model-dependent, so a failed evidence or tool assertion needs inspection even when transport succeeds. Results and the disposable profile are written under `test/out/`; remove that run directory after retaining the report. `ZOTERO_BIN`, `ZUSIA_LIVE_OUT` and `ZUSIA_LIVE_TIMEOUT` override the executable, output directory and timeout in milliseconds. Both runners refuse a nonempty output directory.

The videos are recorded in a real Zotero with its own demo profile and library, so your library is never used. The scenes move the real pointer: don't touch the Mac while they run. Needs `ffmpeg`, `cliclick`, the `claude` CLI, and Screen Recording and Accessibility permission for the app the terminal runs in. With `INSIDE=1` neither permission is needed, nor `cliclick`: Zotero draws its own window into every frame, clicks and typing reach it as events, and the pointer and the window's buttons are drawn into the film afterwards, so the Mac's pointer stays yours; keep the demo window uncovered while it runs. The videos on this page were made this way. With `REHEARSE=1` nothing is recorded, the pointer stays where it is and no assistant is called, so neither permission is needed: every scene is walked through with events sent to Zotero and a canned answer, and what the window shows at each step is saved under `~/.cache/zusia-demo/rehearsal/`. Run it after the interface changes, to see that the scenes still find their way.

## Release

Bump `version` in `package.json` and `src/manifest.json`, then tag it:

```sh
git tag v1.1.0 && git push origin v1.1.0
```

The tag is what releases. `.github/workflows/release.yml` refuses to run if the tag and the two versions disagree, then runs the tests, builds the `.xpi`, writes `updates.json` and attaches both to a GitHub release. Pushing to `main` never publishes anything.

New behaviour starts with a failing test; see [CONTRIBUTING.md](CONTRIBUTING.md).

</details>

## Support

Zusia is free, and every feature is in the free release. If it saved you an afternoon on a hard paper, you can [buy me a breakfast](https://github.com/sponsors/firekern): an espresso is $1.

An issue, an idea or a pull request counts as much as a donation. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Icons: [Phosphor Icons](https://phosphoricons.com) (MIT). Maths: [KaTeX](https://katex.org) (MIT) and Latin Modern Math (GUST Font License). The study buddies are original to this project; the illustrations were made for Zusia with Google Gemini. Papers in the videos: arXiv 1706.03762, 1512.03385, 1810.04805, 2010.11929, 2005.14165, 1412.6980. Details in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Zusia is MIT licensed. See [LICENSE](LICENSE).
