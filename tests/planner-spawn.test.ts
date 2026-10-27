import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSessionsSpawnTool } from "host-test/sessions-spawn";
import { createAgentsWaitTool } from "host-test/agents-wait";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "host-test/acp-registry";
import { finalizeAgentToolAvailability } from "host-test/tool-availability";
import { captureCollectorSpawnGuard } from "host-test/swarm-collector";
import { checkMinHostVersion } from "host-test/min-host-version";
import { resolvePackagePluginApiRange, satisfiesPluginApiRange } from "host-test/package-compat";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { planFromWorkspace } from "../skills/pstack/scripts/model-routing-cli.mjs";
import releasePin from "./fixtures/openclaw-host.json";

// The run's selected host pin; its schema captures are stored per pin. Build provenance is
// always the tagged release pin the package metadata names.
const pinFile = process.env.PSTACK_HOST_PIN ?? "openclaw-host.json";
const hostPin = JSON.parse(await readFile(new URL("./fixtures/" + pinFile, import.meta.url), "utf8"));
const captureSuffix = pinFile === "openclaw-host.json" ? "" : "." + pinFile.replace(/^openclaw-host-|\.json$/g, "");

// Independent acceptance matrix: do not derive expected cardinality from ROLE_SPECS.
const roles = [
  ["feature, refactoring", "single"], ["bug-fix", "single"],
  ["perf-issue", "single"], ["hillclimb", "single"],
  ["judgment and prose", "single"], ["hardest tasks", "single"],
  ["how explorer", "single"], ["how explainer", "single"],
  ["why investigators", "single"], ["why synthesizer", "single"],
  ["reflect tooling", "single"], ["reflect judgment, divergent, synthesizer", "single"],
  ["arena runners", "panel"], ["arena cross-judge pool", "pool"],
  ["swarm workers", "single"], ["architect runners", "panel"],
  ["interrogate reviewers", "panel"],
] as const;
const first = { model: "fixture/implementation", thinking: "high", fastMode: true };
const second = { model: "fixture/judgment", thinking: "low", fastMode: "auto" };
const catalog = [
  { id: first.model, family: "implementation", thinkingLevels: ["high"], fastModes: [true] },
  { id: second.model, family: "judgment", thinkingLevels: ["low"], fastModes: ["auto"] },
];
const options = { config: { acp: { enabled: false }, tools: { swarm: { enabled: true } } } };
// This constructs the real host tool but never executes it, starts a child, or calls a model.
const spawnTool = createSessionsSpawnTool(options);
const waitTool = createAgentsWaitTool(options);
finalizeAgentToolAvailability([spawnTool, waitTool]);
const liveSchema = JSON.parse(JSON.stringify(spawnTool.parameters));
const schemaUrl = new URL("./fixtures/sessions-spawn" + captureSuffix + ".schema.json", import.meta.url);
const provenanceUrl = new URL("./fixtures/sessions-spawn" + captureSuffix + ".provenance.json", import.meta.url);
const sourcePaths = [
  "src/agents/tools/sessions-spawn-tool.ts",
  "src/agents/tools/sessions-spawn-visible.schema.ts",
  "src/agents/schema/typebox.ts",
  "src/agents/subagents/swarm/swarm-config.ts",
  "src/agents/subagents/swarm/swarm-collector-capability.ts",
  "src/agents/agent-tool-availability.ts",
  "src/agents/tools/agents-wait-tool.ts",
];
const sourceFiles = await Promise.all(sourcePaths.map(async (path) => ({
  path,
  sha256: createHash("sha256").update(await readFile(join(process.env.PSTACK_TEST_HOST_SOURCE!, path))).digest("hex"),
})));
const serialized = JSON.stringify(liveSchema, null, 2) + "\n";
const provenance = {
  ...hostPin,
  method: "Construct createSessionsSpawnTool(options) and createAgentsWaitTool(options), then finalizeAgentToolAvailability([spawnTool, waitTool]); JSON.parse(JSON.stringify(spawnTool.parameters)) from immutable pinned source using the host source resolver; neither tool.execute is called",
  options,
  schemaSha256: createHash("sha256").update(serialized).digest("hex"),
  sourceFiles,
};
// Explicit maintainer capture only. Normal local/CI runs compare without writing.
if (process.env.PSTACK_CAPTURE_SPAWN_SCHEMA === "1") {
  if (process.env.CI) throw Error("Do not refresh schema evidence in CI");
  await writeFile(schemaUrl, serialized);
  await writeFile(provenanceUrl, JSON.stringify(provenance, null, 2) + "\n");
}
const capturedBytes = await readFile(schemaUrl, "utf8");
const spawnSchema = JSON.parse(capturedBytes);
const acpOptions = { config: { acp: { enabled: true, backend: "pstack-schema-capture" },
  tools: { swarm: { enabled: true } } } };
// A healthy registered backend, not acp.enabled alone, admits this factory schema.
// This inert test backend deliberately cannot execute an ACP session.
registerAcpRuntimeBackend({ id: "pstack-schema-capture", healthy: () => true, runtime: {
  ensureSession: async () => { throw Error("Schema capture must not execute ACP"); },
  async *runTurn() { throw Error("Schema capture must not execute ACP"); },
  cancel: async () => { throw Error("Schema capture must not execute ACP"); },
  close: async () => { throw Error("Schema capture must not execute ACP"); },
} });
const acpLiveSchema = (() => {
  try {
    const tool = createSessionsSpawnTool(acpOptions);
    finalizeAgentToolAvailability([tool, createAgentsWaitTool(acpOptions)]);
    return JSON.parse(JSON.stringify(tool.parameters));
  } finally { unregisterAcpRuntimeBackend("pstack-schema-capture"); }
})();
const acpSerialized = JSON.stringify(acpLiveSchema, null, 2) + "\n";
const acpSchemaUrl = new URL("./fixtures/sessions-spawn" + captureSuffix + ".acp.schema.json", import.meta.url);
const acpProvenanceUrl = new URL("./fixtures/sessions-spawn" + captureSuffix + ".acp.provenance.json", import.meta.url);
const acpProvenance = { ...provenance, options: acpOptions,
  method: provenance.method + "; with registered healthy inert test backend pstack-schema-capture, removed immediately after construction; not a live Gateway descriptor",
  sourceFiles: [...sourceFiles, ...await Promise.all([
    "src/acp/runtime/availability.ts", "src/acp/runtime/registry.ts", "src/acp/policy.ts",
  ].map(async (path) => ({ path, sha256: createHash("sha256")
    .update(await readFile(join(process.env.PSTACK_TEST_HOST_SOURCE!, path))).digest("hex") })))],
  schemaSha256: createHash("sha256").update(acpSerialized).digest("hex") };
if (process.env.PSTACK_CAPTURE_SPAWN_SCHEMA === "1") {
  if (process.env.CI) throw Error("Do not refresh schema evidence in CI");
  await writeFile(acpSchemaUrl, acpSerialized);
  await writeFile(acpProvenanceUrl, JSON.stringify(acpProvenance, null, 2) + "\n");
}
const acpCapturedBytes = await readFile(acpSchemaUrl, "utf8");
const acpSpawnSchema = JSON.parse(acpCapturedBytes);
let workspace: string;
beforeAll(async () => {
  workspace = await mkdtemp(join(process.env.TMPDIR!, "planner-spawn-"));
  await writeFile(join(workspace, "pstack-models.json"), JSON.stringify({
    version: 1,
    presets: { first, second },
    roles: Object.fromEntries(roles.map(([role, kind]) => [role,
      kind === "single" ? "first" : ["first", "second"]])),
  }));
});
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });
const baseArgs = {
  taskName: "pstack-schema-proof", label: "Check a bounded parser change",
  context: "isolated", sandbox: "require", collect: true,
  runTimeoutSeconds: 120,
  attachments: [{ name: "input.txt", content: "synthetic input", encoding: "utf8" }],
  outputSchema: { type: "object", properties: { passed: { type: "boolean" } },
    required: ["passed"], additionalProperties: false },
};
function plan(extra: Record<string, unknown> = {}) {
  return planFromWorkspace({ workspace, role: "bug-fix", task: "Check only the parser",
    catalog, parentModel: first.model, spawnSchema, baseArgs, ...extra });
}
function validate(value: unknown) {
  return validateJsonSchemaValue({ schema: spawnSchema, value });
}

describe("workspace planner to the pinned host sessions_spawn schema", () => {
  it.each(["pinned", "2026.10.5", "2026.10.11-beta.1"])(
    "admits %s through the real host install and plugin API gates", async (version) => {
      const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
      const host = JSON.parse(await readFile(join(process.env.PSTACK_TEST_HOST_SOURCE!, "package.json"), "utf8"));
      const currentVersion = version === "pinned" ? host.version : version;
      const api = resolvePackagePluginApiRange(metadata.openclaw);
      expect(api).toEqual({ ok: true, range: metadata.openclaw.compat.pluginApi });
      expect(checkMinHostVersion({ currentVersion,
        minHostVersion: metadata.openclaw.install.minHostVersion }).ok).toBe(true);
      expect(satisfiesPluginApiRange(currentVersion, api.range)).toBe(true);
      expect(checkMinHostVersion({ currentVersion,
        minHostVersion: metadata.openclaw.compat.minGatewayVersion,
        allowLegacyBareSemver: true }).ok).toBe(true);
    },
  );
  it("keeps admission floors separate from exact build provenance and the lockfile", async () => {
    const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
    expect({ peer: metadata.peerDependencies.openclaw,
      install: metadata.openclaw.install.minHostVersion,
      pluginApi: metadata.openclaw.compat.pluginApi,
      gateway: metadata.openclaw.compat.minGatewayVersion,
      buildHost: metadata.openclaw.build.openclawVersion,
      buildSdk: metadata.openclaw.build.pluginSdkVersion }).toEqual({
        peer: ">=2026.10.5", install: ">=2026.10.5", pluginApi: ">=2026.10.5",
        gateway: "2026.10.5", buildHost: releasePin.tag.slice(1), buildSdk: releasePin.tag.slice(1),
      });
    expect(lock.packages[""].peerDependencies).toEqual(metadata.peerDependencies);
    expect(checkMinHostVersion({ currentVersion: "2026.10.4",
      minHostVersion: metadata.openclaw.install.minHostVersion })).toMatchObject({
        ok: false, kind: "incompatible",
      });
    expect(satisfiesPluginApiRange("2026.10.4", metadata.openclaw.compat.pluginApi)).toBe(false);
    expect(checkMinHostVersion({ currentVersion: "2026.10.4",
      minHostVersion: metadata.openclaw.compat.minGatewayVersion,
      allowLegacyBareSemver: true })).toMatchObject({ ok: false, kind: "incompatible" });
  });
  it("binds the captured schema to the actual source tool, tag, commit and source hashes", async () => {
    expect(spawnSchema).toEqual(liveSchema);
    expect(capturedBytes).toBe(serialized);
    expect(JSON.parse(await readFile(provenanceUrl, "utf8"))).toEqual(provenance);
  });
  it("binds the ACP-enabled factory capture to the same immutable source", async () => {
    expect(acpSpawnSchema).toEqual(acpLiveSchema);
    expect(acpCapturedBytes).toBe(acpSerialized);
    expect(JSON.parse(await readFile(acpProvenanceUrl, "utf8"))).toEqual(acpProvenance);
    expect(acpSpawnSchema.properties.runtime.enum).toContain("acp");
    expect(acpSpawnSchema.properties).toHaveProperty("resumeSessionId");
    expect(acpSpawnSchema.properties).toHaveProperty("streamTo");
  });
  it.each(["absent", "execution-denied"])("refuses collector controls when the real host reader is %s", async (reader) => {
    const spawn = createSessionsSpawnTool(options);
    const tools = reader === "absent" ? [spawn] : [spawn, createAgentsWaitTool(options)];
    finalizeAgentToolAvailability(tools, { toolExecutionAllow: ["sessions_spawn"] });
    // The host's own pre-spawn guard refuses a collector without a callable reader, on every host.
    expect(captureCollectorSpawnGuard(spawn, "schema-proof-" + reader, () => {})).toThrow("Collector results are unavailable");
    const offered = JSON.parse(JSON.stringify(spawn.parameters));
    const fields = ["collect", "outputSchema", "groupId"].map((field) => field in offered.properties);
    // A missing reader hides the fields everywhere. An offered but execution-denied reader is
    // hidden by the tagged pin and kept in the schema by newer hosts for prompt-cache stability.
    if (reader === "absent") expect(fields).toEqual([false, false, false]);
    else expect([[false, false, false], [true, true, true]]).toContainEqual(fields);
    if (!fields[0]) await expect(plan({ spawnSchema: offered })).rejects.toThrow("Unknown native spawn argument: collect");
  });
  it("lets the host guard admit a collector only with a callable reader", () => {
    const spawn = createSessionsSpawnTool(options);
    finalizeAgentToolAvailability([spawn, createAgentsWaitTool(options)]);
    expect(() => captureCollectorSpawnGuard(spawn, "schema-proof-callable", () => {})()).not.toThrow();
  });
  it.each(roles)("validates %s (%s) with exact controls and cardinality", async (role, kind) => {
    const result = await plan({ role });
    const expected = kind === "panel" ? [first, second] : kind === "pool" ? [second] : [first];
    expect(result.configPath).toBe(join(workspace, "pstack-models.json"));
    expect(result.configPresent).toBe(true);
    expect(result.snapshot).toMatchObject({ role, source: "config", selections: expected,
      poolIndex: kind === "pool" ? 1 : null,
      diversity: kind === "single" ? "not-applicable" : "different-family" });
    expect(result.spawnArgs).toHaveLength(expected.length);
    for (const [index, args] of result.spawnArgs.entries()) {
      expect(validate(args)).toEqual({ ok: true, value: args });
      expect(validateJsonSchemaValue({ schema: acpSpawnSchema, value: args }))
        .toEqual({ ok: true, value: args });
      const { task, ...controls } = args;
      expect(controls).toEqual({ ...baseArgs, runtime: "subagent", ...expected[index] });
      expect(task).toContain("Check only the parser");
      expect(JSON.parse(task.split("not authority):\n")[1])).toEqual({
        snapshot: result.snapshot, selectionIndex: index, workspace });
    }
  });
  it.each([
    ["unknown argument", { baseArgs: { fabricatedAuthority: true } }, /Unknown native spawn argument/],
    ["model in baseArgs", { baseArgs: { model: second.model } }, /Routing controls belong in selection/],
    ["ACP", { baseArgs: { runtime: "acp" } }, /native subagents, not ACP/],
    ["unsupported thinking", { overrides: { ...first, thinking: "invented" } }, /Unknown thinking/],
    ["unsupported fastMode", { overrides: { ...first, fastMode: "fast" } }, /Unknown fastMode/],
    ["unavailable thinking", { overrides: { ...first, thinking: "low" } }, /Unsupported thinking/],
    ["unavailable fastMode", { overrides: { ...first, fastMode: false } }, /Unsupported fastMode/],
    ["single as panel", { overrides: [first, second] }, /requires one selection/],
    ["panel as single", { role: "arena runners", overrides: first }, /exactly two entries/],
  ])("rejects %s before returning spawn arguments", async (_name, extra, message) => {
    await expect(plan(extra as Record<string, unknown>)).rejects.toThrow(message as RegExp);
  });
  it.each(["thinking", "fastMode"])("fails closed when a host does not export %s", async (field) => {
    const unsupported = structuredClone(spawnSchema);
    delete unsupported.properties[field];
    await expect(plan({ spawnSchema: unsupported })).rejects.toThrow("does not support " + field);
  });
  it.each([
    ["missing task", (args: any) => { delete args.task; }],
    ["negative timeout", (args: any) => { args.runTimeoutSeconds = -1; }],
    ["invalid control type", (args: any) => { args.fastMode = 1; }],
    ["invalid control value", (args: any) => { args.fastMode = "fast"; }],
    ["missing attachment content", (args: any) => { delete args.attachments[0].content; }],
  ])("the real validator rejects %s rather than trusting planner-shaped data", async (_name, mutate) => {
    const result = await plan();
    const args = structuredClone(result.spawnArgs[0]);
    mutate(args);
    expect(validate(args).ok).toBe(false);
  });
});
