import { readFileSync } from "node:fs";

const [tag, filename] = process.argv.slice(2);
if (
  !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(tag ?? "") ||
  !filename
) {
  throw new Error("Usage: node scripts/release-notes.mjs vX.Y.Z CHANGELOG.md");
}
const changelog = readFileSync(filename, "utf8");
const headings = [...changelog.matchAll(/^## (.+)$/gm)];
const matches = headings.filter((heading) => heading[1].startsWith(`${tag.slice(1)} - `));
if (matches.length !== 1) throw new Error(`Expected one changelog section for ${tag}`);
const heading = matches[0];
const next = headings[headings.indexOf(heading) + 1];
const section = changelog.slice(heading.index, next?.index ?? changelog.length).trim();
if (!section.includes("\n") || !section.slice(section.indexOf("\n")).trim()) {
  throw new Error(`Empty changelog section for ${tag}`);
}
process.stdout.write(`${section}\n`);
