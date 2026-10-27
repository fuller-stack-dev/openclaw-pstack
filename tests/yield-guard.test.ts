import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { createPluginStateKeyedStoreV2ForTests, resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createEmptyPluginRegistry } from "host-test/empty-registry";
import { initializeGlobalHookRunner, getGlobalHookRunner, resetGlobalHookRunner } from "host-test/hook-runner-global";
import { runBeforeToolCallHook } from "host-test/before-tool-call";
import { createSessionsYieldTool } from "host-test/sessions-yield";
import { register } from "../src/index.ts";
import { MAX_RECORDS, transition } from "../src/state.ts";

let fixture: Awaited<ReturnType<typeof createOpenClawTestState>>;
const ctx = { agentId: "worker", sessionKey: "agent:worker:dashboard:handoff", sessionId: "incarnation" };
const handoff = "Handoff: shipping, verify pending\nOwner: owner\nPending: verifier run r1, session child\nDone so far: plan\nSnapshot: selected model\nNext: collect r1";

async function setup(spawnedBy?: string) {
  const store = () => createPluginStateKeyedStoreV2ForTests("pstack", { namespace: "session-mode-v2", maxEntries: MAX_RECORDS, overflowPolicy: "reject-new" }, { assertCurrent() {} });
  const registry: any = createEmptyPluginRegistry();
  register(createTestPluginApi({ id: "pstack", runtime: {
    state: { openKeyedStoreV2: store },
    agent: { session: { getSessionEntryAsync: async () => ({ sessionId: ctx.sessionId, spawnedWorkspaceDir: fixture.workspaceDir, ...(spawnedBy ? { spawnedBy } : {}) }) } },
  }, on: (hookName: string, handler: unknown, options: any) => registry.typedHooks.push({ pluginId: "pstack", hookName, handler, source: "yield-regression", ...(options?.matcher ? { matcher: options.matcher } : {}) }) } as any));
  await transition(store(), { sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, userId: "owner", workspace: fixture.workspaceDir }, true);
  initializeGlobalHookRunner(registry);
}
const before = (params: Record<string, unknown>, toolCallId = "call") => runBeforeToolCallHook({ toolName: "sessions_yield", params, toolCallId, ctx });
const persist = (toolCallId: string) => getGlobalHookRunner()!.runToolResultPersist({ toolName: "sessions_yield", toolCallId,
  message: { role: "toolResult", toolCallId, toolName: "sessions_yield", content: [{ type: "text", text: "{}" }] } as any },
{ sessionKey: ctx.sessionKey, toolName: "sessions_yield", toolCallId });

beforeEach(async () => { fixture = await createOpenClawTestState({ label: "pstack-yield", applyEnv: true }); });
afterEach(async () => { resetGlobalHookRunner(); resetPluginStateStoreForTests(); await fixture.cleanup(); });

describe("1.2.6 handoff follow-ups", () => {
  it.each(["waitFor", "wait_for"])("removes %s through the real hook and yield tool pipeline (P3-72 H2)", async key => {
    await setup();
    const input = { acknowledgment: handoff, message: "private", [key]: "message" };
    const outcome: any = await before(input);
    expect(outcome.blocked).toBe(false);
    const claims: unknown[] = [], delivered: unknown[] = [];
    const tool = createSessionsYieldTool({ sessionId: ctx.sessionId,
      claimYield: async (intent?: unknown) => { claims.push(intent); return true; },
      onYield: (message: string, acknowledgment?: string) => { delivered.push([message, acknowledgment]); } });
    const result: any = await tool.execute("call", outcome.params);
    expect(claims).toEqual([undefined]);
    expect(delivered).toEqual([["private", handoff]]);
    expect(result.details).toMatchObject({ status: "yielded", acknowledgment: handoff });
    expect(input[key]).toBe("message");
    // Control: the host really reads this alias when the plugin is absent.
    await tool.execute("bare", input);
    expect(claims[1]).toEqual({ waitFor: "message", acknowledgment: handoff });
  });

  it("retains exactly the newest 64 unconsumed yield notes (P3-72 H8)", async () => {
    await setup();
    for (let i = 0; i < 65; i++) expect((await before({ waitFor: "message" }, "call-" + i)).blocked).toBe(false);
    expect((persist("call-0") as any).message.content).toEqual([{ type: "text", text: "{}" }]);
    for (let i = 1; i < 65; i++) {
      const result: any = persist("call-" + i);
      expect(result?.message.content.at(-1).text, "call-" + i).toContain("Pstack removed waitFor");
      expect((persist("call-" + i) as any).message.content).toEqual([{ type: "text", text: "{}" }]);
    }
  });

  it("preserves requester-message waiting for a spawned visible child in mode (P3-71)", async () => {
    const params = { acknowledgment: "Waiting for your scope decision", waitFor: "message" };
    await setup();
    expect((await before(params)).blocked).toBe(true);
    resetGlobalHookRunner();
    await setup("agent:worker:dashboard:parent");
    const outcome: any = await before(params);
    expect(outcome.blocked).toBe(false);
    const claims: unknown[] = [];
    await createSessionsYieldTool({ sessionId: ctx.sessionId, claimYield: async (intent?: unknown) => { claims.push(intent); return true; }, onYield: () => {} }).execute("call", outcome.params);
    expect(claims).toEqual([{ waitFor: "message", acknowledgment: params.acknowledgment }]);
    expect((persist("call") as any).message.content).toEqual([{ type: "text", text: "{}" }]);
  });

  it("does not recognize hyphenated words as handoff labels", async () => {
    await setup();
    const acknowledgment = "Handoff-ish thing\nOwner-less\nPending-review\nDone so far-ish\nSnapshot-free\nNext-gen";
    expect((await before({ acknowledgment })).blocked).toBe(true);
  });

  const formats: [string, (line: string, index: number) => string][] = [
    ["plain", line => line],
    ["bold", line => line.replace(/^([^:]+):/, "**$1:**")],
    ["table cells", line => "| " + line.replace(":", " |") + " |"],
    ["table line", line => "| " + line + " |"],
    ["checkbox", line => "- [x] " + line],
    ["letter", (line, i) => String.fromCharCode(65 + i) + ". " + line],
    ["Roman numeral", (line, i) => ["I", "II", "III", "IV", "V", "VI"][i] + ") " + line],
    ["three digits", (line, i) => (100 + i) + ". " + line],
    ["emoji", line => "✅ " + line],
    ["keycap emoji", line => "1️⃣ " + line],
    ["full-width colon", line => line.replace(":", "：")],
    ["em dash", line => line.replace(":", " —")],
    ["en dash", line => line.replace(":", " –")],
    ["hyphen", line => line.replace(":", " -")],
  ];
  it.each(formats)("accepts non-empty %s handoff labels (P3-77)", async (_name, format) => {
    await setup();
    expect((await before({ acknowledgment: handoff.split("\n").map(format).join("\n") })).blocked).toBe(false);
  });
  it.each(formats)("refuses empty %s label values, not just missing labels", async (_name, format) => {
    await setup();
    const lines = handoff.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const empty = lines.map((line, index) => format(index === i ? line.split(":")[0] + ": ** **" : line, index)).join("\n");
      const outcome: any = await before({ acknowledgment: empty });
      expect(outcome.blocked, empty).toBe(true);
      expect(outcome.reason).toContain("lacks the handoff line(s) " + lines[i].split(":")[0] + ":; each");
      expect(outcome.reason).toContain("non-empty value");
    }
  });
});
