// Repository hygiene: docs, licences of bundled files, versions and CI stay in step with the code.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const exists = path => existsSync(new URL("../" + path, import.meta.url));

test("README explains install, build, test and opens with the illustration", () => {
	const readme = read("README.md");
	assert.ok(readme.trimStart().startsWith('<p align="center"><img src="docs/zusia-hero.jpg"'), "the wide illustration is the first thing");
	for (const heading of ["## Install", "## Build", "## Test", "## Privacy"]) {
		assert.ok(readme.includes(heading), "README section " + heading);
	}
	for (const image of readme.matchAll(/\]\((docs\/[^)]+)\)|src="(docs\/[^"]+)"/g)) {
		assert.ok(exists(image[1] || image[2]), "missing " + (image[1] || image[2]));
	}
});

test("the README videos are recorded in Zotero and shown with their full-quality copies", () => {
	const readme = read("README.md");
	for (const video of ["zusia-chat", "zusia-style", "zusia-proof", "zusia-explain-better", "zusia-figure"]) {
		assert.ok(readme.includes(`docs/videos/${video}.gif`), video + ".gif shown");
		assert.ok(readme.includes(`docs/videos/${video}.mp4`), video + ".mp4 linked");
	}
	assert.ok(exists("test/videos/zotero/record.sh"));
});

test("every bundled third-party file is credited with its licence", () => {
	const notices = read("THIRD_PARTY_NOTICES.md");
	const bundled = [
		["KaTeX", "src/content/lib/KATEX-LICENSE"],
		["Latin Modern Math", "src/content/lib/LATINMODERN-MATH-LICENSE.txt"],
		["Phosphor Icons", "src/content/icons/PHOSPHOR-LICENSE"],
	];
	for (const [name, licence] of bundled) {
		assert.ok(notices.includes(name), name + " credited");
		assert.ok(exists(licence), licence + " shipped");
	}
	const icons = readdirSync(new URL("../src/content/icons/", import.meta.url)).filter(f => f.endsWith(".svg"));
	const own = icons.filter(f => f.startsWith("mascot-"));
	assert.deepEqual(own.sort(), ["mascot-cat.svg", "mascot-owl.svg", "mascot-robot.svg"], "only the mascots are the plugin's own drawings");
});

test("the extension is called Zusia everywhere a user sees its name", () => {
	const manifest = JSON.parse(read("src/manifest.json"));
	assert.equal(manifest.name, "Zusia");
	assert.equal(JSON.parse(read("package.json")).name, "zusia");
	assert.match(read("src/locale/en-US/zusia.ftl"), /\.label = Zusia/);
	assert.match(read("src/content/zusia.js"), /label: "Zusia"/);
	assert.match(read("build.sh"), /zusia\.xpi/);
	assert.match(read("README.md"), /Zusia/);
	assert.equal(manifest.applications.zotero.id, "zusia@firekern.github.io");
});

test("nothing but the Claude Code backend itself is named after Claude", () => {
	// Zusia drives three assistants. Naming its own files, globals, preferences or
	// data directory after one of them was a leftover from when Claude was the only
	// backend, and it misleads anyone reading the source.
	for (const path of ["src", "test"]) {
		const stray = readdirSync(new URL("../" + path + "/", import.meta.url), { recursive: true })
			.filter(name => /claude/i.test(name));
		assert.deepEqual(stray, [], "no file under " + path + "/ is named after an assistant");
	}
	const sidebar = read("src/content/zusia.js");
	for (const identity of ["ClaudeSidebar", "claude-sidebar"]) {
		assert.ok(!sidebar.includes(identity), identity + " is gone from the sidebar");
	}
	// What is left must be the backend entry, symmetric with codex and agy.
	assert.match(sidebar, /BACKENDS: \{\s*claude: \{/);
	for (const backend of ["claude", "codex", "agy"]) {
		assert.ok(sidebar.includes("run" + backend[0].toUpperCase()), "run helper for " + backend);
	}
});

test("package and manifest versions match", () => {
	const pkg = JSON.parse(read("package.json"));
	const manifest = JSON.parse(read("src/manifest.json"));
	assert.equal(pkg.version, manifest.version);
	assert.equal(pkg.scripts.build, "bash build.sh");
});

test("CI runs the tests and builds the plugin", () => {
	const ci = read(".github/workflows/ci.yml");
	assert.match(ci, /npm ci/);
	assert.match(ci, /npm test/);
	assert.match(ci, /npm run build/);
	assert.match(ci, /zusia\.xpi/);
	for (const file of [".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/feature_request.yml",
		".github/pull_request_template.md", "CONTRIBUTING.md", ".editorconfig"]) {
		assert.ok(exists(file), file);
	}
});

test("a tag is the only thing that publishes a release, and it is checked against the versions", () => {
	const release = read(".github/workflows/release.yml");
	assert.match(release, /tags: \["v\*"\]/, "only tags release");
	assert.doesNotMatch(release, /branches:/, "no branch ever publishes");
	assert.match(release, /npm test/, "tests gate the release");
	assert.match(release, /npm run build/);
	assert.match(release, /node scripts\/updates\.mjs/);
	assert.match(release, /gh release create/);
	assert.match(release, /exit 1/, "a tag that disagrees with the versions fails the job");
});

test("the update manifest points at the release the tag will create", async () => {
	const manifest = JSON.parse(read("src/manifest.json"));
	assert.match(manifest.applications.zotero.update_url, /^https:\/\/github\.com\/firekern\/zusia\/releases\/latest\/download\/updates\.json$/);
	const { execFileSync } = await import("node:child_process");
	execFileSync(process.execPath, [new URL("../scripts/updates.mjs", import.meta.url).pathname]);
	const updates = JSON.parse(read("updates.json")).addons[manifest.applications.zotero.id].updates[0];
	assert.equal(updates.version, manifest.version);
	assert.equal(updates.update_link, `https://github.com/firekern/zusia/releases/download/v${manifest.version}/zusia.xpi`);
});

test("the project is MIT licensed, so a fork is allowed to exist", () => {
	assert.match(read("LICENSE"), /^MIT License/);
	assert.match(read("LICENSE"), /Copyright \(c\) \d{4} .+/);
});
