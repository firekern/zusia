# API walkthrough sources

Final media and the PR description are attached to [PR #3](https://github.com/firekern/zusia/pull/3). Local exports stay in the ignored `test/out/pr-media/api-backends/` directory, outside version control. These scripts prepare synthetic data and compose annotations. They do not automate the Windows UI or replace the native/live API test suites.

## Synthetic material and isolated setup

`create-study-note.py` uses ReportLab to create the original two-page `study-note.pdf`. Page 2 contains `ORCHID-427`; it is deliberately absent from the item's abstract so answering the verification question requires the PDF's content. `study-note-source.png` is the reviewed two-page preview.

`prepare-demo.py` only accepts an existing live-probe profile named `profile` beneath this checkout's `test/out`. Set `ZUSIA_DEMO_PROFILE` to that task-owned directory, close that instance and run the script. It copies the packaged XPI, replaces the probe helper with `demo-bootstrap.js`, sets an isolated data directory and seeds a readable 1440 x 1000 window. Never point it at a personal profile.

The bootstrap selects `unsloth/gemma-4-E2B-it-GGUF` at `http://127.0.0.1:8888/v1`. That exact model and its profile must already be loaded; do not use this setup to reconfigure a shared runtime. Pass an existing Unsloth key through `ZUSIA_LIVE_KEY` when launching the isolated process. The helper consumes and clears that environment value, keeps the key only in the plugin's session map and clears the map on shutdown. No credential belongs in these sources or final media.

`ZUSIA_DEMO_OLLAMA_URL` enables the independent Ollama endpoint. The recorded demo used a task-owned CPU-only Ollama 0.40.16 container at `http://127.0.0.1:35434/v1`, with already-downloaded `qwen3:0.6b`, `qwen3:1.7b` and `qwen3-vl:2b`. Its image digest is recorded in the media manifest. The container/image were removed afterwards; the downloaded test models were retained with the existing test artifacts.

The helper prepares backend state and imports the synthetic PDF. Every visible interaction, including model selection, numeric-field editing, loading, prompts and Stop, was performed through the official Computer Use `@oai/sky` API. Native form edits need real typing and blur; changing a field's UIA value alone does not necessarily save it.

## Recording and annotations

Record only the uniquely selected demo/settings HWND, never the desktop or personal Zotero window. The recording pipeline uses FFmpeg 8.1 Windows Graphics Capture:

```text
gfxcapture=hwnd=<observed demo HWND>:max_framerate=15:display_border=1
  -> hwdownload,format=bgra
  -> even dimensions, 64-pixel title strip, Segoe UI title, yuv420p
  -> libx264, CRF 22, preset fast, 15 fps
```

The settings clips and Stop clip use `-g 30 -movflags +frag_keyframe+empty_moov+default_base_moof`; the answer clip uses a normal finalized MP4. Send `q` to FFmpeg, repaint the captured window with an observed UI action if WGC is idle, and verify the recorder's exit code before closing the demo. Do not wait indefinitely for a static window or leave a recording helper running.

`capture-svg.mjs` exports `saveAnnotated(state, options)`. It accepts an explicit allowlist of observed window IDs, embeds the original Computer Use screenshot and draws callouts outside the UI. Keep the SVG as the reproducible source. Each text node names Helvetica explicitly because the SVG renderer does not inherit the group font reliably.

Render the reviewed compositions with PyMuPDF:

```sh
python test/videos/api/render-captures.py api-assistants api-grounded-answer api-provider-profile api-capabilities api-recovery api-stop
```

Inspect complete PNGs for callout overlap and readability. Probe duration/codec and decode every final MP4 with FFmpeg; review key frames and the observed UI outcomes. Inspect media for keys, private paths, personal papers and notifications before publication. Retain final media and these sources, rather than duplicate draft exports.
