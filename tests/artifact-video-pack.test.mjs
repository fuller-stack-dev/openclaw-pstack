import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-video-pack-"));
const root = path.resolve(import.meta.dirname, "..");
function run(command, args, env = process.env, cwd = root) {
  const p = spawnSync(command, args, { cwd, encoding: "utf8", env, timeout: 120000, maxBuffer: 2e6 });
  assert.ifError(p.error);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  return p.stdout;
}
try {
  const result = JSON.parse(run(process.execPath, ["scripts/pack.mjs", "--commit", "HEAD", "--out-dir", stage]));
  const tar = result.path;
  const unpack = path.join(stage, "unpack"); fs.mkdirSync(unpack);
  run("tar", ["-xzf", tar, "-C", unpack]);
  const pkg = path.join(unpack, "package");
  const metadata = JSON.parse(fs.readFileSync(path.join(pkg, "package.json")));
  assert.equal(metadata.name, "@fuller-stack-dev/openclaw-pstack");
  const provenance = JSON.parse(fs.readFileSync(path.join(pkg, "dist/ketchup-video.build.json")));
  assert.equal(provenance.sourceCommit, result.commit);
  assert.equal(provenance.output.sha256, result.media.outputSha256);
  for (const file of ["dist/ketchup-video.mjs", "licenses/ketchup-video-MPL-2.0.txt", "licenses/ketchup-video-OFL.txt", "licenses/ketchup-video-sources.md"])
    assert.ok(fs.statSync(path.join(pkg, file)).isFile());
  assert.ok(!fs.existsSync(path.join(pkg, "src")));
  assert.ok(!fs.existsSync(path.join(pkg, "node_modules")));
  // Execute the packed CLI outside the checkout without source loaders or dependencies.
  fs.copyFileSync(path.join(root, "tests/artifact-video.test.mjs"), path.join(stage, "consumer.test.mjs"));
  const env = { ...process.env, PSTACK_VIDEO_CLI: path.join(pkg, "dist/ketchup-video.mjs") };
  for (const key of ["NODE_PATH", "NODE_OPTIONS", "PELE_MODULE", "ESBUILD_MODULE", "TSX_TSCONFIG_PATH", "PSTACK_RESVG", "PSTACK_ESBUILD", "PSTACK_KEEP_PROOF", "NODE_TEST_CONTEXT", "PSTACK_VIDEO_CACHE", "PSTACK_VIDEO_OFFLINE", "PSTACK_SOURCE_COMMIT"])
    delete env[key];
  const output = run(process.execPath, ["--test", path.join(stage, "consumer.test.mjs")], env, stage);
  assert.match(output, /CALIBRATION/);
  assert.match(output, /CAPTION_MUTATION/);
  console.log(output);
  console.log(JSON.stringify({ package: metadata.name, version: metadata.version, sha256: result.sha256, commit: result.commit, sourceFree: true }));
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
