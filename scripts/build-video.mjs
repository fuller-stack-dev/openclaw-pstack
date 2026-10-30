import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const defaultCache = () => resolve(process.env.PSTACK_VIDEO_CACHE || join(homedir(), ".cache/pstack/video-assets"));
export async function verified(file, pin) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Not a regular build input: " + file);
  const bytes = await readFile(file);
  if (sha256(bytes) !== pin.sha256 || (pin.bytes !== undefined && bytes.length !== pin.bytes))
    throw Error("Build asset digest mismatch: " + file);
  return bytes;
}
export async function cachedAsset(cache, pin) {
  const file = join(cache, pin.sha256);
  try { return await verified(file, pin); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!pin.url || process.env.PSTACK_VIDEO_OFFLINE === "1") throw Error("Missing verified media input: " + pin.sha256);
  const response = await fetch(pin.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error("Asset fetch failed: " + response.status + " " + pin.url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== pin.sha256 || bytes.length !== pin.bytes) throw Error("Downloaded asset digest mismatch: " + pin.url);
  await mkdir(cache, { recursive: true });
  try { await writeFile(file, bytes, { flag: "wx", mode: 0o644 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return verified(file, pin);
}
export async function buildVideo({ root = resolve(import.meta.dirname, ".."), cache = defaultCache(), commit = null, esbuildModule } = {}) {
  root = resolve(root); cache = resolve(cache);
  const pinsBytes = await readFile(join(root, "scripts/video-assets.json"));
  const pins = JSON.parse(pinsBytes);
  const source = join(root, "licenses/ketchup-video-renderer");
  const inputs = { "scripts/video-assets.json": sha256(pinsBytes) };
  for (const pin of pins.sourceFiles) {
    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(pin.path) || pin.path.split("/").some(p => p === ".." || p === ".")) throw Error("Invalid renderer source path");
    inputs["licenses/ketchup-video-renderer/" + pin.path] = sha256(await verified(join(source, pin.path), pin));
  }
  const require = createRequire(join(root, "package.json"));
  const esbuild = await import(pathToFileURL(esbuildModule || process.env.PSTACK_ESBUILD || require.resolve("esbuild")).href);
  if (esbuild.version !== pins.esbuild) throw Error("Build requires esbuild " + pins.esbuild);
  const wasmPin = pins.renderer["index_bg.wasm"];
  try { await verified(join(cache, wasmPin.sha256), wasmPin); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (process.env.PSTACK_VIDEO_OFFLINE === "1") throw Error("Missing verified media input: " + wasmPin.sha256);
    const result = spawnSync("python3", [join(root, "scripts/build-video-renderer.py"), "--cache", cache], {
      cwd: root, stdio: ["ignore", "inherit", "inherit"], timeout: 600000,
      env: { ...process.env, PSTACK_ESBUILD: fileURLToPath(pathToFileURL(esbuildModule || process.env.PSTACK_ESBUILD || require.resolve("esbuild"))) },
    });
    if (result.error || result.status !== 0) throw Error("Locked renderer source build failed: " + (result.error?.message ?? result.status));
  }
  const assets = new Map([["renderer.wasm", await verified(join(cache, wasmPin.sha256), wasmPin)]]);
  for (const font of pins.fonts) assets.set(font.name, await cachedAsset(cache, font));
  assets.set("renderer.mjs", await verified(join(source, "candidate/index.mjs"), pins.renderer["index.mjs"]));
  await mkdir(join(root, "dist"), { recursive: true });
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: ["src/artifacts/ketchup-video/cli.mjs"],
    outfile: "dist/ketchup-video.mjs", write: false, bundle: true, platform: "node", format: "esm", target: "node22",
    legalComments: "eof", metafile: true,
    plugins: [{ name: "verified-media", setup(build) {
      build.onResolve({ filter: /^@resvg\/resvg-wasm(?:\/index_bg\.wasm)?$|^\.\/assets\/NotoSans(?:Math)?-Regular\.ttf$/ }, args => ({
        namespace: "verified-media", path: args.path === "@resvg/resvg-wasm" ? "renderer.mjs" : args.path.endsWith(".wasm") ? "renderer.wasm" : args.path.split("/").at(-1),
      }));
      build.onLoad({ filter: /.*/, namespace: "verified-media" }, args => ({ contents: assets.get(args.path), loader: args.path.endsWith(".mjs") ? "js" : "binary" }));
    } }],
  });
  for (const output of Object.values(result.metafile.outputs)) for (const i of output.imports)
    if (i.external && !i.path.startsWith("node:")) throw Error("Unexpected external runtime dependency: " + i.path);
  for (const path of Object.keys(result.metafile.inputs)) {
    if (path.startsWith("verified-media:")) { inputs[path] = sha256(assets.get(path.slice("verified-media:".length))); continue; }
    inputs[path] = sha256(await readFile(join(root, path)));
  }
  for (const path of ["scripts/build-video.mjs", "scripts/build-video-renderer.py", "package-lock.json"]) inputs[path] = sha256(await readFile(join(root, path)));
  const bytes = result.outputFiles[0].contents;
  if (sha256(bytes) !== pins.bundleSha256) throw Error("Derived media digest mismatch: " + sha256(bytes));
  const receipt = { version: 1, sourceCommit: commit, inputs, esbuild: esbuild.version,
    output: { path: "dist/ketchup-video.mjs", bytes: bytes.length, sha256: sha256(bytes) } };
  await writeFile(join(root, receipt.output.path), bytes, { mode: 0o644 });
  await writeFile(join(root, "dist/ketchup-video.build.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o644 });
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildVideo({ commit: process.env.PSTACK_SOURCE_COMMIT || null }).then(r => console.log(JSON.stringify(r.output))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
