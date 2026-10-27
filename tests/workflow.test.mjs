import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflow, workflowView, workflowStages, appendEvent, mutateWorkflow, ownedRecord, workflowKey, digest, judgeCandidates, shapeDigest, LEDGER_BUDGET, LedgerBudgetError } from "../src/workflow.ts";
import { parseSpawnTag, spawnTag, checkSpawnRecord } from "../src/spawn-guard.ts";
import { resolveRole, validateSnapshot } from "../skills/pstack/scripts/model-routing.mjs";
import { architectOutput, arenaOutput, judgeOutput, reviewerOutput, finding } from "./fixtures/panel-outputs.mjs";

const owner = { sessionKey: "agent:worker:dashboard:workflow", sessionId: "incarnation-1", workspace: "/fixture/workspace" };
const roles = {
  architect: ["architect runners", "arena cross-judge pool"], arena: ["arena runners", "arena cross-judge pool"],
  interrogate: ["interrogate reviewers"], swarm: ["swarm workers"], how: ["how explainer"],
  why: ["why investigators", "why synthesizer"], reflect: ["reflect tooling", "reflect judgment, divergent, synthesizer"],
};
const sources = ["source-control", "issues", "documents", "chat", "observability", "errors", "analytics"].map((category, i) => ({ id: "source-" + i, category, disposition: i === 0 ? "available" : "unavailable", reason: i === 0 ? "Authorized fixture history" : "No scoped connector in fixture" }));
function setup(kind, options = {}, catalog = [], snapshots) {
  if (kind === "architect" && !Object.keys(options).length) options = { intent: "checkpoint" };
  if (kind === "how" && !Object.keys(options).length) options = { complexity: "simple" };
  if (kind === "swarm" && !Object.keys(options).length) options = { slices: [{ id: "slice-a", sha: "a".repeat(40), method: "five alternating pairs; one sample is one complete request" }] };
  if (kind === "why" && !Object.keys(options).length) options = { sources };
  const names = kind === "how" && options.complexity === "complex" ? ["how explorer", "how explainer"] : roles[kind];
  return { kind, taskDigest: digest("bounded task"), sourceDigest: digest("frozen source"), catalog,
    snapshots: snapshots ?? names.map(role => resolveRole({ role, catalog: [] })), options };
}
const design = name => ({ output: architectOutput(name) });
function fixture(kind, options, catalog, snapshots) {
  let record = createWorkflow("task-one", owner, setup(kind, options, catalog, snapshots)), serial = 0;
  const view = () => workflowView(record);
  const event = (e) => { record = appendEvent(record, view().revision, { id: "event-" + ++serial, ...e }); return view(); };
  const fail = (e, pattern) => assert.throws(() => appendEvent(record, view().revision, { id: "bad-" + ++serial, ...e }), pattern);
  const gate = (evidence) => event({ type: "advance", evidence });
  const admit = (slot, run = "run-" + serial) => {
    const job = view().jobs.find(x => x.id === slot);
    return event({ type: "accept", slot, runId: run, childSessionKey: "agent:worker:subagent:" + run, snapshotId: view().currentSnapshots[job.role] });
  };
  // Panel roles get a valid default output; tests override it to prove each contract rule.
  const usable = prefix => Object.entries(view().attempts).filter(([id, a]) => id.startsWith(prefix) && a.at(-1).result && a.at(-1).result.status !== "BLOCKED" && !a.at(-1).rejected).map(([id]) => id);
  const defaults = slot => {
    const role = view().jobs.find(j => j.id === slot)?.role;
    if (role === "arena runners") return { output: arenaOutput() };
    if (role === "arena cross-judge pool") return { output: judgeOutput(usable(kind === "architect" ? "designs:" : "candidates:")) };
    if (role === "interrogate reviewers") return { output: reviewerOutput() };
    return {};
  };
  const collect = (slot, extra = {}) => {
    const runId = view().attempts[slot].at(-1).runId;
    const result = { status: "PASS", artifactDigest: digest(slot), evidence: ["fixture/artifact#observed-outcome"], ...(extra.status === "BLOCKED" ? {} : defaults(slot)), ...extra };
    return event({ type: "collect", slot, runId, result });
  };
  const result = (slot, extra = {}) => ({ type: "collect", slot, runId: view().attempts[slot].at(-1).runId, result: { status: "PASS", artifactDigest: digest(slot), evidence: ["fixture/artifact#observed-outcome"], ...extra } });
  return { view, event, fail, gate, admit, collect, result, record: () => record };
}

test("architect cannot judge or synthesize before both distinct whole-shape designs, the cross-judge and lead comparison", () => {
  const f = fixture("architect");
  f.fail({ type: "advance", evidence: {} }, /gate how/);
  f.gate({ how: "grounding/how.md", "rationale-constraints": "grounding/why.md" });
  assert.deepEqual(f.view().jobs.map(j => [j.role, j.index]), [["architect runners", 0], ["architect runners", 1]]);
  f.admit("designs:0", "A"); f.collect("designs:0", design("message pipeline"));
  f.fail({ type: "advance", evidence: {} }, /designs:1/);
  f.admit("designs:1", "B"); f.collect("designs:1", design("immutable events"));
  f.gate({}); assert.equal(f.view().phase, "judge");
  f.fail({ type: "advance", evidence: {} }, /judge:0/);
  f.admit("judge:0", "J"); f.collect("judge:0"); f.gate({});
  f.fail({ type: "advance", evidence: {} }, /lead-scores/);
  f.gate({ "lead-scores": "scores.md", "judge-comparison": "comparison.md", "red-flags": "red-flags.md" });
  f.gate({ "caller-first-package": "design.md", rationale: "rationale.md", "alternatives-grafts-rejections": "alternatives.md" });
  assert.equal(f.view().status, "awaiting-user");
  f.fail({ type: "advance", evidence: {} }, /user-decision/);
  f.gate({ "user-decision": "user-message: explicit approval of design A" });
  f.gate({ "implementation-authority": "original scoped implementation request", "behavioral-verification": "verification.md", "deviations-or-none": "none" });
  assert.equal(f.view().status, "completed"); assert.equal(f.view().assurance, "agent-attested");
  f.fail({ type: "resume" }, /terminal/);
});

test("architect explicit design-only intent finishes at sketch; implementation intent records existing authority without fabricating approval", () => {
  for (const intent of ["design-only", "implement"]) {
    const f = fixture("architect", { intent });
    f.gate({ how: "grounded", "rationale-constraints": "unchanged constraints" });
    for (const [i, slot] of ["designs:0", "designs:1"].entries()) { f.admit(slot); f.collect(slot, design("shape " + i)); }
    f.gate({}); f.admit("judge:0"); f.collect("judge:0"); f.gate({});
    f.gate({ "lead-scores": "scores", "judge-comparison": "comparison", "red-flags": "screened" });
    f.gate({ "caller-first-package": "package", rationale: "rationale", "alternatives-grafts-rejections": "record" });
    if (intent === "design-only") assert.equal(f.view().status, "completed");
    else {
      assert.equal(f.view().phase, "implement");
      f.fail({ type: "advance", evidence: { "behavioral-verification": "passed", "deviations-or-none": "none" } }, /implementation-authority/);
      f.gate({ "implementation-authority": "original user request scoped to this implementation", "behavioral-verification": "passed", "deviations-or-none": "none" });
      assert.equal(f.view().status, "completed");
    }
  }
  assert.throws(() => fixture("architect", { intent: "guessed" }), /intent/);
});

test("arena records a terminal dropout but never judges a pending child or zero usable artifacts", () => {
  const f = fixture("arena"); f.gate({ "task-and-isolation": "frozen task", "rubric-3-to-6": "rubric" });
  f.admit("candidates:0", "usable"); f.collect("candidates:0");
  f.admit("candidates:1", "dropout");
  f.fail({ type: "advance", evidence: { dropouts: "not enough: still writing" } }, /pending candidate/);
  f.event({ type: "reject", slot: "candidates:1", runId: "dropout", reason: "Native run terminated without output" });
  f.fail({ type: "advance", evidence: {} }, /dropouts/);
  f.gate({ dropouts: "dropout: terminal failed run; lead inspected no usable output" });
  assert.equal(f.view().phase, "judge");
  const empty = fixture("arena"); empty.gate({ "task-and-isolation": "frozen", "rubric-3-to-6": "rubric" });
  for (const slot of ["candidates:0", "candidates:1"]) {
    empty.admit(slot); empty.event({ type: "reject", slot, runId: empty.view().attempts[slot][0].runId, reason: "terminal failure" });
  }
  empty.fail({ type: "advance", evidence: { dropouts: "both failed" } }, /usable artifact/);
});

test("two copies of one architectural shape do not satisfy alternatives", () => {
  const f = fixture("architect"); f.gate({ how: "grounded", "rationale-constraints": "no layering change" });
  for (const slot of ["designs:0", "designs:1"]) { f.admit(slot); f.collect(slot, design("same shape")); }
  f.fail({ type: "advance", evidence: {} }, /distinct whole-shape/);
  assert.equal(f.view().phase, "designs");
});

test("arena collects two candidates before the cross-judge, and requires independent lead and final artifact verification", () => {
  const f = fixture("arena"); f.gate({ "task-and-isolation": "frozen task", "rubric-3-to-6": "three rubric criteria" });
  for (const slot of ["candidates:0", "candidates:1"]) { f.admit(slot); f.collect(slot); }
  f.gate({}); assert.equal(f.view().jobs[0].role, "arena cross-judge pool");
  f.admit("judge:0"); f.collect("judge:0"); f.gate({});
  f.gate({ "lead-scores": "end-to-end independent scores", "judge-comparison": "compared rationales" });
  f.gate({ "base-and-rejections": "candidate A with rejected B rationale", "grafts-or-convergence": "one graft from B" });
  f.fail({ type: "advance", evidence: { "synthesis-note": "done" } }, /behavioral-verification/);
  f.gate({ "behavioral-verification": "real artifact checks", "synthesis-note": "base/grafts/rejections/limitations" });
  assert.equal(f.view().status, "completed");
});

test("interrogate preserves both independent reviewers and a model-attributed four-bucket verdict", () => {
  const f = fixture("interrogate"); f.gate({ intent: "bounded intent", "frozen-head": "a".repeat(40), rubric: "rubric.md" });
  f.admit("reviewers:0"); f.collect("reviewers:0");
  f.fail({ type: "advance", evidence: {} }, /reviewers:1/);
  f.admit("reviewers:1"); f.collect("reviewers:1"); f.gate({});
  f.fail({ type: "advance", evidence: { "all-findings-four-buckets": "all classified", "source-validation": "checked" } }, /agreement-map/);
  f.gate({ "all-findings-four-buckets": "buckets.md", "model-attributed-agreement-map": "agreement.md", "source-validation": "validation.md" });
  assert.equal(f.view().status, "completed");
});

test("short wait retains accepted IDs; collection may settle during the handoff and resume does not respawn", () => {
  const f = fixture("how"); f.admit("explainer:0", "accepted-original");
  f.fail({ type: "wait", timeoutSeconds: 31 }, /0-30/);
  f.event({ type: "wait", timeoutSeconds: 2 });
  assert.equal(f.view().status, "waiting");
  f.fail({ type: "accept", slot: "explainer:0", runId: "duplicate", childSessionKey: "agent:worker:subagent:duplicate", snapshotId: Object.values(f.view().currentSnapshots)[0] }, /resume/);
  f.collect("explainer:0");
  f.fail({ type: "advance", evidence: {} }, /resume/);
  f.event({ type: "resume" });
  assert.equal(f.view().attempts["explainer:0"][0].runId, "accepted-original");
  f.gate({}); f.gate({ "explanation-sections": "Overview/Key Concepts/How/Where/Gotchas", "light-edits-only": "no substantial rewrite" });
  assert.equal(f.view().status, "completed");
});

test("complex how requires 2-4 independent explorers before one explainer; simple how never adds explorers", () => {
  for (const n of [1, 5]) assert.throws(() => fixture("how", { complexity: "complex", explorers: n }), /2-4/);
  const f = fixture("how", { complexity: "complex", explorers: 3 });
  assert.deepEqual(f.view().jobs.map(j => j.index), [0, 0, 0]);
  for (const slot of ["explorers:0", "explorers:1"]) { f.admit(slot); f.collect(slot); }
  f.fail({ type: "advance", evidence: {} }, /explorers:2/);
  f.admit("explorers:2"); f.collect("explorers:2"); f.gate({});
  assert.deepEqual(f.view().jobs.map(j => j.role), ["how explainer"]);
  assert.deepEqual(fixture("how").view().jobs.map(j => j.role), ["how explainer"]);
});

test("why requires every category, an actual source-control investigator, and a separately admitted synthesizer", () => {
  assert.throws(() => fixture("why", { sources: sources.slice(1) }), /seven/);
  assert.throws(() => fixture("why", { sources: sources.map(s => ({ ...s, disposition: "unavailable" })) }), /Source-control.*BLOCKED/);
  const f = fixture("why"); assert.deepEqual(f.view().jobs.map(j => j.role), ["why investigators"]);
  f.admit("investigators:source-0"); f.collect("investigators:source-0"); f.gate({});
  assert.equal(f.view().jobs[0].role, "why synthesizer");
  f.fail({ type: "advance", evidence: {} }, /synthesizer:0/);
  f.admit("synthesizer:0"); f.collect("synthesizer:0"); f.gate({});
  f.gate({ "five-confidence-tiers": "Direct/Supported/Inferred/Speculative/Unknown", "citations-and-contradictions": "sources.md", "all-seven-categories-and-gaps": "gaps.md", "mechanics-not-intent": "confidence.md" });
  assert.equal(f.view().status, "completed");
});

test("reflect needs all three lenses, a fourth synthesis child, and explicit per-row approval before applying", () => {
  const f = fixture("reflect");
  assert.deepEqual(f.view().jobs.map(j => j.id), ["lenses:judgment", "lenses:tooling", "lenses:divergent"]);
  for (const slot of ["lenses:judgment", "lenses:tooling"]) { f.admit(slot); f.collect(slot); }
  f.fail({ type: "advance", evidence: {} }, /divergent/);
  f.admit("lenses:divergent"); f.collect("lenses:divergent"); f.gate({});
  f.admit("synthesizer:0"); f.collect("synthesizer:0"); f.gate({});
  assert.equal(f.view().status, "awaiting-user");
  f.fail({ type: "advance", evidence: { "accepted-rejected-backlog": "rows.md" } }, /row-by-row/);
  f.gate({ "accepted-rejected-backlog": "full rows.md", "row-by-row-user-decisions": "user-message: accept row 2; reject row 1" });
  f.gate({ "only-approved-rows": "only row 2", "skill-validation-or-no-approved-edits": "validator passed", "backlog-filed-or-explicitly-blocked": "unfiled: no tracker write authority" });
  assert.equal(f.view().status, "completed");
});

test("swarm rejects wrong SHA/method and permits one retry only without losing original custody", () => {
  const f = fixture("swarm"); f.gate({ "predicate-and-coverage": "slice A", "predeclared-race-rule-or-partition": "partitioned" });
  f.admit("workers:slice-a", "first");
  f.fail({ type: "collect", slot: "workers:slice-a", runId: "first", result: { status: "PASS", artifactDigest: digest("bad"), evidence: ["result"], sha: "b".repeat(40), method: "wrong" } }, /SHA.method mismatch/);
  f.event({ type: "reject", slot: "workers:slice-a", runId: "first", reason: "method and head omitted" });
  f.event({ type: "retry", slot: "workers:slice-a", reason: "one allowed retry" });
  f.admit("workers:slice-a", "second"); f.event({ type: "reject", slot: "workers:slice-a", runId: "second", reason: "wrong SHA again" });
  f.fail({ type: "retry", slot: "workers:slice-a", reason: "third try" }, /once/);
  f.fail({ type: "advance", evidence: {} }, /Required collected/);
  f.event({ type: "block", reason: "Coverage gap: slice A failed its required SHA twice" });
  assert.deepEqual(f.view().attempts["workers:slice-a"].map(x => x.runId), ["first", "second"]);
  assert.equal(f.view().status, "blocked");
});

test("valid swarm results need exact source/method and integration verification", () => {
  const f = fixture("swarm"); f.gate({ "predicate-and-coverage": "slice A", "predeclared-race-rule-or-partition": "partitioned" });
  const { sha, method } = setup("swarm").options.slices[0];
  f.admit("workers:slice-a"); f.collect("workers:slice-a", { sha, method });
  f.gate({}); f.gate({ "integration-verification": "integration suite passes", "coverage-and-dropouts": "slice A covered; no dropouts" });
  assert.equal(f.view().status, "completed");
});

test("foreign runs, duplicate admission, invalid output, blocked results and corrupt replay cannot advance a phase", () => {
  const f = fixture("how"); f.admit("explainer:0", "owned");
  f.fail({ type: "accept", slot: "explainer:0", runId: "duplicate", childSessionKey: "agent:worker:subagent:duplicate", snapshotId: "a".repeat(64) }, /already accepted/);
  f.fail({ type: "collect", slot: "explainer:0", runId: "foreign", result: {} }, /pending accepted/);
  f.fail({ type: "collect", slot: "explainer:0", runId: "owned", result: { status: "PASS", artifactDigest: "bad", evidence: [] } }, /digest/);
  f.collect("explainer:0", { status: "BLOCKED" });
  f.fail({ type: "advance", evidence: {} }, /Required collected/);
  const corrupt = structuredClone(f.record()); corrupt.events[0].snapshotId = "b".repeat(64);
  assert.throws(() => workflowView(corrupt), /Snapshot does not match/);
});

test("explicit blockers are not wait handoffs, cancellation is terminal and neither is silently resumed", () => {
  const f = fixture("how"); f.event({ type: "block", reason: "missing authorized reader" });
  f.fail({ type: "resume" }, /blocks need explicit/);
  f.fail({ type: "unblock", evidence: "" }, /clearing evidence/);
  f.event({ type: "unblock", evidence: "reader capability now present" });
  f.event({ type: "cancel", reason: "explicit user stop" });
  f.fail({ type: "resume" }, /terminal/);
});

test("append-only explicit corrections preserve original snapshots and accepted selections, not mutable defaults", () => {
  const catalog = [{ id: "fixture/model-a", thinkingLevels: ["high"], fastModes: [true, false] }, { id: "fixture/model-b", thinkingLevels: ["high"], fastModes: [true, false] }];
  const a = resolveRole({ role: "how explainer", overrides: { model: "fixture/model-a", thinking: "high", fastMode: false }, catalog });
  const f = fixture("how", { complexity: "simple" }, catalog, [a]); f.admit("explainer:0", "already-accepted");
  const corrected = structuredClone(a); corrected.selections[0].model = "fixture/model-b";
  f.event({ type: "supersede", snapshotId: digest(a), snapshot: corrected, catalog, instruction: "explicit user correction: use B for future continuation" });
  assert.deepEqual(f.view().snapshots[digest(a)], a);
  assert.equal(f.view().attempts["explainer:0"][0].snapshotId, digest(a));
  assert.deepEqual(f.view().supersessions, [{ from: digest(a), to: digest(corrected), instruction: "explicit user correction: use B for future continuation" }]);
  f.fail({ type: "supersede", snapshotId: digest(a), snapshot: corrected, catalog, instruction: "stale correction" }, /latest snapshot/);
  const reordered = { ...corrected, role: "why synthesizer" };
  f.fail({ type: "supersede", snapshotId: digest(corrected), snapshot: reordered, catalog, instruction: "swap role" }, /cannot change snapshot/);
});

test("CAS conflicts, stale revisions and event-ID collisions never overwrite the winning record", async () => {
  const rows = new Map();
  let writes = 0;
  const store = {
    async observe(key) { const r = rows.get(key); return { value: structuredClone(r?.value), comparison: r?.revision ?? 0 }; },
    async apply(key, comparison, value) {
      if ((rows.get(key)?.revision ?? 0) !== comparison) return { status: "conflict" };
      writes++; rows.set(key, { value: structuredClone(value), revision: comparison + 1 }); return { status: "applied" };
    },
  };
  const created = await mutateWorkflow(store, owner, "atomic", 0, setup("how"), () => {});
  const e1 = { id: "writer-a", type: "block", reason: "dependency A" }, e2 = { id: "writer-b", type: "cancel", reason: "stop" };
  const results = await Promise.allSettled([mutateWorkflow(store, owner, "atomic", 1, e1, () => {}), mutateWorkflow(store, owner, "atomic", 1, e2, () => {})]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.match(results.find(x => x.status === "rejected").reason.message, /Concurrent/);
  const saved = rows.get(workflowKey(owner, "atomic")).value;
  assert.deepEqual(saved.events, [e1]); assert.equal(writes, 2);
  await mutateWorkflow(store, owner, "atomic", 1, e1, () => {}); assert.equal(writes, 2);
  assert.throws(() => appendEvent(saved, 1, e2), /Stale/);
  assert.deepEqual(appendEvent(saved, 1, e1), saved);
  assert.throws(() => appendEvent(saved, 2, { ...e1, reason: "changed" }), /reused/);
  assert.equal(created.view.revision, 1);
  await assert.rejects(mutateWorkflow(store, owner, "atomic", 0, setup("how"), () => {}), /already exists/);
});

test("authority revoked after an awaited read prevents publication and exact resets/children cannot adopt the ledger", async () => {
  let revoked = false, writes = 0;
  const store = { async observe() { revoked = true; return { value: undefined, comparison: 0 }; }, async apply() { writes++; return { status: "applied" }; } };
  await assert.rejects(mutateWorkflow(store, owner, "revoked", 0, setup("how"), () => { if (revoked) throw Error("revoked"); }), /revoked/);
  assert.equal(writes, 0);
  const record = createWorkflow("private", owner, setup("how"));
  for (const different of [{ ...owner, sessionId: "reset" }, { ...owner, sessionKey: "agent:worker:subagent:child" }, { ...owner, workspace: "/other" }]) {
    assert.throws(() => ownedRecord(record, different, "private"), /owner mismatch/);
    assert.notEqual(workflowKey(different, "private"), workflowKey(owner, "private"));
  }
});

test("tagged spawn rejects model/thinking/fast drift without rewriting and leaves untagged tasks alone", () => {
  const catalog = [{ id: "fixture/model-a", thinkingLevels: ["high"], fastModes: [true] }];
  const snapshot = resolveRole({ role: "how explainer", overrides: { model: "fixture/model-a", thinking: "high", fastMode: true }, catalog });
  const record = createWorkflow("guarded", owner, setup("how", { complexity: "simple" }, catalog, [snapshot]));
  const params = { runtime: "subagent", ...snapshot.selections[0], task: "bounded task\n" + spawnTag(workflowKey(owner, record.id), digest(snapshot), "explainer:0") };
  const tag = parseSpawnTag(params), original = structuredClone(params);
  checkSpawnRecord(record, owner, tag, params); assert.deepEqual(params, original);
  for (const delta of [{ model: "fixture/other" }, { thinking: "low" }, { fastMode: false }, { runtime: "acp" }, { fastMode: undefined }]) {
    const changed = { ...params, ...delta }, before = structuredClone(changed);
    assert.throws(() => checkSpawnRecord(record, owner, tag, changed), /drift|Native subagent/);
    assert.deepEqual(changed, before);
  }
  assert.equal(parseSpawnTag({ task: "ordinary native spawn", model: "different" }), undefined);
  assert.equal(parseSpawnTag({ task: "Explain the PSTACK_SNAPSHOT format without tagging this spawn" }), undefined);
  for (const task of ["[PSTACK_SNAPSHOT:broken", params.task + params.task]) assert.throws(() => parseSpawnTag({ task }), /Malformed/);
  assert.throws(() => checkSpawnRecord(record, { ...owner, sessionId: "reset" }, tag, params), /owner mismatch/);
  assert.throws(() => checkSpawnRecord(undefined, owner, tag, params), /Unknown pstack/);
});

test("inherited controls cannot be overridden and accepted or superseded snapshot slots cannot spawn again", () => {
  const f = fixture("how"), snapshotId = f.view().currentSnapshots["how explainer"];
  const params = { runtime: "subagent", task: spawnTag(workflowKey(owner, "task-one"), snapshotId, "explainer:0") }, tag = parseSpawnTag(params);
  assert.throws(() => checkSpawnRecord(f.record(), owner, tag, { ...params, fastMode: false }), /fastMode/);
  f.admit("explainer:0");
  assert.throws(() => checkSpawnRecord(f.record(), owner, tag, params), /unaccepted slot/);
});


test("finite ledger budgets preserve original history and refuse publication instead of truncating required gates", async () => {
  const record = createWorkflow("bounded", owner, setup("how"));
  record.events = Array.from({ length: 256 }, (_, n) => ({ id: "hold-" + n, type: "block", reason: "documented dependency" }));
  assert.equal(workflowView(record).revision, 257);
  const before = structuredClone(record);
  assert.throws(() => appendEvent(record, 257, { id: "overflow", type: "unblock", evidence: "dependency cleared" }), /event budget/);
  assert.deepEqual(record, before);
  const large = createWorkflow("large", owner, setup("how"));
  large.events = Array.from({ length: 130 }, (_, n) => ({ id: "hold-" + n, type: "block", reason: "x".repeat(4096) }));
  let writes = 0;
  const store = { async observe() { return { value: large, comparison: 1 }; }, async apply() { writes++; return { status: "applied" }; } };
  await assert.rejects(mutateWorkflow(store, owner, "large", 131, { id: "clear", type: "unblock", evidence: "cleared" }, () => {}), /size budget/);
  assert.equal(writes, 0); assert.equal(large.events.length, 130);
});

test("panel collection enforces the role output contract and leaves a rejected collect pending for a corrected one", () => {
  const f = fixture("arena"); f.gate({ "task-and-isolation": "frozen", "rubric-3-to-6": "rubric" });
  f.admit("candidates:0", "A");
  f.fail(f.result("candidates:0"), /Panel output required for arena runners \(arena-runner\)/);
  f.fail(f.result("candidates:0", { output: { ...arenaOutput(), selfScore: 5 } }), /unexpected field selfScore/);
  f.fail(f.result("candidates:0", { status: "BLOCKED", output: arenaOutput() }), /BLOCKED result carries evidence/);
  assert.equal(f.view().attempts["candidates:0"][0].result, undefined);
  f.collect("candidates:0");
  assert.deepEqual(f.view().attempts["candidates:0"][0].result.output, arenaOutput());
  const how = fixture("how"); how.admit("explainer:0");
  how.fail(how.result("explainer:0", { output: arenaOutput() }), /No output contract for role how explainer/);
});

test("the arena judge must score exactly the usable candidates, excluding recorded dropouts", () => {
  const f = fixture("arena"); f.gate({ "task-and-isolation": "frozen", "rubric-3-to-6": "rubric" });
  f.admit("candidates:0", "A"); f.collect("candidates:0");
  f.admit("candidates:1", "B"); f.collect("candidates:1", { status: "BLOCKED" });
  f.gate({ dropouts: "candidates:1 BLOCKED: no artifact" });
  f.admit("judge:0", "J");
  f.fail(f.result("judge:0", { output: judgeOutput(["candidates:0", "candidates:1"]) }), /exactly the usable candidates: candidates:0/);
  const partial = judgeOutput(["candidates:0"]); partial.candidates[0].scores.pop(); partial.rubric.pop();
  f.fail(f.result("judge:0", { output: partial }), /rubric: expected 3-6/);
  f.collect("judge:0", { output: judgeOutput(["candidates:0"]) });
  f.gate({}); assert.equal(f.view().phase, "compare");
});

test("the ledger derives architect shape digests from the reported shape, so relabelled copies cannot pass as alternatives", () => {
  const f = fixture("architect"); f.gate({ how: "grounded", "rationale-constraints": "none" });
  f.admit("designs:0", "A");
  const output = architectOutput("event log");
  // A runner reports only the output; a supplied digest must equal the derived one, and the error names it.
  f.fail(f.result("designs:0", { output, shapeDigest: digest("a different shape") }), new RegExp("omit it \\(the derived value is " + shapeDigest(output) + "\\)"));
  f.collect("designs:0", { output });
  f.admit("designs:1", "B");
  // Key order, package path and prose differ; the shape is the same.
  const relabelled = architectOutput("event log"); relabelled.packagePath = "/task/designs/b/README.md"; relabelled.rationale.problem = "Reworded";
  relabelled.shape = Object.fromEntries(Object.entries(relabelled.shape).reverse());
  f.collect("designs:1", { output: relabelled });
  f.fail({ type: "advance", evidence: {} }, /distinct whole-shape/);
  assert.equal(f.view().phase, "designs");
  const distinct = fixture("architect"); distinct.gate({ how: "grounded", "rationale-constraints": "none" });
  distinct.admit("designs:0", "A"); distinct.collect("designs:0", { output });
  distinct.admit("designs:1", "B"); distinct.collect("designs:1", { output: architectOutput("immutable events"), shapeDigest: shapeDigest(architectOutput("immutable events")) });
  distinct.gate({}); assert.equal(distinct.view().phase, "judge");
  distinct.admit("judge:0", "J");
  distinct.fail(distinct.result("judge:0", { shapeDigest: shapeDigest(output), output: judgeOutput(["designs:0", "designs:1"]) }), /shapeDigest belongs only to a collected architect design/);
});

test("the judge phase names the exact usable candidate labels with their reported artifact paths", () => {
  const f = fixture("arena"); f.gate({ "task-and-isolation": "frozen", "rubric-3-to-6": "rubric" });
  assert.equal(judgeCandidates(f.record()), undefined);
  f.admit("candidates:0", "A"); f.collect("candidates:0", { output: { ...arenaOutput(), artifactPath: "/task/candidates/a/patch.diff" } });
  f.admit("candidates:1", "B"); f.collect("candidates:1", { status: "BLOCKED" });
  assert.equal(judgeCandidates(f.record()), undefined);
  f.gate({ dropouts: "candidates:1 BLOCKED: no artifact" });
  assert.deepEqual(judgeCandidates(f.record()), [{ label: "candidates:0", path: "/task/candidates/a/patch.diff" }]);
  const a = fixture("architect"); a.gate({ how: "grounded", "rationale-constraints": "none" });
  a.admit("designs:0", "A"); a.collect("designs:0", design("message pipeline"));
  a.admit("designs:1", "B"); a.collect("designs:1", design("immutable events"));
  a.gate({});
  assert.deepEqual(judgeCandidates(a.record()), [{ label: "designs:0", path: "/task/designs/message-pipeline/README.md" }, { label: "designs:1", path: "/task/designs/immutable-events/README.md" }]);
  a.admit("judge:0", "J"); a.collect("judge:0"); a.gate({});
  assert.equal(judgeCandidates(a.record()), undefined);
});

test("interrogate reviewer status must agree with the reported findings", () => {
  const f = fixture("interrogate"); f.gate({ intent: "intent", "frozen-head": "a".repeat(40), rubric: "rubric" });
  f.admit("reviewers:0", "A");
  f.fail(f.result("reviewers:0", { output: reviewerOutput([finding("critical")]) }), /PASS cannot carry/);
  f.fail(f.result("reviewers:0", { status: "ISSUES", output: reviewerOutput() }), /ISSUES requires/);
  f.collect("reviewers:0", { status: "ISSUES", output: reviewerOutput([finding("critical")]) });
  f.admit("reviewers:1", "B"); f.collect("reviewers:1", { output: reviewerOutput([finding("nit")]) });
  f.gate({}); assert.equal(f.view().phase, "verdict");
});

// Native (version 2) controller records.
const reviewerCatalog = [{ id: "fixture/model-a", thinkingLevels: ["high"] }, { id: "fixture/model-b", fastModes: [true] }];
function native(kind, options = {}) {
  const base = setup(kind, options);
  const snapshots = kind === "interrogate"
    ? [resolveRole({ role: "interrogate reviewers", catalog: reviewerCatalog, overrides: [{ model: "fixture/model-a", thinking: "high" }, { model: "fixture/model-b", fastMode: true }] })]
    : base.snapshots;
  const task = "Native task for " + kind;
  let record = createWorkflow("native-" + kind, owner, { ...base, catalog: kind === "interrogate" ? reviewerCatalog : base.catalog, snapshots, task, taskDigest: digest(task) }, 2), serial = 0;
  const view = () => workflowView(record);
  const event = (e) => { record = appendEvent(record, view().revision, { id: "n-" + ++serial, ...e }); return view(); };
  const fail = (e, pattern) => assert.throws(() => appendEvent(record, view().revision, { id: "nbad-" + ++serial, ...e }), pattern);
  const snapshotId = (slot) => view().currentSnapshots[view().jobs.find(j => j.id === slot).role];
  return { view, event, fail, snapshotId, record: () => record };
}
const receipt = (resolved) => ({ requested: {}, resolved });
const reviewerResult = { status: "PASS", artifactDigest: digest("review"), evidence: ["report.md#1"], report: "No defects.", output: reviewerOutput() };

test("native records admit a child only through its own dispatch and collect it only with confirming host receipts", () => {
  const f = native("interrogate");
  assert.equal(f.view().assurance, "deterministic"); assert.equal(f.view().executor, "native");
  f.event({ type: "advance", evidence: { intent: "i", "frozen-head": "a".repeat(40), rubric: "r" } });
  const sid = f.snapshotId("reviewers:0");
  f.fail({ type: "accept", slot: "reviewers:0", runId: "r0", childSessionKey: "agent:worker:subagent:r0", snapshotId: sid, requestId: "q0" }, /own pending dispatch/);
  f.event({ type: "dispatch", slot: "reviewers:0", requestId: "q0", snapshotId: sid });
  f.fail({ type: "dispatch", slot: "reviewers:0", requestId: "q0b", snapshotId: sid }, /pending dispatch/);
  f.fail({ type: "advance", evidence: {} }, /pending native dispatch/);
  f.fail({ type: "accept", slot: "reviewers:0", runId: "r0", childSessionKey: "agent:worker:subagent:r0", snapshotId: sid, requestId: "other" }, /own pending dispatch/);
  f.event({ type: "accept", slot: "reviewers:0", runId: "r0", childSessionKey: "agent:worker:subagent:r0", snapshotId: sid, requestId: "q0", selection: { requested: { model: "fixture/model-a", thinking: "high" }, resolved: { model: "fixture/model-a" } } });
  // Thinking was requested but no receipt reports it, and a mismatching observation never passes.
  f.fail({ type: "collect", slot: "reviewers:0", runId: "r0", result: reviewerResult }, /Selection unverified.*thinking/);
  f.fail({ type: "collect", slot: "reviewers:0", runId: "r0", result: reviewerResult, selection: { requested: {}, resolved: { model: "fixture/model-a", thinking: "high" }, observed: { thinking: "low" } } }, /Selection mismatch/);
  f.fail({ type: "collect", slot: "reviewers:0", runId: "r0", result: { ...reviewerResult, report: "" }, selection: receipt({ thinking: "high" }) }, /child report/);
  f.event({ type: "collect", slot: "reviewers:0", runId: "r0", result: reviewerResult, selection: receipt({ model: "fixture/model-a", thinking: "high" }) });
  assert.equal(f.view().attempts["reviewers:0"][0].receipts.length, 2);
  f.event({ type: "dispatch", slot: "reviewers:1", requestId: "q1", snapshotId: sid });
  f.fail({ type: "abandon", slot: "reviewers:1", requestId: "wrong", reason: "x" }, /pending dispatch can be abandoned/);
  f.event({ type: "abandon", slot: "reviewers:1", requestId: "q1", reason: "host lists no child" });
  f.fail({ type: "dispatch", slot: "reviewers:1", requestId: "q0", snapshotId: sid }, /already used/);
  f.event({ type: "dispatch", slot: "reviewers:1", requestId: "q1-2", snapshotId: sid });
  f.event({ type: "accept", slot: "reviewers:1", runId: "r1", childSessionKey: "agent:worker:subagent:r1", snapshotId: sid, requestId: "q1-2", selection: { requested: {}, resolved: { model: "fixture/model-b", fastMode: true } } });
  f.event({ type: "collect", slot: "reviewers:1", runId: "r1", result: reviewerResult });
  f.event({ type: "advance", evidence: {} });
  assert.deepEqual(f.view().evidenceSource, { frame: "agent-attested", reviewers: "controller" });
  f.fail({ type: "supersede", snapshotId: sid, snapshot: resolveRole({ role: "interrogate reviewers", catalog: [] }), catalog: [], instruction: "x" }, /Native workflows keep their admitted routing/);
});

test("agent-attested records refuse every native-only transition and never carry a stored task or child report", () => {
  const f = fixture("how");
  for (const e of [{ type: "dispatch", slot: "explainer:0", requestId: "q", snapshotId: "a".repeat(64) }, { type: "configure", options: {} },
    { type: "decide", decision: "approve", by: "user" }, { type: "abandon", slot: "explainer:0", requestId: "q", reason: "x" },
    { type: "schedule", jobId: "j", requestId: "r", atMs: 1, deadlineAtMs: 2, maxRuns: 1, survivesRestart: true, instance: "i" }])
    f.fail(e, /Only native controller records/);
  f.admit("explainer:0");
  f.fail(f.result("explainer:0", { report: "text" }), /Invalid result/);
  assert.throws(() => createWorkflow("v1-task", owner, { ...setup("how"), task: "x" }), /Invalid setup/);
  assert.throws(() => createWorkflow("v2-digest", owner, { ...setup("how"), task: "changed" }, 2), /task digest mismatch/);
});

test("a native approval stage moves only through an authenticated decision, and revise returns to the parent checkpoint", () => {
  const f = native("architect", { intent: "checkpoint" });
  const run = (slot, output) => {
    const sid = f.snapshotId(slot);
    f.event({ type: "dispatch", slot, requestId: "q-" + slot, snapshotId: sid });
    f.event({ type: "accept", slot, runId: "r-" + slot, childSessionKey: "agent:worker:subagent:" + slot.replace(":", "-"), snapshotId: sid, requestId: "q-" + slot });
    f.event({ type: "collect", slot, runId: "r-" + slot, result: { status: "PASS", artifactDigest: digest(slot), evidence: ["e"], report: "r", output } });
  };
  f.event({ type: "advance", evidence: { how: "h", "rationale-constraints": "c" } });
  run("designs:0", architectOutput("pipeline")); run("designs:1", architectOutput("events")); f.event({ type: "advance", evidence: {} });
  run("judge:0", judgeOutput(["designs:0", "designs:1"])); f.event({ type: "advance", evidence: {} });
  f.event({ type: "advance", evidence: { "lead-scores": "s", "judge-comparison": "c", "red-flags": "r" } });
  f.fail({ type: "decide", decision: "approve", by: "operator" }, /awaiting-user approval stage/);
  f.event({ type: "advance", evidence: { "caller-first-package": "p", rationale: "r", "alternatives-grafts-rejections": "a" } });
  assert.equal(f.view().status, "awaiting-user");
  f.fail({ type: "advance", evidence: { "user-decision": "agent says yes" } }, /authenticated \/pstack resume decision/);
  f.fail({ type: "decide", decision: "revise", by: "operator" }, /user's notes/);
  f.event({ type: "decide", decision: "revise", by: "operator", notes: "use events" });
  assert.equal(f.view().phase, "synthesis");
  f.event({ type: "advance", evidence: { "caller-first-package": "p2", rationale: "r2", "alternatives-grafts-rejections": "a2" } });
  f.event({ type: "decide", decision: "approve", by: "operator" });
  assert.deepEqual(f.view().evidence.agree, { "user-decision": "Approved by authenticated command sender operator as presented" });
  assert.equal(f.view().phase, "implement");
  const reflect = native("reflect");
  assert.equal(reflect.view().stageKind, "jobs");
});

test("native swarm and why defer their framing options to one configure event before the first advance", () => {
  const swarm = native("swarm", { slices: undefined });
  assert.equal(swarm.view().needsConfigure, true);
  swarm.fail({ type: "advance", evidence: { "predicate-and-coverage": "p", "predeclared-race-rule-or-partition": "r" } }, /Configure the deferred slices/);
  swarm.fail({ type: "configure", options: { slices: [{ id: "BAD", sha: "x", method: "m" }] } }, /slice identity/);
  swarm.event({ type: "configure", options: { slices: [{ id: "slice-a", sha: "a".repeat(40), method: "m" }] } });
  swarm.fail({ type: "configure", options: { slices: [{ id: "slice-b", sha: "b".repeat(40), method: "m" }] } }, /once/);
  swarm.event({ type: "advance", evidence: { "predicate-and-coverage": "p", "predeclared-race-rule-or-partition": "r" } });
  assert.deepEqual(swarm.view().jobs.map(j => j.id), ["workers:slice-a"]);
  const why = native("why", { sources: undefined });
  assert.equal(why.view().stageKind, "jobs"); assert.deepEqual(why.view().jobs, []);
  why.fail({ type: "advance", evidence: {} }, /Configure the deferred sources/);
  why.fail({ type: "configure", options: { slices: [] } }, /configured options/);
  why.event({ type: "configure", options: { sources } });
  assert.deepEqual(why.view().jobs.map(j => j.id), ["investigators:source-0"]);
  assert.throws(() => createWorkflow("v1-deferred", owner, setup("swarm", { slices: undefined })), /1-64 bounded slices/);
});

test("schedule receipts are validated, recorded once and allowed in any non-terminal state", () => {
  const f = native("interrogate");
  const s = { jobId: "job-1", requestId: "resume-1", atMs: 1000, deadlineAtMs: 2000, maxRuns: 1, survivesRestart: false, instance: "pid:1:a" };
  f.fail({ type: "schedule", ...s, deadlineAtMs: 1000 }, /Invalid schedule receipt/);
  f.event({ type: "block", reason: "waiting on something" });
  f.event({ type: "schedule", ...s });
  f.fail({ type: "schedule", ...s, requestId: "resume-2" }, /already recorded/);
  assert.deepEqual(f.view().schedules, [s]);
  f.event({ type: "cancel", reason: "stop" });
  f.fail({ type: "schedule", ...s, jobId: "job-2", requestId: "resume-3" }, /terminal/);
});

test("a native record's profile pins bind every dispatch of a pinned role and nothing else", () => {
  const pin = { id: "panel-reviewer", instructionsSha256: digest("panel reviewer bytes") };
  const base = setup("interrogate", {}, reviewerCatalog, [resolveRole({ role: "interrogate reviewers", catalog: reviewerCatalog, overrides: [{ model: "fixture/model-a" }, { model: "fixture/model-b" }] })]);
  const task = "Pinned review";
  let record = createWorkflow("pinned", owner, { ...base, task, taskDigest: digest(task), profiles: { "interrogate reviewers": pin } }, 2), n = 0;
  const view = () => workflowView(record);
  const event = (e) => { record = appendEvent(record, view().revision, { id: "p-" + ++n, ...e }); return view(); };
  const fail = (e, pattern) => assert.throws(() => appendEvent(record, view().revision, { id: "pbad-" + ++n, ...e }), pattern);
  // panel-reviewer keeps the shell, so its label says read-only shell use stays prompt-enforced.
  assert.deepEqual(view().enforcement, { "interrogate reviewers": "host-profile-shell" });
  event({ type: "advance", evidence: { intent: "i", "frozen-head": "a".repeat(40), rubric: "r" } });
  const sid = view().currentSnapshots["interrogate reviewers"];
  fail({ type: "dispatch", slot: "reviewers:0", requestId: "q0", snapshotId: sid }, /pinned host profile/);
  fail({ type: "dispatch", slot: "reviewers:0", requestId: "q0", snapshotId: sid, profile: { ...pin, instructionsSha256: digest("edited bytes") } }, /pinned host profile/);
  fail({ type: "dispatch", slot: "reviewers:0", requestId: "q0", snapshotId: sid, profile: { id: "Panel Reviewer", instructionsSha256: pin.instructionsSha256 } }, /Invalid profile id/);
  event({ type: "dispatch", slot: "reviewers:0", requestId: "q0", snapshotId: sid, profile: pin });
  event({ type: "accept", slot: "reviewers:0", runId: "r0", childSessionKey: "agent:worker:subagent:r0", snapshotId: sid, requestId: "q0" });
  assert.deepEqual(view().attempts["reviewers:0"][0].profile, pin);
  // Pins are validated at creation: only roles this workflow spawns, only well-formed digests.
  assert.throws(() => createWorkflow("bad-role", owner, { ...base, task, taskDigest: digest(task), profiles: { "arena runners": pin } }, 2), /does not spawn/);
  assert.throws(() => createWorkflow("bad-sha", owner, { ...base, task, taskDigest: digest(task), profiles: { "interrogate reviewers": { id: pin.id, instructionsSha256: "x" } } }, 2), /profile instructions digest/);
  assert.throws(() => createWorkflow("v1-pin", owner, { ...base, profiles: { "interrogate reviewers": pin } }), /Invalid setup/);
  // An unpinned native record never claims a profile.
  const plain = native("interrogate");
  plain.event({ type: "advance", evidence: { intent: "i", "frozen-head": "a".repeat(40), rubric: "r" } });
  plain.fail({ type: "dispatch", slot: "reviewers:0", requestId: "q", snapshotId: plain.snapshotId("reviewers:0"), profile: pin }, /pinned host profile/);
  assert.deepEqual(plain.view().enforcement, { "interrogate reviewers": "prompt" });
});

test("tiered ledger budgets: progress stops first, then a block still fits, then a cancel still fits", () => {
  // Event tier: a native record full of real schedule receipts.
  const f = native("interrogate");
  const full = structuredClone(f.record());
  full.events = Array.from({ length: LEDGER_BUDGET.progress.events }, (_, n) => ({ id: "s-" + n, type: "schedule", jobId: "job-" + n, requestId: "resume-" + n, atMs: 1000 + n, deadlineAtMs: 2000 + n, maxRuns: 1, survivesRestart: true, instance: "pid:1:a" }));
  let revision = workflowView(full).revision, record = full;
  assert.throws(() => appendEvent(record, revision, { id: "more", type: "schedule", jobId: "j", requestId: "r", atMs: 1, deadlineAtMs: 2, maxRuns: 1, survivesRestart: true, instance: "i" }),
    (error) => error instanceof LedgerBudgetError && /event budget reached \(248 events\); history is preserved and block and cancel still fit/.test(error.message));
  for (let n = LEDGER_BUDGET.progress.events; n < LEDGER_BUDGET.block.events; n++) { record = appendEvent(record, revision, { id: "b-" + n, type: "block", reason: "held " + n }); revision++; }
  assert.throws(() => appendEvent(record, revision, { id: "b-last", type: "block", reason: "one too many" }), /event budget reached \(255 events\); history is preserved and cancel still fit/);
  record = appendEvent(record, revision, { id: "stop", type: "cancel", reason: "full ledger" });
  assert.equal(workflowView(record).status, "cancelled");
  assert.equal(record.events.length, LEDGER_BUDGET.cancel.events);
  // Size tier: an agent-attested record filled with maximal block reasons.
  const big = createWorkflow("bytes", owner, setup("how"));
  let bytes = big, rev = 1;
  while (Buffer.byteLength(JSON.stringify(bytes)) < LEDGER_BUDGET.progress.bytes - 4200) { bytes = appendEvent(bytes, rev, { id: "x-" + rev, type: "block", reason: "x".repeat(4096) }); rev++; }
  bytes = appendEvent(bytes, rev, { id: "x-" + rev, type: "block", reason: "x".repeat(4096) }); rev++;
  assert.ok(Buffer.byteLength(JSON.stringify(bytes)) > LEDGER_BUDGET.progress.bytes - 100);
  assert.throws(() => appendEvent(bytes, rev, { id: "clear", type: "unblock", evidence: "cleared" }), /size budget reached/);
  while (true) {
    try { bytes = appendEvent(bytes, rev, { id: "y-" + rev, type: "block", reason: "y".repeat(4096) }); rev++; }
    catch (error) { assert.ok(error instanceof LedgerBudgetError); assert.match(error.message, /cancel still fit/); break; }
  }
  assert.ok(Buffer.byteLength(JSON.stringify(bytes)) <= LEDGER_BUDGET.block.bytes);
  bytes = appendEvent(bytes, rev, { id: "end", type: "cancel", reason: "c".repeat(4096) });
  assert.ok(Buffer.byteLength(JSON.stringify(bytes)) <= LEDGER_BUDGET.cancel.bytes);
  assert.equal(workflowView(bytes).status, "cancelled");
});

test("stages version 2 adds architect grounding and the interrogate lead, ends how, why and interrogate at the delivered child, and leaves earlier records unchanged", () => {
  const v2 = (kind, options, roles) => {
    const task = "Version 2 " + kind;
    return createWorkflow("v2-" + kind, owner, { ...setup(kind, options), snapshots: roles.map(role => resolveRole({ role, catalog: [] })), task, taskDigest: digest(task), stagesVersion: 2 }, 2);
  };
  const shape = (record) => workflowStages(record.setup).map(s => s.name + "/" + s.kind + (s.roles.length ? "/" + s.roles.join("+") : ""));
  assert.deepEqual(shape(v2("architect", { intent: "design-only", grounding: "how-why" }, ["how explainer", "why synthesizer", "architect runners", "arena cross-judge pool"])),
    ["grounding/jobs/how explainer+why synthesizer", "designs/jobs/architect runners", "judge/jobs/arena cross-judge pool", "compare/checkpoint", "synthesis/checkpoint"]);
  assert.deepEqual(shape(v2("architect", { intent: "checkpoint", grounding: "how-only" }, ["how explainer", "architect runners", "arena cross-judge pool"])).slice(0, 2),
    ["grounding/jobs/how explainer", "designs/jobs/architect runners"]);
  assert.deepEqual(shape(v2("architect", { intent: "design-only", grounding: "greenfield" }, ["architect runners", "arena cross-judge pool"]))[0], "ground/checkpoint");
  assert.deepEqual(shape(v2("interrogate", {}, ["interrogate reviewers", "judgment and prose"])), ["frame/checkpoint", "reviewers/jobs/interrogate reviewers", "lead/jobs/judgment and prose"]);
  assert.deepEqual(shape(v2("how", { complexity: "simple" }, ["how explainer"])), ["explainer/jobs/how explainer"]);
  assert.deepEqual(shape(v2("why", { sources }, ["why investigators", "why synthesizer"])), ["investigators/jobs/why investigators", "synthesizer/jobs/why synthesizer"]);
  // Records admitted before version 2 keep their parent checkpoints.
  assert.deepEqual(shape(native("interrogate").record()).at(-1), "verdict/checkpoint");
  assert.deepEqual(shape(native("how").record()).at(-1), "present/checkpoint");
  assert.deepEqual(shape(native("architect", { intent: "checkpoint" }).record())[0], "ground/checkpoint");
  // The version is native-only, exact, and decides which options and roles a setup may carry.
  const task = "t", digested = { task, taskDigest: digest(task) };
  assert.throws(() => createWorkflow("v1-version", owner, { ...setup("how"), stagesVersion: 2 }), /Invalid setup/);
  assert.throws(() => createWorkflow("v3", owner, { ...setup("how"), ...digested, stagesVersion: 3 }, 2), /Unsupported native stages version/);
  assert.throws(() => createWorkflow("no-grounding", owner, { ...setup("architect", { intent: "design-only" }), ...digested, stagesVersion: 2 }, 2), /Explicit architect grounding required/);
  assert.throws(() => createWorkflow("legacy-grounding", owner, { ...setup("architect", { intent: "design-only", grounding: "how-only" }), ...digested }, 2), /Options do not belong/);
  assert.throws(() => createWorkflow("missing-lead", owner, { ...setup("interrogate"), ...digested, stagesVersion: 2 }, 2), /Every workflow role needs/);
});

test("a native swarm records a coverage gap only after the slice's one retry, and only beside a usable slice", () => {
  const slice = (id) => ({ id, sha: id[0].repeat(40), method: "commit in the slice worktree " + id });
  const f = native("swarm", { slices: [slice("a-slice"), slice("b-slice")] });
  f.event({ type: "advance", evidence: { "predicate-and-coverage": "p", "predeclared-race-rule-or-partition": "partitioned" } });
  let n = 0;
  const run = (id, status) => {
    const slot = "workers:" + id, sid = f.snapshotId(slot), runId = "r" + ++n;
    f.event({ type: "dispatch", slot, requestId: "q" + n, snapshotId: sid });
    f.event({ type: "accept", slot, runId, childSessionKey: "agent:worker:subagent:" + runId, snapshotId: sid, requestId: "q" + n });
    f.event({ type: "collect", slot, runId, result: { status, artifactDigest: digest(runId), evidence: ["e"], report: status + " report", sha: slice(id).sha, method: slice(id).method } });
  };
  run("a-slice", "PASS"); run("b-slice", "BLOCKED");
  f.fail({ type: "advance", evidence: { "coverage-gaps": "workers:b-slice blocked" } }, /retry the slice once before recording a coverage gap/);
  f.event({ type: "retry", slot: "workers:b-slice", reason: "write scope named" });
  run("b-slice", "BLOCKED");
  f.fail({ type: "advance", evidence: {} }, /Invalid swarm coverage gaps/);
  f.fail({ type: "advance", evidence: { "integration-verification": "x" } }, /Invalid phase evidence/);
  f.event({ type: "advance", evidence: { "coverage-gaps": "workers:b-slice failed its one retry" } });
  assert.equal(f.view().phase, "aggregate");
  assert.deepEqual(f.view().evidence.workers, { "coverage-gaps": "workers:b-slice failed its one retry" });
  assert.equal(f.view().evidenceSource.workers, "controller");
  // Nothing usable is not a gap to aggregate, and a gap is never claimed without one.
  const none = native("swarm", { slices: [slice("a-slice")] });
  none.event({ type: "advance", evidence: { "predicate-and-coverage": "p", "predeclared-race-rule-or-partition": "partitioned" } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const slot = "workers:a-slice", sid = none.snapshotId(slot), runId = "z" + attempt;
    none.event({ type: "dispatch", slot, requestId: "zq" + attempt, snapshotId: sid });
    none.event({ type: "accept", slot, runId, childSessionKey: "agent:worker:subagent:" + runId, snapshotId: sid, requestId: "zq" + attempt });
    none.event({ type: "reject", slot, runId, reason: "SHA omitted" });
    if (!attempt) none.event({ type: "retry", slot, reason: "once" });
  }
  none.fail({ type: "advance", evidence: { "coverage-gaps": "workers:a-slice" } }, /nothing is left to aggregate/);
  const clean = native("swarm", { slices: [slice("a-slice")] });
  clean.event({ type: "advance", evidence: { "predicate-and-coverage": "p", "predeclared-race-rule-or-partition": "partitioned" } });
  const sid = clean.snapshotId("workers:a-slice");
  clean.event({ type: "dispatch", slot: "workers:a-slice", requestId: "c", snapshotId: sid });
  clean.event({ type: "accept", slot: "workers:a-slice", runId: "c1", childSessionKey: "agent:worker:subagent:c1", snapshotId: sid, requestId: "c" });
  clean.event({ type: "collect", slot: "workers:a-slice", runId: "c1", result: { status: "PASS", artifactDigest: digest("c1"), evidence: ["e"], report: "ok", sha: slice("a-slice").sha, method: slice("a-slice").method } });
  clean.fail({ type: "advance", evidence: { "coverage-gaps": "none really" } }, /No swarm coverage gap to record/);
  // Agent-attested swarm ledgers keep their gates; coverage gaps are a native controller record.
  const attested = fixture("swarm"); attested.gate({ "predicate-and-coverage": "p", "predeclared-race-rule-or-partition": "r" });
  attested.fail({ type: "advance", evidence: { "coverage-gaps": "x" } }, /Invalid phase evidence/);
});

test("an accept may use the block tier, so a child the host already runs is recorded even at the progress limit", () => {
  const f = native("interrogate");
  f.event({ type: "advance", evidence: { intent: "i", "frozen-head": "a".repeat(40), rubric: "r" } });
  const sid = f.snapshotId("reviewers:0");
  f.event({ type: "dispatch", slot: "reviewers:0", requestId: "q0", snapshotId: sid });
  let record = f.record(), revision = workflowView(record).revision;
  while (record.events.length < LEDGER_BUDGET.progress.events) {
    record = appendEvent(record, revision, { id: "s-" + revision, type: "schedule", jobId: "job-" + revision, requestId: "resume-" + revision, atMs: 1000, deadlineAtMs: 2000, maxRuns: 1, survivesRestart: true, instance: "pid:1:a" });
    revision++;
  }
  record = appendEvent(record, revision, { id: "accept", type: "accept", slot: "reviewers:0", runId: "r0", childSessionKey: "agent:worker:subagent:r0", snapshotId: sid, requestId: "q0" });
  revision++;
  assert.equal(workflowView(record).attempts["reviewers:0"][0].runId, "r0");
  assert.throws(() => appendEvent(record, revision, { id: "next", type: "dispatch", slot: "reviewers:1", requestId: "q1", snapshotId: sid }),
    (error) => error instanceof LedgerBudgetError && /event budget reached \(249 events\); history is preserved and block and cancel still fit/.test(error.message));
  record = appendEvent(record, revision, { id: "held", type: "block", reason: "ledger full" }); revision++;
  record = appendEvent(record, revision, { id: "stop", type: "cancel", reason: "replace" });
  assert.equal(workflowView(record).status, "cancelled");
});

test("H-2: panels and pools report different-family only when both families are known and differ", () => {
  const catalog = [{ id: "fixture/claude-a", family: "anthropic" }, { id: "fixture/gpt-b", family: "openai" }, { id: "fixture/claude-c", family: "anthropic" }, { id: "fixture/unknown-d" }];
  const panel = (a, b, extra = {}) => resolveRole({ role: "interrogate reviewers", catalog, overrides: [a, b].map(model => model ? { model } : "inherit"), ...extra });
  const pool = (a, b, extra = {}) => resolveRole({ role: "arena cross-judge pool", catalog, overrides: [{ model: a }, { model: b }], ...extra });
  assert.equal(panel("fixture/claude-a", "fixture/gpt-b").diversity, "different-family");
  // Two providers of one developer's models are not diversity, and neither is one model twice.
  assert.equal(panel("fixture/claude-a", "fixture/claude-c").diversity, "not-established");
  assert.equal(panel("fixture/claude-a", "fixture/claude-a").diversity, "not-established");
  // An absent family is unknown, never different.
  assert.equal(panel("fixture/claude-a", "fixture/unknown-d").diversity, "unverified");
  assert.equal(resolveRole({ role: "interrogate reviewers", catalog: null, overrides: [{ model: "fixture/claude-a" }, { model: "fixture/gpt-b" }] }).diversity, "unverified");
  // An inherited entry runs the parent's model, so it has the parent's family when that is known.
  assert.equal(panel(undefined, "fixture/gpt-b", { parentModel: "fixture/claude-a" }).diversity, "different-family");
  assert.equal(panel(undefined, "fixture/gpt-b").diversity, "unverified");
  assert.equal(panel(undefined, undefined).diversity, "not-established");
  // Pools compare each entry with the parent and pick the first proven different one.
  assert.deepEqual(pool("fixture/unknown-d", "fixture/gpt-b", { parentModel: "fixture/claude-a" }), { version: 1, role: "arena cross-judge pool", source: "override", selections: [{ model: "fixture/gpt-b" }], poolIndex: 1, diversity: "different-family" });
  assert.equal(pool("fixture/unknown-d", "fixture/claude-c", { parentModel: "fixture/claude-a" }).diversity, "unverified");
  assert.equal(pool("fixture/claude-c", "fixture/claude-a", { parentModel: "fixture/claude-a" }).diversity, "not-established");
  assert.equal(pool("fixture/gpt-b", "fixture/claude-c", { parentModel: "fixture/unknown-d" }).diversity, "unverified");
  // Snapshots recorded before panels were compared stay valid; a single role never claims diversity.
  const legacy = { ...panel("fixture/claude-a", "fixture/gpt-b"), diversity: "not-applicable" };
  assert.deepEqual(validateSnapshot(legacy, catalog), legacy);
  assert.throws(() => validateSnapshot({ ...resolveRole({ role: "bug-fix", catalog, overrides: { model: "fixture/gpt-b" } }), diversity: "different-family" }, catalog), /Invalid snapshot diversity/);
});

test("1.2.3: lead-first arena and architect records put the lead's scores before the judge, and earlier records keep their stages", () => {
  const v2 = (kind, options, roles, extra = {}) => {
    const task = "Lead-first " + kind;
    return createWorkflow("lf-" + kind, owner, { ...setup(kind, options), snapshots: roles.map(role => resolveRole({ role, catalog: [] })), task, taskDigest: digest(task), stagesVersion: 2, ...extra }, 2);
  };
  const shape = (record) => workflowStages(record.setup).map(s => s.name + "/" + s.kind + (s.gates.length ? "/" + s.gates.join("+") : ""));
  const arena = ["arena runners", "arena cross-judge pool"];
  assert.deepEqual(shape(v2("arena", {}, arena, { leadFirst: true })),
    ["frame/checkpoint/task-and-isolation+rubric-3-to-6", "candidates/jobs", "lead/checkpoint/lead-scores", "judge/jobs", "compare/checkpoint/judge-comparison", "graft/checkpoint/base-and-rejections+grafts-or-convergence", "verify/checkpoint/behavioral-verification+synthesis-note"]);
  assert.deepEqual(shape(v2("arena", {}, arena)).slice(1, 4), ["candidates/jobs", "judge/jobs", "compare/checkpoint/lead-scores+judge-comparison"]);
  assert.deepEqual(shape(v2("architect", { intent: "design-only", grounding: "greenfield" }, ["architect runners", "arena cross-judge pool"], { leadFirst: true })).slice(1, 5),
    ["designs/jobs", "lead/checkpoint/lead-scores", "judge/jobs", "compare/checkpoint/judge-comparison+red-flags"]);
  assert.throws(() => v2("how", { complexity: "simple" }, ["how explainer"], { leadFirst: true }), /leadFirst belongs only/);
  assert.throws(() => v2("arena", {}, arena, { leadFirst: false }), /leadFirst belongs only/);
  assert.throws(() => createWorkflow("v1-lead", owner, { ...setup("arena"), leadFirst: true }), /Invalid setup/);
  // The judge scores the candidates before the lead checkpoint, under their slot labels.
  let record = v2("arena", {}, arena, { leadFirst: true }), n = 0;
  const apply = (e) => { record = appendEvent(record, workflowView(record).revision, { id: "lf-" + ++n, ...e }); return workflowView(record); };
  apply({ type: "advance", evidence: { "task-and-isolation": "t", "rubric-3-to-6": "r" } });
  for (const slot of ["candidates:0", "candidates:1"]) {
    const sid = workflowView(record).currentSnapshots["arena runners"];
    apply({ type: "dispatch", slot, requestId: "q-" + slot, snapshotId: sid });
    apply({ type: "accept", slot, runId: "r-" + slot, childSessionKey: "agent:worker:subagent:" + slot.replace(":", "-"), snapshotId: sid, requestId: "q-" + slot, selection: { requested: {}, resolved: {} } });
    apply({ type: "collect", slot, runId: "r-" + slot, result: { status: "PASS", artifactDigest: digest(slot), evidence: ["e"], report: "r", output: arenaOutput() } });
  }
  apply({ type: "advance", evidence: { dropouts: "none" } });
  assert.equal(workflowView(record).phase, "lead");
  assert.equal(judgeCandidates(record), undefined);
  assert.throws(() => apply({ type: "advance", evidence: { "lead-scores": "candidates:1 4/5" } }), /missing candidates:0/);
  apply({ type: "advance", evidence: { "lead-scores": "candidates:0 4/5; candidates:1 3/5" } });
  assert.deepEqual(judgeCandidates(record).map(c => c.label), ["candidates:0", "candidates:1"]);
});

test("P3-60: the reducer refuses a retry of a passing non-deliverable native child", () => {
  const f = native("interrogate");
  f.event({ type: "advance", evidence: { intent: "i", "frozen-head": "a".repeat(40), rubric: "r" } });
  const sid = f.snapshotId("reviewers:0");
  f.event({ type: "dispatch", slot: "reviewers:0", requestId: "q0", snapshotId: sid });
  f.event({ type: "accept", slot: "reviewers:0", runId: "r0", childSessionKey: "agent:worker:subagent:r0", snapshotId: sid, requestId: "q0", selection: { requested: {}, resolved: { model: "fixture/model-a", thinking: "high" } } });
  f.event({ type: "collect", slot: "reviewers:0", runId: "r0", result: reviewerResult });
  f.fail({ type: "retry", slot: "reviewers:0", reason: "once more" }, /Only a rejected\/blocked swarm slice or native child, or a native deliverable, may retry once/);
  f.event({ type: "dispatch", slot: "reviewers:1", requestId: "q1", snapshotId: sid });
  f.event({ type: "accept", slot: "reviewers:1", runId: "r1", childSessionKey: "agent:worker:subagent:r1", snapshotId: sid, requestId: "q1", selection: { requested: {}, resolved: { model: "fixture/model-b", fastMode: true } } });
  f.event({ type: "reject", slot: "reviewers:1", runId: "r1", reason: "No structured result" });
  f.event({ type: "retry", slot: "reviewers:1", reason: "once" });
  assert.deepEqual(Object.keys(f.view().corrections), ["reviewers:1"]);
});

