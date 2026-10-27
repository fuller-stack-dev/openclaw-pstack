import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Read a relative path below root, refusing traversal and any linked component. */
export async function safeRead(root, path) {
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")) throw Error("Unsafe input path: " + path);
  let cursor = root;
  if ((await lstat(cursor)).isSymbolicLink()) throw Error("Linked root");
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw Error("Linked input: " + path);
  }
  return readFile(cursor);
}

export async function inventory(root) {
  const found = [];
  async function walk(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const child = path ? path + "/" + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw Error("Linked generated/source path: " + child);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) found.push(child);
      else throw Error("Non-file generated/source path: " + child);
    }
  }
  await walk("");
  return found.sort();
}

/**
 * Verify every pinned upstream file against source-manifest.json and the exact
 * inventory, returning the manifest and the verified bytes by path.
 */
export async function loadPinnedSource(skill) {
  const sourceBytes = await safeRead(skill, "source-manifest.json");
  const source = JSON.parse(sourceBytes);
  const files = new Map();
  for (const record of source.files) {
    if (files.has(record.path)) throw Error("Duplicate pinned source: " + record.path);
    const bytes = await safeRead(skill, "upstream/" + record.path);
    if (bytes.length !== record.bytes || sha(bytes) !== record.sha256)
      throw Error("Pinned source changed without review: " + record.path);
    files.set(record.path, bytes);
  }
  const actual = await inventory(join(skill, "upstream"));
  if (source.fileCount !== files.size || JSON.stringify(actual) !== JSON.stringify([...files.keys()].sort()))
    throw Error("Pinned source inventory mismatch");
  return { source, sourceBytes, files };
}
