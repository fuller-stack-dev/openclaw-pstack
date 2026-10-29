import { createRequire } from "node:module";
import { resolve } from "node:path";

// Prefer the locked local build tool. Existing dependency-ready host checkouts
// remain an explicit fallback; no package install or host mutation is performed.
let build;
try {
  ({ build } = await import("esbuild"));
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || !process.env.OPENCLAW_SOURCE) throw error;
  const require = createRequire(resolve(process.env.OPENCLAW_SOURCE, "package.json"));
  ({ build } = require("esbuild"));
}
const gateway = await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["openclaw/*"],
  sourcemap: false,
  metafile: true,
});

// Inspect the complete gateway graph, not only the artifact entry's graph.
const inputs = Object.keys(gateway.metafile.inputs);
if (inputs.some(p => p.split("/").some(part => ["artifacts", "pele", "rastermill"].includes(part))))
  throw Error("Artifact/render dependency leaked into gateway bundle");
const artifact = await build({
  entryPoints: { statechart: "src/artifacts/statechart/statechart.ts", "statechart-worker": "src/artifacts/statechart/worker.ts" },
  outdir: "dist", outExtension: { ".js": ".mjs" }, bundle: true,
  format: "esm", platform: "node", target: "node24", metafile: true,
  legalComments: "inline",
  banner: { js: "/*! Native statechart port; notices: licenses/statechart-MIT.txt and licenses/pele.txt. */" },
});
console.log(JSON.stringify({ gatewayInputs: inputs, artifactInputs: Object.keys(artifact.metafile.inputs), outputs: Object.keys(artifact.metafile.outputs) }));
