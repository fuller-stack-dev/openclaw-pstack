import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { register } from "../src/index.ts";
import { build } from "./fixtures/tool-factory.ts";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { getSessionEntryAsync, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveOpenClawPluginToolInputs } from "host-test/plugin-tool-inputs";
import { applyModelOverrideToSessionEntry } from "host-test/model-overrides";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "host-test/runtime-snapshot";
import { resolveOpenClawAgentSqlitePath, closeOpenClawAgentDatabasesAsync } from "host-test/agent-database";

let workspace: string;
const first = "transport/family-a-model", second = "transport/family-b-model";
const rows = [{ provider: "transport", id: "family-a-model", name: "A", family: "family-a" },
  { provider: "transport", id: "family-b-model", name: "B", family: "family-b" }];
const schema = { type: "object", properties: { task: { type: "string" }, model: { type: "string" } } };
const saved = { version: 1, role: "arena cross-judge pool", source: "config", selections: [{ model: second }], poolIndex: 1, diversity: "different-family" };
const request = { role: "arena cross-judge pool", task: "Judge the frozen candidate packages", spawnSchema: schema };
beforeEach(async () => {
  workspace = await mkdtemp(join(process.env.TMPDIR!, "parent-model-"));
  await writeFile(join(workspace, "pstack-models.json"), JSON.stringify({ version: 1, presets: {},
    roles: { "arena cross-judge pool": [{ model: first }, { model: second }] } }));
});
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });
function harness() {
  let factory: any;
  const session = { sessionId: "one", modelProvider: "transport", model: "family-a-model", liveModelSwitchPending: false };
  const entry = vi.fn(async () => ({ ...session }));
  const list = vi.fn(async () => ({ state: "prepared", revision: "catalog-one", models: structuredClone(rows) }));
  const state = vi.fn(() => { throw Error("Role planning must not open a state store"); });
  let current = true;
  const context: any = { workspaceDir: "", sessionKey: "agent:worker:dashboard:parent", sessionId: "one", agentId: "worker",
    activeModel: { provider: "transport", modelId: "family-a-model", modelRef: first },
    assertInvocationCurrent() { if (!current) throw Error("invocation retired"); }, runtimeContext: { models: { list } } };
  const registerFactory = (capabilities = ["requester-model-catalog-v1", "requester-model-family-v1"]) => {
    register(createTestPluginApi({ id: "pstack", runtime: { capabilities, state: { openKeyedStoreV2: state },
      agent: { session: { getSessionEntryAsync: entry } } }, registerTool: (value: any, options: any) => {
        if (options?.names?.includes("pstack_route")) factory = value;
      } } as any));
  };
  registerFactory();
  context.workspaceDir = workspace;
  const tool = (overrides: any = {}) => build(factory, { ...context, ...overrides });
  const call = (args: any = request, overrides: any = {}) => tool(overrides).execute("judge-plan", args);
  return { call, tool, context, entry, list, state, session, registerFactory, retire: () => { current = false; } };
}
it("selects a different canonical family from current-turn metadata, not stale stored runtime or caller hints", async () => {
  const h = harness();
  const firstPlan = await h.call();
  expect(firstPlan.details.snapshot).toMatchObject({ poolIndex: 1, diversity: "different-family", selections: [{ model: second }] });
  expect(firstPlan.details.spawnArgs[0].model).toBe(second);
  // A new turn changed model; durable runtime metadata still describes the previous turn.
  const secondPlan = await h.call(request, { activeModel: { provider: "transport", modelId: "family-b-model", modelRef: second } });
  expect(secondPlan.details.snapshot).toMatchObject({ poolIndex: 0, diversity: "different-family", selections: [{ model: first }] });
  expect(secondPlan.details.spawnArgs[0].model).toBe(first);
  expect(h.state).not.toHaveBeenCalled();
  expect(h.entry).toHaveBeenCalledWith({ sessionKey: h.context.sessionKey, agentId: "worker", readConsistency: "latest" });
});
it("rejects forged parent facts rather than using them to choose the same family", async () => {
  const h = harness();
  await expect(h.call({ ...request, parentModel: second })).rejects.toThrow(/parent.*contradicts/i);
  await expect(h.call({ ...request, parentFamily: "family-b" })).rejects.toThrow(/parent.*contradicts/i);
  expect(h.state).not.toHaveBeenCalled();
});
it.each(["active-model", "family", "capability", "catalog", "pending-catalog", "guard", "session"].flatMap(missing => [false, true].map(resume => ({ missing, resume }))))("blocks required judge when $missing metadata is unavailable (resume=$resume)", async ({ missing, resume }) => {
  const h = harness();
  if (missing === "active-model") delete h.context.activeModel;
  if (missing === "guard") delete h.context.assertInvocationCurrent;
  if (missing === "session") delete h.context.sessionId;
  if (missing === "pending-catalog") h.list.mockResolvedValue({ state: "pending", revision: "pending", models: structuredClone(rows) } as any);
  if (missing === "family") h.list.mockResolvedValue({ state: "prepared", revision: "unknown", models: rows.map(({ family, ...row }) => row) } as any);
  if (missing === "capability") h.registerFactory([]);
  if (missing === "catalog") delete h.context.runtimeContext;
  await expect(h.call({ ...request, ...(resume ? { snapshot: saved } : {}), parentModel: first, parentFamily: "family-a", catalog: rows.map(row => ({ id: row.provider + "/" + row.id, family: row.family })) })).rejects.toThrow(/BLOCKED.*different-family/);
  const ordinary = await h.call({ role: "bug-fix", task: "Fix a bounded parser", spawnSchema: schema });
  expect(ordinary.details.snapshot.selections).toEqual([{}]);
  expect(h.state).not.toHaveBeenCalled();
});
it("refuses a same-family pool and an inherited-only pool", async () => {
  const h = harness();
  h.list.mockResolvedValue({ state: "prepared", revision: "same", models: rows.map(row => ({ ...row, family: "family-a" })) });
  await expect(h.call()).rejects.toThrow(/BLOCKED.*different-family/);
  await rm(join(workspace, "pstack-models.json"));
  await expect(h.call()).rejects.toThrow(/BLOCKED.*different-family/);
});
it.each(["reset", "switch", "retired"].flatMap(change => [false, true].map(resume => ({ change, resume }))))("rejects $change during awaited catalog preparation (resume=$resume)", async ({ change, resume }) => {
  const h = harness();
  h.list.mockImplementation(async () => {
    if (change === "reset") h.session.sessionId = "two";
    if (change === "switch") h.session.liveModelSwitchPending = true;
    if (change === "retired") h.retire();
    return { state: "prepared", revision: "changed", models: structuredClone(rows) };
  });
  await expect(h.call({ ...request, ...(resume ? { snapshot: saved } : {}) })).rejects.toThrow(/incarnation|switch|retired/);
  expect(h.state).not.toHaveBeenCalled();
});
it("refuses stale incarnation after the config read and does not accept modelRef contradictions", async () => {
  const h = harness();
  h.entry.mockResolvedValueOnce({ ...h.session }).mockResolvedValueOnce({ ...h.session, sessionId: "new" });
  await expect(h.call()).rejects.toThrow(/incarnation/);
  await expect(h.call(request, { activeModel: { provider: "transport", modelId: "family-a-model", modelRef: second } })).rejects.toThrow(/model.*contradict/i);
});
it("qualifies the host active-model producer against actual latest SQLite reads, picker changes and resets", async () => {
  const fixture = await createOpenClawTestState({ label: "parent-model-store", applyEnv: true });
  try {
    setRuntimeConfigSnapshot({});
    const h = harness();
    const scope = { agentId: "worker", sessionKey: h.context.sessionKey };
    const database = resolveOpenClawAgentSqlitePath({ agentId: scope.agentId });
    expect(database.startsWith(process.env.OPENCLAW_STATE_DIR! + "/")).toBe(true);
    console.info(JSON.stringify({ privateSessionDatabase: database }));
    const stored: any = { ...h.session, updatedAt: 1 };
    await upsertSessionEntry({ ...scope, entry: stored });
    h.entry.mockImplementation(params => getSessionEntryAsync(params) as any);
    const current = (modelId: string) => ({ ...h.context,
      ...resolveOpenClawPluginToolInputs({ options: { workspaceDir: workspace, runSessionKey: scope.sessionKey,
        sessionId: stored.sessionId, modelProvider: "transport", modelId } }).context });
    const before = await h.call(request, current("family-a-model"));
    expect(before.details.spawnArgs[0].model).toBe(second);
    // Real host picker code clears stale runtime fields; lastSubmittedModel is historical.
    stored.lastSubmittedModel = { provider: "transport", model: "family-a-model" };
    applyModelOverrideToSessionEntry({ entry: stored, selection: { provider: "transport", model: "family-b-model", isDefault: false }, markLiveSwitchPending: true });
    expect(stored.model).toBeUndefined();
    expect(stored.modelProvider).toBeUndefined();
    await upsertSessionEntry({ ...scope, entry: stored });
    await expect(h.call(request, current("family-a-model"))).rejects.toThrow(/switch is pending/);
    delete stored.liveModelSwitchPending;
    await upsertSessionEntry({ ...scope, entry: stored });
    // New turn's producer supplies B despite the missing durable runtime pair.
    expect((await h.call(request, current("family-b-model"))).details.spawnArgs[0].model).toBe(first);
    const retained = h.tool(current("family-b-model"));
    await upsertSessionEntry({ ...scope, entry: { ...stored, sessionId: "replacement" } });
    await expect(retained.execute("stale-plan", request)).rejects.toThrow(/incarnation/);
  } finally { await closeOpenClawAgentDatabasesAsync(); clearRuntimeConfigSnapshot(); await fixture.cleanup(); }
});
it("keeps role-only inspection read-only and labels unknown diversity without returning a spawn plan", async () => {
  const h = harness();
  h.registerFactory([]); delete h.context.runtimeContext; delete h.context.activeModel;
  const inspected = await h.call({ role: request.role });
  expect(inspected.details.snapshot.diversity).toBe("unverified");
  expect(inspected.details.spawnArgs).toBeUndefined();
  expect(h.entry).not.toHaveBeenCalled();
  expect(h.state).not.toHaveBeenCalled();
});
it("retains historical judge snapshots without reselection on a metadata-poor older host", async () => {
  const h = harness();
  const snapshot = { version: 1, role: request.role, source: "config", selections: [{ model: first }], poolIndex: 0, diversity: "unverified" };
  h.registerFactory([]);
  delete h.context.activeModel; delete h.context.runtimeContext; delete h.context.assertInvocationCurrent;
  const result = await h.call({ ...request, snapshot, catalog: [{ id: first }, { id: second }] });
  expect(result.details.snapshot).toEqual(snapshot);
  expect(result.details.spawnArgs[0].model).toBe(first);
  expect(h.entry).not.toHaveBeenCalled();
  expect(h.state).not.toHaveBeenCalled();
});

it.each(["taskless", "crafted"])("requires native proof for a %s snapshot claiming different-family", async origin => {
  const h = harness();
  h.registerFactory([]); delete h.context.runtimeContext;
  const catalog = rows.map(row => ({ id: row.provider + "/" + row.id, family: row.family }));
  const snapshot = origin === "taskless" ? (await h.call({ role: request.role, parentModel: first, parentFamily: "family-a", catalog })).details.snapshot : saved;
  expect(snapshot.diversity).toBe("different-family");
  // Resume accepts the role carried by the snapshot, even when the request omits it.
  await expect(h.call({ task: request.task, spawnSchema: schema, snapshot, catalog })).rejects.toThrow(/BLOCKED.*different-family/);
  expect(h.state).not.toHaveBeenCalled();
});
it.each(["same", "unknown", "opposite"])("rechecks a saved selection against current %s family without reselection", async family => {
  const h = harness();
  h.list.mockResolvedValue({ state: "prepared", revision: "fresh", models: [rows[0], { ...rows[1], family: family === "same" ? "family-a" : family === "unknown" ? undefined : "family-b" }] } as any);
  // New configuration must not replace the retained member.
  await writeFile(join(workspace, "pstack-models.json"), JSON.stringify({ version: 1, presets: {}, roles: { [request.role]: [{ model: first }, { model: first }] } }));
  const result = h.call({ ...request, snapshot: saved });
  if (family === "opposite") {
    const plan = await result;
    expect(plan.details.snapshot).toEqual(saved);
    expect(plan.details.spawnArgs[0].model).toBe(second);
  } else await expect(result).rejects.toThrow(/BLOCKED.*different-family/);
  expect(h.state).not.toHaveBeenCalled();
});

it.runIf(process.env.PSTACK_HOST_PIN === "openclaw-host-main.json")("retains the judge with families produced by the pinned main catalog and SDK projection", async () => {
  const host = process.env.PSTACK_TEST_HOST_SOURCE!;
  const { createBundledStaticCatalogModelResolver } = await import(join(host, "src/agents/embedded-agent-runner/model.static-catalog.ts"));
  const { projectRequesterModelCatalog } = await import(join(host, "src/gateway/server-methods/requester-model-catalog-projection.ts"));
  const resolve = createBundledStaticCatalogModelResolver({ includeRuntimeDiscovery: true });
  const models = [{ provider: "openai", id: "gpt-5.5" }, { provider: "anthropic", id: "claude-opus-5-5" }]
    .map(row => ({ ...resolve({ provider: row.provider, modelId: row.id }), ...row, available: true }));
  expect(models.map(row => row.family)).toEqual(["openai", "anthropic"]);
  const h = harness();
  const parent = models[0].provider + "/" + models[0].id, judge = models[1].provider + "/" + models[1].id;
  h.context.activeModel = { provider: models[0].provider, modelId: models[0].id, modelRef: parent };
  h.list.mockResolvedValue(projectRequesterModelCatalog({ models }) as any);
  const snapshot = { ...saved, selections: [{ model: judge }] };
  await writeFile(join(workspace, "pstack-models.json"), JSON.stringify({ version: 1, presets: {}, roles: { [request.role]: [{ model: parent }, { model: judge }] } }));
  const result = await h.call({ ...request, snapshot });
  expect(result.details.snapshot).toEqual(snapshot);
  expect(result.details.spawnArgs[0].model).toBe(judge);
  expect(h.state).not.toHaveBeenCalled();
});
