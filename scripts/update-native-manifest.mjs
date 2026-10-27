import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skill = join(root, "skills/pstack");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = [];
async function add(path) {
  const bytes = await readFile(join(skill, path));
  files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
}
async function walk(path) {
  for (const entry of await readdir(join(skill, path), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error("Linked adapter file: " + entry.name);
    const child = path + "/" + entry.name;
    if (entry.isDirectory()) await walk(child);
    else if (entry.isFile()) await add(child);
  }
}
for (const path of metadata.files) {
  const rel = path.replace(/^skills\/pstack\//, "");
  if (rel === path || ["upstream", "native-manifest.json"].includes(rel)) continue;
  if (rel === "native") await walk(rel);
  else await add(rel);
}
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
await writeFile(join(skill, "native-manifest.json"), JSON.stringify({
  schema: 1,
  adapterVersion: "plugin-" + metadata.version,
  files,
  aliasSha256: sha(await readFile(join(root, "skills/poteto-mode/SKILL.md"))),
  baselineSkillNames: [],
}, null, 2) + "\n");
console.log(JSON.stringify({ adapterVersion: metadata.version, files: files.length }));
