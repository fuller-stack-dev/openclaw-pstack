import { open } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
export const geometry = Object.freeze({
  width: 640,
  height: 360,
  strip: 64,
  fps: 12,
  transition: 6,
});
export const sha = (b) => createHash("sha256").update(b).digest("hex");
export function fields(o, names, context) {
  if (
    !o ||
    typeof o !== "object" ||
    Array.isArray(o) ||
    Object.keys(o).some((k) => !names.includes(k))
  )
    throw Error("Invalid " + context + " fields");
}
export async function boundedFile(path, max) {
  const handle = await open(path, "r");
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.size > max)
      throw Error("File exceeds byte bound or is not regular: " + path);
    const b = Buffer.alloc(max + 1);
    let length = 0;
    while (length < b.length) {
      const { bytesRead } = await handle.read(b, length, b.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > max) throw Error("File grew beyond byte bound");
    return b.subarray(0, length);
  } finally {
    await handle.close();
  }
}
export function words(s) {
  // Count punctuation tokens too; never discount labels or infer prior knowledge.
  return s
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .reduce((n, t) => n + Math.max(1, Array.from(t.matchAll(/[\p{L}\p{N}]+/gu)).length), 0);
}
export function pngSize(b) {
  if (
    b.length < 33 ||
    b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    b.toString("ascii", 12, 16) !== "IHDR"
  )
    throw Error("Source must be PNG");
  const w = b.readUInt32BE(16),
    h = b.readUInt32BE(20);
  if (!w || !h || w > 4096 || h > 4096 || w * h > 8_000_000)
    throw Error("PNG dimension/pixel bound exceeded");
  return { width: w, height: h };
}
export async function loadManifest(file) {
  const bytes = await boundedFile(file, 65536);
  let m;
  try {
    m = JSON.parse(bytes);
  } catch {
    throw Error("Invalid manifest JSON");
  }
  fields(m, ["version", "window", "slides"], "manifest");
  if (m.version !== 1) throw Error("Manifest version must be 1");
  fields(m.window, ["lastUserMessageId", "invocationId"], "window");
  for (const x of Object.values(m.window))
    if (typeof x !== "string" || !x.trim() || x.length > 256) throw Error("Window IDs required");
  if (!m.window.lastUserMessageId || !m.window.invocationId)
    throw Error("Both ketchup window IDs required");
  if (!Array.isArray(m.slides) || !m.slides.length || m.slides.length > 10)
    throw Error("Use 1 through 10 factual slides");
  const slides = [];
  const ids = new Set();
  let start = 0;
  for (const s of m.slides) {
    fields(s, ["id", "source", "caption", "newLabels"], "slide");
    fields(s.source, ["type", "path", "sha256", "ref"], "source");
    if (typeof s.id !== "string" || !s.id.match(/^[a-zA-Z0-9_-]{1,64}$/) || ids.has(s.id))
      throw Error("Unique safe slide id required");
    ids.add(s.id);
    if (!["screenshot", "diff", "data"].includes(s.source.type))
      throw Error("Only screenshot/diff/data sources are factual inputs");
    if (typeof s.source.ref !== "string" || !s.source.ref.trim() || s.source.ref.length > 1024)
      throw Error("Explicit source reference required");
    if (
      typeof s.source.path !== "string" ||
      !s.source.path.length ||
      s.source.path.length > 2048 ||
      s.source.path.includes("://") ||
      s.source.path.includes("\0")
    )
      throw Error("Source must name a local PNG file");
    if (typeof s.source.sha256 !== "string" || !s.source.sha256.match(/^[0-9a-f]{64}$/))
      throw Error("Explicit source SHA256 required");
    if (
      typeof s.caption !== "string" ||
      !s.caption.trim() ||
      s.caption.length > 300 ||
      /[\p{Cc}\p{Cf}]/u.test(s.caption)
    )
      throw Error("Caption must be a bounded single visible line");
    if (
      !Array.isArray(s.newLabels) ||
      s.newLabels.length > 32 ||
      s.newLabels.some(
        (x) => typeof x !== "string" || !x.trim() || x.length > 200 || /[\p{Cc}\p{Cf}]/u.test(x),
      )
    )
      throw Error("newLabels must list bounded visible text already in source");
    const path = resolve(dirname(file), s.source.path),
      input = await boundedFile(path, 8 * 1024 * 1024);
    if (sha(input) !== s.source.sha256) throw Error("Source digest changed: " + s.id);
    const size = pngSize(input),
      addedWords = words(s.caption) + s.newLabels.reduce((a, x) => a + words(x), 0);
    const holdFrames = Math.max(geometry.fps, Math.ceil((addedWords * geometry.fps) / 3));
    if (holdFrames > geometry.fps * 120) throw Error("Slide exceeds bounded 120-second hold");
    slides.push({ ...s, path, input, size, addedWords, holdFrames, startFrame: start });
    start += holdFrames + geometry.transition;
  }
  if (slides.length === 1) slides[0].startFrame = geometry.transition;
  return {
    manifest: m,
    digest: sha(bytes),
    slides,
    totalFrames:
      slides.length === 1
        ? slides[0].holdFrames + 2 * geometry.transition
        : start - geometry.transition,
    ...geometry,
  };
}
