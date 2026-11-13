# Contributing

## Setup

```sh
npm ci
npm test
```

## Workflow: tests first

1. Write a test in `test/*.test.mjs` that describes the behaviour, and run `npm test` to see it fail.
2. Implement the smallest change in `src/` that makes it pass.
3. Run `npm test` again; all tests must pass before a commit.
4. For visual changes, check `test/harness.html` in a browser (for example `?scenario=wizard&step=3`) or run `npm run shots`. If the change shows in a README video, re-record them with `npm run videos` (macOS, real Zotero).

The harness takes the state to render from its URL: `scenario` (`empty`, `pairs`, `chat`, `long`, `streaming`, `error`, `clarifications`, `wizard`, `prefs`, `menu-model`, …), `fixture=<file in test/fixtures>`, `layout=<minimal|standard|rich|visual>`, `dock=1` for the left panel (a column of fixed height, `height=<px>`), `width=<px>`, `reading=1` for reading progress, `zoom=2`. Look at a change in light and dark, in the dock at 380 and 280px, and in the item pane at about 300px.

## Real Zotero

`npm run test:zotero` starts a separate headless Zotero with a throwaway profile, loads the plugin from `src/` and writes `test/integration/out/results.json`. It uses `/Applications/Zotero.app` on macOS and, on Linux, the binary in `ZOTERO_BIN` if set, Flatpak otherwise.

`npm run test:zotero:linux` runs the same checks in Docker against the official Zotero Linux build for your architecture, so Linux is covered from any machine with Docker. Results go to `test/integration/out-linux/`; set `ZOTERO_VERSION` to test another release (`7.0.32`, `8.0.4`, `9.0.2`: the plugin supports Zotero 7 and later, and Zotero 7 is a much older Gecko), and `XPI=1` to load the packaged plugin instead of `src/`. On Zotero 7 a plugin loaded from `src/` cannot use its own SVG files as CSS masks, which a packaged one can: the buddy's face beside answers in the Visual layout is missing there only in that setup. The container has stub `claude`, `codex` and `agy` commands and no logins, so `LIVE=1` does not apply. `bash test/integration/linux/shots.sh` runs `npm run shots` the same way, for machines without Firefox or Pillow.

`npm run test:zotero:windows` runs them in the official Windows build of Zotero under Wine, in a `linux/amd64` container, so the plugin's Windows branches run in a real Gecko without a Windows machine. Results go to `test/integration/out-windows/`. No child process can be started there (the x86 emulator dies at the spawn), so the one check that needs `agy models` answered is reported as not runnable and does not fail the run. `test/windows.test.mjs` covers what Wine cannot show (Windows spelling the variable `Path`) on a path model that the same run compares with the real `PathUtils`.

`HEADED=1 npm run test:zotero` (macOS) opens a real window and adds the checks that need one: the side panel following a click in the items tree and the reader tabs.

## Layout

| Path | What |
|---|---|
| `src/bootstrap.js` | Zotero plugin lifecycle |
| `src/content/zusia.js` | Constants, state, logging, and the two lists below: `MODULES` and `STYLES` |
| `src/content/modules/` | One file per area; each adds its members to `Zusia` with `Object.assign`. A file missing from `MODULES` never loads (a test checks the list) |
| `src/content/modules/dock.js`, `window.js` | Where the chat is: the panel at the left or right edge of the window, or the section in Zotero's item pane |
| `src/content/modules/sidebar.js`, `chat.js`, `ask.js` | The chat itself: its skeleton, the messages, a question from send to answer |
| `src/content/modules/layouts.js` | The four layouts and the parts only some of them show |
| `src/content/modules/binaries.js`, `prompts.js`, `backends.js` | Finding the assistant CLIs, what they are told, running them |
| `src/content/readingmap.js` | Pure functions that build a paper's reading map |
| `src/content/styles/` | One stylesheet per area, linked in the order of `Zusia.STYLES`, which is the cascade: a later file overrides an earlier one. Every colour comes from Zotero's theme tokens or `--zs-*` variables |
| `src/content/styles/layouts.css`, `layout-<name>.css` | What the layouts share, then one file per layout, last in the cascade |
| `src/content/icons/` | Phosphor Duotone icons and the original study buddies |
| `test/` | jsdom unit tests, the visual harness and the Zotero integration run |
| `test/videos/zotero/` | Scenes that drive a real Zotero and record the README videos |

## Adding a layout

A layout is a look for the same chat, not another chat: the skeleton in `sidebar.js` holds every part, and a layout's stylesheet shows and arranges its own, keyed on `data-layout` on the chat's root.

1. Add it to `LAYOUTS` in `layouts.js`, with the `look` it starts from (style, buddy, spacing, labels).
2. Add `src/content/styles/layout-<name>.css` and its name at the end of `STYLES`. Scope every rule with `.zs-root[data-layout="<name>"]`.
3. A part no other layout has goes into the skeleton, hidden by default in `layouts.css`.
4. `test/layouts.test.mjs` and the layout checks in `test/integration/tester/bootstrap.js` pick the new layout up from `LAYOUTS`; render it with `layout=<name>` in the harness.

## Icons and artwork

Only add icons from Phosphor Duotone (MIT), or original drawings. Add every new third-party file to `THIRD_PARTY_NOTICES.md`; `test/repo.test.mjs` checks this.

## Releases

Bump `version` in both `package.json` and `src/manifest.json` (a test keeps them equal), then push a matching tag:

```sh
git tag v1.1.0 && git push origin v1.1.0
```

`ci.yml` runs on every push and PR and publishes nothing: the unit tests, the build, then the built `.xpi` inside Zotero 7, 8, 9 and 10 on Linux (`XPI=1 npm run test:zotero:linux`, one job per version; the renders and `results.json` of each are kept for a week as the run's artifacts). `release.yml` compares the tag with both versions and fails if they disagree, runs all of `ci.yml`, then writes `updates.json` and publishes the GitHub release with the `.xpi` those checks ran on.

Before tagging, run the checks no workflow runs: `npm run build && XPI=1 npm run test:zotero` (the packaged plugin in a real Zotero on macOS, where Zotero's own stylesheet differs: it caps every button at 25px) and `npm run test:zotero:windows`.

If Actions cannot run, the same release can be cut by hand after pushing the tag: `npm test && npm run build && node scripts/updates.mjs && gh release create vX.Y.Z zusia.xpi updates.json --title "Zusia vX.Y.Z" --generate-notes`. Zotero's update check reads `updates.json` from the latest release, so it has to be attached.
