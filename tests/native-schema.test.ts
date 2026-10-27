import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { normalizeOpenAIToolSchemas } from "openclaw/plugin-sdk/provider-tools";
import { createPluginStateKeyedStoreV2ForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { normalizeToolParameters } from "host-test/tool-schema";
import { runAgentLoop } from "host-test/agent-core";
import { createAssistantMessageEventStream } from "host-test/llm-core";
import { register } from "../src/index.ts";
import { build } from "./fixtures/tool-factory.ts";

// Factory schemas at the immutable pin, not a live Gateway effective descriptor.
// planner-spawn.test.ts verifies both captures and adjacent provenance.
const spawnSchemas = await Promise.all(["sessions-spawn.schema.json", "sessions-spawn.acp.schema.json"]
  .map(async (name) => [name, JSON.parse(
    await readFile(new URL("./fixtures/" + name, import.meta.url), "utf8"),
  )] as const));
const sol = { model: "openai/gpt-6.1-sol", thinking: "high", fastMode: true };
const opus = { model: "anthropic/claude-opus-5-5" };
const providers = ["openai", "anthropic", "google"];
const catalog = [
  { id: sol.model, family: "gpt-sol" },
  { id: opus.model, family: "claude-opus" },
];
// Independent acceptance list, not derived from the implementation's role table.
const roles = [
  ["feature, refactoring", "single"],
  ["bug-fix", "single"],
  ["perf-issue", "single"],
  ["hillclimb", "single"],
  ["judgment and prose", "single"],
  ["hardest tasks", "single"],
  ["how explorer", "single"],
  ["how explainer", "single"],
  ["why investigators", "single"],
  ["why synthesizer", "single"],
  ["reflect tooling", "single"],
  ["reflect judgment, divergent, synthesizer", "single"],
  ["arena runners", "panel"],
  ["arena cross-judge pool", "pool"],
  ["swarm workers", "single"],
  ["architect runners", "panel"],
  ["interrogate reviewers", "panel"],
];
let root: string, workspace: string, config: any;
beforeEach(async () => {
  root = await mkdtemp(join(process.env.TMPDIR!, "native-schema-case-"));
  workspace = join(root, "requester-workspace");
  await mkdir(workspace);
  config = {
    version: 1,
    presets: { sol, opus },
    roles: Object.fromEntries(
      roles.map(([role, kind]) => [
        role,
        kind === "single" ? (role === "hardest tasks" ? "opus" : "sol") : ["sol", "opus"],
      ]),
    ),
  };
  await saveConfig();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function saveConfig() {
  await writeFile(join(workspace, "pstack-models.json"), JSON.stringify(config));
}
function nativeTool(workspaceDir: string | undefined, provider = "openai") {
  let factory: any;
  register(
    createTestPluginApi({
      id: "pstack",
      runtime: { state: { openKeyedStoreV2: (spec: any, opts: any) =>
        createPluginStateKeyedStoreV2ForTests("pstack", spec, opts) } },
      registerTool: (value: any, options: any) => {
        if (options?.names?.includes("pstack_route")) factory = value;
      },
    } as any),
  );
  const source = build(factory, {
    workspaceDir,
    sessionKey: "agent:worker:subagent:native-schema-requester",
    sessionId: "native-schema-incarnation",
    agentId: "worker",
  });
  const execute = vi.spyOn(source, "execute");
  // The real host normalization is part of every admission, not a local copy.
  const normalized = normalizeToolParameters(source, { modelProvider: provider });
  const [tool] = normalizeOpenAIToolSchemas({
    provider,
    modelId:
      provider === "google"
        ? "gemini-3.1-pro"
        : provider === "anthropic"
          ? "claude-opus-5-5"
          : "gpt-6.1-sol",
    modelApi:
      provider === "google"
        ? "google-generative-ai"
        : provider === "anthropic"
          ? "anthropic-messages"
          : "openai-responses",
    tools: [normalized],
  });
  return { tool, execute };
}
async function dispatch(
  args: any,
  options: {
    workspaceDir?: string;
    missingWorkspace?: boolean;
    provider?: string;
    block?: boolean;
  } = {},
) {
  const h = nativeTool(
    options.missingWorkspace ? undefined : (options.workspaceDir ?? workspace),
    options.provider,
  );
  const id = "native-ingress-call";
  const events: any[] = [];
  let turns = 0;
  const beforeToolCall = vi.fn(async () =>
    options.block ? { block: true, reason: "Requester policy denies pstack_route" } : undefined,
  );
  // Only model I/O is scripted. The real loop owns argument validation,
  // beforeToolCall admission, dispatch, error conversion and result events.
  const streamFn = () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      turns++;
      const message = {
        role: "assistant",
        api: "fixture",
        provider: "fixture",
        model: "fixture",
        content:
          turns === 1
            ? [{ type: "toolCall", id, name: h.tool.name, arguments: args }]
            : [{ type: "text", text: "done" }],
        stopReason: turns === 1 ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: "done", reason: message.stopReason, message } as any);
    });
    return stream;
  };
  const messages = await runAgentLoop(
    [{ role: "user", content: "Plan the assigned task", timestamp: Date.now() }],
    {
      systemPrompt: "Native ingress fixture; no model or spawn execution",
      messages: [],
      tools: [h.tool],
    },
    {
      model: {
        id: "fixture",
        name: "Fixture",
        api: "fixture",
        provider: "fixture",
        baseUrl: "http://localhost:0",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      } as any,
      convertToLlm: (messages: any) => messages,
      beforeToolCall,
    },
    (event: any) => {
      events.push(event);
    },
    undefined,
    streamFn as any,
  );
  expect(turns).toBe(2);
  const result = messages.find((message: any) => message.role === "toolResult") as any;
  expect(result?.toolCallId).toBe(id);
  return {
    ...h,
    result,
    end: events.find((event) => event.type === "tool_execution_end"),
    beforeToolCall,
  };
}
function accepted(run: any) {
  expect(run.result.isError, JSON.stringify(run.result)).toBe(false);
  expect(run.execute).toHaveBeenCalledTimes(1);
  expect(run.beforeToolCall).toHaveBeenCalledTimes(1);
  expect(run.end).toMatchObject({ executionStarted: true, isError: false });
  return run.result.details;
}
function rejected(run: any, error: RegExp, stage: "schema" | "planner" = "planner") {
  expect(run.result.isError).toBe(true);
  expect(JSON.stringify(run.result.content)).toMatch(error);
  if (stage === "schema") {
    expect(run.execute).not.toHaveBeenCalled();
    expect(run.beforeToolCall).not.toHaveBeenCalled();
    expect(run.end).toMatchObject({
      executionStarted: false,
      isError: true,
      errorKind: "argument-validation",
    });
  } else {
    expect(run.execute).toHaveBeenCalledTimes(1);
    expect(run.end).toMatchObject({ executionStarted: true, isError: true });
  }
}

function strictRejected(run: any, args: any, field: string) {
  rejected(run, /Validation failed/, "schema");
  const message = run.result.content.find((part: any) => part.type === "text").text;
  const received = JSON.parse(message.split("\n\nReceived arguments:\n")[1]);
  const rejection = received.__pstack_invalid_arguments__;
  expect(rejection.originalArguments).toEqual(args);
  expect(rejection.diagnostics.join("; ")).toContain(field);
  expect(rejection.diagnostics.length).toBeLessThanOrEqual(8);
  expect(rejection.diagnostics.every((line: string) => line.length <= 256)).toBe(true);
  return rejection;
}

describe.each(spawnSchemas)("pstack_route through native normalization and dispatch with %s", (_name, spawnSchema) => {
  function request(extra: any = {}) {
    return { role: "bug-fix", task: "Repair the assigned parser only", catalog, spawnSchema, ...extra };
  }
  it.each(roles)(
    "plans exact role %s (%s), preserving configured controls and workspace lineage",
    async (role, kind) => {
      const run = await dispatch(request({ role, parentModel: sol.model }));
      const result = accepted(run);
      const selections =
        kind === "panel"
          ? [sol, opus]
          : kind === "pool" || role === "hardest tasks"
            ? [opus]
            : [sol];
      expect(result.snapshot).toEqual({
        version: 1,
        role,
        source: "config",
        selections,
        poolIndex: kind === "pool" ? 1 : null,
        // The fixture catalog gives the two panel entries different families.
        diversity: kind === "single" ? "not-applicable" : "different-family",
      });
      expect(result.configPath).toBe(join(workspace, "pstack-models.json"));
      expect(result.spawnArgs).toHaveLength(selections.length);
      for (const [index, args] of result.spawnArgs.entries()) {
        expect(args).toMatchObject({ runtime: "subagent", ...selections[index] });
        const marker = JSON.parse(args.task.split("not authority):\n")[1]);
        expect(marker).toEqual({ snapshot: result.snapshot, selectionIndex: index, workspace });
      }
      expect(run.beforeToolCall.mock.calls[0][0].args).toEqual(
        request({ role, parentModel: sol.model }),
      );
    },
  );
  it("plans a blind trial through the tool: no model IDs, role or workspace in the task, custody returned separately", async () => {
    const task = "Make the retry policy handle a 429 with Retry-After.";
    const trialArgs = [{ cwd: join(root, "trial-north") }, { cwd: join(root, "trial-south") }];
    const result = accepted(await dispatch(request({ role: "arena runners", task, blind: true, withheld: ["429 and 503 are retried; 400 is not"], trialArgs })));
    expect(result.hostBlind.status).toBe("unavailable");
    expect(result.spawnArgs.map((args: any) => args.task)).toEqual([task, task]);
    expect(result.spawnArgs.map((args: any) => args.cwd)).toEqual(trialArgs.map((args) => args.cwd));
    expect(result.spawnArgs[0]).toMatchObject(sol);
    expect(result.spawnArgs[1]).toMatchObject(opus);
    for (const hidden of [sol.model, opus.model, "arena", workspace]) expect(JSON.stringify(result.spawnArgs.map((args: any) => args.task))).not.toContain(hidden);
    expect(result.custody).toEqual([0, 1].map((selectionIndex) => ({ snapshot: result.snapshot, selectionIndex, workspace })));
  });
  it("admits nested dynamic host schema and baseArgs without pinning or stripping them", async () => {
    const dynamicSchema = structuredClone(spawnSchema);
    dynamicSchema.properties.futureNativeOption = {
      type: "object",
      properties: { nested: { type: "array", items: { type: "boolean" } } },
    };
    const baseArgs = {
      taskName: "schema-proof",
      context: "isolated",
      sandbox: "require",
      collect: true,
      placement: { kind: "local" },
      attachments: [{ name: "input.txt", content: "fixture", encoding: "utf8" }],
      outputSchema: {
        type: "object",
        properties: { value: { anyOf: [{ type: "number" }, { type: "null" }] } },
        required: ["value"],
        additionalProperties: false,
      },
      futureNativeOption: { nested: [true, false] },
    };
    const result = accepted(await dispatch(request({ spawnSchema: dynamicSchema, baseArgs })));
    expect(result.spawnArgs[0]).toMatchObject(baseArgs);
    expect(result.spawnArgs[0]).toMatchObject(sol);
    expect(result.spawnArgs[0]).not.toHaveProperty("user");
  });
  it("accepts catalog capability metadata and explicit panel overrides", async () => {
    const result = accepted(
      await dispatch(
        request({
          role: "arena runners",
          overrides: [sol, opus],
          catalog: [
            { ...catalog[0], thinkingLevels: ["high"], fastModes: [true, "auto", "ultrafast"] },
            catalog[1],
          ],
        }),
      ),
    );
    expect(result.snapshot).toMatchObject({ source: "override", selections: [sol, opus] });
    expect(result.spawnArgs[1]).toMatchObject(opus);
    expect(result.spawnArgs[1]).not.toHaveProperty("thinking");
    expect(result.spawnArgs[1]).not.toHaveProperty("fastMode");
  });
  describe.each(providers)("%s full native provider matrix", (provider) => {
    const saved = (role: string, selections: any[], poolIndex: number | null = null, diversity = poolIndex === null ? "not-applicable" : "different-family") => ({
      version: 1,
      role,
      source: "config",
      selections,
      poolIndex,
      diversity,
    });
    const single = saved("bug-fix", [sol]);
    const pool0 = saved("arena cross-judge pool", [sol], 0);
    const pool1 = saved("arena cross-judge pool", [opus], 1);
    it.each([
      ["plan", {}, single],
      ["resume single", { snapshot: single }, single],
      ["resume pool index 0", { role: pool0.role, snapshot: pool0 }, pool0],
      ["resume pool index 1", { role: pool1.role, snapshot: pool1 }, pool1],
      ["object override", { overrides: sol }, { ...single, source: "override" }],
      [
        "preset-string override",
        { overrides: "opus" },
        { ...single, source: "override", selections: [opus] },
      ],
      [
        "panel override",
        { role: "arena runners", overrides: [sol, opus] },
        { ...saved("arena runners", [sol, opus], null, "different-family"), source: "override" },
      ],
    ])("admits %s with exact controls and snapshot", async (_name, extra, expected) => {
      const result = accepted(await dispatch(request(extra), { provider }));
      expect(result.snapshot).toEqual(expected);
      expect(result.spawnArgs).toHaveLength(expected.selections.length);
      for (const [index, args] of result.spawnArgs.entries()) {
        const { task, runtime, ...controls } = args;
        expect(runtime).toBe("subagent");
        expect(controls).toEqual(expected.selections[index]);
        expect(JSON.parse(task.split("not authority):\n")[1])).toEqual({
          snapshot: expected,
          selectionIndex: index,
          workspace,
        });
      }
    });
    it("admits confirm ultrafast with native service-tier proof", async () => {
      const requested = { ...sol, fastMode: "ultrafast" };
      const evidence = {
        source: "native-trace",
        model: sol.model,
        provider: "openai",
        thinking: "high",
        fastMode: "ultrafast",
        serviceTier: "ultrafast",
      };
      const result = accepted(
        await dispatch(
          {
            action: "confirm",
            requested,
            receipt: { status: "accepted", resolvedModel: sol.model, resolvedProvider: "openai" },
            evidence,
          },
          { provider },
        ),
      );
      expect(result).toEqual({
        status: "confirmed",
        checks: {
          model: "confirmed",
          provider: "confirmed",
          thinking: "confirmed",
          fastMode: "confirmed",
          serviceTier: "confirmed",
        },
        observed: {
          model: sol.model,
          provider: "openai",
          thinking: "high",
          fastMode: "ultrafast",
          serviceTier: "ultrafast",
        },
      });
    });
    it.each(["true", 1])("retains raw mismatching evidence fastMode %j", async (fastMode) => {
      const result = accepted(
        await dispatch(
          {
            action: "confirm",
            requested: sol,
            receipt: { resolvedModel: sol.model, resolvedProvider: "openai" },
            evidence: { source: "native-status", thinking: "high", fastMode },
          },
          { provider },
        ),
      );
      expect(result.status).toBe("mismatch");
      expect(result.checks.fastMode).toBe("mismatch");
      expect(result.observed.fastMode).toBe(fastMode);
    });
    it.each([
      ["unknown control", { overrides: { ...sol, fastMode: "fast" } }, /Unknown fastMode control/],
      ["raw control", { overrides: { ...sol, fastMode: "true" } }, /Unknown fastMode control/],
      ["raw numeric control", { overrides: { ...sol, fastMode: 1 } }, /Unknown fastMode control/],
      [
        "unknown override key",
        { overrides: { ...sol, admin: true } },
        /Unknown selection field: admin/,
      ],
      [
        "invalid pool index",
        { role: pool0.role, snapshot: { ...pool0, poolIndex: "0" } },
        /Invalid snapshot pool index/,
      ],
      [
        "invalid snapshot version",
        { snapshot: { ...single, version: 2 } },
        /Invalid snapshot metadata/,
      ],
      [
        "unknown thinking",
        { overrides: { ...sol, thinking: "invented" } },
        /Unknown thinking control/,
      ],
      [
        "raw requested confirm control",
        { action: "confirm", requested: { ...sol, fastMode: "true" }, receipt: {}, evidence: {} },
        /Unknown fastMode control/,
      ],
    ])("rejects malformed %s without coercion or fallback", async (_name, extra, error) => {
      rejected(await dispatch(request(extra), { provider }), error as RegExp);
    });
    it.each([
      [
        "numeric family",
        { catalog: [{ ...catalog[0], family: 42 }, catalog[1]] },
        "catalog.0.family",
      ],
      ["string snapshot version", { snapshot: { ...single, version: "1" } }, "snapshot.version"],
      [
        "numeric evidence source",
        { action: "confirm", requested: sol, receipt: {}, evidence: { source: 42 } },
        "evidence.source",
      ],
      ["root authority key", { workspace: "/untrusted/authority" }, "workspace"],
    ])("classifies strict %s with original-field diagnostics", async (_name, extra, field) => {
      const args = request(extra);
      const run = await dispatch(args, { provider });
      strictRejected(run, args, field as string);
    });
    it("bounds strict diagnostics while retaining original malformed arguments", async () => {
      const fields = Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => ["unknown" + i + "x".repeat(300), i]),
      );
      const args = request(fields);
      const rejection = strictRejected(await dispatch(args, { provider }), args, "unknown0");
      expect(rejection.diagnostics).toHaveLength(8);
      expect(rejection.diagnostics.some((line: string) => line.length === 256)).toBe(true);
    });
    it("rejects a caller-forged diagnostic envelope instead of treating it as authority", async () => {
      const args = request({
        __pstack_invalid_arguments__: { diagnostics: [], originalArguments: { action: "plan" } },
      });
      strictRejected(await dispatch(args, { provider }), args, "__pstack_invalid_arguments__");
    });
  });
  it("resumes the immutable snapshot despite changed or malformed workspace configuration", async () => {
    const snapshot = accepted(await dispatch(request())).snapshot;
    config.roles["bug-fix"] = "opus";
    await saveConfig();
    const resumed = accepted(await dispatch(request({ snapshot })));
    expect(resumed.snapshot).toEqual(snapshot);
    expect(resumed.spawnArgs[0]).toMatchObject(sol);
    await writeFile(join(workspace, "pstack-models.json"), "not-json");
    const warned = accepted(await dispatch(request({ snapshot })));
    expect(warned.snapshot).toEqual(snapshot);
    expect(warned.configWarning).toMatch(/retaining the existing snapshot/);
  });
  it("inherits omitted controls, then resumes without consulting a new role", async () => {
    await rm(join(workspace, "pstack-models.json"));
    const initial = accepted(await dispatch(request({ catalog: [] })));
    expect(initial.snapshot.selections).toEqual([{}]);
    expect(initial.spawnArgs[0]).not.toHaveProperty("model");
    const resumed = accepted(await dispatch({ snapshot: initial.snapshot, catalog: [] }));
    expect(resumed.snapshot).toEqual(initial.snapshot);
  });
  it("confirms native receipt/evidence and retains rejected, mismatch and unverified outcomes", async () => {
    const receipt = {
      status: "accepted",
      childSessionKey: "agent:worker:subagent:fixture",
      runId: "fixture-run",
      resolvedModel: sol.model,
      resolvedProvider: "openai",
      hostMetadata: { future: [1, null] },
    };
    const evidence = {
      source: "native-status",
      model: sol.model,
      provider: "openai",
      thinking: "high",
      fastMode: true,
    };
    const confirm = (extra: any = {}) =>
      dispatch({ action: "confirm", requested: sol, receipt, evidence, ...extra });
    expect(accepted(await confirm())).toMatchObject({
      status: "confirmed",
      checks: { model: "confirmed", thinking: "confirmed", fastMode: "confirmed" },
    });
    expect(
      accepted(await confirm({ receipt: { status: "forbidden", error: "requester denied" } })),
    ).toEqual({ status: "rejected", checks: {}, observed: {} });
    expect(accepted(await confirm({ evidence: { ...evidence, model: opus.model } }))).toMatchObject(
      { status: "mismatch", checks: { model: "mismatch" } },
    );
    expect(accepted(await confirm({ evidence: {} }))).toMatchObject({
      status: "unverified",
      checks: { thinking: "unverified", fastMode: "unverified" },
    });
    expect(
      accepted(
        await dispatch({
          action: "confirm",
          requested: { fastMode: "ultrafast" },
          receipt,
          evidence: { source: "native-trace", fastMode: "ultrafast" },
        }),
      ),
    ).toMatchObject({ status: "unverified", checks: { serviceTier: "unverified" } });
  });
  it("blocks valid planning at an agent-core beforeToolCall policy callback boundary", async () => {
    const args = request();
    const run = await dispatch(args, { block: true });
    expect(run.beforeToolCall).toHaveBeenCalledTimes(1);
    expect(run.beforeToolCall.mock.calls[0][0].args).toEqual(args);
    expect(run.execute).not.toHaveBeenCalled();
    expect(run.result.isError).toBe(true);
    expect(JSON.stringify(run.result.content)).toContain("Requester policy denies pstack_route");
    expect(run.end.executionStarted).toBe(false);
  });
  it.each([
    ["catalog record unknown key", { catalog: [{ ...catalog[0], admin: true }] }],
    ["catalog record missing id", { catalog: [{ family: "gpt-sol" }] }],
    ["catalog array item", { catalog: ["openai/gpt-6.1-sol"] }],
    ["catalog capability shape", { catalog: [{ ...catalog[0], fastModes: "true" }] }],
    [
      "snapshot unknown key",
      {
        snapshot: {
          version: 1,
          role: "bug-fix",
          source: "config",
          selections: [sol],
          poolIndex: null,
          diversity: "not-applicable",
          extra: true,
        },
      },
    ],
    [
      "evidence unknown key",
      {
        action: "confirm",
        requested: sol,
        receipt: {},
        evidence: { source: "native-status", admin: true },
      },
    ],
    [
      "requested unknown key",
      { action: "confirm", requested: { ...sol, admin: true }, receipt: {} },
    ],
    ["unknown action", { action: "spawn" }],
    ["unknown role", { role: "almost-bug-fix" }],
    ["host schema not an object", { spawnSchema: [] }],
    ["baseArgs not an object", { baseArgs: [] }],
  ])("rejects %s before dispatch", async (_name, extra) => {
    const args = request(extra);
    const run = await dispatch(args);
    const field = Object.keys(extra)[0];
    strictRejected(
      run,
      args,
      extra.action === "confirm" ? ("evidence" in extra ? "evidence" : "requested") : field,
    );
  });
  it.each([
    ["duplicate catalog", { catalog: [catalog[0], catalog[0]] }, /Duplicate catalog/],
    ["non-native model ID", { catalog: [{ id: "not-a-native-id" }] }, /exact native provider/],
    ["empty family", { catalog: [{ ...catalog[0], family: " " }] }, /Invalid model family/],
    ["unavailable model", { catalog: [catalog[1]] }, /Unavailable native model/],
    [
      "unsupported capability",
      { catalog: [{ ...catalog[0], fastModes: [false] }, catalog[1]] },
      /Unsupported fastMode/,
    ],
    [
      "native schema control unsupported",
      {
        spawnSchema: {
          type: "object",
          properties: {
            task: { type: "string" },
            model: { type: "string" },
            thinking: { type: "string" },
            fastMode: { type: "boolean", const: false },
          },
        },
      },
      /does not support fastMode/,
    ],
    [
      "native schema missing",
      { spawnSchema: { properties: {} } },
      /sessions_spawn schema required/,
    ],
    [
      "unknown dynamic spawn argument",
      { baseArgs: { fabricatedAuthority: true } },
      /Unknown native spawn argument/,
    ],
    [
      "routing control in baseArgs",
      { baseArgs: { model: opus.model } },
      /Routing controls belong in selection/,
    ],
    ["ACP runtime", { baseArgs: { runtime: "acp" } }, /native subagents, not ACP/],
    [
      "visible thinking override",
      { baseArgs: { visible: true } },
      /visible sessions do not accept thinking/,
    ],
    ["empty task", { task: " " }, /bounded task is required/],
    ["single-role panel override", { overrides: [sol, opus] }, /requires one selection/],
    [
      "family contradiction",
      { role: "arena cross-judge pool", parentModel: sol.model, parentFamily: "claude-opus" },
      /contradicts native catalog/,
    ],
  ])("retains strict planner rejection: %s", async (_name, extra, error) => {
    rejected(await dispatch(request(extra)), error as RegExp);
  });
  it("rejects invalid snapshot cardinality and replacement on resume", async () => {
    const snapshot = accepted(await dispatch(request())).snapshot;
    rejected(
      await dispatch(request({ snapshot: { ...snapshot, selections: [sol, opus] } })),
      /Invalid snapshot cardinality/,
    );
    rejected(await dispatch(request({ snapshot, overrides: opus })), /cannot be replaced/);
    rejected(await dispatch(request({ snapshot, role: "hardest tasks" })), /cannot be replaced/);
  });
  it("fails closed for malformed config, unused unknown config roles and missing requester workspace", async () => {
    await writeFile(join(workspace, "pstack-models.json"), "null");
    rejected(await dispatch(request()), /Config must be an object/);
    config.roles["unrecognized role"] = "sol";
    await saveConfig();
    rejected(await dispatch(request()), /Unknown pstack role/);
    rejected(
      await dispatch(request(), { missingWorkspace: true }),
      /Requester workspace is unavailable/,
    );
  });
});
