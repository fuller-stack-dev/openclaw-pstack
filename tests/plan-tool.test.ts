import { normalizeToolParameters } from "host-test/tool-schema";
import { normalizeOpenAIToolSchemas } from "openclaw/plugin-sdk/provider-tools";
import { runAgentLoop } from "host-test/agent-core";
import { createAssistantMessageEventStream } from "host-test/llm-core";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valid } from "./fixtures/plan-source.mjs";
import { it, expect, vi } from "vitest";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { register } from "../src/index.ts";
import { build } from "./fixtures/tool-factory.ts";

function tool(context: any = {}) {
  const factories: any[] = [];
  register(createTestPluginApi({ id: "pstack",
    runtime: { state: { openKeyedStoreV2() { throw Error("read-only helper must not open state"); } } },
    registerTool: (factory: any) => factories.push(factory),
  } as any));
  const result = factories.map(factory => build(factory, context)).find(candidate => candidate.name === "pstack_plan_check");
  expect(result, "The supplied-source read-only plan adapter must be registered").toBeDefined();
  return result;
}

it("registers the read-only supplied-source adapter and returns real plan diagnostics", async () => {
  const result = await tool().execute("check", { source: "# Empty plan\n", label: "relay.md" });
  expect(result.details).toMatchObject({ file: "relay.md", status: "ISSUES", verification: "plan-structure-only" });
  expect(result.details.problems).toContainEqual({ line: 1, message: 'missing "## How to read this"' });
  expect(result.details.notice).toContain("not prove route execution");
});

it("accepts a complete supplied plan without touching a label path or changing boxes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plan-source-only-"));
  const label = join(directory, "sentinel.md");
  writeFileSync(label, "not the supplied plan");
  try {
    const input = { source: valid, label }, before = structuredClone(input);
    const result = await tool().execute("pass", input);
    expect(result.details).toMatchObject({ status: "PASS", verification: "plan-structure-only", problems: [] });
    expect(result.details.reports).toHaveLength(1);
    expect(result.details.reports[0].counts["Verify, live."]).toBe(10);
    expect(input).toEqual(before);
    expect(readFileSync(label, "utf8")).toBe("not the supplied plan");
    expect(readdirSync(directory)).toEqual(["sentinel.md"]);
    expect((await tool().execute("path", { source: label })).details.status).toBe("ISSUES");
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
for (const [name, source, diagnostic] of [
  ["missing tenth live lane", valid.replace(/^.*Lane 10\..*\n/m, ""), "exactly 1 through 10"],
  ["missing performance threshold", valid.replace("5 percent", "an unspecified amount"), "numeric failure threshold"],
  ["missing review video", valid.replace("None. PR-1 is not review-gated.", "The operator reviews before merge."), "review gate lacks video"],
  ["missing hold safety", valid.replace("zero-writes", "omitted"), "zero-writes stop"],
]) it("retains native gate diagnostics for " + name, async () => {
  const result = await tool().execute("bad-plan", { source });
  expect(result.details.status).toBe("ISSUES");
  expect(result.details.problems.some((p: any) => p.message.includes(diagnostic))).toBe(true);
});
for (const args of [null, {}, { source: 1 }, { source: {} }, { source: "x", path: "/etc/passwd" },
  { source: "x", label: "   " }, { source: "x", label: 1 }, { source: "x".repeat(131073) }])
it("refuses malformed arguments before coercion and on direct execution", async () => {
  const t = tool();
  expect(() => t.prepareArguments(args)).toThrow("Invalid pstack_plan_check");
  await expect(t.execute("invalid", args)).rejects.toThrow("Invalid pstack_plan_check");
});
it("honors invocation revocation without requiring write authority for a pure check", async () => {
  const guard = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw Error("revoked"); });
  await expect(tool({ assertInvocationCurrent: guard }).execute("revoked", { source: valid })).rejects.toThrow("revoked");
  expect(guard).toHaveBeenCalledTimes(2);
  const initial = vi.fn(() => { throw Error("already revoked"); });
  await expect(tool({ assertInvocationCurrent: initial }).execute("revoked", { source: valid })).rejects.toThrow("already revoked");
  expect(initial).toHaveBeenCalledTimes(1);
  expect((await tool().execute("read-only", { source: valid })).details.status).toBe("PASS");
});

// Script only model I/O; the pinned host owns admission and execution.
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
for (const provider of ["openai", "anthropic", "google"]) it("admits data and rejects coercion through actual " + provider + " native ingress", async () => {
  const [normalized] = normalizeOpenAIToolSchemas({ provider,
    modelId: provider === "google" ? "gemini-3.1-pro" : provider === "anthropic" ? "claude-opus-5-5" : "gpt-6.1-sol",
    modelApi: provider === "google" ? "google-generative-ai" : provider === "anthropic" ? "anthropic-messages" : "openai-responses",
    tools: [normalizeToolParameters(tool(), { modelProvider: provider })] });
  const result = await ingress(normalized, { source: valid, label: "native.md" });
  expect(result.isError, JSON.stringify(result.content)).toBe(false);
  expect(result.details).toMatchObject({ status: "PASS", file: "native.md", verification: "plan-structure-only" });
  const bad = await ingress(normalized, { source: 123 });
  expect(bad.isError).toBe(true);
  expect(JSON.stringify(bad.content)).toContain("Invalid pstack_plan_check");
  expect((await ingress(normalized, { source: valid, path: "forbidden" })).isError).toBe(true);
});
