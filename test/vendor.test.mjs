import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("the committed SSE parser and license match npm run vendor", () => {
	execFileSync(process.execPath, ["scripts/vendor.mjs", "--check"], {
		cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "pipe",
	});
});
