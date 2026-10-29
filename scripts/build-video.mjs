import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const esbuild = await import("esbuild");
if (esbuild.version !== "0.28.2") throw Error("Build requires esbuild 0.28.2");
const resvg = dirname(require.resolve("@resvg/resvg-wasm"));
if (JSON.parse(await readFile(resolve(resvg, "package.json"), "utf8")).version !== "2.6.2")
  throw Error("Build requires @resvg/resvg-wasm 2.6.2");
const pins = {
  [resolve(resvg, "index_bg.wasm")]:
    "22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70",
  "src/artifacts/ketchup-video/assets/NotoSans-Regular.ttf":
    "b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5",
  "src/artifacts/ketchup-video/assets/NotoSansMath-Regular.ttf":
    "80b61fd613d3519197e64fff6f7e71fdc7f3e6526440ea4115b554ef7fd59af7",
  "src/artifacts/ketchup-video/assets/OFL.txt":
    "0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb",
  "src/artifacts/ketchup-video/assets/MPL-2.0.txt":
    "4b89d4518bd135ab4ee154a7bce722246b57a98c3d7efc1a09409898160c2bd1",
};
for (const [file, expected] of Object.entries(pins))
  if (
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex") !== expected
  )
    throw Error("Build asset digest mismatch: " + file);
const alias = {
  "@resvg/resvg-wasm": resolve(resvg, "index.mjs"),
  "@resvg/resvg-wasm/index_bg.wasm": resolve(resvg, "index_bg.wasm"),
};
const result = await esbuild.build({
  entryPoints: ["src/artifacts/ketchup-video/cli.mjs"],
  outfile: "dist/ketchup-video.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  loader: { ".wasm": "binary", ".ttf": "binary" },
  alias,
  legalComments: "eof",
  metafile: true,
});
for (const output of Object.values(result.metafile.outputs))
  for (const i of output.imports)
    if (i.external && !i.path.startsWith("node:"))
      throw Error("Unexpected external runtime dependency: " + i.path);
console.log(
  JSON.stringify({
    bundle: "dist/ketchup-video.mjs",
    bytes: result.metafile.outputs["dist/ketchup-video.mjs"].bytes,
    inputs: Object.keys(result.metafile.inputs).length,
    externalImports: result.metafile.outputs["dist/ketchup-video.mjs"].imports.map((i) => i.path),
  }),
);
