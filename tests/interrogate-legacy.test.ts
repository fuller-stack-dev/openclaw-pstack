import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import frozen from "./fixtures/interrogate-legacy.json";
import { appendEvent, workflowView, ownedRecord, workflowKey, type RecordV1 } from "../src/workflow.ts";
import { childTask, deliverable, envelopeSchema, missingSections, nativeContext, runNative } from "../src/controller.ts";
import { contractFor, subagentProfiles } from "../skills/pstack/scripts/output-contracts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const copy = (version: "v1" | "v2", pending = false): RecordV1 => {
  const fixture = frozen[version];
  const record = structuredClone(fixture.record) as RecordV1;
  if (pending) record.events = record.events.slice(0, fixture.pendingEvents);
  return record;
};
const append = (record: RecordV1, event: any) => appendEvent(record, workflowView(record).revision, { id: "test-" + record.events.length, ...event });

describe("frozen pre-executed-proof interrogate records", () => {
  it.each(["v1", "v2"] as const)("reads, resumes and cancels %s without changing its collected output or accepted lineage", version => {
    const record = copy(version, true), view = workflowView(record);
    expect(ownedRecord(record, record.owner, record.id)).toEqual(record);
    expect(view.phase).toBe("reviewers");
    expect(view.attempts["reviewers:0"]![0]!.result!.output).toEqual(frozen.v1.record.events.find(e => e.type === "collect")!.result!.output);
    expect(view.attempts["reviewers:1"]![0]!.runId).toBe("legacy-reviewers:1");
    const waiting = append(record, { type: "wait", timeoutSeconds: 1 });
    const resumed = append(waiting, { type: "resume" });
    expect(workflowView(resumed).attempts).toEqual(view.attempts);
    expect(() => append(resumed, { type: "accept", slot: "reviewers:1", runId: "duplicate", childSessionKey: "agent:fixture:subagent:duplicate", snapshotId: view.currentSnapshots["interrogate reviewers"] })).toThrow(/already accepted/);
    expect(workflowView(append(resumed, { type: "cancel", reason: "owner cancelled" })).status).toBe("cancelled");
    expect(record.setup).not.toHaveProperty("executedProof");
  });

  it("requires the old rubric and four-bucket v1 gates on replay", () => {
    const record = copy("v1");
    record.events = [];
    expect(() => append(record, { type: "advance", evidence: { intent: "intent", "frozen-head": "head" } })).toThrow(/rubric/);
    const beforeVerdict = copy("v1"); beforeVerdict.events.pop();
    expect(workflowView(beforeVerdict).gates).toEqual(["all-findings-four-buckets", "model-attributed-agreement-map", "source-validation"]);
    expect(workflowView(copy("v1")).status).toBe("completed");
    const invalid = copy("v2");
    const result = invalid.events.find(e => e.type === "collect") as any;
    result.result.output.findings = [{ severity: "warning" }];
    expect(() => workflowView(invalid)).toThrow(/Invalid interrogate reviewers output/);
  });

  it("keeps the legacy schema, host-profile definition and exact instruction digest", () => {
    expect(contractFor("interrogate reviewers")).toEqual(frozen.reviewerContract);
    expect(envelopeSchema("interrogate reviewers").properties.output).toEqual(frozen.reviewerContract.schema);
    expect(subagentProfiles().find(p => p.id === frozen.profile.id)).toEqual(frozen.profile);
    expect(hash(readFileSync(join(root, frozen.profile.instructionsFile)))).toBe(frozen.profileDigest);
    expect(copy("v2").setup.profiles!["interrogate reviewers"]!.instructionsSha256).toBe(frozen.profileDigest);
  });

  it("uses preserved reference bytes and the legacy workflow section in reviewer and lead briefs", () => {
    const pending = copy("v2", true), lead = copy("v2"); lead.events = lead.events.slice(0, -1);
    const reviewer = childTask(pending, workflowView(pending), "reviewers:1", root, pending.setup.task!);
    const leadBrief = childTask(lead, workflowView(lead), "lead:0", root, lead.setup.task!);
    for (const [file, digest] of Object.entries(frozen.referenceDigests)) {
      const path = join(root, "skills/pstack/native/legacy/interrogate", file);
      expect(hash(readFileSync(path))).toBe(digest);
      expect(file === "lead-judgment.md" ? leadBrief : reviewer).toContain(path);
    }
    for (const brief of [reviewer, leadBrief]) {
      expect(brief).toContain(join(root, "skills/pstack/native/legacy/interrogate/workflow.md"));
      expect(brief).not.toContain("upstream/skills/interrogate/");
    }
    expect(nativeContext(pending, workflowView(pending), root)).toContain(join(root, "skills/pstack/native/legacy/interrogate/workflow.md"));
    expect(reviewer).toContain("read-only reviewers");
    expect(leadBrief).toContain("Agreement Map");
  });

  it("delivers the completed legacy report verbatim and retains its section requirements", () => {
    const record = copy("v2"), view = workflowView(record), report = view.attempts["lead:0"]![0]!.result!.report!;
    expect(missingSections(record, view, "lead:0", report)).toEqual([]);
    expect(missingSections(record, view, "lead:0", "## Intent")).toEqual(["Reviewers", "Act on", "Consider", "Noted", "Dismissed", "Agreement Map"]);
    expect(deliverable(record, view)).toContain(report.split("\n").map(line => line ? "> " + line : ">").join("\n"));
    expect(deliverable(record, view)).toContain("legacy-lead:0");
  });

  it.each(["pending", "natural-native", "correction", "failed-correction"] as const)("resumes frozen %s with original pins and no duplicate accepted child or second correction", async mode => {
    const correction = mode === "correction" || mode === "failed-correction";
    let record = correction ? structuredClone(frozen.correction) as RecordV1 : copy("v2", true);
    if (mode === "natural-native") record.setup.profiles = structuredClone(frozen.nativeAdmissionV2.profiles);
    const spawned: any[] = [], collected: string[][] = [];
    const key = workflowKey(record.owner, record.id);
    const result = (slot: string) => {
      if (mode === "failed-correction") return { status: "BLOCKED", evidence: ["Required source unavailable"], report: "Cannot correct the missing source constraint." };
      const { status, evidence, report, output } = (frozen.v2.record.events.find(e => e.type === "collect" && e.slot === slot) as any).result;
      return { status, evidence, report, ...(output ? { output } : {}) };
    };
    const deps: any = { owner: record.owner, root, assertCurrent() {}, requester: "fixture-owner", profiles: new Map([[frozen.profile.id, { id: frozen.profile.id, instructionsSha256: frozen.profileDigest, ownsOutputSchema: false }]]),
      store: { observe: async (k: string) => {
        if (correction && k === workflowKey(record.owner, frozen.v2.record.id)) return { value: copy("v2"), comparison: "source" };
        expect(k).toBe(key); return { value: record, comparison: record };
      }, apply: async (_k: string, before: unknown, next: RecordV1) => { expect(before).toBe(record); record = next; return { status: "applied" }; } },
      subagents: { spawn: async (params: any) => { spawned.push(params); return { runId: "new-lead", childSessionKey: "agent:fixture:subagent:new-lead", selection: { requested: {}, resolved: {} } }; },
        collect: async ({ ids }: { ids: string[] }) => { collected.push(ids); return { completed: ids.map(runId => ({ runId, status: "done", structured: result(runId === "new-lead" ? "lead:0" : "reviewers:1"), selection: { requested: {}, resolved: {} } })), pending: [] }; } } };
    const finished = await runNative(deps, record);
    expect(finished.view.status).toBe(mode === "failed-correction" ? "blocked" : "completed");
    expect(collected).toEqual(correction ? [["new-lead"]] : [["legacy-reviewers:1"], ["new-lead"]]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].profile).toBe(mode === "natural-native" ? undefined : "panel-reviewer");
    if (mode === "natural-native") expect(record.setup.profiles).not.toHaveProperty("judgment and prose");
    expect(spawned[0].task).toContain("slot lead:0");
    if (correction) {
      expect(spawned[0].task).toContain("one correction");
      expect(spawned[0].task).toContain("### reviewers:1");
      expect(spawned[0].task).toContain(JSON.stringify(workflowView(copy("v2")).attempts["reviewers:1"]![0]!.result!.output));
      expect(spawned[0].task).toContain(frozen.correction.setup.correction.errors);
      expect(record.setup).not.toHaveProperty("executedProof");
      expect(record.setup.profiles).toEqual(frozen.correction.setup.profiles);
    } else expect(finished.view.attempts["reviewers:1"]![0]!.childSessionKey).toBe("agent:fixture:subagent:legacy-reviewers:1");
    await runNative(deps, record);
    expect(spawned).toHaveLength(1);
  });
});
