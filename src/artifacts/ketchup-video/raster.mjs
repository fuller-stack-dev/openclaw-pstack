import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import { fontBuffers, checkGlyphs } from "./fonts.mjs";
import { geometry } from "./manifest.mjs";
import { run, ffmpeg, base } from "./process.mjs";
let ready;
const escape = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export async function raster(slide, signal) {
  checkGlyphs(slide.caption);
  for (const label of slide.newLabels) checkGlyphs(label);
  // Decode actual bytes before resvg: valid IHDR alone is not a valid image.
  await run(
    ffmpeg(),
    [
      ...base,
      "-xerror",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    { input: slide.input, signal },
  );
  await (ready ??= initWasm(wasm));
  const { width: w, height: h, strip } = geometry,
    top = h - strip;
  const options = {
    font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Noto Sans" },
    textRendering: 1,
  };
  const text =
    '<text x="320" y="335" text-anchor="middle" font-family="Noto Sans" font-size="20" fill="white">' +
    escape(slide.caption) +
    "</text>";
  const prefix =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="640" height="360">';
  const measure = new Resvg(prefix + text + "</svg>", options);
  try {
    const box = measure.innerBBox();
    if (!box) throw Error("Caption rendered no glyphs");
    try {
      if (box.x < 16 || box.x + box.width > w - 16 || box.y < top + 8 || box.y + box.height > h - 8)
        throw Error(
          "Caption readability/overflow: shorten text to fit the 608px strip at 20px; no shrinking or clipping",
        );
    } finally {
      box.free();
    }
  } finally {
    measure.free();
  }
  const svg =
    prefix +
    '<rect width="640" height="360" fill="#151a22"/><image x="0" y="0" width="640" height="296" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,' +
    slide.input.toString("base64") +
    '"/><rect y="296" width="640" height="64" fill="#111827"/>' +
    text +
    "</svg>";
  const renderer = new Resvg(svg, options);
  let image;
  try {
    image = renderer.render();
    if (image.width !== w || image.height !== h) throw Error("Unexpected raster geometry");
    return Buffer.from(image.asPng());
  } finally {
    image?.free();
    renderer.free();
  }
}
export async function pixels(png, signal) {
  const b = await run(
    ffmpeg(),
    [
      ...base,
      "-xerror",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { input: png, signal, max: geometry.width * geometry.height * 3 },
  );
  if (b.length !== geometry.width * geometry.height * 3) throw Error("Incomplete raster decode");
  return b;
}
