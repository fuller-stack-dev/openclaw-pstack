import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkPlan, hasAngleTag, stripLinkTargets } from "../skills/pstack/scripts/plan-check.mjs";

const rule = "Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";
const lanes = Array.from({ length: 10 }, (_, i) => `- [ ] Lane ${i + 1}. ${i === 0 ? "Regression lane against trunk. " : ""}Open a saved relay and confirm delivery. Save \`relay-${i + 1}.png\`. Pass when the delivery receipt is visible.`).join("\n");
const pr = (id, depends = "None.") => [
  `## Deliver a relay receipt (${id})`,
  `**Depends on.** ${depends}`,
  "**Files.**", "- [ ] Edit `src/relay.js`.",
  "**Build.**", "- [ ] Add `receipt` to `send` in `src/relay.js`.",
  "**You see.**", "- [ ] The relay prints `delivered` after acknowledgment.",
  `**Verify, unit.** ${rule}`, "- [ ] Run `node --test relay.test.js` and retain the passing log.",
  `**Verify, live.** ${rule} Ten lanes on \`provider/worker\` at the PR head.`, lanes,
  `**Verify, perf.** ${rule}`,
  "- [ ] Metric. Delivery latency in ms at trunk and head.",
  "- [ ] Probe. Alternate the delivery probe on trunk and head five times.",
  "- [ ] Baseline. Record the trunk median in `latency.json` before head runs.",
  "- [ ] Rule. Fail if head exceeds trunk by 5 percent.",
  `**Review gate.** None. ${id} is not review-gated.`,
  "**Merge.**", "- [ ] Record root exact-head verdict and green CI before the authorized merge.",
].join("\n");
const prefix = [
  "# Relay plan", "", "Deliver receipts for relay users through PR-1.",
  "## How to read this",
  "One box is one unit of work. Every box names the evidence.",
  "Check a box only when its evidence exists.",
  "The program runs playbooks/autopilot-full. The authorized owner merges.", rule,
  "## Program checklist", "### Arm the program",
  "- [ ] Wait for the operator explicit go and read the native leaves from trunk.",
  "- [ ] Record the authorized native audit lifecycle and send a status message only for changes.",
  "- [ ] Propagate hold as zero-writes.", "### Spawn owners",
  "- [ ] Use pstack_route and sessions_spawn for one owner per PR.",
  "### PR mechanics", "- [ ] Run committed-head repo checks through the authorized forge flow.",
  "### Verdict and merge", "- [ ] Audit receipts and apply patch-id requalification.",
  "### Boot recipe", "- [ ] Check out the exact head in an isolated environment and run the relay driver.",
].join("\n");
const tail = [
  "## Close the program", "- [ ] Check every box with its resolving evidence.",
  "## Appendix A. Prototype evidence", "The driver at `proof/relay.log` confirms acknowledgment order.",
  "## Appendix B. Alternatives rejected", "Polling duplicates the event subscription.",
  "## Appendix C. Risks", "PR-1 watches lost acknowledgments.",
  "## Appendix D. Links and reading list", "Read the relay API and native verification routes.",
].join("\n");
const valid = `${prefix}\n${pr("PR-1")}\n${tail}\n`;
const messages = (source) => checkPlan(source).problems.map((problem) => problem.message).join("\n");

test("accepts a concrete plan and reports each PR independently", () => {
  const result = checkPlan(`${prefix}\n${pr("PR-1")}\n${pr("PR-2", "PR-1.")}\n${tail}`);
  assert.deepEqual(result.problems, []);
  assert.equal(result.reports.length, 2);
  assert.equal(result.reports[0].counts["Verify, live."], 10);
});

test("accepts Markdown headings indented like the copyable native skeleton", () => {
  for (const indent of [" ", "  ", "   "]) {
    assert.deepEqual(checkPlan(valid.replace(/^#{1,3} /gm, (heading) => indent + heading)).problems, []);
  }
});

test("accepts a review-gated interaction with screenshots, video, and operator approval", () => {
  const source = valid.replace("**Review gate.** None. PR-1 is not review-gated.", "**Review gate.** The operator reviews before merge.\n- [ ] Save screenshots in `review/`.\n- [ ] Save a 30 second video in `review/demo.mp4`.\n- [ ] Send to the operator and wait for approval.");
  assert.deepEqual(checkPlan(source).problems, []);
});

test("rejects missing, reordered, or duplicate plan sections and sub-blocks", () => {
  assert.match(messages(valid.replace("## Appendix C. Risks\nPR-1 watches lost acknowledgments.\n", "")), /missing "## Appendix C/);
  assert.match(messages(valid.replace("**Files.**", "**Build.**")), /sub-blocks must be/);
  assert.match(messages(valid + "## Appendix A. Prototype evidence\nDuplicate.\n"), /duplicate section/);
  assert.match(messages(valid.replace("## How to read this", "## Other")), /missing "## How to read this/);
});

test("rejects missing program safety markers and evidence boxes", () => {
  for (const [fragment, diagnostic] of [["explicit go", "operator explicit go"], ["zero-writes", "zero-writes stop"], ["sessions_spawn", "native sessions_spawn"], ["patch-id", "patch-id requalification"]]) {
    assert.match(messages(valid.replace(fragment, "omitted")), new RegExp(diagnostic));
  }
  assert.match(messages(valid.replace("- [ ] Add `receipt` to `send` in `src/relay.js`.\n", "")), /Build\. has no evidence box/);
  assert.match(messages(valid.replace("**Depends on.** None.", "**Depends on.**")), /Depends on names nothing/);
  assert.match(messages(valid.replace(`**Verify, unit.** ${rule}`, "**Verify, unit.** Unit tests suffice.")), /must open with the verification rule/);
});

test("rejects missing, duplicate, and incomplete live lanes", () => {
  assert.match(messages(valid.replace(/^.*Lane 10\..*\n/m, "")), /exactly 1 through 10/);
  assert.match(messages(valid.replace("Lane 10.", "Lane 9.")), /exactly 1 through 10/);
  assert.match(messages(valid.replace("Save `relay-4.png`.", "Retain image.")), /screenshot path/);
  assert.match(messages(valid.replace("Pass when the delivery receipt is visible.", "Inspect output.")), /pass predicate/);
  assert.match(messages(valid.replace("Regression lane against trunk.", "Delivery lane.")), /missing Regression lane/);
  assert.match(messages(valid.replace("Ten lanes on `provider/worker`", "Ten lanes")), /resolved native worker selection/);
});

test("rejects incomplete performance and contradictory review gates", () => {
  assert.match(messages(valid.replace("- [ ] Baseline. Record the trunk median in `latency.json` before head runs.\n", "")), /perf boxes must be/);
  assert.match(messages(valid.replace("5 percent", "an unspecified amount")), /numeric failure threshold/);
  assert.match(messages(valid.replace("**Merge.**", "- [ ] Extra review step.\n**Merge.**")), /None review gate must have no boxes/);
  const review = valid.replace("None. PR-1 is not review-gated.", "The operator reviews before merge.");
  assert.match(messages(review), /review gate needs evidence boxes/);
  assert.match(messages(review), /review gate lacks video/);
});

test("handles frontmatter, CRLF, and fences without counting code examples as evidence", () => {
  assert.deepEqual(checkPlan(("---\nlabel: Relay\n---\n" + valid).replaceAll("\n", "\r\n")).problems, []);
  for (const indent of ["", " ", "  ", "   "]) {
    assert.deepEqual(checkPlan(valid + `${indent}\`\`\`\`md\n\`\`\`\n## Not a section\nWords: inside code.\n\`\`\`\n${indent}\`\`\`\`\`\t\n`).problems, []);
  }
  assert.deepEqual(checkPlan(valid + "~~~md `info`\n## Not a section\n~~~\n").problems, []);
  const fake = valid.replace("- [ ] Add `receipt` to `send` in `src/relay.js`.", "```md\n- [ ] Pretend evidence.\n```");
  assert.match(messages(fake), /Build\. has no evidence box/);
  assert.match(messages(valid + "```\nHidden text\n"), /unclosed code fence/);
  assert.match(messages("---\n" + valid), /unclosed frontmatter/);
});

test("rejects unfilled placeholders and prose violations with original line numbers", () => {
  const result = checkPlan(valid + "Unfilled <metric>.\nBad prose: connector.\nLong — dash and ‘quote’.\n", "relay.md");
  const line = valid.split("\n").length;
  assert.deepEqual(result.problems, [
    { line, message: "unfilled angle-bracket placeholder or HTML; use concrete Markdown evidence" },
    { line: line + 1, message: "mid-sentence colon" },
    { line: line + 2, message: "long dash" },
    { line: line + 2, message: "curly quote" },
  ]);
  assert.deepEqual(checkPlan(valid + "Use `node x:y` and [the docs](https://example.invalid/a:b).\n").problems, []);
});

for (const count of [1, 2, 3, 4]) test(`ignores punctuation inside matching ${count}-backtick code spans`, () => {
  const delimiter = "`".repeat(count);
  const inner = count === 1 ? "x" : "`x`";
  assert.deepEqual(checkPlan(valid + `Use ${delimiter}echo ${inner}: “quoted” — example${delimiter}.\n`).problems, []);
});

test("matches whole backtick runs and leaves unmatched and surrounding prose visible", () => {
  const punctuation = ["long dash", "curly quote", "mid-sentence colon"];
  const line = valid.split("\n").length;
  for (const [source, expected] of [
    ["Use ``echo `x`: y``. Bad: prose.", ["mid-sentence colon"]],
    ["Bad: ‘prose’ — before ``echo `x`: y``.", punctuation],
    ["Use ``unclosed: bad` here.", ["mid-sentence colon"]],
    ["Use `unclosed: ‘bad’ — here.", punctuation],
    ["Use ```unclosed: ‘bad’ — here``.", punctuation],
    ["Use ``unclosed: ‘bad’ — here````.", punctuation],
    ["Use ``unclosed `inside: ‘code’ — only` outside: prose.", ["mid-sentence colon"]],
    ["Use ``one ` shorter: ‘code’ — run``.", []],
    ["Use `one `` longer: ‘code’ — run`.", []],
    ["Use ``one: ‘code’ — span`` and `two: ‘code’ — span`.", []],
  ]) {
    assert.deepEqual(checkPlan(valid + source + "\n").problems,
      expected.map(message => ({ line, message })), source);
  }
});

test("CLI returns pass, diagnostics, usage, and read-error exits without changing input", () => {
  const directory = mkdtempSync(join(tmpdir(), "native-plan-"));
  const file = join(directory, "relay.md");
  const checker = fileURLToPath(new URL("../skills/pstack/scripts/plan-check.mjs", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCLAW_")));
  const run = (args) => spawnSync(process.execPath, [checker, ...args], { encoding: "utf8", env, cwd: directory });
  try {
    writeFileSync(file, valid);
    const pass = run([file]);
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /1 PR sections, 0 problems/);
    assert.equal(readFileSync(file, "utf8"), valid);
    assert.deepEqual(readdirSync(directory), ["relay.md"]);
    writeFileSync(file, valid.replace("Lane 10.", "Lane 9."));
    const failed = run([file]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /relay\.md:\d+: .*exactly 1 through 10/);
    assert.equal(run([]).status, 2);
    const missing = run([join(directory, "missing.md")]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /cannot read plan \(ENOENT\)/);
    assert.equal(run([file, "extra"]).status, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("fills the actual shipped multi-phase skeleton with both execution path forms", () => {
  const playbooks = readFileSync(new URL("../skills/pstack/native/playbooks.md", import.meta.url), "utf8");
  const skeleton = playbooks.match(/~~~~markdown\n([\s\S]*?)\n~~~~/)[1];
  const fills = {
  "Program": "Relay",
  "Who benefits, what changes, the governing rule, and ordered PR ids. Under ten lines.": "Relay users receive acknowledgments through PR-1. Exact-head receipts gate landing.",
  "execution route": "autopilot-full",
  "Who merges and which items stop at merge-ready.": "The authorized PR owner merges after root approval.",
  "Concrete dependency graph and branching order.": "PR-1 starts from trunk without dependencies.",
  "Exclusive file boundaries per PR.": "PR-1 owns src/relay.js and tests/relay.test.js.",
  "Interaction-changing PR ids requiring screenshots and video review.": "PR-1 requires screenshots and video review before landing.",
  "Authorized native forge and PR creation operation, ready or explicitly required draft, correct base.": "Use the authorized GitHub PR tool for PR-1 against main after explicit publication approval.",
  "Repo lint, typecheck, focused tests on committed head before push. Hooks stay enabled.": "Run npm run lint, npm run typecheck and node --test tests/relay.test.js at the committed head; retain logs and hooks.",
  "Scope cleanup before commit, no-comments before review, and concrete review-thread triage.": "Remove unrelated edits, run no-comments and resolve every PR-1 review thread.",
  "Code-ready rebase rule for this execution route, every later head receipt, self-proof and babysit. Stack owners never rebase or retarget.": "Record code-ready head after rebase to trunk, then self-proof, babysit and requalify every later head.",
  "Code-ready full swarm with one gates lane, ten live lanes, perf lane, and at least two audit lanes. Minor-fix new-head verifier rule.": "Collect one gates lane, ten live lanes, one perf lane and two audit lanes at code-ready head; minor fixes need a new-head verifier.",
  "Root receipt audit, all lanes PASS, owner fix-forward for findings, patch-id requalification.": "Root audits all PASS receipts; owner fixes findings and records patch-id requalification after every change.",
  "Authorized merge rule, or root stack append and operator landing.": "The authorized owner merges only after root approval and green exact-head checks.",
  "Isolated authorized environment, exact head checkout, backend and surface start, ready predicate.": "Check out the exact head in isolated HOME, run npm run relay and wait for the ready log.",
  "Named native control driver for input and read-only diagnostics.": "Use the installed native browser driver to submit the relay form and inspect its receipt.",
  "Per-lane screenshot and report paths.": "Save each lane screenshot and report under proof/PR-1/lane-N.",
  "Task as a verb phrase": "Deliver a relay receipt",
  "PR id": "PR-1",
  "PR id or None.": "None.",
  "Edit, create, or delete concrete path.": "Edit src/relay.js and create tests/relay.test.js.",
  "One change naming a symbol and file.": "Add a receipt to send in src/relay.js.",
  "Observable log or screen state.": "The relay surface shows delivered after acknowledgment.",
  "Test file, behavioral case, exact command, and output artifact.": "Run node --test tests/relay.test.js for delayed acknowledgment and save proof/unit.log.",
  "resolved native swarm workers selection": "fixture/worker",
  "Same load-bearing scenario on trunk and head, or honest absence and added end-state gate.": "Replay the delayed acknowledgment on trunk and head.",
  "screenshot path": "proof/receipt.png",
  "predicate": "the delivered receipt is visible",
  "Scenario.": "Submit a saved relay and confirm acknowledgment.",
  "Same metric at trunk and head, plus added work and end state when necessary.": "Measure delivery latency in ms on trunk and head.",
  "Interleaved concrete procedure on both revisions.": "Alternate five delivery probes on trunk and head.",
  "Trunk value and artifact recorded first.": "Record the trunk median in proof/latency.json before head runs.",
  "Numeric failure threshold and absolute budgets when unlike scenarios forbid a ratio.": "Fail if the head median exceeds trunk by 5 percent.",
  "Operator reviews before merge, or None. PR id is not review-gated.": "The operator reviews before merge.",
  "Copy named screenshots to review artifacts. Remove these boxes for None.": "Copy screenshots to proof/review/.",
  "Record 30 to 60 second video and save its path.": "Save a 30 second video to proof/review/demo.mp4.",
  "Send the artifacts through authorized chat, then stop at merge-ready for operator review.": "Send screenshots and video to the operator and wait for approval.",
  "Root clean exact-head verdict and resolved review findings.": "Record the root clean verdict and resolved review findings at the exact head.",
  "Fresh-head CI, base-drift checks, and patch-id rule.": "Record green head CI, base-drift inspection and patch-id evidence.",
  "Authorized owner merge or root append for operator landing.": "The authorized owner records the merge result after approval.",
  "Questions settled with branch, SHA, artifacts, and unresolved questions.": "The prototype relay-receipt branch at recorded SHA and proof/prototype.log settles acknowledgment order.",
  "Alternatives and reasons.": "Polling was rejected because it duplicates the event subscription.",
  "Risk, responsible PR, what its owner watches, missing control capabilities.": "PR-1 watches lost acknowledgments; browser capture is required and missing capture blocks live proof.",
  "Required native leaves, how and interrogate PRs, and decision trail.": "Read the native execution, how and interrogate leaves and the relay API decision trail."
};
  const filled = skeleton.replace(/<([^>\n]+)>/g, (_whole, name) => {
    assert.ok(Object.hasOwn(fills, name), "Unfilled shipped placeholder " + name);
    return fills[name];
  });
  assert.match(messages(skeleton), /unfilled angle-bracket/);
  for (const route of ["autopilot-full", "autopilot-stack", "orchestrate"]) {
    for (const path of ["playbooks/" + route, "playbooks.md#" + route]) {
      const source = filled.replace("playbooks/autopilot-full", "[execution route](" + path + ")");
      const result = checkPlan(source);
      assert.deepEqual(result.problems, [], path + "\n" + JSON.stringify(result.problems));
      assert.equal(result.reports.length, 1);
      assert.equal(result.reports[0].counts["Verify, live."], 10);
    }
  }
  assert.match(messages(filled.replace("playbooks/autopilot-full", "playbooks.md#unknown")), /must name the execution playbook/);
});

test("linear prose scanners match the original regexes exactly on exhaustive short inputs", () => {
  const reference = (text) => text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\]\([^)]*\)/g, "]");
  const alphabet = ["!", "[", "]", "(", ")", "<", ">", "a", "\n"];
  let checked = 0;
  const visit = (prefix, depth) => {
    assert.equal(stripLinkTargets(prefix), reference(prefix), JSON.stringify(prefix));
    assert.equal(hasAngleTag(prefix), /<[^>\n]+>/.test(prefix), JSON.stringify(prefix));
    checked++;
    if (depth) for (const c of alphabet) visit(prefix + c, depth - 1);
  };
  visit("", 6);
  assert.equal(checked, (9 ** 7 - 1) / 8);
  assert.equal(stripLinkTargets("see ![shot](a.png) and [doc](x.md): end"), "see  and [doc]: end");
});

test("pathological 128 KiB lines check in bounded time and still report their findings", () => {
  for (const [line, finding] of [["](".repeat(65_536), undefined], ["![".repeat(65_536), undefined], ["<".repeat(131_071) + ">", "angle-bracket"],
    ["![a](".repeat(26_214), undefined], ["<a".repeat(65_536), undefined]]) {
    const started = performance.now();
    const result = checkPlan("# Title\n" + line);
    assert.ok(performance.now() - started < 1_000, "took " + (performance.now() - started) + " ms");
    const placeholder = result.problems.some((p) => p.message.includes("angle-bracket"));
    assert.equal(placeholder, finding === "angle-bracket");
  }
});
