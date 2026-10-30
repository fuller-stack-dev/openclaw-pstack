import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-statechart-pack-"));
const root = path.resolve(import.meta.dirname, "..");
function run(command, args, env = process.env, cwd = root) {
  const p = spawnSync(command, args, { cwd, encoding: "utf8", env, timeout: 120000, maxBuffer: 2e6 });
  assert.ifError(p.error);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  return p.stdout;
}
try {
  const result = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", stage]));
  const tar = path.join(stage, result[0].filename);
  const unpack = path.join(stage, "unpack"); fs.mkdirSync(unpack);
  run("tar", ["-xzf", tar, "-C", unpack]);
  const pkg = path.join(unpack, "package");
  const metadata = JSON.parse(fs.readFileSync(path.join(pkg, "package.json")));
  assert.equal(metadata.name, "@fuller-stack-dev/openclaw-pstack");
  assert.equal(metadata.dependencies.pele, "1.9.0");
  for (const file of ["dist/statechart.mjs", "dist/statechart-worker.mjs", "licenses/statechart-MIT.txt", "licenses/pele.txt"])
    assert.ok(fs.statSync(path.join(pkg, file)).isFile());
  assert.ok(!fs.existsSync(path.join(pkg, "src")));
  assert.ok(!fs.existsSync(path.join(pkg, "node_modules")));
  // Run the packed CLI outside the checkout without inherited module paths or loader hooks.
  fs.copyFileSync(path.join(root, "tests/artifact-statechart.test.mjs"), path.join(stage, "consumer.test.mjs"));
  const env = { ...process.env, STATECHART_CLI: path.join(pkg, "dist/statechart.mjs") };
  for (const key of ["NODE_PATH", "NODE_OPTIONS", "TSX_TSCONFIG_PATH"])
    delete env[key];
  console.log(run(process.execPath, ["--test", path.join(stage, "consumer.test.mjs")], env, stage));
  console.log(JSON.stringify({ package: metadata.name, version: metadata.version, integrity: result[0].integrity, files: result[0].entryCount, sourceFree: true }));
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
