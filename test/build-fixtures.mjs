// Bundles test/fixtures/*.md into a script, since file:// pages cannot fetch() local files.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const dir = new URL("./fixtures/", import.meta.url);
const fixtures = Object.fromEntries(
	readdirSync(dir).filter(f => f.endsWith(".md")).map(f => [f, readFileSync(new URL(f, dir), "utf8")])
);
writeFileSync(new URL("./fixtures.generated.js", import.meta.url), "var FIXTURES = " + JSON.stringify(fixtures) + ";\n");
