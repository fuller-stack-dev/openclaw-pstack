import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { createPluginStateKeyedStoreV2ForTests, resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { register } from "../src/index.ts";
import { resolveRole } from "../skills/pstack/scripts/model-routing.mjs";
import { createWorkflow, digest, workflowKey } from "../src/workflow.ts";
import { WORKFLOW_RETENTION, workflowParameters } from "../src/workflow-tool.ts";
import { normalizeToolParameters } from "host-test/tool-schema";
import { normalizeOpenAIToolSchemas } from "openclaw/plugin-sdk/provider-tools";
import { runAgentLoop } from "host-test/agent-core";
import { createAssistantMessageEventStream } from "host-test/llm-core";
import { reviewerOutput, finding, architectOutput, arenaOutput, judgeOutput } from "./fixtures/panel-outputs.mjs";
import { parseSpawnTag } from "../src/spawn-guard.ts";
import { build } from "./fixtures/tool-factory.ts";

let fixture: any, identity: { sessionKey: string; sessionId: string; workspace: string };
let serial = 0;
const spec = { namespace: "workflow-v1", maxEntries: 256, overflowPolicy: "reject-new" as const, defaultTtlMs: WORKFLOW_RETENTION.idleTtlMs };
const persisted = () => createPluginStateKeyedStoreV2ForTests("pstack", spec, { assertCurrent() {} });
beforeAll(async () => { fixture = await createOpenClawTestState({ label: "pstack-workflow", applyEnv: true }); });
afterAll(async () => { resetPluginStateStoreForTests(); await fixture.cleanup(); });
beforeEach(async () => {
  await persisted().clear();
  identity = { sessionKey: "agent:worker:dashboard:ledger-" + ++serial, sessionId: "incarnation-one", workspace: await realpath(fixture.workspaceDir) };
});
function harness() {
  const tools: any[] = [], hooks = new Map<string, any>(), registrations = new Map<string, any>();
  const entry = vi.fn(async ({ sessionKey }: any) => sessionKey === identity.sessionKey ? { sessionId: identity.sessionId, spawnedWorkspaceDir: identity.workspace } : undefined);
  const api = createTestPluginApi({ id: "pstack", runtime: {
    config: { current: () => ({}) },
    state: { openKeyedStoreV2: (s: any, opts: any) => createPluginStateKeyedStoreV2ForTests("pstack", s, { assertCurrent() {}, ...opts }) },
    agent: { session: { getSessionEntryAsync: entry }, resolveAgentWorkspaceDir: () => { throw Error("unexpected fallback"); } },
  }, registerTool: (t: any) => tools.push(t), registerCommand() {},
  on: (name: string, handler: any, options: any) => { hooks.set(name, handler); registrations.set(name, options); },
  } as any);
  register(api);
  const context = { sessionKey: identity.sessionKey, sessionId: identity.sessionId, agentId: "worker", assertInvocationCurrent() {} };
  const tool = (ctx: any = context) => tools.map(t => build(t, ctx)).find(t => t.name === "pstack_workflow");
  const call = (params: any, ctx: any = context) => tool(ctx).execute("native-tool-call", params);
  const hook = (params: any, ctx: any = context, toolName = "sessions_spawn") => hooks.get("before_tool_call")({ toolName, params }, ctx);
  return { call, hook, tool, context, entry, registrations };
}
const catalog = [{ id: "fixture/model", thinkingLevels: ["high"], fastModes: [true] }];
function setup() {
  return { kind: "how", taskDigest: digest("question"), sourceDigest: digest("frozen source"),
    snapshots: [resolveRole({ role: "how explainer", catalog, overrides: { model: "fixture/model", thinking: "high", fastMode: true } })],
    catalog, options: { complexity: "simple" } };
}
const schema = { type: "object", properties: { task: { type: "string" }, runtime: { type: "string", enum: ["subagent", "acp"] }, model: { type: "string" }, thinking: { type: "string", enum: ["high"] }, fastMode: { type: "boolean" } }, required: ["task"] };

it("persists in the real native CAS store, plans tagged native arguments, and blocks drift without rewriting", async () => {
  const h = harness();
  expect(h.registrations.get("before_tool_call")).toEqual({ matcher: ["sessions_spawn", "sessions_yield"] });
  const created = await h.call({ action: "create", workflowId: "explain", revision: 0, setup: setup() });
  expect(created.details.view).toMatchObject({ assurance: "agent-attested", phase: "explainer", revision: 1 });
  expect((await persisted().lookup(workflowKey(identity, "explain")))?.setup).toEqual(setup());
  const planned = await h.call({ action: "spawn-plan", workflowId: "explain", slot: "explainer:0", task: "Explain bounded target", spawnSchema: schema });
  const args = planned.details.spawnArgs;
  expect(args).toMatchObject({ runtime: "subagent", model: "fixture/model", thinking: "high", fastMode: true });
  expect(args.task).toContain("[PSTACK_SNAPSHOT:");
  expect(await h.hook(args)).toBeUndefined();
  const wrong = { ...args, fastMode: false }, before = structuredClone(wrong);
  expect(await h.hook(wrong)).toMatchObject({ block: true, blockReason: expect.stringContaining("fastMode") });
  expect(wrong).toEqual(before);
  expect(await h.hook(wrong, h.context, "other_tool")).toBeUndefined();
  expect(await h.hook({ task: "ordinary untagged spawn", model: "unrelated" })).toBeUndefined();
  expect(await h.hook({ task: "[PSTACK_SNAPSHOT:malformed" })).toMatchObject({ block: true });
  expect(await h.hook({ task: "Explain PSTACK_SNAPSHOT without tagging this spawn" })).toBeUndefined();
  expect((await h.call({ action: "get", workflowId: "explain" })).details.record).toEqual(created.details.record);
});

it("plans panel children with their closed output contract and persists only contract-valid collections", async () => {
  const h = harness();
  const reviewers = { kind: "interrogate", taskDigest: digest("review"), sourceDigest: digest("frozen head"), catalog,
    snapshots: [resolveRole({ role: "interrogate reviewers", catalog, overrides: [{ model: "fixture/model", thinking: "high" }, { model: "fixture/model", fastMode: true }] })], options: {} };
  await h.call({ action: "create", workflowId: "review", revision: 0, setup: reviewers });
  await h.call({ action: "apply", workflowId: "review", revision: 1, event: { id: "frame", type: "advance", evidence: { intent: "intent", "frozen-head": "a".repeat(40), rubric: "rubric" } } });
  const plan = (await h.call({ action: "spawn-plan", workflowId: "review", slot: "reviewers:1", task: "Review frozen head", spawnSchema: schema })).details;
  expect(plan.outputContract).toBe("interrogate-reviewer");
  expect(plan.spawnArgs).toMatchObject({ model: "fixture/model", fastMode: true });
  const embedded = plan.spawnArgs.task.match(/Output contract `interrogate-reviewer`[^\n]*\n(\{.*\})/);
  expect(JSON.parse(embedded[1]).required).toEqual(["findings", "lenses", "testAssessment"]);
  expect(plan.spawnArgs.task.trimEnd().endsWith("]")).toBe(true);
  expect(parseSpawnTag(plan.spawnArgs)).toMatchObject({ slot: "reviewers:1", snapshotId: plan.snapshotId });
  expect(await h.hook(plan.spawnArgs)).toBeUndefined();
  await h.call({ action: "apply", workflowId: "review", revision: 2, event: { id: "admit", type: "accept", slot: "reviewers:1", runId: "r1", childSessionKey: "agent:worker:subagent:r1", snapshotId: plan.snapshotId } });
  const before = await persisted().lookup(workflowKey(identity, "review"));
  const collect = (id: string, status: string, output: unknown) => h.call({ action: "apply", workflowId: "review", revision: 3, event: { id, type: "collect", slot: "reviewers:1", runId: "r1", result: { status, artifactDigest: digest("report"), evidence: ["report.md#findings"], output } } });
  await expect(collect("bad", "PASS", reviewerOutput([finding("critical")]))).rejects.toThrow("PASS cannot carry critical or warning findings");
  await expect(collect("bad-shape", "ISSUES", { findings: [] })).rejects.toThrow("missing required field lenses");
  expect(await persisted().lookup(workflowKey(identity, "review"))).toEqual(before);
  const ok = await collect("good", "ISSUES", reviewerOutput([finding("critical")]));
  expect(ok.details.view.attempts["reviewers:1"][0].result.output.findings[0].severity).toBe("critical");
  await h.call({ action: "create", workflowId: "plain", revision: 0, setup: setup() });
  const plain = (await h.call({ action: "spawn-plan", workflowId: "plain", slot: "explainer:0", task: "Explain", spawnSchema: schema })).details;
  expect(plain.outputContract).toBeNull();
  expect(plain.spawnArgs.task).not.toContain("Output contract");
});

describe("documented panel flow through the tool", () => {
  // Uses only what the docs tell an agent: spawn-plan, the native accept IDs, and the
  // child's returned JSON. No digest is computed and no label is invented here.
  const panel = (role: string) => resolveRole({ role, catalog, overrides: [{ model: "fixture/model", thinking: "high" }, { model: "fixture/model", fastMode: true }] });
  async function run(h: ReturnType<typeof harness>, id: string, slot: string, revision: number, output: (plan: any) => unknown, status = "PASS") {
    const plan = (await h.call({ action: "spawn-plan", workflowId: id, slot, task: "Bounded " + slot, spawnSchema: schema })).details;
    expect(await h.hook(plan.spawnArgs)).toBeUndefined();
    const runId = "run-" + slot;
    await h.call({ action: "apply", workflowId: id, revision, event: { id: "accept-" + slot, type: "accept", slot, runId, childSessionKey: "agent:worker:subagent:" + runId, snapshotId: plan.snapshotId } });
    const result = { status, artifactDigest: digest(slot), evidence: ["artifact#" + slot], ...(status === "BLOCKED" ? {} : { output: output(plan) }) };
    await h.call({ action: "apply", workflowId: id, revision: revision + 1, event: { id: "collect-" + slot, type: "collect", slot, runId, result } });
    return plan;
  }
  it("architect: designs collect without a runner-computed digest, and the judge scores the labels its plan names", async () => {
    const h = harness();
    await h.call({ action: "create", workflowId: "arch", revision: 0, setup: { kind: "architect", taskDigest: digest("design"), sourceDigest: digest("source"), catalog,
      snapshots: [panel("architect runners"), panel("arena cross-judge pool")], options: { intent: "design-only" } } });
    await h.call({ action: "apply", workflowId: "arch", revision: 1, event: { id: "ground", type: "advance", evidence: { how: "how.md", "rationale-constraints": "why.md" } } });
    await run(h, "arch", "designs:0", 2, () => architectOutput("message pipeline"));
    await run(h, "arch", "designs:1", 4, () => architectOutput("immutable events"));
    await h.call({ action: "apply", workflowId: "arch", revision: 6, event: { id: "designs", type: "advance", evidence: {} } });
    let judgeTask = "";
    const plan = await run(h, "arch", "judge:0", 7, (planned) => {
      judgeTask = planned.spawnArgs.task;
      return judgeOutput(planned.candidates.map((c: any) => c.label));
    });
    expect(plan.candidates).toEqual([{ label: "designs:0", path: "/task/designs/message-pipeline/README.md" }, { label: "designs:1", path: "/task/designs/immutable-events/README.md" }]);
    expect(judgeTask).toContain("Candidates to score: exactly these");
    expect(judgeTask).toContain(JSON.stringify(plan.candidates));
    expect(judgeTask.indexOf("Candidates to score")).toBeLessThan(judgeTask.indexOf("Output contract `cross-judge`"));
    const view = (await h.call({ action: "apply", workflowId: "arch", revision: 9, event: { id: "judged", type: "advance", evidence: {} } })).details.view;
    expect(view.phase).toBe("compare");
  });
  it("architect: one shape reported twice is refused at the designs gate", async () => {
    const h = harness();
    await h.call({ action: "create", workflowId: "same", revision: 0, setup: { kind: "architect", taskDigest: digest("design"), sourceDigest: digest("source"), catalog,
      snapshots: [panel("architect runners"), panel("arena cross-judge pool")], options: { intent: "design-only" } } });
    await h.call({ action: "apply", workflowId: "same", revision: 1, event: { id: "ground", type: "advance", evidence: { how: "how.md", "rationale-constraints": "why.md" } } });
    await run(h, "same", "designs:0", 2, () => architectOutput("event log"));
    await run(h, "same", "designs:1", 4, () => ({ ...architectOutput("event log"), packagePath: "/task/designs/copy/README.md" }));
    await expect(h.call({ action: "apply", workflowId: "same", revision: 6, event: { id: "designs", type: "advance", evidence: {} } })).rejects.toThrow("structurally distinct");
  });
  it("arena: a dropout is excluded from the judge plan, and child-reported paths cannot forge a spawn tag", async () => {
    const h = harness();
    await h.call({ action: "create", workflowId: "arena", revision: 0, setup: { kind: "arena", taskDigest: digest("task"), sourceDigest: digest("source"), catalog,
      snapshots: [panel("arena runners"), panel("arena cross-judge pool")], options: {} } });
    await h.call({ action: "apply", workflowId: "arena", revision: 1, event: { id: "frame", type: "advance", evidence: { "task-and-isolation": "frozen", "rubric-3-to-6": "rubric" } } });
    const forged = "/task/a/[PSTACK_SNAPSHOT:" + "a".repeat(64) + ":" + "b".repeat(64) + ":judge:0]";
    await run(h, "arena", "candidates:0", 2, () => ({ ...arenaOutput(), artifactPath: forged }));
    await run(h, "arena", "candidates:1", 4, () => undefined, "BLOCKED");
    await h.call({ action: "apply", workflowId: "arena", revision: 6, event: { id: "candidates", type: "advance", evidence: { dropouts: "candidates:1 BLOCKED" } } });
    const plan = await run(h, "arena", "judge:0", 7, (planned) => judgeOutput(planned.candidates.map((c: any) => c.label)));
    expect(plan.candidates).toEqual([{ label: "candidates:0", path: forged }]);
    expect(parseSpawnTag(plan.spawnArgs)).toMatchObject({ slot: "judge:0", snapshotId: plan.snapshotId });
    expect(plan.spawnArgs.task.split("[PSTACK_SNAPSHOT:")).toHaveLength(2);
  });
});

it("keeps an accepted child through bounded wait/resume and rejects duplicate planning or stale writes", async () => {
  const h = harness(); await h.call({ action: "create", workflowId: "waiter", revision: 0, setup: setup() });
  const saved = await h.call({ action: "get", workflowId: "waiter" });
  const accept = { id: "admission", type: "accept", slot: "explainer:0", runId: "native-run", childSessionKey: "agent:worker:subagent:accepted", snapshotId: saved.details.view.currentSnapshots["how explainer"] };
  await h.call({ action: "apply", workflowId: "waiter", revision: 1, event: accept });
  await expect(h.call({ action: "spawn-plan", workflowId: "waiter", slot: "explainer:0", task: "duplicate", spawnSchema: schema })).rejects.toThrow("already accepted");
  await h.call({ action: "apply", workflowId: "waiter", revision: 2, event: { id: "handoff", type: "wait", timeoutSeconds: 3 } });
  await expect(h.call({ action: "apply", workflowId: "waiter", revision: 2, event: { id: "stale", type: "resume" } })).rejects.toThrow("Stale");
  await h.call({ action: "apply", workflowId: "waiter", revision: 3, event: { id: "resume", type: "resume" } });
  const view = (await h.call({ action: "get", workflowId: "waiter" })).details.view;
  expect(view.attempts["explainer:0"]).toEqual([{ runId: "native-run", childSessionKey: "agent:worker:subagent:accepted", snapshotId: accept.snapshotId }]);
});

it("uses native exact-incarnation ownership, not supplied identities, and requires the host invocation guard for writes", async () => {
  const h = harness();
  await expect(h.call({ action: "create", workflowId: "private", revision: 0, setup: setup() }, { ...h.context, assertInvocationCurrent: undefined })).rejects.toThrow("BLOCKED");
  expect(await persisted().count()).toBe(0);
  await h.call({ action: "create", workflowId: "private", revision: 0, setup: setup() });
  const plan = await h.call({ action: "spawn-plan", workflowId: "private", slot: "explainer:0", task: "scope", spawnSchema: schema });
  for (const ctx of [{ ...h.context, sessionId: "reset" }, { ...h.context, sessionKey: "agent:worker:subagent:foreign" }, { ...h.context, agentId: "other" }]) {
    await expect(h.call({ action: "get", workflowId: "private" }, ctx)).rejects.toThrow();
    expect(await h.hook(plan.details.spawnArgs, ctx)).toMatchObject({ block: true });
  }
  await expect(h.call({ action: "get", workflowId: "private", sessionId: "forged" })).rejects.toThrow("Invalid workflow arguments");
  const aborted = new AbortController(); aborted.abort();
  expect(await h.hook(plan.details.spawnArgs, { ...h.context, abortSignal: aborted.signal })).toMatchObject({ block: true });
});

it("rejects authority revocation after awaited native owner resolution without publishing state", async () => {
  const h = harness(); let current = true;
  h.entry.mockImplementationOnce(async () => { current = false; return { sessionId: identity.sessionId, spawnedWorkspaceDir: identity.workspace }; });
  await expect(h.call({ action: "create", workflowId: "revoked", revision: 0, setup: setup() }, { ...h.context, assertInvocationCurrent() { if (!current) throw Error("revoked"); } })).rejects.toThrow("revoked");
  expect(await persisted().count()).toBe(0);
});

it("preserves explicit nested objects through provider normalization and refuses coercion/action-specific extras", async () => {
  const h = harness();
  // prepareArguments must throw rather than let native schema coercion rewrite a revision.
  expect(() => h.tool().prepareArguments({ action: "create", workflowId: "bad", revision: "0", setup: setup() })).toThrow("Invalid pstack_workflow");
  for (const provider of ["openai", "google", "anthropic"]) {
    const [normalized] = normalizeOpenAIToolSchemas({ provider, modelId: provider === "google" ? "gemini-3.1-pro" : provider === "anthropic" ? "claude-opus-5-5" : "gpt-6.1-sol", modelApi: provider === "google" ? "google-generative-ai" : provider === "anthropic" ? "anthropic-messages" : "openai-responses", tools: [normalizeToolParameters({ ...h.tool(), parameters: workflowParameters }, { modelProvider: provider })] });
    const args = { action: "create", workflowId: "provider-" + provider, revision: 0, setup: setup() };
    const result = await ingress(normalized, args);
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    expect((await persisted().lookup(workflowKey(identity, args.workflowId)))?.setup).toEqual(args.setup);
    const invalid = await ingress(normalized, { ...args, workflowId: "bad-" + provider, revision: "0" });
    expect(invalid.isError).toBe(true);
  }
  await expect(h.call({ action: "get", workflowId: "missing", revision: 0 })).rejects.toThrow("Unexpected fields");
  await expect(h.call({ action: "create", workflowId: "bad", revision: 0, setup: { ...setup(), options: { complexity: "simple", unexplained: true } } })).rejects.toThrow("Invalid options");
  expect(await persisted().count()).toBe(3);
});

// Script only model I/O. The pinned host owns preparation, normalization,
// argument validation, execution/error conversion and tool-result events.
async function ingress(tool: any, args: any) {
  let turns = 0;
  const streamFn = () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const first = ++turns === 1;
      const message = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture",
        content: first ? [{ type: "toolCall", id: "ingress", name: tool.name, arguments: args }] : [{ type: "text", text: "done" }],
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: message.stopReason, message } as any);
    });
    return stream;
  };
  const messages = await runAgentLoop([{ role: "user", content: "Bounded workflow fixture", timestamp: Date.now() }],
    { systemPrompt: "No model or native child execution", messages: [], tools: [tool] },
    { model: { id: "fixture", name: "Fixture", api: "fixture", provider: "fixture", baseUrl: "http://localhost:0", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 } as any,
      convertToLlm: (messages: any) => messages }, () => {}, undefined, streamFn as any);
  expect(turns).toBe(2);
  const result = messages.find((message: any) => message.role === "toolResult") as any;
  expect(result?.toolCallId).toBe("ingress");
  return result;
}


it("uses the native worker CAS to publish only one competing exact-revision transition", async () => {
  const h = harness();
  await h.call({ action: "create", workflowId: "concurrent", revision: 0, setup: setup() });
  const contenders = [{ id: "writer-a", type: "block", reason: "dependency" }, { id: "writer-b", type: "cancel", reason: "user stop" }];
  const results = await Promise.allSettled(contenders.map(event => h.call({ action: "apply", workflowId: "concurrent", revision: 1, event })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const failure = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  expect(failure.reason.message).toMatch(/Concurrent|Stale/);
  const saved = await persisted().lookup(workflowKey(identity, "concurrent")) as any;
  expect(saved.events).toHaveLength(1);
  expect(contenders).toContainEqual(saved.events[0]);
  const beforeReplay = structuredClone(saved);
  await h.call({ action: "apply", workflowId: "concurrent", revision: 1, event: saved.events[0] });
  expect(await persisted().lookup(workflowKey(identity, "concurrent"))).toEqual(beforeReplay);
});

it("refreshes a bounded idle expiry on every write and keeps a terminal record readable for 24 hours", async () => {
  const h = harness();
  const ttl = async (id: string) => { const row = (await persisted().entries()).find(e => e.key === workflowKey(identity, id))!; return row.expiresAt! - row.createdAt; };
  await h.call({ action: "create", workflowId: "idle", revision: 0, setup: setup() });
  expect(await ttl("idle")).toBe(WORKFLOW_RETENTION.idleTtlMs);
  await h.call({ action: "apply", workflowId: "idle", revision: 1, event: { id: "pause", type: "block", reason: "dependency" } });
  expect(await ttl("idle")).toBe(WORKFLOW_RETENTION.idleTtlMs);
  await h.call({ action: "apply", workflowId: "idle", revision: 2, event: { id: "stop", type: "cancel", reason: "user stop" } });
  expect(await ttl("idle")).toBe(WORKFLOW_RETENTION.terminalTtlMs);
  expect((await h.call({ action: "get", workflowId: "idle" })).details.view.status).toBe("cancelled");
});

describe("gateway-wide ledger capacity", () => {
  const fill = async (owners: { sessionKey: string; sessionId: string }[]) => {
    const store = persisted();
    for (let i = 0; i < WORKFLOW_RETENTION.maxEntries; i++) {
      const owner = { ...owners[i % owners.length]!, workspace: identity.workspace }, id = "filler-" + i;
      await store.register(workflowKey(owner, id), createWorkflow(id, owner, setup() as any));
    }
    expect(await store.count()).toBe(WORKFLOW_RETENTION.maxEntries);
  };

  it("recovers from exhaustion by sweeping records of replaced or deleted incarnations only", async () => {
    const h = harness();
    // Half belong to this live incarnation; the rest to its replaced predecessor and to deleted sessions.
    await fill([{ sessionKey: identity.sessionKey, sessionId: identity.sessionId }, { sessionKey: identity.sessionKey, sessionId: "incarnation-zero" },
      { sessionKey: identity.sessionKey, sessionId: identity.sessionId }, { sessionKey: "agent:worker:dashboard:deleted", sessionId: "gone" }]);
    const created = await h.call({ action: "create", workflowId: "after-exhaustion", revision: 0, setup: setup() });
    expect(created.details.view.revision).toBe(1);
    const left = await persisted().entries();
    const owners = left.map(e => (e.value as any).owner.sessionId);
    expect(owners.filter(id => id === identity.sessionId)).toHaveLength(129);
    expect(owners.filter(id => id !== identity.sessionId).length).toBeLessThan(128);
    // Every live-incarnation record survives intact and stays readable.
    expect((await h.call({ action: "get", workflowId: "filler-0" })).details.record.id).toBe("filler-0");
  });

  it("reports a named BLOCKED gate and deletes nothing when every record is live", async () => {
    const h = harness();
    await fill([{ sessionKey: identity.sessionKey, sessionId: identity.sessionId }]);
    const before = (await persisted().entries()).map(e => e.key).sort();
    await expect(h.call({ action: "create", workflowId: "one-too-many", revision: 0, setup: setup() }))
      .rejects.toThrow("BLOCKED: the gateway-wide workflow ledger holds 256 live records after retention");
    expect((await persisted().entries()).map(e => e.key).sort()).toEqual(before);
  });

  it("scans past a first batch of live records when the namespace is full", async () => {
    const h = harness();
    const live = { sessionKey: identity.sessionKey, sessionId: identity.sessionId, workspace: identity.workspace };
    const keys = Array.from({ length: 255 }, (_, i) => workflowKey(live, "live-" + i)).sort();
    // One unreachable record whose key sorts after the first 64-row batch.
    const stale = { sessionKey: identity.sessionKey, sessionId: "incarnation-zero", workspace: identity.workspace };
    let n = 0; while (workflowKey(stale, "stale-" + n) <= keys[WORKFLOW_RETENTION.sweepBatch]!) n++;
    const store = persisted();
    for (let i = 0; i < 255; i++) await store.register(workflowKey(live, "live-" + i), createWorkflow("live-" + i, live, setup() as any));
    await store.register(workflowKey(stale, "stale-" + n), createWorkflow("stale-" + n, stale, setup() as any));
    await h.call({ action: "create", workflowId: "fits", revision: 0, setup: setup() });
    expect(await persisted().lookup(workflowKey(stale, "stale-" + n))).toBeUndefined();
    expect(await persisted().count()).toBe(256);
  });

  it("keeps an unreachable row that changed after the scan read it", async () => {
    const h = harness();
    await fill([{ sessionKey: "agent:worker:dashboard:deleted", sessionId: "gone" }]);
    // The scan reads every row, then looks up the owner; a concurrent writer changes one row in between.
    let touched = false, changedKey = "";
    h.entry.mockImplementation(async ({ sessionKey }: any) => {
      if (sessionKey === "agent:worker:dashboard:deleted" && !touched) {
        touched = true;
        const rows = await persisted().entriesInKeyRange({ keyStartInclusive: "", keyEndExclusive: "g", limit: 1 });
        const record = { ...(rows[0]!.value as any), events: [{ id: "late", type: "block", reason: "concurrent writer" }] };
        await persisted().register(rows[0]!.key, record);
        changedKey = rows[0]!.key;
        return undefined;
      }
      return sessionKey === identity.sessionKey ? { sessionId: identity.sessionId, spawnedWorkspaceDir: identity.workspace } : undefined;
    });
    await h.call({ action: "create", workflowId: "after-race", revision: 0, setup: setup() });
    expect(((await persisted().lookup(changedKey)) as any)?.events).toEqual([{ id: "late", type: "block", reason: "concurrent writer" }]);
    expect(await persisted().count()).toBeLessThan(WORKFLOW_RETENTION.maxEntries);
  });

  it("keeps rows whose session lookup fails, and sweeps nothing below the threshold", async () => {
    const h = harness();
    await fill([{ sessionKey: "agent:worker:dashboard:unreadable", sessionId: "unknown" }]);
    h.entry.mockImplementation(async ({ sessionKey }: any) => {
      if (sessionKey === "agent:worker:dashboard:unreadable") throw Error("session store unavailable");
      return sessionKey === identity.sessionKey ? { sessionId: identity.sessionId, spawnedWorkspaceDir: identity.workspace } : undefined;
    });
    await expect(h.call({ action: "create", workflowId: "blocked", revision: 0, setup: setup() })).rejects.toThrow("BLOCKED");
    expect(await persisted().count()).toBe(256);
    await persisted().clear();
    const stale = { sessionKey: identity.sessionKey, sessionId: "incarnation-zero", workspace: identity.workspace };
    await persisted().register(workflowKey(stale, "old"), createWorkflow("old", stale, setup() as any));
    // A fresh registration starts its sweep cursor at the beginning of the namespace.
    await harness().call({ action: "create", workflowId: "fresh", revision: 0, setup: setup() });
    expect(await persisted().lookup(workflowKey(stale, "old"))).toBeDefined();
  });
});

it("rechecks the exact incarnation after awaited reads and after workspace resolution", async () => {
  const h = harness();
  await h.call({ action: "create", workflowId: "recheck", revision: 0, setup: setup() });
  const live = { sessionId: identity.sessionId, spawnedWorkspaceDir: identity.workspace }, reset = { ...live, sessionId: "reset-during-read" };
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "pstack-moved-workspace-")));
  const moved = { ...live, spawnedWorkspaceDir: elsewhere };
  try {
    // get/spawn-plan: the first owner resolution reads twice. The post-read recheck must catch a reset
    // and also a same-incarnation owner whose workspace changed (which owner resolution alone accepts).
    for (const params of [{ action: "get", workflowId: "recheck" }, { action: "spawn-plan", workflowId: "recheck", slot: "explainer:0", task: "t", spawnSchema: schema }]) {
      h.entry.mockImplementationOnce(async () => live).mockImplementationOnce(async () => live).mockImplementationOnce(async () => reset);
      await expect(h.call(params)).rejects.toThrow("incarnation changed");
      h.entry.mockImplementationOnce(async () => live).mockImplementationOnce(async () => live)
        .mockImplementationOnce(async () => moved).mockImplementationOnce(async () => moved);
      await expect(h.call(params)).rejects.toThrow("Workflow requester changed during preparation");
    }
  } finally { await rm(elsewhere, { recursive: true, force: true }); }
  // Owner resolution itself: the session resets while its workspace is resolved.
  h.entry.mockImplementationOnce(async () => live).mockImplementationOnce(async () => reset);
  await expect(h.call({ action: "create", workflowId: "never", revision: 0, setup: setup() })).rejects.toThrow("changed during workspace resolution");
  expect(await persisted().lookup(workflowKey(identity, "never"))).toBeUndefined();
  expect((await h.call({ action: "get", workflowId: "recheck" })).details.record.id).toBe("recheck");
});
