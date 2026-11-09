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

## Real Zotero

`npm run test:zotero` starts a separate headless Zotero with a throwaway profile, loads the plugin from `src/` and writes `test/integration/out/results.json`. It uses `/Applications/Zotero.app` on macOS and, on Linux, the binary in `ZOTERO_BIN` if set, Flatpak otherwise.

`npm run test:zotero:linux` runs the same checks in Docker against the official Zotero Linux build for your architecture, so Linux is covered from any machine with Docker. Results go to `test/integration/out-linux/`; set `ZOTERO_VERSION` to test another release. The container has stub `claude`, `codex` and `agy` commands and no logins, so `LIVE=1` does not apply. `bash test/integration/linux/shots.sh` runs `npm run shots` the same way, for machines without Firefox or Pillow.

## Layout

| Path | What |
|---|---|
| `src/bootstrap.js` | Zotero plugin lifecycle |
| `src/content/zusia.js` | Constants, state, logging and `MODULES`, the list of files below |
| `src/content/modules/` | One file per area (sidebar, chat, wizard, markdown, math, backends, …); each adds its members to `Zusia` |
| `src/content/readingmap.js` | Pure functions that build a paper's reading map |
| `src/content/zusia.css` | Styles; every colour comes from Zotero's theme tokens or `--zs-*` variables |
| `src/content/icons/` | Phosphor Duotone icons and the original study buddies |
| `test/` | jsdom unit tests, the visual harness and the Zotero integration run |
| `test/videos/zotero/` | Scenes that drive a real Zotero and record the README videos |

## Icons and artwork

Only add icons from Phosphor Duotone (MIT), or original drawings. Add every new third-party file to `THIRD_PARTY_NOTICES.md`; `test/repo.test.mjs` checks this.

## Releases

Bump `version` in both `package.json` and `src/manifest.json` (a test keeps them equal), then push a matching tag:

```sh
git tag v1.1.0 && git push origin v1.1.0
```

`release.yml` compares the tag with both versions and fails the job if they disagree, then tests, builds, writes `updates.json` and publishes the GitHub release with the `.xpi` attached. `ci.yml` tests and builds every push and PR but publishes nothing.
