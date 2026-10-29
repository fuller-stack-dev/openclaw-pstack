import sans from "./assets/NotoSans-Regular.ttf";
import math from "./assets/NotoSansMath-Regular.ttf";
export const fontBuffers = [sans, math];
function coverage(bytes) {
  const b = Buffer.from(bytes),
    tables = b.readUInt16BE(4);
  let cmap;
  for (let i = 0; i < tables; i++) {
    const p = 12 + i * 16;
    if (b.toString("ascii", p, p + 4) === "cmap") cmap = b.readUInt32BE(p + 8);
  }
  if (cmap === undefined) throw Error("Bundled font lacks cmap");
  const maps = [];
  for (let i = 0; i < b.readUInt16BE(cmap + 2); i++) {
    const p = cmap + 4 + i * 8,
      o = cmap + b.readUInt32BE(p + 4),
      f = b.readUInt16BE(o);
    if (f === 4 || f === 12) maps.push([o, f]);
  }
  return (cp) =>
    maps.some(([o, f]) => {
      if (f === 12) {
        const n = b.readUInt32BE(o + 12);
        for (let i = 0; i < n; i++) {
          const p = o + 16 + i * 12,
            a = b.readUInt32BE(p),
            z = b.readUInt32BE(p + 4);
          if (cp >= a && cp <= z) return b.readUInt32BE(p + 8) + cp - a !== 0;
        }
        return false;
      }
      if (cp > 65535) return false;
      const n = b.readUInt16BE(o + 6) / 2;
      for (let i = 0; i < n; i++) {
        const end = b.readUInt16BE(o + 14 + i * 2),
          start = b.readUInt16BE(o + 16 + 2 * n + i * 2);
        if (cp < start || cp > end) continue;
        const d = b.readInt16BE(o + 16 + 4 * n + i * 2),
          p = o + 16 + 6 * n + i * 2,
          r = b.readUInt16BE(p);
        const g = r ? b.readUInt16BE(p + r + 2 * (cp - start)) : cp;
        return g !== 0 && ((g + d) & 65535) !== 0;
      }
      return false;
    });
}
const covers = fontBuffers.map(coverage);
export function checkGlyphs(text) {
  const missing = [
    ...new Set(Array.from(text).filter((c) => !covers.some((f) => f(c.codePointAt(0))))),
  ];
  if (missing.length)
    throw Error(
      "Unsupported glyphs in bundled fonts: " +
        missing.map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase()).join(", ") +
        "; supply evidence/captions in supported text or request an explicitly qualified font build",
    );
}
