// Writes the update manifest Zotero polls to offer in-place upgrades. The release
// workflow uploads it next to the .xpi, and manifest.json's update_url points at
// the /releases/latest/download/ redirect so the URL never has to change.
import { readFileSync, writeFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY || "firekern/zusia";
const manifest = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url), "utf8"));
const { id, strict_min_version, strict_max_version } = manifest.applications.zotero;

const updates = {
	addons: {
		[id]: {
			updates: [{
				version: manifest.version,
				update_link: `https://github.com/${repo}/releases/download/v${manifest.version}/zusia.xpi`,
				applications: { zotero: { strict_min_version, strict_max_version } },
			}],
		},
	},
};

const out = new URL("../updates.json", import.meta.url);
writeFileSync(out, JSON.stringify(updates, null, "\t") + "\n");
console.log(`Wrote updates.json for ${id} ${manifest.version}`);
