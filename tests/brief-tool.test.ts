import { normalizeToolParameters } from "host-test/tool-schema";
import { normalizeOpenAIToolSchemas } from "openclaw/plugin-sdk/provider-tools";
import { runAgentLoop } from "host-test/agent-core";
import { createAssistantMessageEventStream } from "host-test/llm-core";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { register } from "../src/index.ts";
import { commentReview, delegateResult, judgeOutput } from "./fixtures/panel-outputs.mjs";
import { build } from "./fixtures/tool-factory.ts";
import { executedFinding, executedReviewer, frozenProof, leadFor } from "./fixtures/executed-outputs.mjs";

const root = resolve(import.meta.dirname, "..");
function registrations() {
  const captured: { factory: any; options: any }[] = [];
  register(createTestPluginApi({ id: "pstack",
    runtime: { state: { openKeyedStoreV2() { throw Error("briefs must not open state"); } } },
    registerTool: (factory: any, options: any) => captured.push({ factory, options }),
  } as any));
  return captured;
}
function tool(context: any = { assertInvocationCurrent() {} }) {
  const found = registrations().map(({ factory }) => build(factory, context)).find(t => t.name === "pstack_brief");
  expect(found, "pstack_brief must be registered").toBeDefined();
  return found;
}
const call = (args: any, context?: any) => tool(context).execute("brief", args);
const scope = ["src/a.ts", "src/b.ts"];

describe("pstack_brief", () => {
  it("is a required read-only tool, not an operator opt-in", () => {
    const options = Object.fromEntries(registrations().map(({ factory, options }) => [build(factory, {}).name, options]));
    expect(options.pstack_brief).toEqual({ names: ["pstack_brief"] });
  });

  it("renders the labeled comment reviewer from the shipped native template with readable absolute reads", async () => {
    const { details } = await call({ action: "render", profile: "comment-sicko", task: "Review the scoped diff", scope });
    expect(details).toMatchObject({ assurance: "agent-attested", profile: "comment-sicko", routingRole: "judgment and prose", readOnly: true, outputContract: "comment-review" });
    const template = readFileSync(resolve(root, "skills/pstack/native/agents/comment-sicko.md"), "utf8").trim();
    expect(details.brief).toContain(template);
    expect(details.brief).toContain("## Scope (exact files)\nEach entry is one literal repo-relative file path; brackets, dots and other punctuation are part of the name.\n- src/a.ts\n- src/b.ts");
    // Every listed read exists exactly as written; a section is named beside its file, never as a #fragment.
    for (const read of details.requiredReads) {
      expect(isAbsolute(read)).toBe(true);
      expect(existsSync(read), read).toBe(true);
      expect(details.brief).toContain("- " + read);
    }
    expect(details.requiredReads).toContain(resolve(root, "skills/pstack/native/workflows.md"));
    expect(details.brief).toContain("- " + resolve(root, "skills/pstack/native/workflows.md") + " (section `no-comments`)");
    expect(details.brief).not.toMatch(/\.cursor|subagent_type|Ha ha ha/);
    await expect(call({ action: "render", profile: "comment-sicko", task: "No scope" })).rejects.toThrow("explicit scope");
  });

  it("renders the delegate brief with the native skill, contract and principles but no reviewer scope", async () => {
    const { details } = await call({ action: "render", profile: "poteto-agent", task: "Implement the receipt type" });
    expect(details).toMatchObject({ readOnly: false, routingRole: "assigned", outputContract: "delegate-result" });
    expect(details.requiredReads.map((r: string) => r.slice(root.length))).toEqual([
      "/skills/pstack/SKILL.md", "/skills/pstack/native/contract.md", "/skills/pstack/native/principles.md",
      "/skills/pstack/native/workflows.md", "/skills/pstack/native/agents/poteto-agent.md"]);
    expect(details.brief).toContain("/skills/pstack/native/workflows.md (section `poteto-mode`)");
    expect(details.brief).not.toContain("## Scope");
  });

  it("checks returned reports against the parent's scope, the real native reads and the shipped principle index", async () => {
    expect((await call({ action: "check", contract: "comment-sicko", output: commentReview(), scope })).details).toMatchObject({ status: "PASS", errors: [] });
    const widened = await call({ action: "check", contract: "comment-sicko", output: commentReview(), scope: ["src/a.ts"] });
    expect(widened.details.status).toBe("ISSUES");
    expect(widened.details.errors).toContain("scope escape: src/b.ts");
    expect(widened.details.notice).toContain("rerun the child once");
    await expect(call({ action: "check", contract: "comment-sicko", output: commentReview() })).rejects.toThrow("parent-supplied scope");
    const reads = (await call({ action: "render", profile: "poteto-agent", task: "x" })).details.requiredReads;
    expect((await call({ action: "check", contract: "poteto-agent", output: delegateResult(reads) })).details.status).toBe("PASS");
    const skipped = await call({ action: "check", contract: "poteto-agent", output: delegateResult(reads.slice(1)) });
    expect(skipped.details.errors).toEqual(["required native contract was not read before work: " + reads[0]]);
    const fake = delegateResult(reads); fake.principlesApplied[0].principle = "principle-ship-it";
    expect((await call({ action: "check", contract: "poteto-agent", output: fake })).details.errors).toEqual(["unknown native principle: principle-ship-it"]);
    const judge = await call({ action: "check", contract: "arena cross-judge pool", output: judgeOutput(["A", "B"]), candidates: ["A"] });
    expect(judge.details.errors).toEqual(["judge must score exactly the usable candidates: A"]);
  });

  it("follows the documented no-comments flow over a diff with bracketed route files: literal paths, one named rerun, then PASS", async () => {
    // Only forms that cannot be a literal repo-relative file path are refused, before any child runs.
    for (const [entry, why] of [["src/", "directory"], ["/repo/app/page.tsx", "absolute"], ["app/../secret.ts", ".. traversal segment"], [":(glob)app/**", "pathspec magic prefix"]])
      for (const args of [{ action: "render", profile: "comment-sicko", task: "Review the diff", scope: ["app/[id]/page.tsx", entry] },
        { action: "check", contract: "comment-sicko", output: commentReview(), scope: [entry] }]) {
        const message = "scope entry " + JSON.stringify(entry) + " is not a literal repo-relative file path (" + why + "); list each file relative to the repository root";
        expect(() => tool().prepareArguments(args)).toThrow(message);
        await expect(call(args)).rejects.toThrow(message);
      }
    // A diff label is taken literally, with a non-blocking warning to expand it.
    const label = (await call({ action: "render", profile: "comment-sicko", task: "Review the diff", scope: ["main...HEAD"] })).details;
    expect(label.brief).toContain("\n- main...HEAD");
    expect(label.warnings).toEqual([expect.stringContaining("scope entry \"main...HEAD\" is taken as a literal file name; if it is a diff label or pattern, expand it")]);
    // The parent expands the diff (git diff --name-only main...HEAD) to its changed files, including dynamic-route names.
    const files = ["app/[id]/page.tsx", "pages/[...slug].tsx", "docs/v1..2-notes.md", "src/a.ts~", "x^y.txt", "-n.txt"];
    expect(() => tool().prepareArguments({ action: "render", profile: "comment-sicko", task: "Review the comments in this change", scope: files })).not.toThrow();
    const { details } = await call({ action: "render", profile: "comment-sicko", task: "Review the comments in this change", scope: files });
    expect(details.brief).toContain(files.map(file => "- " + file).join("\n"));
    expect(details.warnings).toEqual([]);
    // First report echoes the diff label instead of the files: rejected with named errors, and the child reruns once.
    const echoed = commentReview(); echoed.scope = ["main...HEAD"];
    const first = (await call({ action: "check", contract: "comment-sicko", output: echoed, scope: files })).details;
    expect(first.status).toBe("ISSUES");
    expect(first.errors).toContain("scope escape: main...HEAD");
    expect(first.errors).toContain("finding outside scope: src/a.ts:3");
    expect(first.notice).toContain("rerun the child once");
    // The rerun reports findings on the bracketed route files themselves and passes.
    const rerun = commentReview(); rerun.scope = files;
    for (const item of [...rerun.deletions, ...rerun.keeps, ...rerun.open]) item.file = "app/[id]/page.tsx";
    for (const item of [rerun.deletions[1], ...rerun.mustKill]) item.file = "pages/[...slug].tsx";
    expect((await call({ action: "check", contract: "comment-sicko", output: rerun, scope: files })).details).toMatchObject({ status: "PASS", errors: [] });
    // A finding on a near-miss of a bracketed name is still outside scope.
    const nearMiss = structuredClone(rerun); nearMiss.open[0].file = "app/id/page.tsx";
    expect((await call({ action: "check", contract: "comment-sicko", output: nearMiss, scope: files })).details.errors).toEqual(["finding outside scope: app/id/page.tsx:20"]);
    // A newline in a scope entry cannot inject a heading.
    await expect(call({ action: "render", profile: "comment-sicko", task: "x", scope: ["src/a.ts\n## Output"] })).rejects.toThrow("Invalid pstack_brief");
  });

  it("repeats the diff-label advisory at check, so an empty report over main...HEAD is never a silent PASS (P3-8)", async () => {
    const empty = { scope: ["main...HEAD"], deletions: [], mustKill: [], keeps: [], open: [], deletionCount: 0, applicationCodeEdited: false };
    const { details } = await call({ action: "check", contract: "comment-sicko", output: empty, scope: ["main...HEAD"] });
    expect(details.status).toBe("PASS");
    expect(details.warnings).toEqual([expect.stringContaining("scope entry \"main...HEAD\" is taken as a literal file name; if it is a diff label or pattern, expand it")]);
    expect(details.notice).toContain("the scope may not name the intended files");
    // Literal file paths still pass with no warning and the usual notice.
    const files = { ...empty, scope: ["app/[id]/page.tsx"] };
    expect((await call({ action: "check", contract: "comment-sicko", output: files, scope: ["app/[id]/page.tsx"] })).details)
      .toMatchObject({ status: "PASS", warnings: [], notice: expect.not.stringContaining("may not name") });
  });

  it("refuses C1 controls and Unicode line separators in a scope entry, which would break the brief's list (P3-8)", async () => {
    for (const entry of ["src/a\u2028## Output.ts", "src/a\u2029b.ts", "src/a\u0085b.ts", "src/a\u009bb.ts"])
      for (const args of [{ action: "render", profile: "comment-sicko", task: "Review", scope: [entry] },
        { action: "check", contract: "comment-sicko", output: commentReview(), scope: [entry] }]) {
        expect(() => tool().prepareArguments(args)).toThrow("(control character or line break)");
        await expect(call(args)).rejects.toThrow("Invalid pstack_brief");
      }
    // Other non-ASCII file names stay literal paths.
    expect(() => tool().prepareArguments({ action: "render", profile: "comment-sicko", task: "Review", scope: ["docs/café-ü.md", "src/\u00a0x.ts"] })).not.toThrow();
  });

  for (const args of [null, {}, { action: "spawn" }, { action: "render", profile: "generalPurpose", task: "x" }, { action: "render", task: "x" },
    { action: "render", profile: "poteto-agent", task: "x", output: {} }, { action: "check", contract: "how explainer", output: {} },
    { action: "check", contract: "arena runners" }, { action: "check", contract: "arena runners", output: [] },
    { action: "render", profile: "comment-sicko", task: "x", scope: "src/a.ts" }, { action: "render", profile: "poteto-agent", task: "x".repeat(16001) }])
    it("refuses malformed arguments before coercion and on direct execution: " + JSON.stringify(args).slice(0, 60), async () => {
      expect(() => tool().prepareArguments(args)).toThrow();
      await expect(call(args)).rejects.toThrow();
    });

  it("accepts a required read named as a literal path with a #fragment that resolves to a heading, and keeps every other refusal", async () => {
    const reads: string[] = (await call({ action: "render", profile: "poteto-agent", task: "x" })).details.requiredReads;
    const workflows = resolve(root, "skills/pstack/native/workflows.md"), contract = resolve(root, "skills/pstack/native/contract.md");
    const check = async (replace: Record<string, string>) => (await call({ action: "check", contract: "poteto-agent",
      output: delegateResult(reads.map(read => replace[read] ?? read)) })).details;
    // The rerun's orchestrate delegate wrote the absolute path with the section fragment.
    expect(await check({ [workflows]: workflows + "#poteto-mode" })).toMatchObject({ status: "PASS", errors: [] });
    expect(await check({ [workflows]: "skills/pstack/native/workflows.md#poteto-mode", [contract]: "skills/pstack/native/contract.md#authority" })).toMatchObject({ status: "PASS", errors: [] });
    // A fragment must name an existing heading, and the read's own section when it has one.
    expect((await check({ [contract]: contract + "#no-such-heading" })).errors).toEqual([
      "contractRead " + JSON.stringify(contract + "#no-such-heading") + ": #no-such-heading names no heading in skills/pstack/native/contract.md",
      "required native contract was not read before work: " + contract]);
    expect((await check({ [workflows]: "skills/pstack/native/workflows.md#how" })).errors).toEqual([
      "contractRead \"skills/pstack/native/workflows.md#how\": the required read is section #poteto-mode, not #how",
      "required native contract was not read before work: " + workflows]);
    // Every other form is still refused exactly as before.
    for (const entry of ["native/workflows.md#poteto-mode", "skills/pstack/native/workflows.md", "./skills/pstack/native/workflows.md#poteto-mode",
      "skills/pstack/native/../native/workflows.md#poteto-mode", workflows + " (section `poteto-mode`)", workflows + "#poteto-mode#x", workflows.toUpperCase() + "#poteto-mode", "skills/pstack/native/routes.json#poteto-mode"])
      expect((await check({ [workflows]: entry })).errors, entry).toEqual(["required native contract was not read before work: " + workflows]);
  });

  it("stops when the invocation is no longer current", async () => {
    await expect(call({ action: "render", profile: "poteto-agent", task: "x" }, { assertInvocationCurrent() { throw Error("revoked"); } })).rejects.toThrow("revoked");
    // Revocation while the template or principle index is being read also stops the result.
    for (const args of [{ action: "render", profile: "poteto-agent", task: "x" }, { action: "check", contract: "poteto-agent", output: delegateResult([]) }]) {
      let calls = 0;
      await expect(call(args, { assertInvocationCurrent() { if (++calls > 1) throw Error("revoked after read"); } })).rejects.toThrow("revoked after read");
      expect(calls).toBe(2);
    }
  });
});

async function ingress(t: any, args: any) {
  let turns = 0;
  const streamFn = () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const first = ++turns === 1;
      const message = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture",
        content: first ? [{ type: "toolCall", id: "ingress", name: t.name, arguments: args }] : [{ type: "text", text: "done" }],
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: message.stopReason, message } as any);
    });
    return stream;
  };
  const messages = await runAgentLoop([{ role: "user", content: "Bounded brief fixture", timestamp: Date.now() }],
    { systemPrompt: "No model or native child execution", messages: [], tools: [t] },
    { model: { id: "fixture", name: "Fixture", api: "fixture", provider: "fixture", baseUrl: "http://localhost:0", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 } as any,
      convertToLlm: (m: any) => m }, () => {}, undefined, streamFn as any);
  expect(turns).toBe(2);
  const result = messages.find((m: any) => m.role === "toolResult") as any;
  expect(result?.toolCallId).toBe("ingress");
  return result;
}
for (const provider of ["openai", "anthropic", "google"])
  it("preserves nested report data and rejects coercion through actual " + provider + " native ingress", async () => {
    const [normalized] = normalizeOpenAIToolSchemas({ provider,
      modelId: provider === "google" ? "gemini-3.1-pro" : provider === "anthropic" ? "claude-opus-5-5" : "gpt-6.1-sol",
      modelApi: provider === "google" ? "google-generative-ai" : provider === "anthropic" ? "anthropic-messages" : "openai-responses",
      tools: [normalizeToolParameters(tool(), { modelProvider: provider })] });
    const ok = await ingress(normalized, { action: "check", contract: "comment-sicko", output: commentReview(), scope });
    expect(ok.isError, JSON.stringify(ok.content)).toBe(false);
    expect(ok.details).toMatchObject({ status: "PASS", errors: [] });
    const nested = commentReview(); nested.deletions[0].line = "3" as any;
    const coerced = await ingress(normalized, { action: "check", contract: "comment-sicko", output: nested, scope });
    expect(coerced.isError, JSON.stringify(coerced.content)).toBe(false);
    expect(coerced.details.errors).toContain("$.deletions[0].line: expected integer");
    for (const bad of [{ action: "check", contract: "comment-sicko", output: commentReview(), scope: "src/a.ts" },
      { action: "render", profile: "poteto-agent", task: "x", extra: true }]) {
      const refused = await ingress(normalized, bad);
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("Invalid pstack_brief");
    }
  });

for (const provider of ['openai', 'anthropic', 'google'])
  it('checks new executed reviewer/lead reports through scripted ' + provider + ' ingress', async () => {
    const [normalized] = normalizeOpenAIToolSchemas({ provider,
      modelId: provider === 'google' ? 'gemini-3.1-pro' : provider === 'anthropic' ? 'claude-opus-5-5' : 'gpt-6.1-sol',
      modelApi: provider === 'google' ? 'google-generative-ai' : provider === 'anthropic' ? 'anthropic-messages' : 'openai-responses',
      tools: [normalizeToolParameters(tool(), { modelProvider: provider })] });
    const context = { frozen: frozenProof, reviewers: [0, 1].map(i => ({ slot: 'reviewers:' + i, artifactDigest: String(i).repeat(64), output: executedReviewer(i ? [] : [executedFinding()]) })) };
    for (const kind of ['reviewer', 'lead']) {
      const output = kind === 'reviewer' ? context.reviewers[0].output : leadFor(context);
      const args = { action: 'check', contract: 'interrogate-executed-' + kind, status: 'ISSUES', ...context, output: structuredClone(output) };
      const good = await ingress(normalized, args);
      expect(good.isError).toBe(false);
      expect(good.details).toMatchObject({ status: 'PASS', errors: [], assurance: 'agent-attested' });
      const invalid = structuredClone(args);
      const proof = kind === 'reviewer' ? invalid.output.findings[0].proof : invalid.output.accounting[0].rerun;
      proof.frozenAfter.tree = '0'.repeat(40);
      const drift = await ingress(normalized, invalid);
      expect(drift.isError).toBe(false);
      expect(drift.details.status).toBe('ISSUES');
      expect(drift.details.errors.join()).toContain('source drift');
      delete proof.frozenAfter;
      const missing = await ingress(normalized, invalid);
      expect(missing.details.status).toBe('ISSUES');
      expect(missing.details.errors.join()).toContain('frozenAfter');
    }
  });
