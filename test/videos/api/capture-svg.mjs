// Documentation composition: the original Computer Use screenshot remains an
// embedded raster image. Callouts are separate SVG elements, outside the UI.
import { writeFile } from "node:fs/promises";

const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function saveAnnotated(state, { name, title, subtitle, notes, allowedWindowIds }) {
	if (!allowedWindowIds.includes(state.window.id)) throw new Error("Capture is not from an approved documentation window");
	if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid capture name");
	const shot = state.screenshots[0];
	if (!shot?.url?.startsWith("data:image/")) throw new Error("Missing original screenshot");
	const w = shot.width, h = shot.height;
	if (!w || !h) throw new Error("Screenshot dimensions are missing");
	let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w + 400}" height="${h + 110}" viewBox="0 0 ${w + 400} ${h + 110}">
<rect width="100%" height="100%" fill="#141719"/>
<g fill="#f4f6f7"><text font-family="Helvetica" x="20" y="34" font-size="25" font-weight="700">${escape(title)}</text><text font-family="Helvetica" x="20" y="61" font-size="14" fill="#bdc8cd">${escape(subtitle)}</text></g>
<image x="20" y="90" width="${w}" height="${h}" xlink:href="${escape(shot.url)}"/>`;
	for (const note of notes) {
		const mid = note.y + note.h / 2 + 90;
		const label = Math.max(125, mid - 28);
		svg += `<rect x="${note.x + 20}" y="${note.y + 90}" width="${note.w}" height="${note.h}" rx="3" fill="none" stroke="#70c6bd" stroke-width="2"/>
<path d="M${note.x + note.w + 20} ${mid} H${w + 43}" fill="none" stroke="#70c6bd" stroke-width="2"/>
<g><text font-family="Helvetica" x="${w + 60}" y="${label}" fill="#91ddd3" font-size="18" font-weight="700">${escape(note.title)}</text>`;
		for (const [i, line] of note.lines.entries()) svg += `<text font-family="Helvetica" x="${w + 60}" y="${label + 26 + i * 21}" fill="#e0e7ea" font-size="15">${escape(line)}</text>`;
		svg += "</g>";
	}
	svg += "</svg>\n";
	const target = new URL(`../../../test/out/pr-media/api-backends/${name}.svg`, import.meta.url);
	await writeFile(target, svg, "utf8");
	return { file: target.pathname, width: w, height: h, windowId: state.window.id };
}
