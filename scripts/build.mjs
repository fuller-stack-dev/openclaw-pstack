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
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["openclaw/*"],
  sourcemap: false,
});
