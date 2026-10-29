import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdir, writeFile, chmod, realpath, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveChatSendCallerContext } from "host-test/caller-context";
import { createCapturedPluginRegistration } from "host-test/captured-registration";
import { resolveCommandAuthorizationAsync } from "openclaw/plugin-sdk/command-auth-native";
import { register } from "../src/index.ts";
import {
  hash,
  keyOf,
  readMode,
  transition,
  importLegacy,
  importCurrentLegacy,
  cleanupStale,
  MAX_RECORDS,
  type Identity,
} from "../src/state.ts";
import { build } from "./fixtures/tool-factory.ts";
import { createEmptyPluginRegistry } from "host-test/empty-registry";
import { initializeGlobalHookRunner, getGlobalHookRunner, resetGlobalHookRunner } from "host-test/hook-runner-global";
import { runBeforeToolCallHook, wrapToolWithBeforeToolCallHook } from "host-test/before-tool-call";
import { createSessionsYieldTool } from "host-test/sessions-yield";
let fixture: any,
  identity: Identity,
  serial = 0;
const store = (assertCurrent: () => void = () => {}) =>
  createPluginStateKeyedStoreV2ForTests(
    "pstack",
    { namespace: "session-mode-v2", maxEntries: MAX_RECORDS, overflowPolicy: "reject-new" },
    { assertCurrent },
  );
beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "pstack-plugin", applyEnv: true });
});
afterAll(async () => {
  resetPluginStateStoreForTests();
  await fixture.cleanup();
});
beforeEach(async () => {
  await store().clear();
  await rm(join(fixture.workspaceDir, ".pstack-session-state"), { recursive: true, force: true });
  identity = {
    userId: "profile-user",
    sessionKey: "agent:worker:dashboard:test-" + ++serial,
    sessionId: "incarnation-1",
    workspace: await realpath(fixture.workspaceDir),
  };
});
function harness(bareRouteAliases = false) {
  const commands = new Map<string, any>(),
    hooks = new Map<string, any>(),
    hookOptions = new Map<string, any>(),
    tools: any[] = [];
  const entry = vi.fn(async ({ sessionKey }: any) =>
    sessionKey === identity.sessionKey
      ? { sessionId: identity.sessionId, spawnedWorkspaceDir: identity.workspace }
      : undefined,
  );
  const fallback = vi.fn(() => {
    throw Error("must prefer spawned workspace");
  });
  const config = { plugins: { entries: { pstack: { hooks: { allowConversationAccess: true } } } } };
  const current = vi.fn(() => config);
  const api = createTestPluginApi({
    id: "pstack",
    pluginConfig: { bareRouteAliases },
    runtime: {
      config: { current },
      state: { openKeyedStoreV2: (_spec: any, opts: any) => store(opts?.assertCurrent) },
      agent: { session: { getSessionEntryAsync: entry }, resolveAgentWorkspaceDir: fallback },
    },
    registerCommand: (c: any) => commands.set(c.name, c),
    on: (n: string, h: any, o?: any) => { hooks.set(n, h); hookOptions.set(n, o); },
    registerTool: (t: any) => tools.push(t),
  } as any);
  register(api);
  const command = (arg = "on", overrides: any = {}, alias = "pstack") =>
    commands.get(alias).handler({
      senderId: identity.userId,
      isAuthorizedSender: true,
      gatewayClientScopes: ["operator.write"],
      channel: "webchat",
      agentId: "worker",
      sessionKey: identity.sessionKey,
      sessionId: identity.sessionId,
      args: arg,
      commandBody: "/" + alias + " " + arg,
      config,
      ...overrides,
    });
  const prompt = (overrides: any = {}) =>
    hooks.get("before_prompt_build")(
      { prompt: "ordinary follow-up", messages: [] },
      {
        sessionKey: identity.sessionKey,
        sessionId: identity.sessionId,
        agentId: "worker",
        hookInvocation: { assertActive() {} },
        ...overrides,
      },
    );
  return { api, command, prompt, entry, fallback, hooks, hookOptions, tools, config, current, commands };
}
describe("registration capability gate", () => {
  it.each(["cli-metadata", "full"] as const)("captures the real host CLI root under the %s runtime contract", (registrationMode) => {
    // cli-metadata supplies the host's real throwing runtime Proxy, not a stub.
    const captured = createCapturedPluginRegistration({ id: "pstack", registrationMode });
    expect(() => register(captured.api)).not.toThrow();
    expect(captured.cliRegistrars.map(entry => entry.commands)).toEqual([["pstack"]]);
  });
  it("keeps real captured full registration fail-closed when V2 is unavailable", () => {
    const captured = createCapturedPluginRegistration({ id: "pstack", registrationMode: "full" });
    // Only the unavailable legacy capability is varied; registrations are host-owned.
    Object.assign(captured.api, { runtime: { state: {} } });
    expect(() => register(captured.api)).toThrow("Pstack requires keyed-store V2");
    expect(captured.cliRegistrars).toEqual([]);
    expect(captured.tools).toEqual([]);
  });
  it.each([{}, { state: {} }, { state: { openKeyedStoreV2: null } },
    { state: { openKeyedStoreV2: "legacy" } }])(
    "rejects unavailable keyed-store V2 before registering any surface (%j)", (runtime) => {
      const registerCommand = vi.fn(), on = vi.fn(), registerTool = vi.fn(), registerCli = vi.fn();
      const api = createTestPluginApi({ id: "pstack", runtime,
        registerCommand, on, registerTool, registerCli } as any);
      expect(() => register(api)).toThrow(
        "Pstack requires keyed-store V2 (api.runtime.state.openKeyedStoreV2): use OpenClaw >=2026.10.10-beta.2 or a current main build that exports this contract.",
      );
      for (const registration of [registerCommand, on, registerTool, registerCli])
        expect(registration).not.toHaveBeenCalled();
    },
  );
  it("registers with the pinned host SDK and persists through its real V2 store", async () => {
    const h = harness();
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const names = h.tools.map((factory: any) => build(factory, { workspaceDir: identity.workspace }).name);
    expect(names).toEqual(["pstack_route", "pstack_plan_check", "pstack_brief", "pstack_trail", "pstack_worktree_audit", "pstack_workflow"]);
    expect([...names].sort()).toEqual([...manifest.contracts.tools].sort());
    // tool_result_persist (1.2.4) only adds the note to a yield whose waitFor the guard removed.
    expect([...h.hooks.keys()]).toEqual(["before_prompt_build", "before_tool_call", "tool_result_persist"]);
    expect(await h.command("on")).toEqual({ text: "Pstack on (revision 1)." });
    expect(await readMode(store(), identity)).toMatchObject({ active: true, revision: 1 });
  });
});
describe("verified commands and exact-session state", () => {
  it("runs on/status/alias off with no reply_dispatch, event handoff or SenderId", async () => {
    const h = harness();
    expect(await h.command()).toMatchObject({ text: "Pstack on (revision 1)." });
    const before = await store().entries();
    expect((await h.command("status")).text).toContain("revision 1");
    expect(await store().entries()).toEqual(before);
    expect((await h.command("off", {}, "poteto_mode")).text).toContain("revision 2");
    expect(await h.prompt()).toBeUndefined();
    expect(h.entry).toHaveBeenCalledWith({
      sessionKey: identity.sessionKey,
      agentId: "worker",
      readConsistency: "latest",
    });
    expect(h.fallback).not.toHaveBeenCalled();
  });
  it("keeps help/status/absent off and unsupported panels noncreating", async () => {
    const h = harness();
    for (const arg of ["help", "status", "off", "Architect", "ARENA", "Interrogate", "ReSuMe"]) {
      const r = await h.command(arg);
      expect(r.continueAgent).toBeUndefined();
    }
    expect(await store().count()).toBe(0);
    expect(await h.prompt()).toBeUndefined();
  });
  it("validates before activation then continues a normal task", async () => {
    const h = harness();
    expect((await h.command("x".repeat(16001))).text).toContain("not changed");
    expect(await store().count()).toBe(0);
    expect(await h.command("fix the parser")).toEqual({ continueAgent: true, suppressReply: true });
    expect((await h.prompt()).prependContext).toContain("Pstack mode is active");
  });
  it("rejects unauthorized/unknown/channel-scoped callers without writes", async () => {
    const h = harness();
    for (const options of [
      { isAuthorizedSender: false },
      { senderId: undefined },
      { gatewayClientScopes: ["operator.read"] },
      { channel: "discord" },
      { sessionId: undefined },
      { agentId: "other" },
    ])
      expect((await h.command("on", options)).text).toMatch(/rejected|error/);
    expect(await store().count()).toBe(0);
  });
  it("rejects accepted-suggestion synthetic callers using real host sender derivation", async () => {
    const h = harness();
    const caller = resolveChatSendCallerContext({
      connect: {
        client: { id: "openclaw-control-ui", mode: "webchat" },
        scopes: ["operator.admin", "operator.write"],
      },
      authenticatedUserId: "authenticated-person",
      authenticatedUserProfile: { profileId: identity.userId },
      internal: {
        syntheticClient: true,
        senderAttribution: {
          id: identity.userId,
          identity: { type: "profile", id: identity.userId },
          name: "Suggested by fixture",
        },
      },
    } as any);
    const auth = await resolveCommandAuthorizationAsync({
      ctx: caller,
      cfg: h.config,
      commandAuthorized: true,
    } as any);
    expect(auth.senderId).toBeUndefined();
    expect(
      (
        await h.command("on", {
          channel: "internal",
          ...auth,
          gatewayClientScopes: caller.GatewayClientScopes,
        })
      ).text,
    ).toContain("rejected");
    expect(await store().count()).toBe(0);
  });
  it("binds macOS/CLI commands to the host client sender, not the Control UI profile", async () => {
    const h = harness();
    for (const clientId of ["openclaw-macos", "cli"]) {
      const caller = resolveChatSendCallerContext({
        connect: {
          client: { id: clientId, mode: "ui" },
          scopes: ["operator.admin", "operator.write"],
        },
        authenticatedUserId: "authenticated-person",
        authenticatedUserProfile: { profileId: identity.userId },
      } as any);
      const auth = await resolveCommandAuthorizationAsync({
        ctx: caller,
        cfg: h.config,
        commandAuthorized: true,
      } as any);
      expect(auth.senderId).toBe(clientId);
      expect((await h.command("on", { ...auth, channel: "internal" })).text).toContain(
        "on (revision 1)",
      );
      expect((await h.command("off")).text).toContain("another activating requester");
      expect((await readMode(store(), identity))?.active).toBe(true);
      expect((await h.command("off", { ...auth, channel: "internal" })).text).toContain(
        "off (revision 2)",
      );
      await store().clear();
    }
  });
  it("recognizes mixed-case first-token controls without agent continuation", async () => {
    const h = harness();
    expect(await h.command("Off")).toEqual({ text: "Pstack off (revision 0)." });
    expect(await store().count()).toBe(0);
    expect(await h.command("ON")).toEqual({ text: "Pstack on (revision 1)." });
    expect((await h.command("Status trailing words")).text).toContain("on; exact incarnation");
    expect((await h.command("HeLP")).text).toContain("Pstack:");
    expect(await h.command("OfF trailing words")).toEqual({
      text: "Pstack off (revision 2). Trailing text was ignored; use /pstack <task> to run a task.",
    });
    expect((await h.command("ON ignored task")).text).toContain("Trailing text was ignored");
    expect((await h.command("help ignored task")).text).toContain("Trailing text was ignored");
    await h.command("off");
    expect(await h.prompt()).toBeUndefined();
    expect(await h.command("Architect a parser fix")).toEqual({
      continueAgent: true,
      suppressReply: true,
    });
    expect((await readMode(store(), identity))?.revision).toBe(5);
  });
  it("commits off and on despite an unrelated native lookup error or malformed row", async () => {
    const h = harness();
    const ghost = { ...identity, sessionKey: "agent:ghost:dashboard:unrelated" };
    await transition(store(), ghost, true);
    await store().register("bad-key", {
      version: 2,
      identity: { ...identity, sessionKey: "invalid" },
      active: true,
      revision: 1,
    });
    h.entry.mockImplementation(async ({ sessionKey }: any) => {
      if (sessionKey === ghost.sessionKey) throw Error("unknown agent ghost");
      return { sessionId: identity.sessionId, spawnedWorkspaceDir: identity.workspace };
    });
    expect(await h.command("on")).toEqual({ text: "Pstack on (revision 1)." });
    expect(await h.command("off")).toEqual({ text: "Pstack off (revision 2)." });
    expect(await h.command("on")).toEqual({ text: "Pstack on (revision 3)." });
    expect(await readMode(store(), ghost)).toMatchObject({ active: true, revision: 1 });
    expect(await store().lookup("bad-key")).toBeDefined();
  });
  it("shares command/hook keys despite a different hook workspace and uses live fallback", async () => {
    const h = harness();
    const runWorkspace = join(identity.workspace, "different-run-workspace");
    await mkdir(runWorkspace, { recursive: true });
    await h.command("on");
    expect((await h.prompt({ workspaceDir: runWorkspace })).prependContext).toContain(
      "Pstack mode is active",
    );
    expect(await readMode(store(), { ...identity, workspace: runWorkspace })).toBeUndefined();
    h.entry.mockResolvedValue({ sessionId: identity.sessionId } as any);
    const liveConfig = { agents: { defaults: { workspace: identity.workspace } } };
    h.current.mockReturnValue(liveConfig as any);
    h.fallback.mockImplementation((cfg: any, agent: any) => {
      expect(cfg).toEqual(liveConfig);
      expect(agent).toBe("worker");
      return identity.workspace;
    });
    expect((await h.command("status", { config: {} })).text).toContain("on; exact incarnation");
    expect((await h.prompt({ workspaceDir: runWorkspace })).prependContext).toContain(
      "Pstack mode is active",
    );
    expect(h.current).toHaveBeenCalledWith({ clone: true });
    expect((await h.command("off", { config: {} })).text).toContain("off (revision 2)");
    expect(await h.prompt({ workspaceDir: runWorkspace })).toBeUndefined();
  });
  it("reports stored-only status when public hook policy prevents activation", async () => {
    const h = harness();
    await h.command("on");
    expect((await h.command("status")).text).not.toContain("blocked");
    const before = await store().entries();
    for (const hooks of [
      {},
      { allowConversationAccess: false },
      { allowConversationAccess: true, allowPromptInjection: false },
    ]) {
      expect(
        (await h.command("status", { config: { plugins: { entries: { pstack: { hooks } } } } }))
          .text,
      ).toContain("stored mode only: prompt injection is blocked");
    }
    expect(await store().entries()).toEqual(before);
  });
  it("is value-idempotent and monotonically revisions actual changes", async () => {
    const a = await transition(store(), identity, true);
    await transition(store(), identity, true);
    expect((await readMode(store(), identity))?.revision).toBe(a?.revision);
    await transition(store(), identity, false);
    await transition(store(), identity, false);
    expect((await readMode(store(), identity))?.revision).toBe(2);
    await transition(store(), identity, true);
    expect((await readMode(store(), identity))?.revision).toBe(3);
  });
  it("preserves the activating requester and refuses another profile mutation", async () => {
    await transition(store(), identity, true);
    await expect(
      transition(store(), { ...identity, userId: "other-profile" }, false),
    ).rejects.toThrow("another activating requester");
    expect((await readMode(store(), identity))?.active).toBe(true);
  });
  it("isolates resets and child session keys while preserving requester tool policy", async () => {
    await transition(store(), identity, true);
    expect(await readMode(store(), { ...identity, sessionId: "reset" })).toBeUndefined();
    expect(
      await readMode(store(), { ...identity, sessionKey: "agent:worker:subagent:child" }),
    ).toBeUndefined();
    const h = harness();
    expect((await h.prompt()).prependContext).toContain(
      "native requester tool policy still applies",
    );
  });
  it("injects active context without a runContext/profile and stops immediately off", async () => {
    const h = harness();
    expect(await h.prompt()).toBeUndefined();
    await h.command("on");
    expect((await h.prompt()).prependContext).toContain("skills/pstack/SKILL.md");
    await h.command("off");
    expect(await h.prompt()).toBeUndefined();
  });
  it("keeps inactive preparation failures silent and reports actual corrupt lookup", async () => {
    const h = harness();
    h.entry.mockRejectedValueOnce(Error("transient host preparation"));
    expect(await h.prompt()).toBeUndefined();
    await store().register(keyOf(identity), { broken: true });
    expect((await h.prompt()).prependContext).toContain("FAILED CLOSED");
    expect((await h.command("off")).text).toContain("Corrupt");
    expect(await store().lookup(keyOf(identity))).toEqual({ broken: true });
  });
  it("does not inject for missing or superseded native incarnation", async () => {
    const h = harness();
    await h.command();
    expect(await h.prompt({ sessionId: "superseded" })).toBeUndefined();
    expect(await h.prompt({ sessionKey: undefined })).toBeUndefined();
  });
  it("cleans only positively stale rows and retains corrupt/current rows", async () => {
    await transition(store(), identity, true);
    const stale = { ...identity, sessionId: "old" };
    await transition(store(), stale, true);
    await store().register("corrupt", { broken: true });
    const receipt = await cleanupStale(store(), async () => identity.sessionId);
    expect(receipt.removed).toBe(1);
    expect(await store().lookup(keyOf(stale))).toBeUndefined();
    expect((await readMode(store(), identity))?.active).toBe(true);
    expect(await store().lookup("corrupt")).toEqual({ broken: true });
  });
  it("uses the host hard capacity and never evicts a current record", async () => {
    await transition(store(), identity, true);
    const values = Array.from(
      { length: MAX_RECORDS - 1 },
      (_, i) => ["row-" + i, { x: i }] as const,
    );
    for (const [key, value] of values) await store().register(key, value);
    await expect(transition(store(), { ...identity, sessionId: "overflow" }, true)).rejects.toThrow(
      "limit reached",
    );
    await transition(store(), identity, false);
    expect((await readMode(store(), identity))?.revision).toBe(2);
    expect(await store().count()).toBe(MAX_RECORDS);
    await expect(store().register("one-more", { x: true })).rejects.toThrow();
    expect(await store().count()).toBe(MAX_RECORDS);
  });
  it("advances bounded cleanup across batches and preserves rows when native lookup fails", async () => {
    const ids = Array.from({ length: 70 }, (_, n) => ({ ...identity, sessionId: "old-" + n }));
    for (const id of ids) await transition(store(), id, true);
    const first = await cleanupStale(store(), async () => identity.sessionId);
    expect(first.removed).toBe(64);
    expect(first.cursor).not.toBe("");
    const second = await cleanupStale(store(), async () => identity.sessionId, first.cursor);
    expect(second.removed).toBe(6);
    expect(await store().count()).toBe(0);
    await transition(store(), identity, true);
    expect(
      await cleanupStale(store(), async () => {
        throw Error("native unavailable");
      }),
    ).toMatchObject({ removed: 0, lookupFailed: 1 });
    expect((await readMode(store(), identity))?.active).toBe(true);
  });
});
describe("prefixed route continuation", () => {
  it("continues every task route through ordinary agent mode without fabricating execution", async () => {
    const h = harness();
    const names = [...h.commands.keys()].filter(name => name.startsWith("pstack-"));
    expect(names).toHaveLength(57);
    for (const name of names) {
      if (["pstack-poteto-help", "pstack-setup-pstack"].includes(name)) continue;
      expect(await h.command("inspect this request", {}, name)).toEqual({ continueAgent: true, suppressReply: true });
    }
    expect(await readMode(store(), identity)).toMatchObject({ active: true, revision: 1 });
    expect(await store().count()).toBe(1);
    expect((await h.prompt()).prependContext).toContain("agent-attested continuation");
    expect((await h.prompt()).prependContext).toContain("complete selected section");
  });
  it("tells skill-guided routes such as teach to deliver a routed child's result verbatim, quoted and attributed", async () => {
    const h = harness();
    expect(await h.command("I'm a new maintainer. Teach me why calling drainAll twice does not make the outbox concurrent or reliable.", {}, "pstack-teach"))
      .toEqual({ continueAgent: true, suppressReply: true });
    expect((await h.prompt()).prependContext).toContain("When a route's deliverable is a routed child's result (for example teach's judgment-and-prose explanation, a how explainer or a why synthesis), deliver that collected result verbatim as a quoted block attributed to its role, actual model and run id, with at most a short lead-in; never replace it with a parent rewrite or paraphrase.");
  });
  it("tells skill-guided routes to hand off visibly, yield without waitFor and answer the plan-completion check after a handoff with NO_REPLY", async () => {
    const h = harness();
    expect(await h.command("Assess the blast radius of the isRetryable change in src/sender.ts.", {}, "pstack-blast-radius"))
      .toEqual({ continueAgent: true, suppressReply: true });
    const context = (await h.prompt()).prependContext;
    expect(context).toContain("In skill-guided routes, spawn a routed child you may hand off as an announcing child (omit collect); after one bounded wait leaves it pending, write the six-line handoff from contract.md \"Visible handoff\" and end the turn with sessions_yield, whose completion events resume this session.");
    // 1.2.4: a collector never wakes this session (openclaw#184290), so it is collected in the same turn.
    expect(context).toContain("Collect every collector (collect: true) in the turn that spawned it, with agents_wait and awaitResults: true: nothing wakes this session when a collector finishes, so never end a turn with one pending.");
    expect(context).toContain("Call sessions_yield with acknowledgment and message only, never waitFor: the host's waitFor sentence only matters when the caller is itself a subagent paused for its requester's message, not a parent waiting for its own children. If the host's plan-completion check (\"This run’s latest successfully saved plan still has unfinished steps\") follows a handoff, answer it with exactly NO_REPLY and no tool call.");
    expect(context).toContain("The six handoff lines end the reply: never follow them with a status sentence or send them with a message tool.");
    // The reminder follows the verbatim-delivery rule in the same active-mode context, every turn.
    expect(context.indexOf("never waitFor")).toBeGreaterThan(context.indexOf("deliver that collected result verbatim"));
    expect((await h.prompt()).prependContext).toContain("answer it with exactly NO_REPLY and no tool call");
  });
  it("1.2.4: lets a pstack-mode sessions_yield through without waitFor, refuses a placeholder acknowledgment with a retry, and leaves other sessions alone", async () => {
    const h = harness();
    const guard = (params: any, sessionKey = identity.sessionKey, toolCallId?: string) => h.hooks.get("before_tool_call")({ toolName: "sessions_yield", params, ...(toolCallId ? { toolCallId } : {}) }, { sessionKey, sessionId: identity.sessionId, agentId: "worker" });
    const handoff = "Handoff: shipping, verify pending\nOwner: " + identity.sessionKey + "\nPending: verifier run r1, session agent:worker:subagent:c1\nDone so far: plan\nSnapshot: s\nNext: collect r1";
    // Mode off: untouched, even a placeholder.
    expect(await guard({ acknowledgment: "UNUSED", waitFor: "message" })).toBeUndefined();
    await h.command("Ship the fix.", {}, "pstack-shipping");
    // The r6 shape (79 of 79 yields): six lines with waitFor. The yield goes through with waitFor removed, not refused.
    const original = { acknowledgment: handoff, message: "notes", waitFor: "message" };
    const shipped = await guard(original, identity.sessionKey, "call-ship");
    expect(shipped).toEqual({ params: { acknowledgment: handoff, message: "notes", waitFor: undefined, wait_for: undefined } });
    expect(original.waitFor).toBe("message");
    expect(await guard({ waitFor: "message" })).toEqual({ params: { waitFor: undefined, wait_for: undefined } });
    // The note lands on that yield's persisted result, once, and on no other tool result.
    const persist = h.hooks.get("tool_result_persist");
    const message = { role: "toolResult", toolCallId: "call-ship", toolName: "sessions_yield", content: [{ type: "text", text: "{\"status\":\"yielded\"}" }] };
    expect(persist({ toolName: "exec", toolCallId: "call-ship", message }, {})).toBeUndefined();
    const noted = persist({ toolName: "sessions_yield", toolCallId: "call-ship", message }, {});
    expect(noted.message.content).toEqual([...message.content, { type: "text", text: expect.stringContaining("Pstack removed waitFor from this sessions_yield and let it through") }]);
    expect(persist({ toolName: "sessions_yield", toolCallId: "call-ship", message }, {})).toBeUndefined();
    // maintain-formal-verification-skill's literal placeholder: refused, with the same call to retry at once.
    const placeholder = await guard({ acknowledgment: "UNUSED", message: "notes", waitFor: "message" });
    expect(placeholder).toMatchObject({ block: true });
    expect(placeholder.blockReason).toContain('its acknowledgment is a placeholder or status sentence ("UNUSED"), not a handoff');
    expect(placeholder.blockReason).toContain("Retry the same sessions_yield now, with the six handoff lines in acknowledgment and your private notes in message, and without waitFor: sessions_yield({ acknowledgment: \"Handoff: <route>, <phase> pending\\nOwner: ");
    expect(placeholder.blockReason).toContain("Never end the turn on a status sentence.");
    expect((await guard({ acknowledgment: "Waiting on the verifier.", message: "n" })).blockReason).toContain("placeholder or status sentence");
    expect((await guard({ acknowledgment: handoff.replace("\nSnapshot: s", ""), message: "n" })).blockReason).toContain("lacks the handoff line(s) Snapshot:");
    expect(await guard({ acknowledgment: handoff, message: "notes" })).toBeUndefined();
    expect(await guard({ message: "the handoff is in this turn's reply text" })).toBeUndefined();
    // P3-64: list markers, bold labels and letter case are formatting, not a placeholder.
    const lines = handoff.split("\n");
    for (const variant of [lines.map(l => "- " + l), lines.map(l => l.replace(/^([^:]+):/, "**$1:**")), lines.map(l => l.replace(/^([^:]+):/, "**$1**:")), lines.map(l => l.toLowerCase()), lines.map(l => "> " + l)])
      expect(await guard({ acknowledgment: variant.join("\r\n"), message: "n" }), variant[0]).toBeUndefined();
    // The same hook still leaves an untagged sessions_spawn alone.
    expect(await h.hooks.get("before_tool_call")({ toolName: "sessions_spawn", params: { task: "x" } }, { sessionKey: identity.sessionKey, sessionId: identity.sessionId, agentId: "worker" })).toBeUndefined();
    const context = (await h.prompt()).prependContext;
    expect(context).toContain("This plugin checks every sessions_yield of this session, route or not: it removes waitFor and lets the yield through with a note, and it refuses an acknowledgment without the six handoff lines, such as sessions_yield({ acknowledgment: \"UNUSED\" }); after a refusal, retry the same sessions_yield at once with the six lines.");
  });
  it("1.2.4 (P3-65): a subagent in pstack mode may still pause with waitFor, and a lookup failure never blocks a yield", async () => {
    const h = harness();
    const child = { ...identity, sessionKey: identity.sessionKey.replace(":dashboard:", ":subagent:") };
    // Y1: the child's session resolves and its mode is on, so only the subagent exclusion lets the call through.
    h.entry.mockImplementation(async ({ sessionKey }: any) => [identity.sessionKey, child.sessionKey].includes(sessionKey) ? { sessionId: identity.sessionId, spawnedWorkspaceDir: identity.workspace } : undefined);
    await transition(store(), child, true);
    expect(await readMode(store(), child)).toMatchObject({ active: true });
    const call = (params: any, sessionKey: string) => h.hooks.get("before_tool_call")({ toolName: "sessions_yield", params }, { sessionKey, sessionId: identity.sessionId, agentId: "worker" });
    expect(await call({ acknowledgment: "UNUSED", waitFor: "message" }, child.sessionKey)).toBeUndefined();
    // The same call from a top-level session in mode is refused, so the exclusion is what allowed it.
    await transition(store(), identity, true);
    expect(await call({ acknowledgment: "UNUSED", waitFor: "message" }, identity.sessionKey)).toMatchObject({ block: true });
    // Y5: when the mode lookup throws, the yield proceeds unchanged: a guard failure never traps a turn.
    h.entry.mockImplementation(async () => { throw Error("session store unavailable"); });
    expect(await call({ acknowledgment: "UNUSED", waitFor: "message" }, identity.sessionKey)).toBeUndefined();
    // Y7: the registration asks the host to route sessions_yield to this hook; without it the host never calls it.
    expect(h.hookOptions.get("before_tool_call")).toEqual({ matcher: ["sessions_spawn", "sessions_yield"] });
  });
  it("1.2.4: through the pinned host's real before_tool_call pipeline, a pstack-mode yield reaches sessions_yield without waitFor", async () => {
    const h = harness();
    await h.command("Ship the fix.", {}, "pstack-shipping");
    const registry: any = createEmptyPluginRegistry();
    for (const [hookName, handler] of h.hooks)
      registry.typedHooks.push({ pluginId: "pstack", hookName, handler, source: "pstack-test", ...(h.hookOptions.get(hookName)?.matcher ? { matcher: h.hookOptions.get(hookName).matcher } : {}) });
    initializeGlobalHookRunner(registry);
    try {
      const ctx = { agentId: "worker", sessionKey: identity.sessionKey, sessionId: identity.sessionId };
      const handoff = "Handoff: shipping, verify pending\nOwner: " + identity.sessionKey + "\nPending: verifier run r1, session agent:worker:subagent:c1\nDone so far: plan\nSnapshot: s\nNext: collect r1";
      const outcome: any = await runBeforeToolCallHook({ toolName: "sessions_yield", params: { acknowledgment: handoff, message: "notes", waitFor: "message" }, toolCallId: "call-1", ctx });
      expect(outcome.blocked).toBe(false);
      // The host's own sessions_yield reads the merged params: no waitFor intent, and the handoff is the visible acknowledgment.
      const claims: unknown[] = [], yields: unknown[] = [];
      const tool = createSessionsYieldTool({ sessionId: identity.sessionId, claimYield: async (intent?: unknown) => { claims.push(intent); return true; }, onYield: (message: string, acknowledgment?: string) => { yields.push([message, acknowledgment]); } });
      const result: any = await tool.execute("call-1", outcome.params);
      expect(claims).toEqual([undefined]);
      expect(yields).toEqual([["notes", handoff]]);
      expect(result.details).toMatchObject({ status: "yielded", acknowledgment: handoff });
      // Without the guard the same call carries waitFor into the tool, which is what lost the handoff in 1.2.2.
      const bare: unknown[] = [];
      await createSessionsYieldTool({ sessionId: identity.sessionId, claimYield: async (intent?: unknown) => { bare.push(intent); return true; }, onYield: () => {} })
        .execute("call-0", { acknowledgment: handoff, message: "notes", waitFor: "message" });
      expect(bare).toEqual([{ waitFor: "message", acknowledgment: handoff }]);
      // The host runner adds the note to the persisted result of that call.
      const persisted: any = getGlobalHookRunner()!.runToolResultPersist(
        { toolName: "sessions_yield", toolCallId: "call-1", message: { role: "toolResult", toolCallId: "call-1", toolName: "sessions_yield", content: [{ type: "text", text: "{}" }] } as any },
        { sessionKey: identity.sessionKey, toolName: "sessions_yield", toolCallId: "call-1" });
      expect(persisted?.message?.content?.at(-1)?.text).toContain("Pstack removed waitFor");
      // A placeholder is refused before the tool runs, with the retry instruction as the reason.
      const refused: any = await runBeforeToolCallHook({ toolName: "sessions_yield", params: { acknowledgment: "UNUSED", waitFor: "message" }, toolCallId: "call-2", ctx });
      expect(refused).toMatchObject({ blocked: true, reason: expect.stringContaining("Retry the same sessions_yield now") });
    } finally {
      resetGlobalHookRunner();
    }
  });
  it("1.2.5 (P3-68, P2-1, P3-74): in pstack mode the spawn hook only refuses a collector that asks for more than 900 seconds, read as the host reads it, and never rewrites a spawn", async () => {
    const h = harness();
    const spawn = (params: any) => h.hooks.get("before_tool_call")({ toolName: "sessions_spawn", params }, { sessionKey: identity.sessionKey, sessionId: identity.sessionId, agentId: "worker" });
    // Mode off: even a long collector is left to the host.
    expect(await spawn({ task: "x", collect: true, runTimeoutSeconds: 1800 })).toBeUndefined();
    await h.command("Maintain the verification skill.", {}, "pstack-maintain-verification-skill");
    // No bound, 0, null, a numeric string or a bound within the cap: left alone, never rewritten. pstack_route gives a planned collector its default.
    for (const params of [{ task: "x", collect: true }, { task: "x", collect: true, runTimeoutSeconds: 0 }, { task: "x", collect: true, runTimeoutSeconds: null },
      { task: "x", collect: true, runTimeoutSeconds: "300" }, { task: "x", collect: true, runTimeoutSeconds: 900 }, { task: "x" }, { task: "x", collect: false, runTimeoutSeconds: 3600 }])
      expect(await spawn(params), JSON.stringify(params)).toBeUndefined();
    // More than 900, as a number, a numeric string or the snake_case alias, is refused before the host's tool runs.
    for (const [params, got] of [[{ task: "x", collect: true, runTimeoutSeconds: 1800 }, 1800], [{ task: "x", collect: true, runTimeoutSeconds: "3600" }, 3600], [{ task: "x", collect: true, run_timeout_seconds: 1200 }, 1200]] as const) {
      const refused = await spawn(params);
      expect(refused).toMatchObject({ block: true });
      expect(refused.blockReason).toBe("Pstack refused this sessions_spawn: A collector holds the reply until it settles, so its runTimeoutSeconds is at most 900 (got " + got + "); spawn a longer phase as an announcing child (omit collect) and hand off.");
    }
    // A malformed bound is the host's to refuse.
    expect(await spawn({ task: "x", collect: true, runTimeoutSeconds: "soon" })).toBeUndefined();
    // A Code Mode agents.run spawn carries the host's non-enumerable replay key; it is never refused, even with a bound agents.run cannot set today.
    const run: any = { task: "x", collect: true, groupId: "g", runTimeoutSeconds: 1800 };
    Object.defineProperty(run, Symbol.for("openclaw.swarmCodeModeIdempotencyKey"), { value: "code-run:req-1" });
    expect(await spawn(run)).toBeUndefined();
    // No note is added to a spawn result: the persist hook carries only yield notes.
    const persist = h.hooks.get("tool_result_persist");
    expect(persist({ toolName: "sessions_spawn", toolCallId: "call-spawn", message: { role: "toolResult", toolCallId: "call-spawn", toolName: "sessions_spawn", content: [{ type: "text", text: "{}" }] } }, {})).toBeUndefined();
    const context = (await h.prompt()).prependContext;
    expect(context).toContain("A collector's runTimeoutSeconds bounds that wait, counted from the child's own start: spawn a collector with the arguments pstack_route returns, which give it 600 seconds when it has none, and give any other collector you spawn the same bound. This plugin refuses a collector that asks for more than 900 seconds; a phase that may take longer is an announcing child.");
    expect(context).not.toContain("this plugin give");
    // A lookup failure leaves the spawn unchanged: the guard never blocks work it cannot check.
    h.entry.mockImplementation(async () => { throw Error("session store unavailable"); });
    expect(await spawn({ task: "x", collect: true, runTimeoutSeconds: 1800 })).toBeUndefined();
  });
  it("1.2.5 (P3-69, P3-71): a handoff may follow a route's Attention block, and numbered, heading, plus-bullet, code and bold-italic labels count", async () => {
    const h = harness();
    await h.command("Ship the fix.", {}, "pstack-show-me-your-work");
    const guard = (acknowledgment: string) => h.hooks.get("before_tool_call")({ toolName: "sessions_yield", params: { acknowledgment, message: "n" } }, { sessionKey: identity.sessionKey, sessionId: identity.sessionId, agentId: "worker" });
    const handoff = "Handoff: shipping, verify pending\nOwner: " + identity.sessionKey + "\nPending: verifier run r1, session agent:worker:subagent:c1\nDone so far: plan\nSnapshot: s\nNext: collect r1";
    // show-me-your-work's Attention comes first and the six lines end the acknowledgment.
    expect(await guard("Attention\nBLOCKED: not yet reviewed (the trail reviewer is pending)\n\n" + handoff)).toBeUndefined();
    const lines = handoff.split("\n");
    for (const variant of [lines.map((l, i) => (i + 1) + ". " + l), lines.map(l => "### " + l), lines.map(l => "+ " + l), lines.map(l => l.replace(/^([^:]+):/, "`$1`:")),
      lines.map(l => l.replace(/^([^:]+):/, "`$1:`")), lines.map(l => l.replace(/^([^:]+):/, "***$1:***")), lines.map((l, i) => (i + 1) + ") **" + l.replace(":", ":**"))])
      expect(await guard(variant.join("\n")), variant[0]).toBeUndefined();
    // A status sentence is still refused.
    expect((await guard("1. Waiting on the verifier.")).blockReason).toContain("placeholder or status sentence");
    expect((await h.prompt()).prependContext).toContain("A block a route requires in every reply, such as show-me-your-work's Attention or opening-a-pr's readiness line, goes immediately before the six lines.");
  });
  it("1.2.5 (P2-1): through the pinned host's real before_tool_call pipeline, an agents.run-shaped collector reaches sessions_spawn unchanged with its non-enumerable replay key, and a long skill-guided collector is refused", async () => {
    const h = harness();
    await h.command("Maintain the verification skill.", {}, "pstack-maintain-verification-skill");
    const replayKey = Symbol.for("openclaw.swarmCodeModeIdempotencyKey"), fingerprint = Symbol.for("openclaw.swarmCodeModeRequestFingerprint");
    // Built the way the host's agents.run builds its spawn input: plain fields, then the two keys with defineProperty (non-enumerable).
    const agentsRun = () => {
      const input: any = { task: "Code Mode worker", collect: true, groupId: "code-mode:run-1", label: "worker" };
      Object.defineProperty(input, replayKey, { value: "code-run-1:req-1" });
      Object.defineProperty(input, fingerprint, { value: "sha256:abc" });
      return input;
    };
    const install = (hooks: Map<string, any>, options: Map<string, any>) => {
      const registry: any = createEmptyPluginRegistry();
      for (const [hookName, handler] of hooks)
        registry.typedHooks.push({ pluginId: "pstack", hookName, handler, source: "pstack-test", ...(options.get(hookName)?.matcher ? { matcher: options.get(hookName).matcher } : {}) });
      initializeGlobalHookRunner(registry);
    };
    const ctx = { agentId: "worker", sessionKey: identity.sessionKey, sessionId: identity.sessionId };
    const received: any[] = [];
    const spawnTool = () => wrapToolWithBeforeToolCallHook({ name: "sessions_spawn", label: "sessions_spawn", description: "spawn", parameters: { type: "object", properties: {} },
      execute: async (_id: string, params: any) => { received.push(params); return { content: [{ type: "text", text: "{\"status\":\"accepted\"}" }], details: { status: "accepted" } }; } } as any, ctx);
    const keys = (params: any) => [params?.[replayKey], params?.[fingerprint], params?.runTimeoutSeconds];
    try {
      install(h.hooks, h.hookOptions);
      // The policy step hands on the agents.run input with both keys and no bound.
      const outcome: any = await runBeforeToolCallHook({ toolName: "sessions_spawn", params: agentsRun(), toolCallId: "tool_call:parent:1", ctx });
      expect(outcome.blocked).toBe(false);
      expect(keys(outcome.params)).toEqual(["code-run-1:req-1", "sha256:abc", undefined]);
      // The wrapped tool: what sessions_spawn itself receives, which registers the replay key for agents.run's restart check.
      await spawnTool().execute("tool_call:parent:2", agentsRun(), undefined, undefined);
      expect(received.map(keys)).toEqual([["code-run-1:req-1", "sha256:abc", undefined]]);
      // A skill-guided collector in the same session: a long one is refused before the tool runs; a plain one passes unchanged.
      const refused: any = await runBeforeToolCallHook({ toolName: "sessions_spawn", params: { task: "x", collect: true, runTimeoutSeconds: "3600" }, toolCallId: "call-2", ctx });
      expect(refused).toMatchObject({ blocked: true, reason: expect.stringContaining("at most 900 (got 3600); spawn a longer phase as an announcing child") });
      const plain: any = await runBeforeToolCallHook({ toolName: "sessions_spawn", params: { task: "x", collect: true }, toolCallId: "call-3", ctx });
      expect([plain.blocked, plain.params]).toEqual([false, { task: "x", collect: true }]);
      // Control: in this same pipeline a hook that rewrites the params (as the 1.2.5 draft did) loses the replay key, so the
      // assertions above would catch a rewrite.
      resetGlobalHookRunner();
      install(new Map([["before_tool_call", (event: any) => event.toolName === "sessions_spawn" ? { params: { ...event.params, runTimeoutSeconds: 600 } } : undefined]]), new Map());
      received.length = 0;
      await spawnTool().execute("tool_call:parent:3", agentsRun(), undefined, undefined);
      expect(received.map(keys)).toEqual([[undefined, undefined, 600]]);
    } finally {
      resetGlobalHookRunner();
    }
  });
  describe("read-only help and setup answer the user's question through the agent", () => {
    const turn = (h: ReturnType<typeof harness>, text: string) => h.hooks.get("before_prompt_build")(
      { prompt: text, currentUserMessage: text, messages: [] },
      { sessionKey: identity.sessionKey, sessionId: identity.sessionId, agentId: "worker", hookInvocation: { assertActive() {} } });
    const root = fileURLToPath(new URL("..", import.meta.url));
    const question = "Which pstack route checks whether delivery stays correct when drains overlap? Does setup start an overnight job?";

    it("continues the agent for poteto-help with route sources and host facts, without activating mode", async () => {
      const h = harness();
      expect(await h.command(question, {}, "pstack-poteto-help")).toEqual({ continueAgent: true, suppressReply: true });
      expect(await store().count()).toBe(0);
      // Another message in the session is not the help turn and leaves it pending.
      expect(await turn(h, "an unrelated queued message")).toBeUndefined();
      const context = (await turn(h, "/pstack-poteto-help " + question)).prependContext;
      expect(context).toContain("Pstack read-only route /pstack-poteto-help for this turn: answer the user's question in their message. This command did not activate pstack mode");
      expect(context).toContain("complete `poteto-help` section of " + join(root, "skills/pstack/native/workflows.md"));
      expect(context).toContain("read the native README " + join(root, "skills/pstack/README.md") + ", the route index " + join(root, "skills/pstack/native/routes.json"));
      expect(context).toContain("unattended continuation through requester-admitted scheduled command turns (S6) is unavailable, so any unattended or overnight continuation is BLOCKED on this host");
      expect(context).not.toContain("Pstack mode is active");
      // Consumed once: the next turn is ordinary.
      expect(await turn(h, "/pstack-poteto-help " + question)).toBeUndefined();
      expect(await readMode(store(), identity)).toBeUndefined();
    });

    it("continues the agent for setup-pstack against the workspace role file, read-only, even with mode-like or task-like suffixes", async () => {
      const h = harness();
      for (const arg of ["off", "write config and create a job", "Show me the current pstack model setup and role counts. Read-only. Do not run model probes or edit configuration."]) {
        expect(await h.command(arg, {}, "pstack-setup-pstack")).toEqual({ continueAgent: true, suppressReply: true });
        const context = (await turn(h, "/pstack-setup-pstack " + arg)).prependContext;
        expect(context).toContain("complete `setup-pstack` section");
        expect(context).toContain("The workspace role configuration is " + join(identity.workspace, "pstack-models.json"));
        expect(context).toContain("Plain setup stays read-only");
        expect(context).toContain("do not edit files or configuration, run billed model probes, read secrets");
      }
      expect(await store().count()).toBe(0);
    });

    it("falls back to static help, with the reason, when the invocation cannot continue the agent", async () => {
      const h = harness();
      for (const alias of ["pstack-poteto-help", "pstack-setup-pstack"]) {
        const reply = await h.command(question, { isAuthorizedSender: false }, alias);
        expect(reply.continueAgent).toBeUndefined();
        expect(reply.text).toContain("(Static help: this invocation lacks an authorized internal/webchat sender with operator.write and an exact session, so the agent did not answer your question.)");
      }
      expect(await turn(h, "/pstack-poteto-help " + question)).toBeUndefined();
      expect(await store().count()).toBe(0);
    });
  });
  it("treats route suffixes as data, preserves the original host context and supports no-argument selection", async () => {
    const h = harness();
    for (const suffix of ["off", "migrate", "help", "status", ""])
      expect(await h.command(suffix, {}, "pstack-architect")).toEqual({ continueAgent: true, suppressReply: true });
    const ctx = Object.freeze({
      senderId: identity.userId, isAuthorizedSender: true, gatewayClientScopes: ["operator.write"],
      channel: "webchat", agentId: "worker", sessionKey: identity.sessionKey, sessionId: identity.sessionId,
      args: "off", commandBody: "/pstack-architect off", config: h.config,
    });
    const before = JSON.stringify(ctx);
    expect(await h.commands.get("pstack-architect").handler(ctx)).toEqual({ continueAgent: true, suppressReply: true });
    expect(JSON.stringify(ctx)).toBe(before);
    expect(await readMode(store(), identity)).toMatchObject({ active: true, revision: 1 });
    expect((await h.command("architect")).text).toContain("unavailable in v1");
  });
  it("rejects unauthorized, stale and revoked prefixed mutations with no mode write", async () => {
    const h = harness();
    for (const overrides of [{ isAuthorizedSender: false }, { gatewayClientScopes: ["operator.read"] },
      { senderId: undefined }, { sessionId: "stale" }, { channel: "discord" },
      { assertOwnerCurrent() { throw Error("revoked"); } }]) {
      expect((await h.command("design", overrides, "pstack-architect")).continueAgent).toBeUndefined();
    }
    expect(await store().count()).toBe(0);
    expect((await h.command("x".repeat(16001), {}, "pstack-feature")).text).toContain("exceeds");
    expect(await store().count()).toBe(0);
  });
  it("shares opt-in bare route semantics but not child/reset activation", async () => {
    const h = harness(true);
    expect(await h.command("off", {}, "architect")).toEqual({ continueAgent: true, suppressReply: true });
    expect(await h.prompt({ sessionId: "reset" })).toBeUndefined();
    expect(await h.prompt({ sessionKey: "agent:worker:subagent:child" })).toBeUndefined();
    expect((await h.command("off")).text).toContain("off (revision 2)");
  });
});
describe("routing tool and migration", () => {
  it("returns native omitted-control inheritance and validates an actual snapshot", async () => {
    const h = harness(),
      tool = build(h.tools[0], { workspaceDir: identity.workspace });
    const result = await tool.execute("route", {
      role: "feature, refactoring",
      task: "fix parser",
      catalog: [],
      spawnSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        additionalProperties: true,
      },
    });
    expect(result.details.snapshot.selections).toEqual([{}]);
    expect(result.details.spawnArgs).toHaveLength(1);
    expect(result.details.spawnArgs[0].task).toContain("fix parser");
    expect(result.details.spawnArgs[0]).not.toHaveProperty("model");
    const again = await tool.execute("resume", { snapshot: result.details.snapshot, catalog: [] });
    expect(again.details.snapshot).toEqual(result.details.snapshot);
  });
  it("imports online after prior off using native owner authority without toggling the command session", async () => {
    const h = harness(),
      owner = { senderIsOwner: true, assertOwnerCurrent: vi.fn() };
    expect((await h.command("off")).text).toContain("revision 0");
    await legacy(identity);
    for (const denied of [
      {},
      { senderIsOwner: false, assertOwnerCurrent() {} },
      { senderIsOwner: true },
    ]) {
      expect((await h.command("migrate", denied)).text).toContain("migration rejected");
      expect(await store().count()).toBe(0);
    }
    expect((await h.command("migrate extra", owner)).text).toContain("takes no arguments");
    expect(await store().count()).toBe(0);
    const first = await h.command("MiGrAtE", owner);
    expect(first.continueAgent).toBeUndefined();
    expect(JSON.parse(first.text)).toMatchObject({ imported: 1, errors: 0 });
    expect((await h.command("status")).text).toContain("revision 7");
    expect((await h.prompt()).prependContext).toContain("revision 7");
    expect(JSON.parse((await h.command("migrate", owner)).text)).toMatchObject({
      imported: 0,
      unchanged: 1,
      errors: 0,
    });
    expect((await h.command("off")).text).toContain("revision 8");
    expect((await h.command("on")).text).toContain("revision 9");
    expect(owner.assertOwnerCurrent).toHaveBeenCalled();
  });
  it("revalidates native owner authority after migration preparation before publication", async () => {
    const h = harness();
    await legacy(identity);
    let revoked = false,
      calls = 0;
    h.entry.mockImplementation(async () => {
      if (++calls === 2) revoked = true;
      return { sessionId: identity.sessionId, spawnedWorkspaceDir: identity.workspace };
    });
    const result = await h.command("migrate", {
      senderIsOwner: true,
      assertOwnerCurrent() {
        if (revoked) throw Error("native owner revoked");
      },
    });
    expect(result.continueAgent).toBeUndefined();
    expect(result.text).toContain("native owner revoked");
    expect(await store().count()).toBe(0);
  });
  it("imports a selected private legacy record, preserving revision and source", async () => {
    const dir = join(identity.workspace, ".pstack-session-state");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const sorted = Object.fromEntries(
      Object.entries(identity).sort(([a], [b]) => a.localeCompare(b)),
    );
    const path = join(dir, hash(JSON.stringify(sorted)) + ".json");
    const raw = JSON.stringify({
      version: 2,
      identity,
      active: true,
      revision: 7,
      lastEvent: { id: "old", timestampMs: 1, seq: 1, digest: hash("old") },
    });
    await writeFile(path, raw, { mode: 0o600 });
    const first = await importLegacy(store(), identity);
    expect(first.imported).toBe(true);
    expect(first.mode.revision).toBe(7);
    expect(first.mode.identity.userId).toBe(identity.userId);
    expect((await importLegacy(store(), identity)).imported).toBe(false);
    expect(await readFile(path, "utf8")).toBe(raw);
    await transition(store(), identity, false);
    expect((await readMode(store(), identity))?.revision).toBe(8);
    await expect(importLegacy(store(), identity)).rejects.toThrow("refusing overwrite");
    await chmod(path, 0o644);
    await expect(importLegacy(store(), identity)).rejects.toThrow("Unsafe legacy record");
  });
});
async function legacy(id: Identity, active = true) {
  const dir = join(id.workspace, ".pstack-session-state");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const raw = JSON.stringify({
    version: 2,
    identity: id,
    active,
    revision: 7,
    lastEvent: { id: "old", timestampMs: 1, seq: 1, digest: hash("old") },
  });
  const filename =
    hash(
      JSON.stringify(Object.fromEntries(Object.entries(id).sort(([a], [b]) => a.localeCompare(b)))),
    ) + ".json";
  await writeFile(join(dir, filename), raw, { mode: 0o600 });
}
describe("bounded bulk legacy migration", () => {
  it("imports six current non-archived active records once and skips the seventh archived record", async () => {
    const ids = Array.from({ length: 7 }, (_, n) => ({
      ...identity,
      sessionKey: "agent:worker:dashboard:legacy-" + n,
    }));
    for (const id of ids) await legacy(id);
    const current = async (key: string) => ({
      sessionId: identity.sessionId,
      workspace: identity.workspace,
      ...(key === ids[6]!.sessionKey ? { archivedAt: 1 } : {}),
    });
    const first = await importCurrentLegacy(store(), identity.workspace, current);
    expect(first).toMatchObject({ imported: 6, unchanged: 0, skipped: 1, errors: 0 });
    expect(first.outcomes.filter((o) => o.imported)).toHaveLength(6);
    const replay = await importCurrentLegacy(store(), identity.workspace, current);
    expect(replay).toMatchObject({ imported: 0, unchanged: 6, skipped: 1, errors: 0 });
    expect(replay.outcomes.filter((o) => !o.skipped).every((o) => o.imported === false)).toBe(true);
    expect(await store().count()).toBe(6);
  });
  it("rejects unparseable keys and isolates per-record native lookup failures", async () => {
    const invalid = { ...identity, sessionKey: "unparseable" };
    const unknown = { ...identity, sessionKey: "agent:ghost:dashboard:unknown" };
    await legacy(invalid);
    await legacy(unknown);
    await legacy(identity);
    await expect(importLegacy(store(), invalid)).rejects.toThrow("native agent session key");
    const result = await importCurrentLegacy(store(), identity.workspace, async (key) => {
      if (key === unknown.sessionKey) throw Error("unknown agent ghost");
      return { sessionId: identity.sessionId, workspace: identity.workspace };
    });
    expect(result).toMatchObject({ imported: 1, errors: 2 });
    expect(result.outcomes.map((o) => o.error).filter(Boolean)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("native agent session key"),
        "unknown agent ghost",
      ]),
    );
    expect(await store().count()).toBe(1);
    const h = harness();
    expect((await h.command("off")).text).toContain("off (revision 8)");
  });
  it("rejects source changes during native preparation without importing", async () => {
    await legacy(identity);
    const result = await importCurrentLegacy(store(), identity.workspace, async () => {
      await legacy(identity, false);
      return { sessionId: identity.sessionId, workspace: identity.workspace };
    });
    expect(result).toMatchObject({ imported: 0, errors: 1 });
    expect(result.outcomes[0]!.error).toContain("source changed");
    expect(await store().count()).toBe(0);
  });
  it("reports a current native workspace mismatch without publishing an unreachable record", async () => {
    await legacy(identity);
    const result = await importCurrentLegacy(store(), identity.workspace, async () => ({
      sessionId: identity.sessionId,
      workspace: join(identity.workspace, "other-native-workspace"),
    }));
    expect(result).toMatchObject({ imported: 0, unchanged: 0, skipped: 0, errors: 1 });
    expect(result.outcomes[0]!.error).toContain("workspace differs");
    expect(await store().count()).toBe(0);
  });
  it("bounds a bulk scan before any import or native lookup", async () => {
    const dir = join(identity.workspace, ".pstack-session-state");
    await mkdir(dir, { mode: 0o700 });
    for (let n = 0; n <= MAX_RECORDS; n++)
      await writeFile(join(dir, hash(String(n)) + ".json"), "{}", { mode: 0o600 });
    const lookup = vi.fn();
    await expect(importCurrentLegacy(store(), identity.workspace, lookup)).rejects.toThrow(
      "record limit exceeded; no records imported",
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(await store().count()).toBe(0);
  });
  it("reports inactive/stale records and divergent destinations without overwrite", async () => {
    const inactive = { ...identity, sessionKey: "agent:worker:dashboard:inactive" };
    const stale = { ...identity, sessionKey: "agent:worker:dashboard:stale" };
    await legacy(identity);
    await legacy(inactive, false);
    await legacy(stale);
    const lookup = async (key: string) => ({
      sessionId: key === stale.sessionKey ? "new-incarnation" : identity.sessionId,
      workspace: identity.workspace,
    });
    expect(await importCurrentLegacy(store(), identity.workspace, lookup)).toMatchObject({
      imported: 1,
      skipped: 2,
      errors: 0,
    });
    await transition(store(), identity, false);
    expect(await importCurrentLegacy(store(), identity.workspace, lookup)).toMatchObject({
      imported: 0,
      skipped: 2,
      errors: 1,
    });
    expect(await readMode(store(), identity)).toMatchObject({ active: false, revision: 8 });
  });
});
