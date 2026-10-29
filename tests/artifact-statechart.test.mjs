import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
const cli = path.resolve(process.env.STATECHART_CLI || "dist/statechart.mjs");
const jar = process.env.TLA2TOOLS;
assert.ok(jar, "Set TLA2TOOLS to qualified 1.7.4 jar");
const root = fs.mkdtempSync(path.join(path.dirname(cli), "qualification-"));
const env = {
  ...process.env,
  HOME: root,
  TMPDIR: root,
  TMP: root,
  TEMP: root,
  TLA2TOOLS: jar,
  // Tiny fixtures only; production retains the selected JVM default/options.
  JAVA_TOOL_OPTIONS: "-Xmx128m",
};
const evidence = [];
function run(args, overrides = {}) {
  const p = spawnSync(process.execPath, [cli, ...args], {
    env: { ...env, ...overrides },
    encoding: "utf8",
    maxBuffer: 2e6,
  });
  evidence.push({
    args,
    exitCode: p.status,
    signal: p.signal,
    stdout: p.stdout?.slice(0, 3000),
    stderr: p.stderr?.slice(0, 3000),
  });
  assert.ifError(p.error);
  return p;
}
function model(name, body, config) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, name + ".tla"),
    "---- MODULE " +
      name +
      " ----\nEXTENDS Naturals\nVARIABLE x\n" +
      body +
      "\n====\n",
  );
  fs.writeFileSync(path.join(dir, name + ".cfg"), config);
  return path.join(dir, name + ".tla");
}
const holds = model(
  "Holds",
  "Init == x = 0\nNext == x < 2 /\\ x' = x + 1\nSafe == x <= 2",
  "INIT Init\nNEXT Next\nINVARIANT Safe\nCHECK_DEADLOCK FALSE",
);
const broken = model(
  "Broken",
  "Init == x = 0\nNext == x < 2 /\\ x' = x + 1\nSafe == x < 2\nOther == x <= 2",
  "INIT Init\nNEXT Next\nINVARIANTS Safe Other\nCHECK_DEADLOCK FALSE",
);
let good, bad;
test("real SANY/TLC holds, breaks, per-rule recheck and reader marks", () => {
  good = path.join(root, "good");
  let p = run(["check", holds, "--out", good]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /Rules that hold/);
  assert.match(p.stdout, /Safe/);
  assert.match(
    fs.readFileSync(path.join(good, "chart.mmd"), "utf8"),
    /stateDiagram-v2/,
  );
  bad = path.join(root, "bad");
  p = run(["check", broken, "--out", bad]);
  assert.equal(p.status, 1, p.stderr);
  assert.match(p.stdout, /Safe breaks/);
  assert.match(p.stdout, /Rules that hold\nOther/);
  assert.match(fs.readFileSync(path.join(bad, "chart.mmd"), "utf8"), /bugPath/);
  assert.match(
    fs.readFileSync(path.join(bad, "chart.mmd"), "utf8"),
    /classDef breaks/,
  );
});
test("real public Pele SVG, typed edge limit and collision preserve proof", () => {
  let p = run(["render", bad, "--out", path.join(root, "svg")]);
  assert.equal(p.status, 0, p.stderr);
  const svg = fs.readFileSync(path.join(root, "svg/chart.svg"), "utf8");
  assert.match(svg, /<svg/);
  assert.match(svg, /#e72e3b/);
  p = run([
    "render",
    bad,
    "--max-edges",
    "1",
    "--out",
    path.join(root, "too-many"),
  ]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /edge limit/);
  assert.ok(!fs.existsSync(path.join(root, "too-many")));
  p = run(["check", holds, "--out", good]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /new or empty/);
  p = run([
    "check",
    holds,
    "--max-edges",
    "1",
    "--out",
    path.join(root, "elided"),
  ]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /Chart omitted/);
  assert.match(p.stdout, /Rules that hold/);
  assert.ok(!fs.existsSync(path.join(root, "elided/chart.mmd")));
});
test("real deadlock and temporal counterexample", () => {
  const dead = model(
    "Dead",
    "Init == x = 0\nNext == x < 1 /\\ x' = x+1",
    "INIT Init\nNEXT Next",
  );
  let p = run(["check", dead, "--out", path.join(root, "dead-out")]);
  assert.equal(p.status, 1, p.stderr);
  assert.match(p.stdout, /NoDeadlock breaks/);
  const live = model(
    "Live",
    "Init == x=0\nNext == x'=1-x\nEventually == <>[](x=1)",
    "INIT Init\nNEXT Next\nPROPERTY Eventually",
  );
  p = run(["check", live, "--out", path.join(root, "live-out")]);
  assert.equal(p.status, 1, p.stderr);
  assert.match(p.stdout, /Eventually breaks/);
  assert.match(p.stdout, /forever/);
  assert.match(
    fs.readFileSync(path.join(root, "live-out/chart.mmd"), "utf8"),
    /repeats/,
  );
});
test("malformed spec/config/view and explicit toolchain failures publish nothing", () => {
  const malformed = model("Malformed", "Init == ????", "INIT Init");
  const cfg = path.join(root, "bad.cfg");
  fs.writeFileSync(cfg, "INIT Init\nBOGUS !");
  const view = path.join(root, "view.mjs");
  fs.writeFileSync(view, "export const state=123");
  const badjar = path.join(root, "bad.jar");
  fs.writeFileSync(badjar, "not a jar");
  const cases = [
    { args: ["check", malformed], match: /SANY/ },
    { args: ["check", holds, "--config", cfg], match: /config/ },
    { args: ["check", holds, "--view", view], match: /state must be/ },
    { args: ["check", holds], env: { TLA2TOOLS: badjar }, match: /SHA256/ },
    {
      args: ["check", holds],
      env: { TLA2TOOLS: path.join(root, "missing.jar") },
      match: /ENOENT/,
    },
    { args: ["check", holds, "--timeout-ms", "0"], match: /bound/ },
  ];
  for (const [i, c] of cases.entries()) {
    const out = path.join(root, "failure-" + i);
    const p = run([...c.args, "--out", out], c.env);
    assert.equal(p.status, 2, p.stderr);
    assert.match(p.stderr, c.match);
    assert.ok(!fs.existsSync(out));
  }
  fs.writeFileSync(view, " ".repeat(1000001));
  const p = run([
    "check",
    holds,
    "--view",
    view,
    "--out",
    path.join(root, "large"),
  ]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /bound/);
});
test("selected hierarchical and parallel view labels preserve reader report", () => {
  const view = path.join(root, "hier.mjs");
  fs.writeFileSync(
    view,
    'export const state=({x})=>["Phase",String(x)]; export const step=(a)=>"advance"; export const group=()=>"ok"; export const colors={ok:"blue"};',
  );
  let p = run([
    "check",
    holds,
    "--view",
    view,
    "--out",
    path.join(root, "hier"),
  ]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(
    fs.readFileSync(path.join(root, "hier/chart.mmd"), "utf8"),
    /state "Phase"/,
  );
  assert.match(
    fs.readFileSync(path.join(root, "hier/chart.mmd"), "utf8"),
    /advance/,
  );
  fs.writeFileSync(
    view,
    'export const state=({x})=>({position:String(x),mode:"ready"});',
  );
  p = run([
    "check",
    holds,
    "--view",
    view,
    "--out",
    path.join(root, "parallel"),
  ]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(
    fs.readFileSync(path.join(root, "parallel/chart.mmd"), "utf8"),
    /At the same time/,
  );
});
test("timeout unknown and SIGTERM kill only owned worker group without partial publish", async () => {
  const view = path.join(root, "spin.mjs");
  fs.writeFileSync(view, "while(true){}");
  const out = path.join(root, "timeout");
  let p = run([
    "check",
    holds,
    "--view",
    view,
    "--timeout-ms",
    "200",
    "--out",
    out,
  ]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /unknown, rules not checked/);
  assert.ok(!fs.existsSync(out));
  const cancelled = path.join(root, "cancel");
  const child = spawn(
    process.execPath,
    [cli, "check", holds, "--view", view, "--out", cancelled],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (x) => (stderr += x));
  const code = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  setTimeout(() => child.kill("SIGTERM"), 300);
  assert.equal(await code, 143);
  assert.match(stderr, /no output published/);
  assert.ok(!fs.existsSync(cancelled));
  evidence.push({
    args: ["check", holds, "--view", view, "SIGTERM"],
    exitCode: 143,
    stderr,
  });
});

test("500-state chart coverage remains separate from completed verification", () => {
  const large = model(
    "Large",
    "Init == x=0\nNext == x < 501 /\\ x'=x+1\nSafe == x<=501",
    "INIT Init\nNEXT Next\nINVARIANT Safe\nCHECK_DEADLOCK FALSE",
  );
  const out = path.join(root, "coverage");
  const p = run(["check", large, "--out", out]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /502 states/);
  assert.match(p.stdout, /chart budget of 500/);
  assert.match(p.stdout, /Rules that hold/);
  assert.ok(!fs.existsSync(path.join(out, "chart.mmd")));
});
test("malformed TLC output is rejected through native CLI (Java boundary fault injection)", () => {
  const wrapper = path.join(root, "java-fault.cjs");
  // Real Java handles version and SANY. Only TLC stdout is deliberately corrupted.
  fs.writeFileSync(
    wrapper,
    "#!/usr/bin/env node\n" +
      'const {spawnSync}=require("node:child_process");const args=process.argv.slice(2);if(args.includes("tlc2.TLC")){console.log("truncated invalid TLC output");process.exit(0);}const p=spawnSync(' +
      JSON.stringify(process.env.JAVA || "java") +
      ',args,{stdio:"inherit"});process.exit(p.status??2);\n',
  );
  fs.chmodSync(wrapper, 0o700);
  const out = path.join(root, "malformed-tlc");
  const p = run(["check", holds, "--out", out], { JAVA: wrapper });
  assert.equal(p.status, 2, p.stderr);
  assert.match(p.stderr, /incomplete or malformed/);
  assert.ok(!fs.existsSync(out));
});
test("invalid selected view output and oversized source fail before publishing", () => {
  const view = path.join(root, "bad-state.mjs");
  fs.writeFileSync(view, "export const state=()=>null");
  let p = run([
    "check",
    holds,
    "--view",
    view,
    "--out",
    path.join(root, "bad-state"),
  ]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /state\(\) returned/);
  const giant = path.join(root, "Giant.tla");
  fs.writeFileSync(giant, " ".repeat(1000001));
  p = run([
    "check",
    giant,
    "--config",
    holds.replace(".tla", ".cfg"),
    "--out",
    path.join(root, "giant"),
  ]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /Source\/view bound/);
});
test("compiled chart validation and source limit precede public Pele rendering", () => {
  const invalid = path.join(root, "invalid-render");
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, "chart.json"), "{}");
  let p = run(["render", invalid, "--out", path.join(root, "invalid-svg")]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /Invalid compiled chart/);
  assert.ok(!fs.existsSync(path.join(root, "invalid-svg")));
  const chart = JSON.parse(
    fs.readFileSync(path.join(good, "chart.json"), "utf8"),
  );
  chart.title = "x".repeat(1000001);
  fs.writeFileSync(path.join(invalid, "chart.json"), JSON.stringify(chart));
  p = run(["render", invalid, "--out", path.join(root, "large-svg")]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /source limit/);
  // Escaped label arrows are not graph edges and must not trigger the edge cap.
  chart.title = "label --> is text";
  chart.regions[0].states[0].path = ["arrow --> label"];
  chart.regions[0].steps = [];
  for (const state of chart.regions[0].states) state.start = false;
  fs.writeFileSync(path.join(invalid, "chart.json"), JSON.stringify(chart));
  p = run([
    "render",
    invalid,
    "--max-edges",
    "1",
    "--out",
    path.join(root, "label-svg"),
  ]);
  assert.equal(p.status, 0, p.stderr);
});
test("real unbounded TLC timeout reports unknown without output", () => {
  const infinite = model(
    "Infinite",
    "Init == x=0\nNext == x'=x+1\nSafe == x>=0",
    "INIT Init\nNEXT Next\nINVARIANT Safe\nCHECK_DEADLOCK FALSE",
  );
  const out = path.join(root, "infinite-out");
  const p = run(["check", infinite, "--timeout-ms", "1500", "--out", out]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /timeout.*unknown/);
  assert.ok(!fs.existsSync(out));
});

test("real per-rule bounded recheck is honestly not checked after a valid break", () => {
  const spec = model(
    "Rerun",
    "Init == x=0\nNext == x'=x+1\nFails == x<1\nPending == x>=0",
    "INIT Init\nNEXT Next\nINVARIANTS Fails Pending\nCHECK_DEADLOCK FALSE",
  );
  const out = path.join(root, "rerun-out");
  const p = run(["check", spec, "--out", out]);
  assert.equal(p.status, 1, p.stderr);
  assert.match(p.stdout, /Fails breaks/);
  assert.match(p.stdout, /Rules not checked\nPending/);
  assert.match(p.stdout, /100,000/);
  assert.doesNotMatch(p.stdout, /Rules that hold\nPending/);
});
test("doctor validates explicit Java and fixed jar without implicit acquisition", () => {
  let p = run(["doctor"]);
  assert.equal(p.status, 0, p.stderr);
  const d = JSON.parse(p.stdout);
  assert.equal(d.release, "1.7.4");
  assert.equal(
    d.sha256,
    "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
  );
  assert.match(d.javaVersion, /version/);
  p = run(["doctor"], { JAVA: path.join(root, "no-java") });
  assert.equal(p.status, 2);
  assert.match(p.stderr, /ENOENT/);
  p = run(["doctor"], { TLA2TOOLS: "" });
  assert.equal(p.status, 2);
  assert.ok(!fs.existsSync(path.join(root, ".cache")));
  // Explicit fetch reuses the already verified canonical path inside private HOME; no download.
  const cache = path.join(root, ".cache/pstack/tla2tools/1.7.4");
  fs.mkdirSync(cache, { recursive: true });
  fs.symlinkSync(jar, path.join(cache, "tla2tools.jar"));
  p = run(["toolchain", "fetch"]);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.trim(), fs.realpathSync(jar));
});
test("new output collision during execution is never overwritten", () => {
  const out = path.join(root, "race-output"),
    view = path.join(root, "collision.mjs");
  fs.writeFileSync(
    view,
    'import fs from "node:fs";fs.mkdirSync(' +
      JSON.stringify(out) +
      ");fs.writeFileSync(" +
      JSON.stringify(path.join(out, "sentinel")) +
      ',"keep");export const state=({x})=>String(x);',
  );
  const p = run(["check", holds, "--view", view, "--out", out]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /collision/);
  assert.equal(fs.readFileSync(path.join(out, "sentinel"), "utf8"), "keep");
  assert.deepEqual(fs.readdirSync(out), ["sentinel"]);
});

test("optional drawing failure preserves completed real TLC verdict (narrow Java fault)", () => {
  const wrapper = path.join(root, "java-draw-fault.cjs");
  fs.writeFileSync(
    wrapper,
    "#!/usr/bin/env node\n" +
      'const {spawnSync}=require("node:child_process");const a=process.argv.slice(2);if(a.at(-1)==="ChartRun"){console.error("injected drawing failure");process.exit(2);}const p=spawnSync(' +
      JSON.stringify(process.env.JAVA || "java") +
      ',a,{stdio:"inherit"});process.exit(p.status??2);\n',
  );
  fs.chmodSync(wrapper, 0o700);
  const out = path.join(root, "draw-fault");
  const p = run(["check", holds, "--out", out], { JAVA: wrapper });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /drawing run exited 2/);
  assert.match(p.stdout, /Rules that hold/);
  assert.doesNotMatch(p.stdout, /more states than/);
  assert.ok(!fs.existsSync(path.join(out, "chart.mmd")));
});
test("signal cancellation actually removes worker and descendant process", async () => {
  const marker = path.join(root, "pids.json"),
    view = path.join(root, "owned.mjs");
  fs.writeFileSync(
    view,
    'import fs from "node:fs";import {spawn} from "node:child_process";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"]);fs.writeFileSync(' +
      JSON.stringify(marker) +
      ",JSON.stringify([process.pid,child.pid]));while(true){}",
  );
  const out = path.join(root, "owned-out");
  const child = spawn(
    process.execPath,
    [cli, "check", holds, "--view", view, "--out", out],
    { env, stdio: "ignore" },
  );
  const ended = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(marker));
    const pids = JSON.parse(fs.readFileSync(marker));
    child.kill("SIGINT");
    assert.equal(await ended, 130);
    for (let i = 0; i < 100; i++) {
      if (
        pids.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        })
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    for (const pid of pids)
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.ok(!fs.existsSync(out));
    evidence.push({
      args: ["check", "owned worker/descendant", "SIGINT"],
      exitCode: 130,
      pidsReaped: true,
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});

test("concurrent native CLIs cannot claim the same empty output", async () => {
  const out = path.join(root, "shared-output"),
    marker = path.join(root, "started"),
    view = path.join(root, "concurrent.mjs");
  fs.writeFileSync(
    view,
    'import fs from "node:fs";fs.writeFileSync(' +
      JSON.stringify(marker) +
      ',"ready");await new Promise(r=>setTimeout(r,500));export const state=({x})=>String(x);',
  );
  const first = spawn(
    process.execPath,
    [cli, "check", holds, "--view", view, "--out", out],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  first.stderr.on("data", (x) => (stderr += x));
  first.stdout.resume();
  const done = new Promise((resolve, reject) => {
    first.once("exit", resolve);
    first.once("error", reject);
  });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(marker));
    const second = run(["check", holds, "--out", out]);
    assert.equal(second.status, 2);
    assert.match(second.stderr, /reserved/);
    assert.equal(await done, 0, stderr);
    assert.match(
      fs.readFileSync(path.join(out, "report.md"), "utf8"),
      /Rules that hold/,
    );
    assert.ok(!fs.readdirSync(root).some((n) => n.startsWith(".statechart")));
  } finally {
    if (first.exitCode === null) first.kill("SIGTERM");
  }
});

test("malformed completion markers never become a holds verdict", () => {
  const wrapper = path.join(root, "bad-markers.cjs");
  const output =
    "@!@!@STARTMSG 2199:0 @!@!@\n1 distinct states found\n@!@!@ENDMSG 2199 @!@!@\n@!@!@STARTMSG 2186:0 @!@!@\nFinished\n@!@!@ENDMSG 9999 @!@!@\n";
  fs.writeFileSync(
    wrapper,
    '#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const a=process.argv.slice(2);if(a.includes("tlc2.TLC")){process.stdout.write(' +
      JSON.stringify(output) +
      ");process.exit(0);}const p=spawnSync(" +
      JSON.stringify(process.env.JAVA || "java") +
      ',a,{stdio:"inherit"});process.exit(p.status??2);',
  );
  fs.chmodSync(wrapper, 0o700);
  const out = path.join(root, "bad-markers-out");
  const p = run(["check", holds, "--out", out], { JAVA: wrapper });
  assert.equal(p.status, 2);
  assert.match(p.stderr, /Malformed TLC message boundary/);
  assert.ok(!fs.existsSync(out));
});

test("production does not force a heap cap while explicit tiny-fixture JVM options survive", () => {
  const wrapper = path.join(root, "java-options.cjs"), log = path.join(root, "java-options.jsonl");
  fs.writeFileSync(wrapper, '#!/usr/bin/env node' + String.fromCharCode(10) + 'const fs=require("node:fs"),{spawnSync}=require("node:child_process");const args=process.argv.slice(2);fs.appendFileSync(' + JSON.stringify(log) + ',JSON.stringify({args,options:process.env.JAVA_TOOL_OPTIONS})+String.fromCharCode(10));const p=spawnSync(' + JSON.stringify(process.env.JAVA || "java") + ',args,{stdio:"inherit"});process.exit(p.status??2);');
  fs.chmodSync(wrapper, 0o700);
  const p = run(["check", holds, "--out", path.join(root, "jvm-options-out")], { JAVA: wrapper });
  assert.equal(p.status, 0, p.stderr);
  const observations = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(observations.some(o => o.args.includes("tlc2.TLC")));
  for (const observation of observations) {
    assert.ok(!observation.args.some(arg => arg.startsWith("-Xmx")));
    assert.equal(observation.options, "-Xmx128m");
  }
});

test.after(() => {
  if (process.env.STATECHART_EVIDENCE)
    fs.writeFileSync(
      process.env.STATECHART_EVIDENCE,
      JSON.stringify(evidence, null, 2),
    );
  fs.rmSync(root, { recursive: true, force: true });
});
