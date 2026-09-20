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

## Layout

| Path | What |
|---|---|
| `src/bootstrap.js` | Zotero plugin lifecycle |
| `src/content/zusia.js` | Sidebar, settings, wizard, rendering, assistant backends |
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
