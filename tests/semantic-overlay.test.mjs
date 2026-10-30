import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { extractRules, syncOverlay } from "../scripts/sync-overlay.mjs";

const root = resolve(import.meta.dirname, "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tmp = process.platform === "darwin" ? "/private/tmp" : "/tmp";

async function fixture(t) {
  const dir = await mkdtemp(join(tmp, "pstack-overlay-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "skills"));
  await cp(join(root, "skills/pstack"), join(dir, "skills/pstack"), { recursive: true });
  return dir;
}
const skillPath = (dir, path) => join(dir, "skills/pstack", path);
const readJson = async (dir, path) => JSON.parse(await readFile(skillPath(dir, path), "utf8"));
const writeJson = (dir, path, value) => writeFile(skillPath(dir, path), JSON.stringify(value, null, 2) + "\n");
async function editOverlay(dir, change) {
  const overlay = await readJson(dir, "native/semantic-overlay.json");
  change(overlay);
  await writeJson(dir, "native/semantic-overlay.json", overlay);
}
const ruleAt = (overlay, path, index = 0) => overlay.files.find((file) => file.path === path).rules[index];
/** Simulate a reviewed upstream refresh: new bytes plus a matching pinned record. */
async function refreshUpstream(dir, path, text) {
  await writeFile(skillPath(dir, "upstream/" + path), text);
  const manifest = await readJson(dir, "source-manifest.json");
  const record = manifest.files.find((file) => file.path === path);
  record.bytes = Buffer.byteLength(text);
  record.sha256 = sha(Buffer.from(text));
  await writeJson(dir, "source-manifest.json", manifest);
}
function python(dir, records) {
  const script = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('v', sys.argv[1]); v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)",
    "print(json.dumps(v.extract_rules(sys.argv[2], json.loads(sys.argv[3]))))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", script, join(root, "skills/pstack/scripts/verify_install.py"), dir, JSON.stringify(records)], { encoding: "utf8" }));
}

test("maps every pinned upstream MUST/required/never line and --check writes nothing", async (t) => {
  const dir = await fixture(t);
  const output = skillPath(dir, "native/semantic-overlay.md");
  const before = await readFile(output);
  const result = await syncOverlay(dir, true);
  assert.equal(result.files, 117);
  assert.equal(result.rules, 363);
  assert.equal(result.carried, 279);
  assert.equal(result.targets.gate + result.targets.native + result.targets.same + result.targets.exclude, 448);
  assert.deepEqual(await readFile(output), before);
  const overlay = await readJson(dir, "native/semantic-overlay.json");
  const text = before.toString("utf8");
  assert.ok(text.includes("Overlay: `semantic-overlay.json` sha256 `" + sha(await readFile(skillPath(dir, "native/semantic-overlay.json"))) + "`"));
  for (const file of overlay.files) for (const rule of file.rules) {
    assert.ok(rule.map.length > 0, rule.id);
    assert.ok(text.includes("](../upstream/" + file.path + ") `" + rule.id + "`"), rule.id);
  }
});

test("regeneration is deterministic and reproduces the committed document", async (t) => {
  const dir = await fixture(t);
  const output = skillPath(dir, "native/semantic-overlay.md");
  const committed = await readFile(output);
  await rm(output);
  await syncOverlay(dir);
  assert.deepEqual(await readFile(output), committed);
  await syncOverlay(dir);
  assert.deepEqual(await readFile(output), committed);
});

test("stale or missing generated document fails --check without repairing it", async (t) => {
  const dir = await fixture(t);
  const output = skillPath(dir, "native/semantic-overlay.md");
  await writeFile(output, "edited by hand");
  await assert.rejects(syncOverlay(dir, true), /Stale generated overlay/);
  assert.equal(await readFile(output, "utf8"), "edited by hand");
  await rm(output);
  await assert.rejects(syncOverlay(dir, true), /Missing generated overlay/);
  await assert.rejects(stat(output), { code: "ENOENT" });
  await editOverlay(dir, (overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map.push({ gate: "tdd/red-green-report" }); });
  await syncOverlay(dir);
  await assert.doesNotReject(syncOverlay(dir, true));
  assert.match(await readFile(output, "utf8"), /Gate \[tdd\/red-green-report\]\(workflows\.md#tdd\)/);
});

test("an unmapped upstream rule fails and names its file, line and id", async (t) => {
  const dir = await fixture(t);
  let removed;
  await editOverlay(dir, (overlay) => { removed = overlay.files.find((file) => file.path === "skills/technical-writing/SKILL.md").rules.pop(); });
  await assert.rejects(syncOverlay(dir, true), new RegExp("Unmapped upstream rule: skills/technical-writing/SKILL\\.md:" + removed.line + " " + removed.id));
});

test("a rule with no disposition fails", async (t) => {
  const dir = await fixture(t);
  await editOverlay(dir, (overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map = []; });
  await assert.rejects(syncOverlay(dir, true), /has no disposition/);
});

test("a new rule in a previously rule-free upstream file fails until it is mapped", async (t) => {
  const dir = await fixture(t);
  const path = "skills/sharpen/SKILL.md";
  const original = await readFile(skillPath(dir, "upstream/" + path), "utf8");
  assert.equal(/\b(must|required|never)\b/i.test(original), false);
  await refreshUpstream(dir, path, original + "\nAgents must never rewrite the prompt.\n");
  const line = original.split("\n").length + 1;
  await assert.rejects(syncOverlay(dir, true), new RegExp("Unmapped upstream rule: " + path + ":" + line + " r-[0-9a-f]{16}"));
});

test("upstream drift fails even when the pinned manifest is refreshed", async (t) => {
  const dir = await fixture(t);
  const path = "skills/technical-writing/SKILL.md";
  const original = await readFile(skillPath(dir, "upstream/" + path), "utf8");
  await refreshUpstream(dir, path, original + "\nA harmless trailing note.\n");
  await assert.rejects(syncOverlay(dir, true), /Upstream drift: skills\/technical-writing\/SKILL\.md overlay pins/);
});

test("a changed rule line is unmapped and its old mapping is stale", async (t) => {
  const dir = await fixture(t);
  const path = "skills/technical-writing/SKILL.md";
  const original = await readFile(skillPath(dir, "upstream/" + path), "utf8");
  const lines = original.split("\n");
  const index = lines.findIndex((line) => /\bnever\b/i.test(line));
  lines[index] = lines[index].replace(/never/i, "never, ever");
  await refreshUpstream(dir, path, lines.join("\n"));
  const error = await syncOverlay(dir, true).catch((caught) => caught);
  assert.match(error.message, new RegExp("Unmapped upstream rule: " + path.replace(/\./g, "\\.") + ":" + (index + 1)));
  assert.match(error.message, /Stale overlay rule \(no longer upstream\): skills\/technical-writing\/SKILL\.md r-/);
});

test("unreviewed upstream bytes fail before any overlay check", async (t) => {
  const dir = await fixture(t);
  await writeFile(skillPath(dir, "upstream/skills/technical-writing/SKILL.md"), "changed required source");
  await assert.rejects(syncOverlay(dir, true), /Pinned source changed without review: skills\/technical-writing\/SKILL\.md/);
});

test("the overlay must pin the source commit and current line numbers", async (t) => {
  const dir = await fixture(t);
  await editOverlay(dir, (overlay) => { overlay.upstreamCommit = "0".repeat(40); });
  await assert.rejects(syncOverlay(dir, true), /Overlay pins upstream commit 0{40}/);
  const fresh = await fixture(t);
  await editOverlay(fresh, (overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").line += 1; });
  await assert.rejects(syncOverlay(fresh, true), /Overlay line drift: r-/);
});

test("gate and native targets must resolve to current native text", async (t) => {
  const cases = [
    [(overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map = [{ gate: "tdd/no-such-gate" }]; }, /Unknown native requirement gate tdd\/no-such-gate/],
    [(overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map = [{ gate: "not-a-route/x" }]; }, /Unknown native requirement gate not-a-route\/x/],
    [(overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map = [{ native: "../README.md", quote: "pstack adapter text" }]; }, /Invalid native document \.\.\/README\.md/],
    [(overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map = [{ native: "semantic-overlay.md", quote: "Upstream rule overlay" }]; }, /Invalid native document semantic-overlay\.md/],
    [(overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map = [{ native: "principles.md", quote: "Proceed" }]; }, /Native quote too short/],
    [(overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map = [{ native: "missing.md", quote: "anything at all here" }]; }, /Missing native document missing\.md/],
    [(overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map = [{ native: "principles.md", quote: "text that is not in the principles" }]; }, /Native text missing from principles\.md/],
  ];
  for (const [change, pattern] of cases) {
    const dir = await fixture(t);
    await editOverlay(dir, change);
    await assert.rejects(syncOverlay(dir, true), pattern);
  }
});

test("deleting or duplicating mapped native text fails", async (t) => {
  const dir = await fixture(t);
  const quote = "Avoid a new framework for a one-off task.";
  const path = skillPath(dir, "native/principles.md");
  const text = await readFile(path, "utf8");
  assert.equal(text.split(quote).length, 2);
  await writeFile(path, text.replace(quote, ""));
  await assert.rejects(syncOverlay(dir, true), /Native text missing from principles\.md .*Avoid a new framework/);
  await writeFile(path, text + "\n" + quote + "\n");
  await assert.rejects(syncOverlay(dir, true), /Ambiguous native quote in principles\.md/);
  const gate = skillPath(dir, "native/requirements/tdd.json");
  await writeFile(path, text);
  const record = JSON.parse(await readFile(gate, "utf8"));
  record.gates = record.gates.filter((item) => item.id !== "red-green-report");
  await writeFile(gate, JSON.stringify(record));
  await editOverlay(dir, (overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map = [{ gate: "tdd/red-green-report" }]; });
  await assert.rejects(syncOverlay(dir, true), /Unknown native requirement gate tdd\/red-green-report/);
});

test("exclusions need a known category and a real justification", async (t) => {
  const cases = [
    [{ exclude: "not-relevant", reason: "This reason is long enough to pass the length rule." }, /Unknown exclusion category not-relevant/],
    [{ exclude: "non-normative", reason: "too short" }, /Exclusion needs a justification of at least 40 characters/],
    [{ exclude: "non-normative", reason: "                                                  " }, /Exclusion needs a justification/],
    [{ exclude: "non-normative", reason: "This reason is long enough to pass the length rule.", gate: "tdd/red-green-report" }, /Invalid disposition/],
    [{ note: "free text" }, /Invalid disposition/],
  ];
  for (const [target, pattern] of cases) {
    const dir = await fixture(t);
    await editOverlay(dir, (overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map = [target]; });
    await assert.rejects(syncOverlay(dir, true), pattern);
  }
});

test("same-rule references must name another directly mapped rule", async (t) => {
  const dir = await fixture(t);
  await editOverlay(dir, (overlay) => { const rule = ruleAt(overlay, "skills/technical-writing/SKILL.md"); rule.map = [{ same: rule.id }]; });
  await assert.rejects(syncOverlay(dir, true), /Unknown same-rule reference r-/);
  const missing = await fixture(t);
  await editOverlay(missing, (overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").map = [{ same: "r-0000000000000000" }]; });
  await assert.rejects(syncOverlay(missing, true), /Unknown same-rule reference r-0{16}/);
  const chained = await fixture(t);
  await editOverlay(chained, (overlay) => {
    const sameRule = overlay.files.flatMap((file) => file.rules).find((rule) => rule.map.some((target) => target.same));
    ruleAt(overlay, "skills/technical-writing/SKILL.md").map = [{ same: sameRule.id }];
  });
  await assert.rejects(syncOverlay(chained, true), /Chained same-rule reference/);
});

test("duplicate, extra and reordered overlay entries fail", async (t) => {
  const cases = [
    [(overlay) => { const rule = ruleAt(overlay, "skills/technical-writing/SKILL.md"); rule.map.push(rule.map[0]); }, /Duplicate disposition/],
    [(overlay) => { overlay.files.push({ path: "skills/sharpen/SKILL.md", sha256: "0".repeat(64), rules: [] }); }, /Overlay file has no upstream rules: skills\/sharpen\/SKILL\.md/],
    [(overlay) => { overlay.files.reverse(); }, /Overlay files out of pinned manifest order/],
    [(overlay) => { const file = overlay.files.find((item) => item.rules.length > 2); file.rules.reverse(); }, /Overlay rules out of upstream order/],
    [(overlay) => { overlay.files.push(overlay.files[0]); }, /Duplicate overlay file/],
    [(overlay) => { overlay.schema = 2; }, /Invalid semantic overlay/],
    [(overlay) => { overlay.reviewedBy = "anyone"; }, /Invalid semantic overlay/],
    [(overlay) => { ruleAt(overlay, "skills/technical-writing/SKILL.md").approved = true; }, /Invalid semantic overlay/],
  ];
  for (const [change, pattern] of cases) {
    const dir = await fixture(t);
    await editOverlay(dir, change);
    await assert.rejects(syncOverlay(dir, true), pattern);
  }
});

test("upstream link syntax in excerpts cannot create unresolved document links", async () => {
  const text = await readFile(join(root, "skills/pstack/native/semantic-overlay.md"), "utf8");
  assert.ok(text.includes("[never-block-on-the-human]\\(./skills/"), "README excerpt keeps its escaped link text");
  const native = join(root, "skills/pstack/native");
  const targets = [...text.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.ok(targets.length > 400);
  for (const target of targets) {
    assert.ok(!target.includes("://"), target);
    await stat(join(native, target.split("#")[0]));
  }
});

test("the doctor extracts exactly the same rules, including edge-case text", async (t) => {
  const manifest = JSON.parse(await readFile(join(root, "skills/pstack/source-manifest.json"), "utf8"));
  const files = new Map();
  for (const record of manifest.files) files.set(record.path, await readFile(join(root, "skills/pstack/upstream", record.path)));
  assert.deepEqual(python(join(root, "skills/pstack"), manifest.files), extractRules(manifest.files, files));

  const dir = await mkdtemp(join(tmp, "pstack-overlay-extract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const samples = {
    "bom.md": "\uFEFFMust be kept with its byte order mark.\nplain line\n",
    "crlf.md": "first\r\nYou MUSTn't stop.\r\n  trailing never \t\r\nREQUIRED\r\n",
    "words.md": "unrequired musty nevertheless never_x required2 mustnt\nmust\nmust\n\u00a0must after nbsp\némust after accent\nMÜST\nYou mustn\u2019t either.\n",
    "separator.md": "one\u2028must stays on this line\nnever keeps a trailing nbsp\u00a0\nrequired keeps a vertical tab\u000b\n",
    "nul.bin": "must\u0000hidden",
    "nested/dir/doc.md": "a line\nNever in a nested file.",
  };
  const records = [];
  const local = new Map();
  for (const [path, text] of Object.entries(samples)) {
    const bytes = Buffer.from(text);
    await mkdir(dirname(join(dir, "upstream", path)), { recursive: true });
    await writeFile(join(dir, "upstream", path), bytes);
    records.push({ path, sha256: sha(bytes) });
    local.set(path, bytes);
  }
  const invalid = Buffer.from([0x6d, 0x75, 0x73, 0x74, 0x20, 0xc3, 0x28]);
  await writeFile(join(dir, "upstream/invalid.md"), invalid);
  records.push({ path: "invalid.md", sha256: sha(invalid) });
  local.set("invalid.md", invalid);
  const expected = extractRules(records, local);
  assert.deepEqual(python(dir, records), expected);
  const lines = Object.fromEntries(expected.map((file) => [file.path, file.rules.map((rule) => rule.text)]));
  assert.deepEqual(lines, {
    "bom.md": ["\uFEFFMust be kept with its byte order mark."],
    "crlf.md": ["You MUSTn't stop.", "  trailing never", "REQUIRED"],
    "words.md": ["must", "must", "\u00a0must after nbsp", "émust after accent", "You mustn\u2019t either."],
    "separator.md": ["one\u2028must stays on this line", "never keeps a trailing nbsp\u00a0", "required keeps a vertical tab\u000b"],
    "nested/dir/doc.md": ["Never in a nested file."],
  });
  const [first, second] = expected.find((file) => file.path === "words.md").rules;
  assert.notEqual(first.id, second.id);
});

// Ratchet: widening the exclusions, or pointing a rule at an excluded rule, needs a reviewed change here.
const EXCLUDED = [
  "automations/benny/FOR_AGENTS.md:32 cursor-harness",
  "automations/benny/skills/reproduce-and-fix-issues/references/control-adapter.md:11 non-normative",
  "automations/benny/skills/reproduce-and-fix-issues/references/feature-map.example.md:46 non-normative",
  "automations/benny/skills/reproduce-and-fix-issues/references/feature-map.example.md:61 non-normative",
  "automations/benny/skills/setup-benny/SKILL.md:94 non-normative",
  "docs/guide/04-design.md:114 guide-example",
  "docs/guide/05-build-and-clean.md:13 guide-example",
  "docs/guide/06-verify-and-ship.md:107 guide-example",
  "docs/guide/10-recipes-and-pitfalls.md:90 guide-example",
  "docs/harness/claude-code.md:54 cursor-harness",
  "skills/arena/SKILL.md:28 cursor-harness",
  "skills/make-bot-ui/SKILL.md:5 non-normative",
  "skills/poteto-help/references/recipes.md:32 guide-example",
  "skills/poteto-mode/SKILL.md:98 cursor-harness",
  "skills/poteto-mode/references/bugbot-triage.md:23 non-normative",
  "skills/poteto-mode/references/bugbot-triage.md:45 non-normative",
  "skills/poteto-mode/references/bugbot-triage.md:138 non-normative",
  "skills/poteto-mode/scripts/watch-pr/cli.ts:37 source-only-code",
  "skills/poteto-mode/scripts/watch-pr/cli.ts:43 source-only-code",
  "skills/poteto-mode/scripts/watch-pr/cli.ts:49 source-only-code",
  "skills/poteto-mode/scripts/watch-pr/cli.ts:56 source-only-code",
  "skills/poteto-mode/scripts/watch-pr/github.ts:81 non-normative",
  "skills/poteto-mode/scripts/watch-pr/policy.ts:278 non-normative",
  "skills/poteto-mode/scripts/watch-pr/policy.ts:325 non-normative",
  "skills/poteto-mode/scripts/watch-pr/policy.ts:831 non-normative",
  "skills/poteto-mode/scripts/watch-pr/render.ts:17 non-normative",
  "skills/poteto-mode/scripts/watch-pr/render.ts:128 non-normative",
  "skills/poteto-mode/scripts/watch-pr/render.ts:165 non-normative",
  "skills/poteto-mode/scripts/watch-pr/types.ts:9 source-only-code",
  "skills/principle-never-block-on-the-human/SKILL.md:2 non-normative",
  "skills/principle-never-block-on-the-human/SKILL.md:7 non-normative",
  "skills/statechart/scripts/backends/report.ts:8 non-normative",
  "skills/statechart/scripts/backends/report.ts:78 non-normative",
  "skills/statechart/scripts/backends/report.ts:138 non-normative",
  "skills/statechart/scripts/frontends/value.ts:79 non-normative",
  "skills/statechart/scripts/frontends/view.ts:78 non-normative",
  "skills/statechart/scripts/ir.ts:300 non-normative",
  "skills/statechart/scripts/ir.ts:313 non-normative",
  "skills/statechart/scripts/ir.ts:314 non-normative",
  "skills/statechart/scripts/passes/annotate.ts:8 non-normative",
  "skills/statechart/scripts/passes/annotate.ts:49 non-normative",
  "skills/statechart/scripts/passes/label.ts:11 non-normative",
  "skills/statechart/scripts/passes/label.ts:28 non-normative",
  "skills/statechart/scripts/passes/label.ts:61 non-normative",
  "skills/statechart/scripts/passes/label.ts:158 non-normative",
  "skills/statechart/scripts/passes/label.ts:171 non-normative",
  "skills/statechart/scripts/passes/label.ts:242 non-normative",
  "skills/statechart/scripts/passes/label.ts:267 non-normative",
  "skills/statechart/scripts/passes/label.ts:268 non-normative",
  "skills/statechart/scripts/passes/lift.ts:6 non-normative",
  "skills/statechart/scripts/passes/lift.ts:38 non-normative",
  "skills/statechart/scripts/passes/loop-check.ts:9 non-normative",
  "skills/statechart/scripts/passes/loop-check.ts:46 non-normative",
  "skills/statechart/scripts/passes/paths.ts:6 non-normative",
  "skills/statechart/scripts/passes/paths.ts:27 non-normative",
  "skills/statechart/scripts/passes/paths.ts:53 non-normative",
  "skills/statechart/scripts/passes/reach.ts:7 non-normative",
  "skills/statechart/scripts/passes/reach.ts:38 non-normative",
  "skills/statechart/scripts/passes/reach.ts:47 non-normative",
  "skills/statechart/scripts/passes/reach.ts:48 non-normative",
  "skills/statechart/scripts/passes/reach.ts:54 non-normative",
  "skills/statechart/scripts/passes/reach.ts:118 non-normative",
  "skills/statechart/scripts/passes/region-check.ts:45 non-normative",
  "skills/statechart/scripts/passes/region-check.ts:92 non-normative",
  "skills/statechart/scripts/passes/regions.ts:14 non-normative",
  "skills/statechart/scripts/passes/regions.ts:192 non-normative",
  "skills/statechart/scripts/run.ts:26 non-normative",
  "skills/statechart/scripts/run.ts:392 non-normative",
  "skills/statechart/scripts/run.ts:403 non-normative",
  "skills/statechart/scripts/run.ts:438 non-normative",
  "skills/statechart/scripts/run.ts:467 non-normative",
  "skills/statechart/scripts/test/ConfigOracle.java:43 non-normative",
  "skills/statechart/scripts/test/chart.test.ts:141 non-normative",
  "skills/statechart/scripts/test/chart.test.ts:566 non-normative",
  "skills/statechart/scripts/test/chart.test.ts:1139 non-normative",
  "skills/statechart/scripts/test/cli.test.ts:786 non-normative",
  "skills/statechart/scripts/test/cli.test.ts:946 non-normative",
  "skills/statechart/scripts/test/cli.test.ts:1047 non-normative",
  "skills/statechart/scripts/test/corpus.test.ts:166 non-normative",
  "skills/statechart/scripts/test/corpus/LoginGuarded/LoginGuarded.tla:61 non-normative",
  "skills/statechart/scripts/test/corpus/LoginParallel/LoginParallel.tla:61 non-normative",
  "skills/statechart/scripts/test/corpus/MediaPlayer/MediaPlayer.tla:100 non-normative",
  "skills/statechart/scripts/test/corpus/MediaPlayerFixed/MediaPlayerFixed.tla:97 non-normative",
  "skills/statechart/scripts/test/corpus/MediaPlayerProps/MediaPlayer.tla:100 non-normative",
  "skills/statechart/scripts/test/differential.test.ts:120 non-normative",
  "skills/statechart/scripts/test/pipeline.test.ts:263 non-normative"
];
const SAME_AS_EXCLUDED = [];
function exclusionSets(overlay) {
  const byId = new Map(overlay.files.flatMap((file) => file.rules.map((rule) => [rule.id, { path: file.path, rule }])));
  const excluded = [], sameAsExcluded = [];
  for (const file of overlay.files) for (const rule of file.rules) for (const target of rule.map) {
    if (target.exclude) excluded.push(file.path + ":" + rule.line + " " + target.exclude);
    if (target.same) {
      const other = byId.get(target.same);
      if (other.rule.map.every((next) => next.exclude)) sameAsExcluded.push(file.path + ":" + rule.line + " -> " + other.path + ":" + other.rule.line);
    }
  }
  return { excluded, sameAsExcluded };
}

test("the exclusion set and the same-as-excluded set are pinned, so a refresh cannot quietly widen them", async (t) => {
  const overlay = JSON.parse(await readFile(join(root, "skills/pstack/native/semantic-overlay.json"), "utf8"));
  assert.deepEqual(exclusionSets(overlay), { excluded: EXCLUDED, sameAsExcluded: SAME_AS_EXCLUDED });
  // Re-dispositioning a carried rule as a plausibly reasoned exclusion passes sync --check, but not this ratchet.
  const dir = await fixture(t);
  await editOverlay(dir, (o) => { ruleAt(o, "skills/poteto-mode/playbooks/babysit.md").map = [{ exclude: "non-normative", reason: "Looks like narration rather than a binding rule here." }]; });
  const widened = await readJson(dir, "native/semantic-overlay.json");
  assert.equal((await syncOverlay(dir, false)).rules, 363);
  assert.notDeepEqual(exclusionSets(widened).excluded, EXCLUDED);
  // Pointing a carried rule at an excluded one is caught too.
  const pointed = structuredClone(overlay);
  ruleAt(pointed, "skills/poteto-mode/playbooks/babysit.md").map = [{ same: ruleAt(overlay, "skills/poteto-mode/scripts/watch-pr/cli.ts").id }];
  assert.notDeepEqual(exclusionSets(pointed).sameAsExcluded, SAME_AS_EXCLUDED);
  // The loose pointers the review found now name their direct carrier or exclusion.
  const setup = overlay.files.find((file) => file.path === "automations/benny/skills/setup-benny/SKILL.md").rules.find((rule) => rule.line === 246);
  assert.deepEqual(setup.map, [{ native: "contract.md", quote: "use supported native scheduler/tool schema, exact owner and bounded lifecycle only when requested" }]);

});
