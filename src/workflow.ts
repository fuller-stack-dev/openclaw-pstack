import { createHash } from "node:crypto";
import { validateSnapshot } from "../skills/pstack/scripts/model-routing.mjs";
import { contractFor, assertOutput, profileKeepsShell, assertProofContext } from "../skills/pstack/scripts/output-contracts.mjs";

import { interrogateSemantics } from "../skills/pstack/scripts/interrogate-semantics.mjs";

export const KINDS = ["architect", "arena", "interrogate", "swarm", "how", "why", "reflect"] as const;
export type Kind = (typeof KINDS)[number];
export type Owner = { sessionKey: string; sessionId: string; workspace: string };
export type Selection = { model?: string; thinking?: string; fastMode?: boolean | "auto" | "ultrafast" };
/** Host-recorded control facts from a native spawn/collect receipt; absent fields are unknown. */
export type Receipt = { requested: Selection; resolved?: Selection; observed?: Selection };
export type Snapshot = { version: number; role: string; source: string; selections: Selection[]; poolIndex: number | null; diversity: string };
export type Catalog = { id: string; family?: string; thinkingLevels?: unknown[]; fastModes?: unknown[] }[];
export type Source = { id: string; category: string; disposition: "available" | "unavailable" | "irrelevant"; reason: string };
export type Slice = { id: string; sha: string; method: string };
export type Options = {
  intent?: "design-only" | "checkpoint" | "implement"; complexity?: "simple" | "complex"; explorers?: number; slices?: Slice[]; sources?: Source[];
  /** Native architect (stages version 2): independent how/why children, how only, or a parent-justified greenfield checkpoint. */
  grounding?: "how-why" | "how-only" | "greenfield";
};
/** A host subagent profile pinned for a role: its local id and the instructions digest. */
export type ProfilePin = { id: string; instructionsSha256: string };
/**
 * `task`, `profiles` and `stagesVersion` are stored only by the native controller: it writes
 * later child briefs from the task, every child of a pinned role must spawn under that profile,
 * and records created before version 2 keep the stage sequence they were admitted with.
 */
export type Setup = { kind: Kind; taskDigest: string; sourceDigest: string; snapshots: Snapshot[]; catalog: Catalog; options: Options; task?: string; profiles?: Record<string, ProfilePin>; stagesVersion?: 2; correction?: Correction; leadFirst?: true; executedProof?: true; parentJudge?: true };
/**
 * Native arena and architect records from 1.2.3 (`leadFirst`): the lead records its own scores in a
 * `lead` checkpoint before the controller spawns the judge, so the judge's scores cannot shape them.
 * Records created without it keep the stage sequence they were admitted with.
 */
export const LEAD_FIRST_KINDS: readonly Kind[] = ["arena", "architect"];
/**
 * A native record that corrects the delivered result of a completed one: one child for the same
 * slot, under the source's pinned routing snapshot and profile, briefed with the source's
 * inputs, the delivered report and the errors found in it.
 */
export type Correction = { workflowId: string; slot: string; runId: string; artifactDigest: string; report: string; errors: string; by: string; proofContext?: { frozen: unknown; reviewers: { slot: string; artifactDigest: string; output: unknown }[] } };
/** The slot whose report a native workflow delivers verbatim, by kind and stages version. */
export const CORRECTABLE: Partial<Record<Kind, { slot: string; role: string }>> = {
  how: { slot: "explainer:0", role: "how explainer" }, why: { slot: "synthesizer:0", role: "why synthesizer" }, interrogate: { slot: "lead:0", role: "judgment and prose" },
};
/**
 * The child whose collected report the controller delivers verbatim: reflect's synthesizer at
 * approval, and the final child of version-2 how, why and interrogate (or of their correction).
 */
export function deliverableSlotOf(s: Setup): string | undefined {
  if (s.correction) return s.correction.slot;
  if (s.kind === "reflect") return "synthesizer:0";
  return s.stagesVersion === 2 ? CORRECTABLE[s.kind]?.slot : undefined;
}
export type Result = {
  status: "PASS" | "ISSUES" | "BLOCKED"; artifactDigest: string; evidence: string[];
  shapeDigest?: string; sha?: string; method?: string; output?: unknown;
  /** Native records only: the child's own report text, kept for the parent's checkpoint work. */
  report?: string;
};
/** New native comparisons bind the lead scorer and judge once, in the lead advance. */
export type JudgeBinding = { parentModel: string; parentFamily: string; snapshot: Snapshot; catalog: Catalog };
export type Event =
  | { id: string; type: "accept"; slot: string; runId: string; childSessionKey: string; snapshotId: string; requestId?: string; selection?: Receipt }
  | { id: string; type: "collect"; slot: string; runId: string; result: Result; selection?: Receipt }
  | { id: string; type: "reject"; slot: string; runId: string; reason: string; selection?: Receipt }
  | { id: string; type: "retry"; slot: string; reason: string }
  | { id: string; type: "advance"; evidence: Record<string, string>; judge?: JudgeBinding }
  | { id: string; type: "wait"; timeoutSeconds: number }
  | { id: string; type: "resume" }
  | { id: string; type: "block"; reason: string }
  | { id: string; type: "unblock"; evidence: string }
  | { id: string; type: "cancel"; reason: string }
  | { id: string; type: "supersede"; snapshotId: string; snapshot: Snapshot; catalog: Catalog; instruction: string }
  // Native (version 2) records only.
  | { id: string; type: "dispatch"; slot: string; requestId: string; snapshotId: string; profile?: ProfilePin; by?: string }
  | { id: string; type: "abandon"; slot: string; requestId: string; reason: string }
  | { id: string; type: "configure"; options: Options }
  | { id: string; type: "schedule"; jobId: string; requestId: string; atMs: number; deadlineAtMs: number; maxRuns: number; survivesRestart: boolean; instance: string }
  | { id: string; type: "decide"; decision: "approve" | "revise"; by: string; notes?: string };
/** An event before its id is assigned, per variant. */
export type EventInput = { [T in Event["type"]]: Omit<Extract<Event, { type: T }>, "id"> }[Event["type"]];
/** Version 1 is agent-attested. Version 2 is written by the native command controller. */
export type RecordV1 = { version: 1 | 2; id: string; owner: Owner; setup: Setup; events: Event[] };
type Job = { id: string; role: string; index: number; slice?: Slice };
type Stage = { name: string; jobs: Job[]; gates: string[]; approval?: true };
type Attempt = { runId: string; childSessionKey: string; snapshotId: string; requestId?: string; profile?: ProfilePin; receipts?: Receipt[]; result?: Result; rejected?: string };
export type View = {
  assurance: "agent-attested" | "deterministic"; executor: "agent" | "native"; revision: number; phase: string;
  status: "active" | "waiting" | "awaiting-user" | "blocked" | "completed" | "cancelled";
  jobs: Job[]; gates: string[]; catalog: Catalog; attempts: Record<string, Attempt[]>; evidence: Record<string, Record<string, string>>;
  snapshots: Record<string, Snapshot>; currentSnapshots: Record<string, string>;
  supersessions: { from: string; to: string; instruction: string }[]; blockers: string[]; next: string;
  /** Native records: accepted-not-yet dispatches, the S6 schedules, user decisions and who supplied each stage's evidence. */
  /** `by` is the command sender whose host child list can prove a dispatch was never accepted. */
  dispatches: Record<string, { requestId: string; snapshotId: string; profile?: ProfilePin; by?: string }>;
  /**
   * Per role: tools removed by a pinned host profile; a profile that keeps the shell
   * ("host-profile-shell") still leaves read-only shell use prompt-enforced.
   */
  enforcement: Record<string, "host-profile" | "host-profile-shell" | "prompt">;
  schedules: { jobId: string; requestId: string; atMs: number; deadlineAtMs: number; maxRuns: number; survivesRestart: boolean; instance: string }[];
  decisions: { stage: string; decision: "approve" | "revise"; by: string; notes?: string }[];
  evidenceSource: Record<string, "controller" | "agent-attested" | "user-command">;
  /** Native records: the one correction of a slot, with the errors that caused it and the failed run. */
  corrections: Record<string, { reason: string; runId: string }>;
  stageKind: "jobs" | "checkpoint" | "approval" | "none"; options: Options; needsConfigure: boolean; judge?: JudgeBinding;
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
export function digest(v: unknown): string {
  const stable = (x: unknown): unknown => Array.isArray(x) ? x.map(stable) : x && typeof x === "object"
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)])) : x;
  return createHash("sha256").update(JSON.stringify(stable(v))).digest("hex");
}
export function text(v: unknown, label: string, max = 4096): asserts v is string {
  if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\u0000")) throw Error("Invalid " + label);
}
function fields(v: unknown, names: string[], label: string): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !names.includes(k))) throw Error("Invalid " + label);
}
function sha(v: unknown, label: string): asserts v is string {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) throw Error("Invalid " + label + " digest");
}
export function validateOwner(v: Owner) {
  fields(v, ["sessionKey", "sessionId", "workspace"], "owner");
  for (const k of ["sessionKey", "sessionId", "workspace"] as const) text(v[k], k);
  if (!/^agent:[^:]+:.+/.test(v.sessionKey) || !v.workspace.startsWith("/")) throw Error("Exact native owner required");
}
const CATEGORIES = ["source-control", "issues", "documents", "chat", "observability", "errors", "analytics"];
const CONTROLS = ["model", "thinking", "fastMode"] as const;
/** Options a native workflow may receive at its framing step, after create. */
const DEFERRED: Partial<Record<Kind, "slices" | "sources">> = { swarm: "slices", why: "sources" };
/**
 * Stages version 2 (native records from 1.1) adds the independent architect grounding and
 * interrogate lead children and ends how, why and interrogate with the child whose result the
 * controller delivers verbatim, instead of a parent rewrite checkpoint.
 */
function stages(s: Setup): Stage[] {
  const checkpoint = (name: string, ...gates: string[]): Stage => ({ name, gates, jobs: [] });
  const jobs = (name: string, role: string, count: number): Stage => ({ name, gates: [], jobs: Array.from({ length: count }, (_, i) => ({ id: name + ":" + i, role, index: ["architect runners", "arena runners", "interrogate reviewers"].includes(role) ? i : 0 })) });
  const v2 = s.stagesVersion === 2;
  if (s.correction) {
    const { slot, role } = CORRECTABLE[s.kind] ?? { slot: s.correction.slot, role: "" };
    return [{ name: slot.split(":")[0]!, gates: [], jobs: [{ id: slot, role, index: 0 }] }];
  }
  switch (s.kind) {
    case "architect": return [
      ...(v2 && s.options.grounding !== "greenfield"
        ? [{ name: "grounding", gates: [], jobs: [{ id: "grounding:how", role: "how explainer", index: 0 }, ...(s.options.grounding === "how-only" ? [] : [{ id: "grounding:why", role: "why synthesizer", index: 0 }])] }]
        : [checkpoint("ground", "how", "rationale-constraints")]),
      jobs("designs", "architect runners", 2), ...(s.leadFirst ? [checkpoint("lead", "lead-scores")] : []), jobs("judge", "arena cross-judge pool", 1), s.leadFirst ? checkpoint("compare", "judge-comparison", "red-flags") : checkpoint("compare", "lead-scores", "judge-comparison", "red-flags"), checkpoint("synthesis", "caller-first-package", "rationale", "alternatives-grafts-rejections"), ...(s.options.intent === "checkpoint" ? [{ ...checkpoint("agree", "user-decision"), approval: true as const }] : []), ...(s.options.intent !== "design-only" ? [checkpoint("implement", "implementation-authority", "behavioral-verification", "deviations-or-none")] : [])];
    case "arena": return [checkpoint("frame", "task-and-isolation", "rubric-3-to-6"), jobs("candidates", "arena runners", 2), ...(s.leadFirst ? [checkpoint("lead", "lead-scores")] : []), jobs("judge", "arena cross-judge pool", 1), s.leadFirst ? checkpoint("compare", "judge-comparison") : checkpoint("compare", "lead-scores", "judge-comparison"), checkpoint("graft", "base-and-rejections", "grafts-or-convergence"), checkpoint("verify", "behavioral-verification", "synthesis-note")];
    case "interrogate": return [checkpoint("frame", ...interrogateSemantics(s)!.frame), jobs("reviewers", "interrogate reviewers", 2),
      v2 ? jobs("lead", "judgment and prose", 1) : checkpoint("verdict", ...interrogateSemantics(s)!.verdict)];
    case "swarm": return [checkpoint("frame", "predicate-and-coverage", "predeclared-race-rule-or-partition"), { name: "workers", gates: [], jobs: (s.options.slices ?? []).map(slice => ({ id: "workers:" + slice.id, role: "swarm workers", index: 0, slice })) }, checkpoint("aggregate", "integration-verification", "coverage-and-dropouts")];
    case "how": return [...(s.options.complexity === "complex" ? [jobs("explorers", "how explorer", s.options.explorers!)] : []), jobs("explainer", "how explainer", 1),
      ...(v2 ? [] : [checkpoint("present", "explanation-sections", "light-edits-only")])];
    case "why": return [{ name: "investigators", gates: [], jobs: (s.options.sources ?? []).filter(x => x.disposition === "available").map(source => ({ id: "investigators:" + source.id, role: "why investigators", index: 0 })) }, jobs("synthesizer", "why synthesizer", 1),
      ...(v2 ? [] : [checkpoint("present", "five-confidence-tiers", "citations-and-contradictions", "all-seven-categories-and-gaps", "mechanics-not-intent")])];
    case "reflect": return [{ name: "lenses", gates: [], jobs: ["judgment", "tooling", "divergent"].map((name) => ({ id: "lenses:" + name, role: name === "tooling" ? "reflect tooling" : "reflect judgment, divergent, synthesizer", index: 0 })) }, jobs("synthesizer", "reflect judgment, divergent, synthesizer", 1), { ...checkpoint("approval", "accepted-rejected-backlog", "row-by-row-user-decisions"), approval: true }, checkpoint("apply", "only-approved-rows", "skill-validation-or-no-approved-edits", "backlog-filed-or-explicitly-blocked")];
  }
}
/** Every checkpoint names at least one gate; a stage without gates is a child (job) stage. */
const stageKind = (stage: Stage | undefined) => !stage ? "none" as const : stage.approval ? "approval" as const : stage.gates.length ? "checkpoint" as const : "jobs" as const;
/** Stage names, kinds, gates and job roles; options still deferred leave a job stage empty. */
export function workflowStages(s: Setup) {
  return stages(s).map(stage => ({ name: stage.name, kind: stageKind(stage), gates: [...stage.gates], roles: [...new Set(stage.jobs.map(j => j.role))] }));
}
function validateSlices(slices: unknown) {
  if (!Array.isArray(slices) || slices.length < 1 || slices.length > 64) throw Error("Swarm needs 1-64 bounded slices");
  const ids = new Set();
  for (const x of slices) {
    fields(x, ["id", "sha", "method"], "slice");
    if (!/^[a-z0-9-]{1,64}$/.test(x.id as string) || ids.has(x.id) || !/^[a-f0-9]{40,64}$/.test(x.sha as string)) throw Error("Invalid slice identity or SHA");
    ids.add(x.id); text(x.method, "measurement method");
  }
}
function validateSources(sources: unknown) {
  if (!Array.isArray(sources) || sources.length < 7 || sources.length > 32) throw Error("Why must account for all seven source categories");
  const ids = new Set();
  for (const source of sources) {
    fields(source, ["id", "category", "disposition", "reason"], "source");
    if (!/^[a-z0-9-]{1,64}$/.test(source.id as string) || ids.has(source.id) || !CATEGORIES.includes(source.category as string) || !["available", "unavailable", "irrelevant"].includes(source.disposition as string)) throw Error("Invalid source disposition");
    ids.add(source.id); text(source.reason, "source access/irrelevance evidence");
  }
  if (CATEGORIES.some(c => !sources.some(x => x.category === c))) throw Error("Why category coverage incomplete");
  if (!sources.some(x => x.category === "source-control" && x.disposition === "available")) throw Error("Source-control investigation BLOCKED; use the documented trivial exception outside this controller");
}
/** Native records may leave swarm slices or why sources to a configure event during framing. */
export function validateSetup(s: Setup, native = false) {
  fields(s, ["kind", "taskDigest", "sourceDigest", "snapshots", "catalog", "options", "executedProof", ...(native ? ["task", "profiles", "stagesVersion", "correction", "leadFirst", "parentJudge"] : [])], "setup");
  if (s.executedProof !== undefined && (s.executedProof !== true || s.kind !== "interrogate")) throw Error("executedProof belongs only to interrogate");
  if (s.stagesVersion !== undefined && s.stagesVersion !== 2) throw Error("Unsupported native stages version");
  if (s.leadFirst !== undefined && (s.leadFirst !== true || s.stagesVersion !== 2 || s.correction || !LEAD_FIRST_KINDS.includes(s.kind))) throw Error("leadFirst belongs only to a version-2 arena or architect record");
  if (s.parentJudge !== undefined && (s.parentJudge !== true || !native || !s.leadFirst || s.stagesVersion !== 2 || s.correction || !LEAD_FIRST_KINDS.includes(s.kind))) throw Error("parentJudge belongs only to a new native lead-first arena or architect record");
  if (s.correction !== undefined) {
    const c = s.correction;
    fields(c, ["workflowId", "slot", "runId", "artifactDigest", "report", "errors", "by", "proofContext"], "correction");
    if (s.stagesVersion !== 2 || !CORRECTABLE[s.kind] || c.slot !== CORRECTABLE[s.kind]!.slot) throw Error("Only a version-2 how, why or interrogate deliverable can be corrected");
    if (typeof c.workflowId !== "string" || !/^pw-[a-z0-9]{12}$/.test(c.workflowId)) throw Error("Invalid corrected workflow id");
    text(c.runId, "corrected run id", 256); sha(c.artifactDigest, "corrected artifact"); text(c.report, "corrected report", 32000);
    if (s.executedProof) assertProofContext(c.proofContext, true);
    else if (c.proofContext !== undefined) throw Error("Legacy correction cannot carry executed proof context");
    text(c.errors, "correction errors", 8000); text(c.by, "correcting requester", 512);
  }
  if (!KINDS.includes(s.kind)) throw Error("Unsupported workflow kind");
  sha(s.taskDigest, "task"); sha(s.sourceDigest, "source");
  if (native) { text(s.task, "native task", 16000); if (digest(s.task) !== s.taskDigest) throw Error("Native task digest mismatch"); }
  fields(s.options, ["intent", "complexity", "explorers", "slices", "sources", "grounding"], "options");
  const allowed = s.kind === "architect" ? ["intent", ...(s.stagesVersion === 2 ? ["grounding"] : [])] : s.kind === "how" ? ["complexity", "explorers"] : s.kind === "swarm" ? ["slices"] : s.kind === "why" ? ["sources"] : [];
  if (Object.keys(s.options).some(k => !allowed.includes(k))) throw Error("Options do not belong to workflow");
  if (s.kind === "architect" && !["design-only", "checkpoint", "implement"].includes(s.options.intent!)) throw Error("Explicit architect intent required: design-only, checkpoint or already-authorized implement");
  if (s.kind === "architect" && s.stagesVersion === 2 && !["how-why", "how-only", "greenfield"].includes(s.options.grounding!)) throw Error("Explicit architect grounding required: how-why, how-only or greenfield");
  if (s.kind === "how") {
    if (!["simple", "complex"].includes(s.options.complexity!)) throw Error("Explicit how complexity required");
    if (s.options.complexity === "complex" ? !Number.isInteger(s.options.explorers) || s.options.explorers! < 2 || s.options.explorers! > 4 : s.options.explorers !== undefined) throw Error("Complex how needs 2-4 explorers; simple how has none");
  }
  const deferred = native && !s.correction && DEFERRED[s.kind] !== undefined && s.options[DEFERRED[s.kind]!] === undefined;
  if (s.kind === "swarm" && !deferred) validateSlices(s.options.slices);
  if (s.kind === "why" && !deferred) validateSources(s.options.sources);
  if (!Array.isArray(s.snapshots) || s.snapshots.length > 8 || !Array.isArray(s.catalog)) throw Error("Invalid routing snapshots");
  const required = new Set(stages(s).flatMap(x => x.jobs.map(j => j.role)));
  if (deferred) required.add(s.kind === "swarm" ? "swarm workers" : "why investigators");
  const expected = new Set(required);
  if (s.parentJudge) expected.delete("arena cross-judge pool");
  const found = new Set();
  for (const snapshot of s.snapshots) {
    validateSnapshot(snapshot, s.catalog);
    if (!expected.has(snapshot.role) || found.has(snapshot.role)) throw Error("Unexpected or duplicate snapshot role");
    found.add(snapshot.role);
  }
  if (found.size !== expected.size) throw Error("Every workflow role needs an immutable routing snapshot");
  if (s.profiles !== undefined) {
    if (!s.profiles || typeof s.profiles !== "object" || Array.isArray(s.profiles) || !Object.keys(s.profiles).length) throw Error("Invalid profile pins");
    for (const [role, pin] of Object.entries(s.profiles)) {
      if (!required.has(role)) throw Error("Profile pin for a role this workflow does not spawn: " + role);
      validatePin(pin);
    }
  }
}
function validatePin(pin: unknown): asserts pin is ProfilePin {
  fields(pin, ["id", "instructionsSha256"], "profile pin");
  if (typeof pin.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(pin.id)) throw Error("Invalid profile id");
  sha(pin.instructionsSha256, "profile instructions");
}
export function createWorkflow(id: string, owner: Owner, setup: Setup, version: 1 | 2 = 1): RecordV1 {
  text(id, "workflow id", 128); validateOwner(owner); validateSetup(setup, version === 2);
  return clone({ version, id, owner, setup, events: [] });
}
/**
 * One comparison for spawn arguments and host receipts: every explicitly requested
 * control must be present in some receipt and every reported value must equal it.
 */
export function selectionCheck(requested: Selection, receipts: Receipt[]) {
  const checks: Record<string, "confirmed" | "mismatch" | "unverified"> = {};
  for (const key of CONTROLS) {
    if (!Object.hasOwn(requested, key)) continue;
    const seen = receipts.flatMap(r => [r.resolved, r.observed]).filter(x => x && Object.hasOwn(x, key)).map(x => x![key]);
    checks[key] = seen.some(v => v !== requested[key]) ? "mismatch" : seen.length ? "confirmed" : "unverified";
  }
  const values = Object.values(checks);
  return { status: values.includes("mismatch") ? "mismatch" as const : values.includes("unverified") ? "unverified" as const : "confirmed" as const, checks };
}
function validateReceipt(r: unknown): asserts r is Receipt {
  fields(r, ["requested", "resolved", "observed"], "selection receipt");
  for (const part of ["requested", "resolved", "observed"] as const) {
    const value = r[part];
    if (value === undefined && part !== "requested") continue;
    fields(value, [...CONTROLS], "selection receipt " + part);
    const v = value as Selection;
    if (v.model !== undefined) text(v.model, "receipt model", 512);
    if (v.thinking !== undefined) text(v.thinking, "receipt thinking", 64);
    if (v.fastMode !== undefined && ![true, false, "auto", "ultrafast"].includes(v.fastMode)) throw Error("Invalid receipt fastMode");
  }
}
/** The nearest child stage before `at`: what a judge, or the lead checkpoint ahead of it, scores. */
function scoredStage(sequence: Stage[], at: number) {
  for (let i = at - 1; i >= 0; i--) if (sequence[i]!.jobs.length) return sequence[i];
  return undefined;
}
/** Usable (collected, not BLOCKED, not rejected) jobs of a settled stage: the exact labels a judge scores. */
function usable(stage: Stage | undefined, view: View) {
  return (stage?.jobs ?? []).filter(j => { const a = view.attempts[j.id]?.at(-1); return a?.result && a.result.status !== "BLOCKED" && !a.rejected; });
}
/** The ledger derives each design's shape digest from its reported shape; runners never compute it. */
export const shapeDigest = (output: unknown) => digest((output as { shape: unknown }).shape);
const effectiveSetup = (record: RecordV1, options: Options): Setup => ({ ...record.setup, options });
/**
 * Candidates a cross-judge must score for the record's current judge phase:
 * each usable slot id (used verbatim as the judge's label) and the artifact
 * path its runner reported. Undefined outside a judge phase.
 */
export function judgeCandidates(record: RecordV1) {
  const view = workflowView(record), sequence = stages(effectiveSetup(record, view.options));
  const at = sequence.findIndex(stage => stage.name === view.phase);
  if (at < 1 || !sequence[at]!.jobs.some(j => j.role === "arena cross-judge pool")) return undefined;
  return usable(scoredStage(sequence, at), view).map(j => {
    const output = view.attempts[j.id]!.at(-1)!.result!.output as { artifactPath?: string; packagePath?: string } | undefined;
    return { label: j.id, path: output?.artifactPath ?? output?.packagePath ?? null };
  });
}
function validateResult(r: Result, job: Job, view: View, native: boolean, setup: Setup, previous?: Stage) {
  fields(r, ["status", "artifactDigest", "evidence", "shapeDigest", "sha", "method", "output", ...(native ? ["report"] : [])], "result");
  if (!["PASS", "ISSUES", "BLOCKED"].includes(r.status)) throw Error("Invalid result status");
  sha(r.artifactDigest, "artifact");
  if (!Array.isArray(r.evidence) || r.evidence.length < 1 || r.evidence.length > 32) throw Error("Result evidence required");
  for (const e of r.evidence) text(e, "result evidence");
  if (r.report !== undefined) text(r.report, "child report", 32000);
  // Panel roles carry a closed output contract; other roles keep artifact digests only.
  const contract = contractFor(job.role, setup);
  if (!contract || (r.status === "BLOCKED" && !(setup.executedProof && job.role === "judgment and prose" && r.output !== undefined))) {
    if (r.output !== undefined) throw Error(contract ? "A BLOCKED result carries evidence, not a panel output" : "No output contract for role " + job.role);
  } else {
    if (r.output === undefined) throw Error("Panel output required for " + job.role + " (" + contract.name + ")");
    const candidates = previous ? usable(previous, view).map(j => j.id) : undefined;
    assertOutput(job.role, r.output, { status: r.status, candidates, setup, ...(setup.executedProof ? proofContext(setup, view) : {}) });
  }
  // Optional for compatibility: when supplied it must equal the digest the ledger derives.
  if (r.shapeDigest !== undefined) {
    if (job.role !== "architect runners" || r.status === "BLOCKED") throw Error("shapeDigest belongs only to a collected architect design");
    const derived = shapeDigest(r.output);
    if (r.shapeDigest !== derived) throw Error("shapeDigest is derived by the ledger from output.shape; omit it (the derived value is " + derived + ")");
  }
  if (job.slice && (r.sha !== job.slice.sha || r.method !== job.slice.method)) throw Error("Swarm result SHA/method mismatch; record rejection, retry the slice once, then report the coverage gap");
}
/** Replay validates the binding before any downstream dispatch; recorded catalog facts never overwrite earlier ones. */
function bindJudge(view: View, judge: JudgeBinding | undefined) {
  fields(judge, ["parentModel", "parentFamily", "snapshot", "catalog"], "judge binding");
  const binding = judge as JudgeBinding;
  text(binding.parentModel, "judge parent model", 512); text(binding.parentFamily, "judge parent family", 64);
  const snapshot = validateSnapshot(binding.snapshot, binding.catalog) as Snapshot;
  const selected = snapshot.selections[0]?.model;
  const parent = binding.catalog.find(row => row.id === binding.parentModel), child = binding.catalog.find(row => row.id === selected);
  const canonical = (family: string | undefined) => !!family && family.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(family);
  if (view.judge || snapshot.role !== "arena cross-judge pool" || snapshot.diversity !== "different-family" || !selected ||
      !canonical(binding.parentFamily) || parent?.family !== binding.parentFamily || !canonical(child?.family) || child?.family === binding.parentFamily)
    throw Error("Invalid different-family judge binding");
  if (binding.catalog.length !== 2) throw Error("Judge catalog must contain exactly its parent and selected model");
  for (const row of binding.catalog) {
    const old = view.catalog.find(c => c.id === row.id);
    if (old && digest(old) !== digest(row)) throw Error("Judge catalog conflicts with recorded model facts: " + row.id);
    if (!old) view.catalog.push(clone(row));
  }
  const id = digest(snapshot);
  view.snapshots[id] = snapshot; view.currentSnapshots[snapshot.role] = id; view.judge = clone(binding);
}
const NATIVE_ONLY = ["dispatch", "abandon", "configure", "schedule", "decide"];
export function workflowView(record: RecordV1): View {
  fields(record, ["version", "id", "owner", "setup", "events"], "workflow record");
  if (record.version !== 1 && record.version !== 2) throw Error("Unsupported workflow state version");
  const native = record.version === 2;
  text(record.id, "workflow id", 128); validateOwner(record.owner); validateSetup(record.setup, native);
  if (!Array.isArray(record.events) || record.events.length > 256) throw Error("Invalid workflow event ledger");
  let options = clone(record.setup.options), sequence = stages(record.setup);
  const deferred = native && !record.setup.correction ? DEFERRED[record.setup.kind] : undefined;
  let pending = deferred !== undefined && options[deferred] === undefined;
  let pos = 0;
  const view: View = { assurance: native ? "deterministic" : "agent-attested", executor: native ? "native" : "agent", revision: 1, phase: sequence[0]!.name, status: sequence[0]!.approval ? "awaiting-user" : "active", jobs: sequence[0]!.jobs, gates: sequence[0]!.gates, catalog: clone(record.setup.catalog), attempts: {}, evidence: {}, snapshots: {}, currentSnapshots: {}, supersessions: [], blockers: [], next: "",
    dispatches: {}, enforcement: {}, schedules: [], decisions: [], evidenceSource: {}, corrections: {}, stageKind: "none", options, needsConfigure: pending };
  for (const role of new Set([...record.setup.snapshots.map(s => s.role), ...Object.keys(record.setup.profiles ?? {}), ...(record.setup.parentJudge ? ["arena cross-judge pool"] : [])])) {
    const pin = record.setup.profiles?.[role];
    view.enforcement[role] = !pin ? "prompt" : profileKeepsShell(pin.id) ? "host-profile-shell" : "host-profile";
  }
  for (const snapshot of record.setup.snapshots) {
    const id = digest(snapshot); view.snapshots[id] = clone(snapshot); view.currentSnapshots[snapshot.role] = id;
  }
  const seenEvents = new Set();
  const enter = (to: number) => {
    pos = to;
    if (pos === sequence.length) { view.status = "completed"; view.phase = "complete"; view.jobs = []; view.gates = []; return; }
    const next = sequence[pos]!; view.phase = next.name; view.jobs = next.jobs; view.gates = next.gates; view.status = next.approval ? "awaiting-user" : "active";
  };
  for (const e of record.events) {
    text(e.id, "event id", 128);
    if (seenEvents.has(e.id)) throw Error("Duplicate workflow event id");
    seenEvents.add(e.id);
    if (["completed", "cancelled"].includes(view.status)) throw Error("Workflow is terminal");
    const stage = sequence[pos]!;
    const job = "slot" in e ? stage.jobs.find(j => j.id === e.slot) : undefined;
    const attempts = job ? view.attempts[job.id] ?? [] : [];
    const attempt = attempts.at(-1);
    const active = () => { if (!["active", "awaiting-user"].includes(view.status)) throw Error("Workflow must resume/unblock before this transition"); };
    const eventFields: Record<Event["type"], string[]> = {
      accept: ["slot", "runId", "childSessionKey", "snapshotId", ...(native ? ["requestId", "selection"] : [])],
      collect: ["slot", "runId", "result", ...(native ? ["selection"] : [])], reject: ["slot", "runId", "reason", ...(native ? ["selection"] : [])],
      retry: ["slot", "reason"], advance: ["evidence", "judge"], wait: ["timeoutSeconds"], resume: [], block: ["reason"], unblock: ["evidence"], cancel: ["reason"], supersede: ["snapshotId", "snapshot", "catalog", "instruction"],
      dispatch: ["slot", "requestId", "snapshotId", "profile", "by"], abandon: ["slot", "requestId", "reason"], configure: ["options"],
      schedule: ["jobId", "requestId", "atMs", "deadlineAtMs", "maxRuns", "survivesRestart", "instance"], decide: ["decision", "by", "notes"],
    };
    if (!Object.hasOwn(eventFields, e.type)) throw Error("Unknown workflow transition");
    if (!native && NATIVE_ONLY.includes(e.type)) throw Error("Only native controller records accept " + e.type);
    fields(e, ["id", "type", ...eventFields[e.type]], "event");
    switch (e.type) {
      case "dispatch": {
        active();
        if (!job || attempt || view.dispatches[job.id]) throw Error("Dispatch needs an unaccepted slot without a pending dispatch; reconcile before spawning again");
        text(e.requestId, "native request id", 256);
        if (view.currentSnapshots[job.role] !== e.snapshotId) throw Error("Snapshot does not match current role selection");
        if (Object.values(view.attempts).flat().some(x => x.requestId === e.requestId)) throw Error("Native request id already used");
        // A pinned role spawns only under its pinned profile; an unpinned role never claims one.
        const pinned = record.setup.profiles?.[job.role];
        if (e.profile !== undefined) validatePin(e.profile);
        if (digest(e.profile ?? null) !== digest(pinned ?? null)) throw Error("Dispatch profile must equal the role's pinned host profile");
        if (e.by !== undefined) text(e.by, "dispatching requester", 512);
        view.dispatches[job.id] = { requestId: e.requestId, snapshotId: e.snapshotId, ...(pinned ? { profile: clone(pinned) } : {}), ...(e.by !== undefined ? { by: e.by } : {}) };
        break;
      }
      case "abandon": {
        const pendingDispatch = job && view.dispatches[job.id];
        if (!pendingDispatch || pendingDispatch.requestId !== e.requestId) throw Error("Only a pending dispatch can be abandoned");
        text(e.reason, "abandon reason");
        delete view.dispatches[job!.id];
        break;
      }
      case "accept": {
        active();
        if (!job || attempt) throw Error("Unknown slot or already accepted child; collect/resume, never respawn");
        text(e.runId, "accepted run id", 256); text(e.childSessionKey, "child session key");
        if (!/^agent:[^:]+:subagent:.+/.test(e.childSessionKey)) throw Error("Native child session key required");
        if (Object.values(view.attempts).flat().some(x => x.runId === e.runId || x.childSessionKey === e.childSessionKey)) throw Error("Child already belongs to another slot");
        if (view.currentSnapshots[job.role] !== e.snapshotId) throw Error("Snapshot does not match current role selection");
        if (native) {
          const pendingDispatch = view.dispatches[job.id];
          if (!pendingDispatch || pendingDispatch.requestId !== e.requestId || pendingDispatch.snapshotId !== e.snapshotId) throw Error("Native accept needs its own pending dispatch");
          if (e.selection !== undefined) validateReceipt(e.selection);
        }
        const profile = native ? view.dispatches[job.id]?.profile : undefined;
        if (native) delete view.dispatches[job.id];
        view.attempts[job.id] = [...attempts, { runId: e.runId, childSessionKey: e.childSessionKey, snapshotId: e.snapshotId,
          ...(native ? { requestId: e.requestId, ...(profile ? { profile: clone(profile) } : {}), receipts: e.selection ? [clone(e.selection)] : [] } : {}) }];
        break;
      }
      case "collect": case "reject": {
        // Collection is allowed while waiting/blocked: the accepted completion
        // path can settle without a duplicate spawn or implicitly clearing a hold.
        if (!job || !attempt || attempt.runId !== e.runId || attempt.result || attempt.rejected) throw Error("Result must belong to the pending accepted child");
        if (native && e.selection !== undefined) { validateReceipt(e.selection); attempt.receipts!.push(clone(e.selection)); }
        if (e.type === "collect") {
          validateResult(e.result, job, view, native, record.setup, scoredStage(sequence, pos));
          if (native) {
            // A native result is usable only when host receipts confirm every requested control.
            const requested = view.snapshots[attempt.snapshotId]!.selections[job.index]!;
            const check = selectionCheck(requested, attempt.receipts!);
            if (check.status !== "confirmed") throw Error("Selection " + check.status + " for " + job.id + ": " + JSON.stringify(check.checks) + "; reject the child instead of collecting it");
          }
          attempt.result = clone(e.result);
        } else { text(e.reason, "rejection reason"); attempt.rejected = e.reason; }
        break;
      }
      case "retry": {
        active(); text(e.reason, "retry reason");
        // A native deliverable is corrected in its own stage, or from the approval that shows it.
        const deliverable = native ? deliverableSlotOf(record.setup) : undefined;
        const fromApproval = !job && native && stage.approval && e.slot === deliverable && sequence[pos - 1]?.jobs.some(j => j.id === e.slot);
        const target = job ?? (fromApproval ? sequence[pos - 1]!.jobs.find(j => j.id === e.slot) : undefined);
        const previous = target ? view.attempts[target.id] ?? [] : [], last = previous.at(-1);
        const swarm = record.setup.kind === "swarm" && !!last && !!(last.rejected || last.result?.status === "BLOCKED");
        const correctable = native && target?.id === deliverable && !!last && !!(last.rejected || last.result);
        // Any other native child of the current stage (a judge, runner, reviewer or grounding child) retries once when rejected or BLOCKED.
        const required = native && record.setup.kind !== "swarm" && !!job && !!last && !!(last.rejected || last.result?.status === "BLOCKED");
        if (!target || previous.length !== 1 || !(swarm || correctable || required)) throw Error("Only a rejected/blocked swarm slice or native child, or a native deliverable, may retry once");
        // Preserve the first attempt, then open one new admission slot.
        view.attempts[target.id + ":previous"] = clone(previous);
        delete view.attempts[target.id];
        if (native) view.corrections[target.id] = { reason: e.reason, runId: last!.runId };
        if (fromApproval) enter(pos - 1);
        break;
      }
      case "configure": {
        active();
        const key = deferred;
        if (!key || !pending || Object.keys(view.evidence).length || pos !== 0) throw Error("Only native swarm/why framing may configure its deferred options, once, before the first advance");
        fields(e.options, [key], "configured options");
        if (key === "slices") validateSlices(e.options.slices); else validateSources(e.options.sources);
        options = { ...options, [key]: clone(e.options[key]) };
        sequence = stages(effectiveSetup(record, options));
        pending = false; view.options = options; view.needsConfigure = false;
        view.jobs = sequence[pos]!.jobs;
        break;
      }
      case "advance": {
        active();
        const binding = native && record.setup.parentJudge && stage.name === "lead";
        if (binding) bindJudge(view, e.judge);
        else if (e.judge !== undefined) throw Error("Judge binding belongs only to a parentJudge lead advance");
        if (pending) throw Error("Configure the deferred " + deferred + " before advancing");
        if (native && stage.approval) throw Error("A native approval stage advances only through an authenticated /pstack resume decision");
        // A native swarm slice that also failed its one retry becomes a recorded coverage gap, never a pass.
        const gaps = native && record.setup.kind === "swarm" && stage.name === "workers";
        fields(e.evidence, stage.name === "candidates" ? ["dropouts"] : gaps ? ["coverage-gaps"] : stage.gates, "phase evidence");
        for (const key of stage.gates) text(e.evidence[key], "gate " + key, record.setup.executedProof ? 128000 : 4096);
        if (record.setup.executedProof && stage.name === "frame") assertProofContext(JSON.parse(e.evidence["frozen-head"]!));
        if (record.setup.executedProof && stage.name === "verdict") {
          const lead = JSON.parse(e.evidence["independent-lead"]!);
          fields(lead, ["status", "output"], "independent lead");
          if (!["PASS", "ISSUES"].includes(lead.status as string)) throw Error("Independent lead unavailable: BLOCKED");
          assertOutput(interrogateSemantics(record.setup)!.lead, lead.output, { status: lead.status, ...proofContext(record.setup, view) });
        }
        if (native && Object.values(view.dispatches).length) throw Error("A pending native dispatch must be reconciled before advancing");
        let usableCount = 0, gapCount = 0;
        for (const j of stage.jobs) {
          const a = view.attempts[j.id]?.at(-1);
          if (stage.name === "candidates") {
            if (!a || (!a.result && !a.rejected)) throw Error("Cannot judge a pending candidate: " + j.id);
            if (!a.rejected && a.result?.status !== "BLOCKED") usableCount++;
            else text(e.evidence.dropouts, "terminal candidate dropouts");
          } else if (a?.result && a.result.status !== "BLOCKED") usableCount++;
          else if (gaps && a && (a.rejected || a.result) && view.attempts[j.id]!.length === 2) gapCount++;
          else throw Error("Required collected result missing: " + j.id + (gaps && a && (a.rejected || a.result) ? " (retry the slice once before recording a coverage gap)" : ""));
        }
        if (stage.name === "candidates" && !usableCount) throw Error("Arena requires at least one usable artifact");
        if (gaps && gapCount) {
          text(e.evidence["coverage-gaps"], "swarm coverage gaps");
          if (!usableCount) throw Error("Every swarm slice is a coverage gap; nothing is left to aggregate");
        } else if (gaps && e.evidence["coverage-gaps"] !== undefined) throw Error("No swarm coverage gap to record");
        // The lead's own scores name every candidate the judge will score, under the same labels.
        if (record.setup.leadFirst && stage.name === "lead") {
          const missing = usable(scoredStage(sequence, pos), view).map(j => j.id).filter(label => !e.evidence["lead-scores"]!.includes(label));
          if (missing.length) throw Error("Lead scores must score every usable candidate under its label before the judge runs; missing " + missing.join(", "));
        }
        if (stage.name === "designs") {
          const shapes = stage.jobs.map(j => shapeDigest(view.attempts[j.id]!.at(-1)!.result!.output));
          if (new Set(shapes).size !== 2) throw Error("Two structurally distinct whole-shape alternatives required");
        }
        view.evidence[stage.name] = clone(e.evidence);
        if (native) view.evidenceSource[stage.name] = stage.jobs.length ? "controller" : "agent-attested";
        enter(pos + 1);
        break;
      }
      case "decide": {
        if (!stage.approval || view.status !== "awaiting-user") throw Error("Only an awaiting-user approval stage takes a decision");
        text(e.by, "deciding requester", 512);
        if (e.notes !== undefined) text(e.notes, "decision notes", 8000);
        view.decisions.push({ stage: stage.name, decision: e.decision, by: e.by, ...(e.notes !== undefined ? { notes: e.notes } : {}) });
        if (e.decision === "approve") {
          const recorded = "Approved by authenticated command sender " + e.by + (e.notes ? ": " + e.notes : " as presented");
          view.evidence[stage.name] = Object.fromEntries(stage.gates.map(g => [g, recorded]));
          view.evidenceSource[stage.name] = "user-command";
          enter(pos + 1);
        } else if (e.decision === "revise") {
          const previous = sequence[pos - 1];
          if (!e.notes) throw Error("A revision needs the user's notes");
          if (!previous || previous.jobs.length || previous.approval) throw Error("This approval has no parent checkpoint to revise; approve with decisions or cancel");
          enter(pos - 1);
        } else throw Error("Unknown decision");
        break;
      }
      case "schedule": {
        text(e.jobId, "schedule job id", 256); text(e.requestId, "schedule request id", 256); text(e.instance, "plugin instance", 128);
        if (!Number.isSafeInteger(e.atMs) || !Number.isSafeInteger(e.deadlineAtMs) || e.deadlineAtMs <= e.atMs || !Number.isSafeInteger(e.maxRuns) || e.maxRuns < 1 || e.maxRuns > 100 || typeof e.survivesRestart !== "boolean") throw Error("Invalid schedule receipt");
        if (view.schedules.some(s => s.jobId === e.jobId || s.requestId === e.requestId)) throw Error("Schedule already recorded");
        view.schedules.push({ jobId: e.jobId, requestId: e.requestId, atMs: e.atMs, deadlineAtMs: e.deadlineAtMs, maxRuns: e.maxRuns, survivesRestart: e.survivesRestart, instance: e.instance });
        break;
      }
      case "wait":
        active();
        if (!Number.isInteger(e.timeoutSeconds) || e.timeoutSeconds < 0 || e.timeoutSeconds > 30 || !stage.jobs.some(j => { const a = view.attempts[j.id]?.at(-1); return a && !a.result && !a.rejected; })) throw Error("Wait needs pending accepted children and a 0-30 second native bound");
        view.status = "waiting"; break;
      case "resume":
        if (view.status !== "waiting") throw Error("Only a bounded-wait handoff can resume; blocks need explicit clearing evidence");
        view.status = stage.approval ? "awaiting-user" : "active"; break;
      case "block":
        text(e.reason, "blocker"); view.blockers.push(e.reason); view.status = "blocked"; break;
      case "unblock":
        if (view.status !== "blocked") throw Error("Workflow is not blocked");
        text(e.evidence, "blocker clearing evidence"); view.evidence["unblock:" + view.revision] = { evidence: e.evidence };
        view.status = stage.approval ? "awaiting-user" : "active"; break;
      case "cancel":
        text(e.reason, "cancellation reason"); view.blockers.push(e.reason); view.status = "cancelled"; break;
      case "supersede": {
        active(); text(e.instruction, "explicit user correction");
        if (native) throw Error("Native workflows keep their admitted routing; cancel and start a new workflow to change it");
        const from = view.snapshots[e.snapshotId];
        if (!from || view.currentSnapshots[from.role] !== e.snapshotId) throw Error("Supersession must extend the latest snapshot");
        const to = validateSnapshot(e.snapshot, e.catalog) as Snapshot;
        if (to.role !== from.role || to.source !== from.source || to.poolIndex !== from.poolIndex || to.diversity !== from.diversity || to.selections.length !== from.selections.length) throw Error("Correction cannot change snapshot role, provenance, order or pool membership");
        const id = digest(to);
        if (id === e.snapshotId) throw Error("No-op supersession");
        view.snapshots[id] = clone(to); view.catalog = clone(e.catalog); view.currentSnapshots[to.role] = id;
        view.supersessions.push({ from: e.snapshotId, to: id, instruction: e.instruction });
        break;
      }
    }
    // A retry never discards the original admission, and may not be repeated.
    if (e.type === "accept" && view.attempts[e.slot + ":previous"] && view.attempts[e.slot]!.length === 1) {
      view.attempts[e.slot]!.unshift(...view.attempts[e.slot + ":previous"]!); delete view.attempts[e.slot + ":previous"];
    }
    view.revision++;
  }
  view.stageKind = stageKind(sequence[pos]);
  view.next = native ? nativeNext(view, record.setup) : view.status === "waiting" ? "Collect pending run IDs through their accepted native completion path, then resume; do not respawn."
    : view.status === "blocked" ? "Resolve the named blocker with evidence; independent authorized work may continue."
    : view.status === "awaiting-user" ? "Record explicit user decisions before applying changes; this is an agent-attested checkpoint, not authenticated approval."
    : view.status === "active" ? "Satisfy every current job and gate, then advance. No tool in this module spawns, waits, approves or writes product files."
    : view.status === "cancelled" ? "Terminal record. Stop/settle any pending accepted child through its native owner; cancellation here does not stop native runs."
    : "Terminal record; no further transitions.";
  return clone(view);
}
function nativeNext(view: View, setup: Setup) {
  if (view.status === "completed") return "Terminal native record; no further transitions.";
  if (view.status === "cancelled") return "Terminal native record. Accepted children keep native custody; this controller spawns nothing further.";
  if (view.status === "blocked") return "BLOCKED: " + view.blockers.at(-1) + ". The controller will not advance or respawn; cancel with /pstack resume cancel, then start a new workflow.";
  if (view.status === "awaiting-user") return "Awaiting the user: /pstack resume approve [notes] or " + (setup.kind === "reflect" ? "/pstack resume correct <what is wrong> for one corrected synthesis" : "/pstack resume revise <notes>") + ". Agent text is not approval.";
  if (view.status === "waiting") return "Children are pending. The native controller collects them on /pstack resume or its scheduled continuation; never spawn them yourself.";
  if (view.needsConfigure) return "Parent framing: record the deferred options with pstack_workflow apply configure, then advance the framing checkpoint.";
  if (view.stageKind === "jobs") return "Controller phase: /pstack resume (or the scheduled continuation) spawns and collects these children. Do not spawn them yourself.";
  return "Parent checkpoint: do the work this phase names, then record each gate with pstack_workflow apply advance. The controller runs the next panel phase.";
}
/**
 * Tiered ledger budgets. Progress stops first, a block still fits after any progress, and a
 * cancel still fits after any block, so a full record can always be stopped and replaced.
 */
export const LEDGER_BUDGET = {
  progress: { events: 248, bytes: 480 * 1024 },
  block: { events: 255, bytes: 504 * 1024 },
  cancel: { events: 256, bytes: 512 * 1024 },
} as const;
/** A write refused only for budget: the caller records BLOCKED or cancels, never truncates. */
export class LedgerBudgetError extends Error {}
export function appendEvent(record: RecordV1, expectedRevision: number, event: Event): RecordV1 {
  const view = workflowView(record);
  const old = record.events.find(e => e.id === event.id);
  if (old) {
    if (digest(old) !== digest(event)) throw Error("Event id reused with different data");
    return clone(record);
  }
  if (view.revision !== expectedRevision) throw Error("Stale workflow revision; read before retrying");
  // An accept records a child the host already runs, so it may use the block tier. The controller
  // checks room for dispatch, accept and result before each progress-tier dispatch; this headroom
  // keeps custody of an accepted child if that estimate was short. Cancel always fits.
  const reserved = event?.type === "block" || event?.type === "accept";
  const tier = event?.type === "cancel" ? LEDGER_BUDGET.cancel : reserved ? LEDGER_BUDGET.block : LEDGER_BUDGET.progress;
  const advice = event?.type === "cancel" ? "" : "; history is preserved and " + (reserved ? "cancel" : "block and cancel") + " still fit. Cancel this workflow (/pstack resume cancel for a native one) and start a new one";
  if (record.events.length >= tier.events) throw new LedgerBudgetError("Workflow event budget reached (" + record.events.length + " events)" + advice);
  const next = clone(record); next.events.push(clone(event)); workflowView(next);
  const bytes = Buffer.byteLength(JSON.stringify(next));
  if (bytes > tier.bytes) throw new LedgerBudgetError("Workflow ledger size budget reached (" + bytes + " bytes)" + advice);
  return next;
}

// Minimal structural port; the host's keyed-store V2 remains the atomic writer.
export type KeyedStore<C = unknown> = {
  observe(key: string): Promise<{ value: unknown; comparison: C }>;
  apply(key: string, comparison: C, value: RecordV1): Promise<{ status: string }>;
};
export const workflowKey = (owner: Owner, id: string) => digest([owner.sessionKey, owner.sessionId, owner.workspace, id]);
export function ownedRecord(value: unknown, owner: Owner, id: string): RecordV1 {
  if (!value) throw Error("Workflow not found for this exact session incarnation");
  const record = value as RecordV1; workflowView(record);
  if (record.id !== id || digest(record.owner) !== digest(owner)) throw Error("Workflow owner mismatch");
  return record;
}
/** A Setup creates a record (version 2 only when the native controller asks); an Event appends. */
export async function mutateWorkflow<C>(store: KeyedStore<C>, owner: Owner, id: string, revision: number, change: Setup | Event, assertCurrent: () => void, version: 1 | 2 = 1) {
  validateOwner(owner); text(id, "workflow id", 128);
  if (!Number.isSafeInteger(revision) || revision < 0) throw Error("Invalid expected revision");
  assertCurrent();
  const key = workflowKey(owner, id), observed = await store.observe(key); assertCurrent();
  let next: RecordV1;
  if (revision === 0) {
    if (observed.value !== undefined) throw Error("Workflow already exists; read it instead of recreating children");
    const setup = change as Setup;
    next = createWorkflow(id, owner, setup.kind === "interrogate" && !setup.correction ? { ...setup, executedProof: true } : setup, version);
  } else next = appendEvent(ownedRecord(observed.value, owner, id), revision, change as Event);
  assertCurrent();
  if (Buffer.byteLength(JSON.stringify(next)) > LEDGER_BUDGET.cancel.bytes) throw new LedgerBudgetError("Workflow ledger size budget reached; nothing was written");
  // An identical event-ID replay is a read: no extra store generation/write.
  if (observed.value !== undefined && digest(observed.value) === digest(next)) return { record: next, view: workflowView(next) };
  const result = await store.apply(key, observed.comparison, next);
  assertCurrent();
  if (result.status !== "applied") throw Error("Concurrent workflow change; read the new revision before retrying");
  return { record: next, view: workflowView(next) };
}

/** Frozen inputs for collection, replay and correction; never derive them from a child report. */
export function proofContext(setup: Setup, view: View) {
  if (setup.correction?.proofContext) return setup.correction.proofContext;
  const frozen = assertProofContext(JSON.parse(view.evidence.frame?.["frozen-head"] ?? "null"));
  const reviewers = ["reviewers:0", "reviewers:1"].flatMap(slot => {
    const result = view.attempts[slot]?.at(-1)?.result;
    return result && result.status !== "BLOCKED" ? [{ slot, artifactDigest: result.artifactDigest, output: result.output }] : [];
  });
  return { frozen, reviewers };
}
