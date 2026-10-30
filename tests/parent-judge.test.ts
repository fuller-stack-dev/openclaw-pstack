import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { realpath, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { createPluginStateKeyedStoreV2ForTests, resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveOpenClawPluginToolInputs } from "host-test/plugin-tool-inputs";
import { register } from "../src/index.ts";
import { workflowKey, workflowView, appendEvent, selectionCheck, type RecordV1 } from "../src/workflow.ts";
import { runNative } from "../src/controller.ts";
import { WORKFLOW_RETENTION } from "../src/workflow-tool.ts";
import { build } from "./fixtures/tool-factory.ts";
import { arenaOutput, architectOutput, judgeOutput } from "./fixtures/panel-outputs.mjs";
import legacy from "./fixtures/parent-judge-legacy.json";

const role = "arena cross-judge pool", F = "transport/f", G = "transport/g";
const rows = [{ provider: "transport", id: "f", name: "F", family: "family-f" }, { provider: "transport", id: "g", name: "G", family: "family-g" }];
const capabilities = ["command-native-subagents-v1", "requester-model-catalog-v1", "requester-model-family-v1", "command-scheduled-turns-v1", "native-subagent-profiles-v1"];
const spec = { namespace: "workflow-v1", maxEntries: 256, overflowPolicy: "reject-new" as const, defaultTtlMs: WORKFLOW_RETENTION.idleTtlMs };
const persisted = () => createPluginStateKeyedStoreV2ForTests("pstack", spec, { assertCurrent() {} });
let fixture: any, workspace: string, serial = 0;
const config = (pool: any[] = [{ model: F }, { model: G }]) => ({ version: 1, presets: {}, roles: { [role]: pool } });
beforeAll(async () => { fixture = await createOpenClawTestState({ label: "parent-judge", applyEnv: true }); workspace = await realpath(fixture.workspaceDir); });
afterAll(async () => { resetPluginStateStoreForTests(); await fixture.cleanup(); });
beforeEach(async () => { await persisted().clear(); await writeFile(join(workspace, "pstack-models.json"), JSON.stringify(config())); });

// Real tool context producer, reducer and keyed CAS writes; child transport is scripted, not inference.
function harness(caps = capabilities) {
  const owner = { sessionKey: "agent:worker:dashboard:judge-" + ++serial, sessionId: "one", workspace };
  const entry = vi.fn(async () => ({ sessionId: owner.sessionId, spawnedWorkspaceDir: workspace, liveModelSwitchPending: false }));
  const list = vi.fn(async () => ({ revision: "catalog-one", state: "prepared", models: structuredClone(rows) }));
  const writes = vi.fn(), commands = new Map<string, any>(), tools = new Map<string, any>();
  const children: any[] = [];
  let current = true, afterObserve: (() => void) | undefined;
  const assertCurrent = () => { if (!current) throw Error("invocation retired"); };
  const subagents = {
    spawn: vi.fn(async (params: any) => { const runId = "r" + children.length; children.push({ runId, params }); return { runId, childSessionKey: "agent:worker:subagent:" + runId, completionMode: "collect", selection: { requested: params.model ? { model: params.model } : {}, resolved: params.model ? { model: params.model } : {} } }; }),
    collect: async ({ ids }: any) => ({ pending: [], completed: ids.map((runId: string) => {
      const child = children.find(c => c.runId === runId), task = child.params.task, slot = /slot ([a-z]+:[a-z0-9]+)/.exec(task)![1]!;
      const output = slot.startsWith("candidates") ? arenaOutput() : slot.startsWith("designs") ? architectOutput(slot) : slot.startsWith("judge") ? judgeOutput(task.includes("designs:0") ? ["designs:0", "designs:1"] : ["candidates:0", "candidates:1"]) : undefined;
      return { runId, status: "done", selection: { requested: {}, resolved: child.params.model ? { model: child.params.model } : {} }, structured: { status: "PASS", evidence: ["Scripted transport"], report: "Grounded fixture", ...(output ? { output } : {}) } };
    }) }),
  };
  const runtimeContext = { models: { list }, subagents, scheduledTurns: { schedule: async (p: any) => ({ jobId: p.requestId, deadlineAtMs: p.deadlineAtMs, maxRuns: p.maxRuns, survivesRestart: true }) } };
  register(createTestPluginApi({ id: "pstack", runtime: { capabilities: caps,
    state: { openKeyedStoreV2: (s: any, opts: any) => { const store = createPluginStateKeyedStoreV2ForTests("pstack", s, { assertCurrent() {}, ...opts }); return { ...store, observe: async (key: string) => { const observed = await store.observe(key); if (s.namespace === spec.namespace) { const hook = afterObserve; afterObserve = undefined; hook?.(); } return observed; }, compareAndApply: async (...args: any[]) => { const result = await (store.compareAndApply as any)(...args); if (s.namespace === spec.namespace && result.status === "applied") writes(args); return result; } }; } },
    agent: { session: { getSessionEntryAsync: entry } } }, agent: { registerSubagentProfile() {} },
    registerCommand: (c: any) => commands.set(c.name, c), registerTool: (t: any, o: any) => { for (const n of o?.names ?? []) tools.set(n, t); },
  } as any));
  const context: any = { ...resolveOpenClawPluginToolInputs({ options: { workspaceDir: workspace, runSessionKey: owner.sessionKey, sessionId: owner.sessionId, modelProvider: "transport", modelId: "f", assertInvocationCurrent: assertCurrent } }).context, assertInvocationCurrent: assertCurrent, runtimeContext };
  const call = (params: any, ctx = context) => build(tools.get("pstack_workflow"), ctx).execute("lead-call", params);
  const get = async (id: string) => (await call({ action: "get", workflowId: id })).details;
  const apply = async (id: string, evidence: any, extra: any = {}) => { const { view } = await get(id); return call({ action: "apply", workflowId: id, revision: view.revision, event: { id: "e" + view.revision, type: "advance", evidence, ...extra } }); };
  const run = (name: string, args: string, scheduled = false) => commands.get(name).handler({ ...owner, agentId: "worker", senderId: scheduled ? undefined : "fixture", isAuthorizedSender: true, gatewayClientScopes: ["operator.write"], channel: "webchat", config: {}, args, assertOwnerCurrent: assertCurrent, runtimeContext });
  const start = async (kind = "arena") => {
    const reply = await run("pstack-" + kind, "design-only bounded task");
    expect(reply).toEqual({ continueAgent: true, suppressReply: true });
    const records = await persisted().entriesInKeyRange({ keyStartInclusive: "", keyEndExclusive: "g", limit: 256 });
    return (records.find((r: any) => r.value.owner.sessionKey === owner.sessionKey)!.value as any).id as string;
  };
  const atLead = async (kind = "arena") => {
    const id = await start(kind);
    if (kind === "arena") { await apply(id, { "task-and-isolation": "Frozen fixture", "rubric-3-to-6": "correctness,boundary,extensibility" }); await run("pstack", "resume " + id); }
    expect((await get(id)).view.phase).toBe("lead"); return id;
  };
  return { owner, context, entry, list, writes, children, tools, get, call, apply, run, start, atLead, retire: () => { current = false; }, afterObserve: (hook: () => void) => { afterObserve = hook; } };
}
const scores = { "lead-scores": "candidates:0: correctness 5; candidates:1: correctness 4" };

it.each(["arena", "architect"])("admits %s without command activeModel; binds G atomically with F's lead scores and dispatches the recorded judge", async kind => {
  const h = harness(), id = await h.atLead(kind), before = await h.get(id);
  expect(before.record.setup).toMatchObject({ parentJudge: true, leadFirst: true, stagesVersion: 2 });
  expect(before.record.setup.snapshots.map((s: any) => s.role)).not.toContain(role);
  expect(before.record.setup.profiles[role].id).toBe("panel-judge");
  expect(h.children.map(c => /slot ([a-z]+:[a-z0-9]+)/.exec(c.params.task)![1])).toEqual(kind === "arena" ? ["candidates:0", "candidates:1"] : ["grounding:how", "grounding:why", "designs:0", "designs:1"]);
  h.writes.mockClear();
  expect(await h.run("pstack", "resume " + id, true)).toEqual({}); expect(h.writes).not.toHaveBeenCalled();
  const evidence = kind === "arena" ? scores : { "lead-scores": "designs:0: 5; designs:1: 4" };
  const result = (await h.apply(id, evidence)).details;
  expect(h.writes).toHaveBeenCalledTimes(1);
  expect(result.view.revision).toBe(before.view.revision + 1);
  expect(result.record.events.at(-1)).toMatchObject({ evidence, judge: { parentModel: F, parentFamily: "family-f", snapshot: { poolIndex: 1, diversity: "different-family", selections: [{ model: G }] } } });
  const bound = structuredClone(result.record.events.at(-1));
  const sameEvent = { ...bound }; delete sameEvent.judge; h.writes.mockClear();
  await h.call({ action: "apply", workflowId: id, revision: before.view.revision, event: sameEvent });
  expect(h.writes).not.toHaveBeenCalled();
  await writeFile(join(workspace, "pstack-models.json"), JSON.stringify(config([{ model: F }, { model: F }])));
  delete h.context.activeModel;
  await h.run("pstack", "resume " + id, true);
  const after = await h.get(id), judge = h.children.at(-1);
  expect(judge.params.model).toBe(G); expect(judge.params.profile).toBe("panel-judge");
  expect(after.view.phase).toBe("compare");
  expect(selectionCheck({ model: G }, after.view.attempts["judge:0"][0].receipts).status).toBe("confirmed");
  expect(after.record.events.find((e: any) => e.id === bound.id)).toEqual(bound);
  const replay = { ...bound }; delete replay.judge; h.writes.mockClear();
  await h.call({ action: "apply", workflowId: id, revision: before.view.revision, event: replay });
  expect(h.writes).not.toHaveBeenCalled();
});

it.each(["active", "guard", "contradiction", "family", "judge-family", "absent", "capability", "pending", "catalog", "switch", "incarnation", "changed", "retired", "same", "inherit", "gate", "forged"])("%s refuses lead without revision/write/spawn and leaves cancellation healthy", async fault => {
  const h = harness(fault === "capability" ? capabilities.filter(c => c !== "requester-model-family-v1") : capabilities), id = await h.atLead();
  const before = await persisted().lookup(workflowKey(h.owner, id)), count = h.children.length;
  if (fault === "active") delete h.context.activeModel;
  if (fault === "guard") delete h.context.assertInvocationCurrent;
  if (fault === "contradiction") h.context.activeModel.modelRef = G;
  if (fault === "family") h.list.mockResolvedValue({ revision: "none", state: "prepared", models: rows.map(({ family, ...r }) => r) } as any);
  if (fault === "judge-family") h.list.mockResolvedValue({ revision: "unknown-judge", state: "prepared", models: rows.map(r => r.id === "g" ? { ...r, family: undefined } : r) } as any);
  if (fault === "absent") h.list.mockResolvedValue({ revision: "absent", state: "prepared", models: [rows[1]] } as any);
  if (fault === "pending") h.list.mockResolvedValue({ revision: "pending", state: "pending", models: rows } as any);
  if (fault === "catalog") delete h.context.runtimeContext;
  if (fault === "switch") h.entry.mockResolvedValue({ sessionId: "one", spawnedWorkspaceDir: workspace, liveModelSwitchPending: true });
  if (fault === "incarnation") h.list.mockImplementation(async () => { h.entry.mockResolvedValue({ sessionId: "replacement", spawnedWorkspaceDir: workspace, liveModelSwitchPending: false }); return { revision: "new", state: "prepared", models: rows }; });
  if (fault === "changed") h.list.mockImplementation(async () => { h.context.activeModel = { provider: "transport", modelId: "g", modelRef: G }; return { revision: "new", state: "prepared", models: rows }; });
  if (fault === "retired") h.list.mockImplementation(async () => { h.retire(); return { revision: "new", state: "prepared", models: rows }; });
  if (fault === "same" || fault === "inherit") await writeFile(join(workspace, "pstack-models.json"), JSON.stringify(config(fault === "same" ? [{ model: F }, { model: F }] : ["inherit", "inherit"])));
  h.writes.mockClear();
  await expect(h.apply(id, fault === "gate" ? {} : scores, fault === "forged" ? { judge: {} } : {})).rejects.toThrow(/different-family|contradict|incarnation|switch|changed|retired|gate|host-owned|invocation authority/i);
  expect(h.writes).not.toHaveBeenCalled(); expect(h.children).toHaveLength(count);
  expect(await persisted().lookup(workflowKey(h.owner, id))).toEqual(before);
  // A reset/retired turn is not allowed to cancel. The still-current owner can cancel on a fresh turn.
  if (!["incarnation", "retired"].includes(fault)) expect((await h.run("pstack", "resume " + id + " cancel")).text).toContain("status cancelled");
});

it("uses lead-time config, rejects stale/concurrent writes and preserves the winning binding", async () => {
  await writeFile(join(workspace, "pstack-models.json"), JSON.stringify(config([{ model: F }, { model: F }])));
  const h = harness(), id = await h.atLead(), before = await h.get(id);
  await expect(h.apply(id, scores)).rejects.toThrow(/different-family/);
  expect((await h.get(id)).view.revision).toBe(before.view.revision);
  await writeFile(join(workspace, "pstack-models.json"), JSON.stringify(config()));
  h.writes.mockClear();
  await expect(h.call({ action: "apply", workflowId: id, revision: before.view.revision - 1, event: { id: "stale", type: "advance", evidence: scores } })).rejects.toThrow(/Stale workflow revision/);
  expect(h.writes).not.toHaveBeenCalled();
  const attempt = (name: string) => h.call({ action: "apply", workflowId: id, revision: before.view.revision, event: { id: name, type: "advance", evidence: scores } });
  const raced = await Promise.allSettled([attempt("left"), attempt("right")]);
  expect(raced.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(raced.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(h.writes).toHaveBeenCalledTimes(1);
  expect((await h.get(id)).view.revision).toBe(before.view.revision + 1);
  expect(h.children).toHaveLength(2);
});

it("validates whole config at admission and refuses forged bindings outside the lead", async () => {
  const h = harness();
  await writeFile(join(workspace, "pstack-models.json"), JSON.stringify(config([{ model: "missing/model" }, { model: G }])));
  expect((await h.run("pstack-arena", "bounded task")).text).toContain("Unavailable native model");
  expect(await persisted().count()).toBe(0); expect(h.children).toEqual([]);
  await writeFile(join(workspace, "pstack-models.json"), JSON.stringify(config()));
  const id = await h.start(), before = await h.get(id); h.writes.mockClear();
  await expect(h.apply(id, { "task-and-isolation": "x", "rubric-3-to-6": "a,b,c" }, { judge: {} })).rejects.toThrow(/host-owned/);
  expect((await h.get(id)).record).toEqual(before.record); expect(h.writes).not.toHaveBeenCalled();
  const old = structuredClone(legacy.records.arena) as RecordV1;
  await expect(h.call({ action: "create", workflowId: "forged-setup", revision: 0, setup: { ...old.setup, parentJudge: true } })).rejects.toThrow(/setup/);
});

it("refuses stored binding tampering on replay and command dispatch without another write or spawn", async () => {
  const h = harness(), id = await h.atLead(); await h.apply(id, scores);
  const valid = (await h.get(id)).record, key = workflowKey(h.owner, id);
  const corruptions = [
    (j: any) => { j.snapshot.diversity = "unverified"; },
    (j: any) => { j.catalog.find((r: any) => r.id === G).family = "family-f"; },
    (j: any) => { j.parentFamily = "wrong"; },
    (j: any) => { j.snapshot.selections = [{}]; },
    (j: any) => { j.catalog.push({ id: "extra/model", family: "extra" }); },
  ];
  for (const corrupt of corruptions) {
    const record = structuredClone(valid); corrupt(record.events.at(-1).judge);
    expect(() => workflowView(record)).toThrow(/judge|family/i);
    const observed = await persisted().observe(key);
    expect((await persisted().compareAndApply(key, observed.comparison, { operation: "update", action: "set", value: record })).status).toBe("applied");
    h.writes.mockClear();
    expect((await h.run("pstack", "resume " + id)).text).toMatch(/Pstack error/);
    expect(h.writes).not.toHaveBeenCalled(); expect(h.children).toHaveLength(2);
  }
  const misplaced = structuredClone(valid); misplaced.events.find((e: any) => e.type === "advance").judge = misplaced.events.at(-1).judge;
  expect(() => workflowView(misplaced)).toThrow(/only.*lead/);
});

it("refuses catalog conflicts instead of rewriting admitted family facts", async () => {
  const h = harness();
  const cfg = config(); cfg.roles["arena runners"] = [{ model: F }, { model: G }];
  await writeFile(join(workspace, "pstack-models.json"), JSON.stringify(cfg));
  const id = await h.atLead(), before = (await h.get(id)).record;
  h.list.mockResolvedValue({ revision: "changed", state: "prepared", models: rows.map(r => ({ ...r, family: r.id === "f" ? "new-family" : r.family })) });
  h.writes.mockClear(); await expect(h.apply(id, scores)).rejects.toThrow(/conflicts with recorded/);
  expect(h.writes).not.toHaveBeenCalled(); expect((await h.get(id)).record).toEqual(before);
});

it("replays fixed pre-change records, advances and cancels them without current-parent metadata", async () => {
  const bytes = await readFile(new URL("./fixtures/parent-judge-legacy.json", import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("b12ffa65a1983a1d67d46d2e3ed545c315fb2cde2debb1705490b12ea9f3a1e6");
  for (const [name, frozen] of Object.entries(legacy.records)) {
    let record = structuredClone(frozen) as RecordV1;
    const original = JSON.stringify(record), initial = workflowView(record);
    expect(record.setup).not.toHaveProperty("parentJudge");
    expect(workflowView(appendEvent(record, initial.revision, { id: "cancel", type: "cancel", reason: "Fixture owner cancellation" })).status).toBe("cancelled");
    if (initial.phase === "lead") record = appendEvent(record, initial.revision, { id: "lead", type: "advance", evidence: { "lead-scores": name === "arena" ? "candidates:0 5; candidates:1 4" : "designs:0 5; designs:1 4" } });
    const spawned: any[] = [];
    if (record.version === 2) {
      const key = workflowKey(record.owner, record.id);
      const deps: any = { owner: record.owner, root: process.cwd(), assertCurrent() {}, profiles: new Map(),
        store: { observe: async (k: string) => ({ value: k === key ? record : undefined, comparison: record }), apply: async (_k: string, comparison: unknown, next: RecordV1) => { expect(comparison).toBe(record); record = next; return { status: "applied" }; } },
        subagents: { spawn: async (params: any) => { spawned.push(params); return { runId: "legacy-judge", childSessionKey: "agent:fixture:subagent:new", selection: { requested: {}, resolved: {} } }; }, collect: async ({ ids }: any) => ({ completed: [], pending: ids }) } };
      await runNative(deps, record); await runNative(deps, record);
      expect(spawned).toHaveLength(1); expect(spawned[0].model).toBeUndefined();
      expect(workflowView(record).status).toBe("waiting");
      expect(workflowView(appendEvent(record, workflowView(record).revision, { id: "cancel-pending", type: "cancel", reason: "Stop" })).status).toBe("cancelled");
    } else {
      const view = workflowView(record), snapshotId = view.currentSnapshots[role]!;
      record = appendEvent(record, view.revision, { id: "judge-accept", type: "accept", slot: "judge:0", runId: "legacy-judge", childSessionKey: "agent:fixture:subagent:new", snapshotId });
      expect(workflowView(record).attempts["judge:0"]![0]!.snapshotId).toBe(snapshotId);
    }
    expect(JSON.stringify(frozen)).toBe(original);
  }
});

it("rechecks the current parent after CAS observation, leaving lead retryable on a late switch", async () => {
  const h = harness(), id = await h.atLead(), before = await h.get(id);
  h.afterObserve(() => h.entry.mockResolvedValue({ sessionId: "one", spawnedWorkspaceDir: workspace, liveModelSwitchPending: true }));
  h.writes.mockClear();
  await expect(h.call({ action: "apply", workflowId: id, revision: before.view.revision, event: { id: "late-switch", type: "advance", evidence: scores } })).rejects.toThrow(/switch is pending/);
  expect(h.writes).not.toHaveBeenCalled(); expect((await h.get(id)).record).toEqual(before.record);
  expect(h.children).toHaveLength(2);
  h.entry.mockResolvedValue({ sessionId: "one", spawnedWorkspaceDir: workspace, liveModelSwitchPending: false });
  await h.apply(id, scores); expect((await h.get(id)).view.phase).toBe("judge");
});
