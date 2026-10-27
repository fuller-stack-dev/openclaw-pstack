// Isolated real-Gateway acceptance for the pstack native controllers. Installs the built
// plugin archive into a private Gateway; only model I/O is a scripted local provider.
// Usage: OPENCLAW_SOURCE=<built host checkout> node scripts/gateway-e2e-native.mjs --host old|new --tgz <archive>
// PSTACK_E2E_ONLY=how,why (new host) runs only those rerun scenarios, for diagnosis; its partial evidence uses separate filenames in the evidence directory.
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { randomUUID, generateKeyPairSync, createHash, sign } from "node:crypto";
import assert from "node:assert/strict";
import { reviewerOutput, architectOutput, judgeOutput, arenaOutput, delegateResult } from "../tests/fixtures/panel-outputs.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 ? pairs : [...pairs, [value.replace(/^--/, ""), all[i + 1]]]), []));
const host = process.env.OPENCLAW_SOURCE;
if (!host || !["old", "new"].includes(args.host) || !args.tgz) throw Error("Usage: OPENCLAW_SOURCE=<host> node scripts/gateway-e2e-native.mjs --host old|new --tgz <archive>");
const root = resolve(import.meta.dirname, "..");
const only = process.env.PSTACK_E2E_ONLY?.split(",").filter(Boolean);
const want = (scenario) => !only || only.includes(scenario);
const tgz = resolve(args.tgz);
const buildInfo = JSON.parse(await readFile(join(host, "dist/build-info.json"), "utf8"));
const hostCommit = spawnSync("git", ["-C", host, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const require = createRequire(join(host, "package.json"));
const { WebSocket } = require("ws");
const dir = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "pstack-e2e-" + args.host + "-"));
const evidenceDir = resolve(process.env.PSTACK_EVIDENCE_DIR || join(root, "artifacts/diagnostics"));
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("OPENCLAW_")) delete env[k];
Object.assign(env, {
  HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), OPENCLAW_STATE_DIR: join(dir, "state"), OPENCLAW_CONFIG_PATH: join(dir, "config.json"),
  OPENCLAW_HIDE_BANNER: "1", OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1", TSX_TSCONFIG_PATH: join(host, "tsconfig.json"),
  // No LAN advertising from a test Gateway (bonjour is also disabled in config).
  OPENCLAW_DISABLE_BONJOUR: "1",
});
const results = [], requests = [], frames = [];
let gateway, provider, port, gatewayLog = "";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// Partial runs use distinct filenames; raw diagnostics are never committed.
const evidence = (suffix) => join(evidenceDir, (only ? "gateway-e2e-partial-" : "gateway-e2e-") + args.host + suffix);
const check = (name, facts = {}) => { results.push({ check: name, ...facts }); console.log("PASS " + name); };
async function freePort() {
  const s = createNetServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
// A test Gateway must never advertise on the LAN.
const assertNoLanAdvertising = () => assert.ok(!/_openclaw-gw\._tcp|bonjour: advertis/i.test(gatewayLog), "Gateway advertised on the LAN");
async function until(fn, label, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    if (gateway && gateway.exitCode !== null) throw Error("Gateway exited: " + gatewayLog.slice(-6000));
    await delay(100);
  }
  throw Error("Timed out: " + label + "\n" + gatewayLog.slice(-6000));
}
function cli(...argv) {
  const r = spawnSync(process.execPath, [join(host, "openclaw.mjs"), ...argv], { cwd: dir, env, encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

// ---- Scripted provider: children answer through structured_output; parent turns follow markers.
// Rerun scenario content (1.0.0 route rerun): each role answers with its scenario's result.
const brain = { childDelayMs: 0, children: [], profileProbe: false, probes: [], slices: [], blockedSlice: "p95",
  verdict: "## Intent\nisRetryable must not retry client errors.\n\n## Reviewers\n- A (alpha): 1 finding\n- B (beta): 1 finding\n\n## Act on\n- [A, B] 400 is classified retryable (src/retry.ts:12) \u2014 harm: duplicate charges.\n\n## Consider\nNone.\n\n## Noted\nNone.\n\n## Dismissed\nNone.\n\n## Agreement Map\n1 shared finding, no contradictions.",
  groundingHow: "E2E_GROUNDING_HOW: send() is called by flush() and drainAll(); sign() runs once per attempt.",
  groundingWhy: "E2E_GROUNDING_WHY (Supported): retries stayed unimplemented until the policy is explicit.\nPreserve: one owner for retry state.",
  explanation: "## Overview\nOutbox.flush() snapshots pending deliveries and hands each to the injected sender; sign() runs per send.\n\n## How It Works\nflush() sends each item once.\n\n## Where Things Live\nsrc/queue.ts\n\n" + "\u914d\u9001\u306e\u8a73\u7d30 \u2709\ufe0f line\n".repeat(900),
  synthesis: "## The Question\nWhy does p95 sort lexically?\n\n## What We Found\n- Inferred: the default Array.prototype.sort was never chosen deliberately (git log -p src/stats.ts).\n\n## What We Don't Know\nWhether anyone chose it.\n\n## Sources Consulted\n- git: log, blame\n- issues: unavailable (no connector)\n\n## Confidence Summary\nInferred.",
  rows: "## Accepted\n| A1 | Problem: waits were not handed off | Proposal: hand off after one bounded wait | Routing: pstack how |\n\n## Rejected\n| R1 | Principle: retry once | Reason: already covered by the swarm section |\n\n## Backlog\n| B1 | Pattern: missed handoff | Evidence: turn 14 | Mechanism: lint the record for a wait event |",
  conflict: "BLOCKED: E2E conflicting write boundaries for this slice.",
  /** Slots whose final text answer, after structured_output, exceeds the host's 100 KB collector bound (H-1). */
  hugeFinal: [],
  /** P-D: the first interrogate lead answers BLOCKED; the explanation a parent later corrects. */
  leadBlockedFirst: false, wrongExplanation: undefined,
  /** P-F: the first arena judge passes its result to structured_output as a JSON string with one extra `}`, on both of its tries (the 1.2.1 rerun's failure). */
  malformedJudgeFirst: false,
  /** P-G: the organic task of a blind trial; no measurement words, model IDs or workspace. */
  blindTask: "Make the relay sender honour Retry-After for E2E-RELAY-TRIAL.",
  /** P-H: how long the plain slow child takes, and the six-line handoff its parent yields with. */
  slowChildMs: 4000,
  /** P-I (P2-1): how long a Code Mode agents.run worker takes. */
  cmWorkerMs: 4000,
  handoff: "Handoff: e2e, slow child pending\nOwner: agent:main:dashboard:pstack-yield-handoff\nPending: slow announcing child, session pending\nDone so far: spawned the child\nSnapshot: parent model\nNext: deliver when its completion event arrives" };
/** The structured result each role's child returns for its scenario. */
function childResult(role, slot, all) {
  const evidence = ["fixture/" + slot.replace(":", "-") + ".md#1"];
  switch (role) {
    case "interrogate reviewers": return { status: "PASS", evidence, report: "Reviewer " + slot + " found no defects.", output: reviewerOutput() };
    case "judgment and prose":
      if (brain.leadBlockedFirst && !all.includes("This is the one correction of slot `lead:0`")) return { status: "BLOCKED", evidence, report: "BLOCKED: E2E the lead could not read the reviews." };
      return { status: "ISSUES", evidence, report: brain.verdict };
    case "how explainer":
      if (brain.wrongExplanation && slot === "explainer:0" && !all.includes("This child is the one correction")) return { status: "PASS", evidence, report: brain.wrongExplanation };
      return { status: "PASS", evidence, report: slot === "grounding:how" ? brain.groundingHow : brain.explanation };
    case "why synthesizer": return { status: "PASS", evidence, report: slot === "grounding:why" ? brain.groundingWhy : brain.synthesis };
    case "architect runners": return { status: "PASS", evidence, report: "Design package " + slot, output: architectOutput(slot === "designs:0" ? "message pipeline" : "immutable events") };
    case "arena cross-judge pool": return { status: "PASS", evidence, report: "Scored every candidate.", output: judgeOutput(JSON.parse(/Candidates to score:[^\n]*\n(\[.*\])/.exec(all)[1]).map((c) => c.label)) };
    case "arena runners": return { status: "PASS", evidence, report: "Candidate " + slot + " written.", output: arenaOutput() };
    case "swarm workers": {
      const slice = JSON.parse(/exactly this slice: (\{.*?\})\n/.exec(all)[1]);
      const blocked = slice.id === brain.blockedSlice;
      return { status: blocked ? "BLOCKED" : "PASS", evidence, report: blocked ? brain.conflict : "Slice " + slice.id + " committed in its worktree.", sha: slice.sha, method: slice.method };
    }
    case "reflect judgment, divergent, synthesizer": return { status: "PASS", evidence, report: slot === "synthesizer:0" ? brain.rows : "Lens " + slot + " findings." };
    default: return { status: "PASS", evidence, report: "Result for " + slot + "." };
  }
}
// A call to a tool the host did not offer comes back flattened into message text.
const calledTool = (messages, name) => messages.some((m) => (m.tool_calls ?? []).some((c) => c.function?.name === name) || text(m).includes(" name=" + name + "]"));
const text = (m) => typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text ?? "").join("\n");
function decide(body) {
  const messages = body.messages ?? [], all = messages.map(text).join("\n"), last = messages.at(-1);
  const tools = (body.tools ?? []).map((t) => t.function?.name);
  // P-H: a plain announcing or collector child (no output schema) that answers a few seconds later, in text.
  if (all.includes("E2E_SLOW_CHILD_TASK") && !messages.some((m) => m.role === "assistant")) return { delayMs: brain.slowChildMs, text: "E2E_SLOW_CHILD_DONE" };
  // P-I: a collector child that needs far longer than its run bound.
  if (all.includes("E2E_HANG_CHILD_TASK") && !messages.some((m) => m.role === "assistant")) return { delayMs: 30000, text: "E2E_HANG_DONE" };
  // P-I (P2-1): a Code Mode agents.run worker.
  if (all.includes("E2E_CM_WORKER_TASK") && !messages.some((m) => m.role === "assistant")) return { delayMs: brain.cmWorkerMs, text: "E2E_CM_WORKER_DONE" };
  if (tools.includes("structured_output")) {
    const match = /slot ([a-z]+:[a-z0-9-]+) \(role `([^`]+)`\)/.exec(all);
    if (brain.malformedJudgeFirst && match?.[2] === "arena cross-judge pool" && !all.includes("This is the one correction of slot `judge:0`")) {
      const tries = messages.filter((m) => (m.tool_calls ?? []).some((c) => c.function?.name === "structured_output")).length;
      if (tries >= 2) return { text: "E2E_JUDGE_GAVE_UP I scored both candidates, but both structured_output attempts were rejected; my status would be PASS." };
      if (!tries) brain.children.push({ model: body.model, slot: match[1], role: match[2], at: Date.now(), task: all, malformed: true });
      return { call: { name: "structured_output", arguments: { result: JSON.stringify(childResult(match[2], match[1], all)) + "}" } } };
    }
    if (calledTool(messages, "structured_output")) return { text: brain.hugeFinal.includes(match?.[1]) ? "Recorded. " + "x".repeat(110_000) : "Recorded." };
    // S5 probe: a profiled reviewer first tries to write a file; the host must refuse it.
    if (brain.profileProbe && match?.[2] === "interrogate reviewers") {
      if (!calledTool(messages, "write")) {
        brain.probes.push({ slot: match[1], model: body.model, tools });
        return { call: { name: "write", arguments: { path: "PROFILE_PROBE-" + match[1].replace(":", "-") + ".txt", content: "a profiled reviewer must not write" } } };
      }
      const probe = brain.probes.find((p) => p.slot === match[1]);
      if (probe && probe.result === undefined) probe.result = text(last);
    }
    brain.children.push({ model: body.model, slot: match?.[1], role: match?.[2], at: Date.now(), task: all });
    const result = childResult(match?.[2], match?.[1], all);
    return { delayMs: brain.childDelayMs, call: { name: "structured_output", arguments: { result } } };
  }
  const lastCall = messages.findLast((m) => m.role === "assistant" && m.tool_calls?.length)?.tool_calls?.[0]?.function?.name;
  if (last?.role === "tool" && all.includes("E2E_YIELD_HANDOFF") && !all.includes("E2E_SLOW_CHILD_DONE")) {
    // The r6 shape: an announcing child pending, then a six-line handoff sent with waitFor.
    if (lastCall === "sessions_spawn") return { call: { name: "sessions_yield", arguments: { acknowledgment: brain.handoff, message: "E2E private resume notes", waitFor: "message" } } };
  }
  if (last?.role === "tool" && (all.includes("E2E_COLLECT_IN_TURN") || all.includes("E2E_COLLECT_BOUNDED"))) {
    // A collector is collected in the turn that spawned it: agents_wait with awaitResults, no handoff.
    // The run id is read by pattern: in pstack mode the spawn result may carry the plugin's note after its JSON.
    // A refused spawn has no run id and falls through to the plain tool reply.
    const accepted = /"runId":\s*"([^"]+)"/.exec(text(last));
    if (lastCall === "sessions_spawn" && accepted) {
      if (text(last).includes("Pstack set runTimeoutSeconds")) brain.collectorNoteSeen = true;
      return { call: { name: "agents_wait", arguments: { ids: [accepted[1]], awaitResults: true } } };
    }
    if (lastCall === "agents_wait") return { text: "E2E_COLLECTED " + text(last) };
  }
  if (last?.role === "tool" && all.includes("E2E_AGENTS_RUN") && lastCall && ["exec", "wait"].includes(lastCall)) {
    // A Code Mode cell still waiting on its nested agents.run resumes with wait; a finished one is reported.
    const result = text(last), waiting = /"status":\s*"waiting"/.test(result) && /"runId":\s*"([^"]+)"/.exec(result);
    if (waiting) return { call: { name: "wait", arguments: { runId: waiting[1] } } };
    return { text: "E2E_AGENTS_RUN_DONE " + result };
  }
  if (last?.role === "tool") return { text: "E2E_TOOL_DONE " + text(last) };
  // The current turn: every user message after the last assistant reply (runtime context included).
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
  const prompt = messages.slice(lastAssistant + 1).filter((m) => m.role === "user").map(text).join("\n");
  const marker = /E2E_WORKFLOW_GET (pw-[a-z0-9]{12})/.exec(prompt);
  if (marker) return { call: { name: "pstack_workflow", arguments: { action: "get", workflowId: marker[1] } } };
  // P-I (P2-1): a Code Mode parent runs one agents.run worker; P-I (P3-68): a collector planned through pstack_route.
  const agentsRun = /E2E_AGENTS_RUN (\w+)/.exec(prompt);
  if (agentsRun && tools.includes("exec")) return { call: { name: "exec", arguments: { title: "Run one Code Mode worker",
    code: 'const result = await agents.run("E2E_CM_WORKER_TASK: reply when done.", { label: "code mode worker ' + agentsRun[1] + '" });\nreturn result;' } } };
  if (prompt.includes("E2E_ROUTE_COLLECTOR")) {
    const spawnSchema = (body.tools ?? []).find((t) => t.function?.name === "sessions_spawn")?.function?.parameters;
    return { call: { name: "pstack_route", arguments: { role: "bug-fix", task: "E2E_SLOW_CHILD_TASK: reply when done.", spawnSchema, baseArgs: { collect: true } } } };
  }
  if (prompt.includes("E2E_ROUTE_ROLE_ONLY")) return { call: { name: "pstack_route", arguments: { role: "bug-fix" } } };
  // P-G: plan a blind trial with the real sessions_spawn schema, then spawn the returned arguments unchanged.
  if (prompt.includes("E2E_ROUTE_BLIND")) {
    const spawnSchema = (body.tools ?? []).find((t) => t.function?.name === "sessions_spawn")?.function?.parameters;
    return { call: { name: "pstack_route", arguments: { role: "arena runners", task: brain.blindTask, blind: true, withheld: ["429 and 503 are retried; 400 is not"], spawnSchema } } };
  }
  const spawnBlind = /E2E_SPAWN_ARGS (\{.*\})/.exec(prompt);
  if (spawnBlind) return { call: { name: "sessions_spawn", arguments: JSON.parse(spawnBlind[1]) } };
  if (prompt.includes("E2E_YIELD_WAITFOR")) return { call: { name: "sessions_yield", arguments: { acknowledgment: "UNUSED", waitFor: "message" } } };
  // P-I (checked before the resume marker, which runtime context listing earlier children can carry): a collector that asks for more than pstack's maximum, and one whose bound is shorter than its child's work.
  if (prompt.includes("E2E_COLLECT_LONG")) return { call: { name: "sessions_spawn", arguments: { task: "E2E_SLOW_CHILD_TASK: reply when done.", label: "long collector child", collect: true, runTimeoutSeconds: 1800 } } };
  if (prompt.includes("E2E_COLLECT_BOUNDED")) return { call: { name: "sessions_spawn", arguments: { task: "E2E_HANG_CHILD_TASK: reply when done.", label: "bounded collector child", collect: true, runTimeoutSeconds: 3 } } };
  // The announcing child's completion event resumes the parent without waitFor.
  if (prompt.includes("E2E_SLOW_CHILD") && messages.some((m) => m.role === "assistant")) return { text: "E2E_RESUMED_BY_CHILD" };
  if (prompt.includes("E2E_YIELD_HANDOFF")) return { call: { name: "sessions_spawn", arguments: { task: "E2E_SLOW_CHILD_TASK: reply when done.", label: "slow announcing child" } } };
  if (prompt.includes("E2E_COLLECT_IN_TURN")) return { call: { name: "sessions_spawn", arguments: { task: "E2E_SLOW_CHILD_TASK: reply when done.", label: "slow collector child", collect: true } } };
  const pool = /E2E_ROUTE_POOL (\S+)/.exec(prompt);
  if (pool) return { call: { name: "pstack_route", arguments: { role: "arena cross-judge pool", parentModel: pool[1] } } };
  if (prompt.includes("E2E_BRIEF_RENDER_DELEGATE")) return { call: { name: "pstack_brief", arguments: { action: "render", profile: "poteto-agent", task: "Implement the fixture receipt" } } };
  const briefCheck = /E2E_BRIEF_CHECK (\{.*\})/.exec(prompt);
  if (briefCheck) return { call: { name: "pstack_brief", arguments: { action: "check", contract: "poteto-agent", output: JSON.parse(briefCheck[1]) } } };
  if (prompt.includes("E2E_BRIEF_RENDER")) return { call: { name: "pstack_brief", arguments: { action: "render", profile: "comment-sicko", task: "Review the fixture", scope: ["src/fixture.ts"] } } };
  // Read-only routes: help answers in text; setup reads the workspace role file the context names.
  if (prompt.includes("Pstack read-only route /pstack-poteto-help")) return { text: "E2E_HELP_ANSWER create-formal-verification-skill; unattended runs need S6." };
  const setupFile = /The workspace role configuration is (\S+?pstack-models\.json)/.exec(prompt);
  if (setupFile) return { call: { name: "read", arguments: { path: setupFile[1] } } };
  // Native framing: record the deferred swarm slices or why sources from the injected context.
  const native = [...prompt.matchAll(/Native pstack [a-z]+ workflow `(pw-[a-z0-9]{12})` \(deterministic controller records; revision (\d+),/g)].at(-1);
  const deferred = /Deferred option to configure: (slices|sources)/.exec(prompt);
  if (native && deferred && /(^|\n)\/pstack/.test(prompt)) {
    const options = deferred[1] === "slices" ? { slices: brain.slices } : { sources: ["source-control", "issues", "documents", "chat", "observability", "errors", "analytics"].map((category) => ({
      id: category === "source-control" ? "git" : category, category, disposition: category === "source-control" ? "available" : "unavailable",
      reason: category === "source-control" ? "local git history" : "no " + category + " connector in this isolated workspace" })) };
    return { call: { name: "pstack_workflow", arguments: { action: "apply", workflowId: native[1], revision: Number(native[2]), event: { id: "e2e-configure-" + native[2], type: "configure", options } } } };
  }
  // Only this turn's injected checkpoint counts; earlier turns' contexts remain in history.
  const gates = [...prompt.matchAll(/Gates to record with pstack_workflow \{action:"apply", workflowId:"(pw-[a-z0-9]{12})", revision:(\d+), event:\{id, type:"advance", evidence:\{([^}]*)\}\}\}/g)].at(-1);
  if (gates && /(^|\n)\/pstack/.test(prompt)) {
    // P-G: lead scores name every usable candidate label the context lists, as the controller requires.
    const labels = [.../under its label verbatim \(([^)]*)\)/.exec(prompt)?.[1]?.matchAll(/`([a-z]+:\d)`/g) ?? []].map((m) => m[1]);
    const evidence = Object.fromEntries([...gates[3].matchAll(/"([^"]+)": <evidence>/g)].map(([, gate]) => [gate, gate === "lead-scores" ? "E2E_LEAD_SCORES " + labels.map((l) => l + ": correctness 4, boundary 3").join("; ") : "e2e evidence for " + gate]));
    return { call: { name: "pstack_workflow", arguments: { action: "apply", workflowId: gates[1], revision: Number(gates[2]), event: { id: "e2e-" + gates[2], type: "advance", evidence } } } };
  }
  return { text: "Isolated model response." };
}
const chunk = (delta, finish_reason = null) => ({ id: "stub-" + randomUUID(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub", choices: [{ index: 0, delta, finish_reason }] });
async function answer(req, res) {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: ["parent", "alpha", "beta", "coder", "openai/gpt-6-astra"].map((id) => ({ id, object: "model" })) })); return; }
  const decision = decide(body);
  requests.push({ url: req.url, model: body.model, tools: (body.tools ?? []).map((t) => t.function?.name), last: text(body.messages?.at(-1)).slice(0, 400), reply: decision.call?.name ?? "text", text: decision.text?.slice(0, 200), body });
  if (decision.delayMs) await delay(decision.delayMs);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const parts = decision.call
    ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + randomUUID().slice(0, 8), type: "function", function: { name: decision.call.name, arguments: JSON.stringify(decision.call.arguments) } }] }), chunk({}, "tool_calls")]
    : [chunk({ role: "assistant" }), chunk({ content: decision.text }), chunk({}, "stop")];
  for (const part of parts) res.write("data: " + JSON.stringify(part) + "\n\n");
  res.end("data: [DONE]\n\n");
}

// ---- Gateway lifecycle and identities.
const identities = new Map();
async function start() {
  gateway = spawn(process.execPath, [join(host, "openclaw.mjs"), "gateway", "run", "--port", String(port), "--bind", "loopback"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  gateway.stdout.on("data", (b) => { gatewayLog += b; });
  gateway.stderr.on("data", (b) => { gatewayLog += b; });
  await until(async () => { try { return (await fetch("http://127.0.0.1:" + port + "/readyz")).ok; } catch { return false; } }, "Gateway ready");
}
async function stop() {
  for (const id of identities.values()) id.ws?.terminate();
  if (gateway && gateway.exitCode === null) {
    const p = gateway;
    p.kill("SIGTERM");
    await Promise.race([new Promise((r) => p.once("exit", r)), delay(20000).then(() => p.kill("SIGKILL"))]);
  }
  gateway = undefined;
}
async function connect(user) {
  const keys = identities.get(user)?.keys ?? generateKeyPairSync("ed25519");
  const rawKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32), deviceId = createHash("sha256").update(rawKey).digest("hex");
  const ws = new WebSocket("ws://127.0.0.1:" + port, { headers: { origin: "http://127.0.0.1:" + port, "x-forwarded-user": user, "x-forwarded-for": "192.0.2.55", "x-forwarded-proto": "https" } });
  const identity = { user, keys, ws, frames: [] };
  identities.set(user, identity);
  ws.on("message", (b) => { try { const f = JSON.parse(String(b)); identity.frames.push(f); frames.push({ user, ...f }); } catch {} });
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  await until(() => identity.frames.some((f) => f.event === "connect.challenge"), "challenge");
  const nonce = identity.frames.findLast((f) => f.event === "connect.challenge").payload.nonce, signedAt = Date.now(), scopes = ["operator.admin", "operator.read", "operator.write"];
  const payload = ["v3", deviceId, "openclaw-control-ui", "webchat", "operator", scopes.join(","), String(signedAt), "", nonce, "test", ""].join("|");
  const hello = await rpc(user, "connect", {
    minProtocol: 4, maxProtocol: 4, client: { id: "openclaw-control-ui", version: "pstack-e2e", buildId: buildInfo.buildId, platform: "test", mode: "webchat" },
    role: "operator", scopes, caps: [],
    device: { id: deviceId, publicKey: rawKey.toString("base64url"), signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64url"), signedAt, nonce },
  });
  identity.scopes = hello.auth?.scopes;
  return identity;
}
async function rpc(user, method, params, { raw = false } = {}) {
  const identity = identities.get(user);
  for (let attempt = 0; attempt < 120; attempt++) {
    const id = randomUUID();
    identity.ws.send(JSON.stringify({ type: "req", id, method, params }));
    const f = await until(() => identity.frames.find((x) => x.type === "res" && x.id === id), method);
    if (f.ok) return f.payload;
    if (f.error?.retryable && ["startup-sidecars", "goal-session-busy"].includes(f.error?.details?.reason)) { await delay(f.error.retryAfterMs ?? 500); continue; }
    if (raw) return { error: f.error };
    throw Error(method + " failed: " + JSON.stringify(f.error));
  }
  throw Error(method + " admission did not become ready");
}
async function chat(user, sessionKey, message) {
  const identity = identities.get(user), before = identity.frames.length;
  const ack = await rpc(user, "chat.send", { sessionKey, message, idempotencyKey: randomUUID() });
  const final = await until(() => identity.frames.slice(before).find((f) => f.event === "chat" && f.payload?.sessionKey === sessionKey && ["final", "error", "aborted"].includes(f.payload?.state)), message, 240000);
  if (final.payload.state !== "final") throw Error("Chat failed: " + JSON.stringify(final.payload).slice(0, 2000));
  return { ack, text: text(final.payload.message) };
}
const toolResult = (reply) => { const at = reply.text.indexOf("E2E_TOOL_DONE "); assert.ok(at >= 0, "tool result expected: " + reply.text.slice(0, 600)); return reply.text.slice(at + 14); };
/** Resumes a native record until `done(reply)` holds; only handoffs and parent turns may come first. */
async function resumeUntil(user, sessionKey, reply, done, limit = 16) {
  const seen = [];
  for (let i = 0; i < limit; i++) {
    if (done(reply)) return { reply, seen };
    assert.match(reply.text, /still running|E2E_TOOL_DONE /, "only handoffs and parent turns may precede the end: " + reply.text.slice(0, 1200));
    seen.push(reply.text.slice(0, 300));
    await delay(500);
    reply = await chat(user, sessionKey, "/pstack resume");
  }
  throw Error("Workflow never finished: " + reply.text.slice(0, 1200));
}
const finished = (reply) => reply.text.includes("No native pstack workflow to resume in this session.");
const quoted = (report) => report.split("\n").map((line) => line ? "> " + line : ">").join("\n");
const childrenSince = (n, role) => brain.children.slice(n).filter((c) => !role || c.role === role);
async function workflow(user, sessionKey, id) {
  const raw = toolResult(await chat(user, sessionKey, "E2E_WORKFLOW_GET " + id)).replace(/^[^{]*/, "");
  try { const got = JSON.parse(raw); return got.details ?? got; }
  catch (error) {
    const at = Number(/position (\d+)/.exec(String(error))?.[1] ?? 0);
    await writeFile(join(evidenceDir, "pstack-e2e-workflow-get-" + id + ".txt"), raw);
    throw Error("pstack_workflow get result is not JSON (" + raw.length + " characters): " + error + " near " + JSON.stringify(raw.slice(Math.max(0, at - 200), at + 200)));
  }
}
/** A native record as the plugin stored it, read from the isolated state database (tool results reach the model trimmed). */
async function storedRecord(id) {
  return storedRecordWhere((record) => record.id === id);
}
async function storedRecordWhere(match) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(env.OPENCLAW_STATE_DIR, "state/openclaw.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT value_json FROM plugin_state_entries WHERE plugin_id = 'pstack' AND namespace = 'workflow-v1'").all();
    return rows.map((row) => JSON.parse(row.value_json)).find(match);
  } finally { db.close(); }
}
/**
 * The session's latest assistant message in full. The host's chat projection shows the first
 * 8,000 characters of a longer message and marks it truncated; the Control UI then recovers the
 * whole persisted message through chat.message.get, as this does.
 */
async function fullReply(user, sessionKey) {
  const latest = ((await rpc(user, "chat.history", { sessionKey, limit: 20 })).messages ?? []).filter((m) => m.role === "assistant").at(-1);
  const meta = latest?.__openclaw ?? {};
  if (meta.truncated !== true) return { text: text(latest), capped: false };
  const got = await rpc(user, "chat.message.get", { sessionKey, messageId: meta.id ?? latest.messageId, maxChars: 500000 });
  assert.equal(got.ok, true, "chat.message.get recovers the capped message: " + JSON.stringify(got).slice(0, 400));
  return { text: text(got.message), capped: true, displayed: text(latest).length };
}
async function history(user, sessionKey) {
  const page = await rpc(user, "chat.history", { sessionKey, limit: 200 });
  return (page.messages ?? []).map((m) => ({ role: m.role, text: text(m) }));
}

try {
  for (const p of [env.HOME, env.TMPDIR, env.OPENCLAW_STATE_DIR, join(dir, "workspace")]) await mkdir(p, { recursive: true, mode: 0o700 });
  // The handoff store must resolve inside private TMPDIR before any Gateway process runs.
  const preflight = join(dir, "preflight.mjs");
  await writeFile(preflight, "import {resolveManagedUpdateLeaseDatabasePath} from " + JSON.stringify(join(host, "src/infra/update-managed-service-handoff-lease.ts")) +
    "; const p=resolveManagedUpdateLeaseDatabasePath(); if(!p.startsWith(" + JSON.stringify(env.TMPDIR + "/") + '))throw Error("Unisolated handoff path: "+p); console.log(p);');
  const checked = spawnSync(process.execPath, ["--import", join(host, "node_modules/tsx/dist/loader.mjs"), preflight], { env, cwd: host, encoding: "utf8", timeout: 60000 });
  if (checked.status !== 0) throw Error("Handoff resolver preflight: " + checked.stdout + checked.stderr);
  check("private handoff store", { path: checked.stdout.trim() });

  provider = createServer((req, res) => { answer(req, res).catch((error) => { res.statusCode = 500; res.end(String(error)); }); });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  port = await freePort();
  const requester = "requester@example.test", admin = "admin@example.test";
  const fixtureModel = (id) => ({ id, name: id, contextWindow: 128000, maxTokens: 512, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const providerRow = (models) => ({ baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1", apiKey: "isolated-not-a-secret", api: "openai-completions", models: models.map(fixtureModel) });
  const config = {
    gateway: {
      mode: "local", port, trustedProxies: ["127.0.0.1", "::1"],
      auth: { mode: "trusted-proxy", identityScopes: Object.fromEntries([requester, admin].map((u) => [u, ["operator.admin", "operator.read", "operator.write"]])),
        trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true, allowUsers: [requester, admin], deviceAutoApprove: { enabled: true, scopes: ["operator.admin", "operator.read", "operator.write"] } } },
      controlUi: { allowedOrigins: ["http://127.0.0.1:" + port] },
      ...(args.host === "new" ? { roles: { default: "operator", definitions: {
        operator: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin", "operator.read", "operator.write"] },
        viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
      } } } : {}),
    },
    agents: { defaults: { workspace: join(dir, "workspace"), model: { primary: "pstack-fixture/parent" }, ...(args.host === "old" ? { heartbeat: { every: "0m" } } : {}), skipBootstrap: true,
      // P-I (P2-1, new host): Code Mode on for one fixture model, which the agents.run parent selects; every other model keeps its default.
      ...(args.host === "new" ? { models: Object.fromEntries(["pstack-fixture/parent", "pstack-fixture/alpha", "pstack-fixture/beta", "pstack-router/openai/gpt-6-astra", "pstack-fam-a/review-a", "pstack-fam-b/review-b"].map((m) => [m, {}]).concat([["pstack-fixture/coder", { codeMode: true }]])) } : {}) } },
    models: { mode: "merge", providers: { "pstack-fixture": providerRow(["parent", "alpha", "beta", "coder"]), "pstack-router": providerRow(["openai/gpt-6-astra"]) } },
    // Direct tool schemas keep the scripted provider simple; Tool Search is a model-facing convenience.
    tools: { profile: "coding", alsoAllow: ["pstack_route", "pstack_workflow", "pstack_brief"], toolSearch: false },
    discovery: { mdns: { mode: "off" } },
  };
  // H-2 (new host): a fixture provider plugin whose static catalog declares a canonical family
  // for each provider. Its configured rows keep the catalog's route (the scripted endpoint), so
  // the host keeps their families, and children on them still reach only the scripted provider.
  const familyPlugin = join(dir, "family-fixture");
  if (args.host === "new") {
    await mkdir(familyPlugin, { recursive: true });
    const catalogProvider = (family, id) => ({ baseUrl: providerRow([]).baseUrl, api: "openai-completions", family, models: [fixtureModel(id)] });
    await writeFile(join(familyPlugin, "openclaw.plugin.json"), JSON.stringify({ id: "pstack-family-fixture", configSchema: { type: "object", additionalProperties: false },
      providers: ["pstack-fam-a", "pstack-fam-b"],
      modelCatalog: { providers: { "pstack-fam-a": catalogProvider("fixture-a", "review-a"), "pstack-fam-b": catalogProvider("fixture-b", "review-b") }, discovery: { "pstack-fam-a": "static", "pstack-fam-b": "static" } } }, null, 2));
    await writeFile(join(familyPlugin, "index.js"), 'module.exports = { id: "pstack-family-fixture", register() {} };\n');
    config.models.providers["pstack-fam-a"] = providerRow(["review-a"]);
    config.models.providers["pstack-fam-b"] = providerRow(["review-b"]);
    config.plugins = { load: { paths: [familyPlugin] }, entries: { "pstack-family-fixture": { enabled: true } } };
  }
  await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  // The configured three-segment router model is the shape that failed role-only routing in 0.3.
  await writeFile(join(dir, "workspace/pstack-models.json"), JSON.stringify({ version: 1,
    presets: { alpha: { model: "pstack-fixture/alpha" }, beta: { model: "pstack-fixture/beta" }, astra: { model: "pstack-router/openai/gpt-6-astra" } },
    roles: { "interrogate reviewers": ["alpha", "beta"], "bug-fix": "astra", "judgment and prose": "astra", "how explainer": "alpha", "why synthesizer": "beta",
      "architect runners": ["alpha", "beta"], "arena cross-judge pool": ["beta", "alpha"], "swarm workers": "alpha", "reflect judgment, divergent, synthesizer": "beta" } }));
  const install = cli("plugins", "install", "npm-pack:" + tgz, "--force", "--accept-capabilities");
  await writeFile(join(dir, "install.log"), install.out);
  if (install.status !== 0) throw Error("Plugin install failed:\n" + install.out);
  check("built archive installed into the isolated Gateway", { archive: tgz, sha256: createHash("sha256").update(await readFile(tgz)).digest("hex"), output: install.out.trim().split("\n").slice(-3) });
  const installed = JSON.parse(await readFile(env.OPENCLAW_CONFIG_PATH, "utf8"));
  installed.plugins = { ...installed.plugins, allow: ["pstack", ...(args.host === "new" ? ["pstack-family-fixture"] : [])], entries: { ...installed.plugins?.entries, pstack: { ...installed.plugins?.entries?.pstack, enabled: true, hooks: { allowConversationAccess: true }, config: { nativeWaitSeconds: 3 } }, bonjour: { enabled: false } } };
  await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(installed, null, 2), { mode: 0o600 });
  const inspect = cli("plugins", "inspect", "pstack", "--json");
  await writeFile(join(dir, "inspect.json"), inspect.out);
  await start();
  await connect(requester);
  await connect(admin);
  assertNoLanAdvertising();
  check("no LAN advertising", { bonjourDisabled: true });
  check("Control UI identities connected", { requester: identities.get(requester).scopes, admin: identities.get(admin).scopes });

  // Role-only routing: no caller catalog. Old hosts report unverified availability; new hosts check the requester catalog.
  const route = JSON.parse(toolResult(await chat(requester, "agent:main:dashboard:pstack-route", "E2E_ROUTE_ROLE_ONLY")).replace(/^[^{]*/, ""));
  const plan = route.details ?? route;
  assert.equal(plan.snapshot?.selections?.[0]?.model ?? JSON.stringify(plan), "pstack-router/openai/gpt-6-astra");
  assert.equal(plan.availability, args.host === "new" ? "checked" : "unverified");
  check("pstack_route role-only call succeeds for the configured router model", { catalogSource: plan.catalogSource, availability: plan.availability });
  const archiveFile = (path) => spawnSync("tar", ["-xOzf", tgz, "package/" + path], { maxBuffer: 4 * 1024 * 1024 }).stdout;
  const archiveDigest = (path) => createHash("sha256").update(archiveFile(path)).digest("hex");
  const rendered = JSON.parse(toolResult(await chat(requester, "agent:main:dashboard:pstack-brief", "E2E_BRIEF_RENDER")).replace(/^[^{]*/, ""));
  const brief = rendered.details ?? rendered;
  assert.equal(brief.enforcement, "prompt-enforced");
  if (args.host === "new") assert.deepEqual(brief.hostProfile, { id: "comment-sicko", registered: true, instructionsSha256: archiveDigest("skills/pstack/native/agents/comment-sicko.md"), appliesTo: "native controller spawns only" });
  else assert.deepEqual(brief.hostProfile, { id: "comment-sicko", registered: false });
  check("pstack_brief labels agent-driven briefs prompt-enforced and reports host profile registration", { hostProfile: brief.hostProfile });
  {
    // P-D: a delegate's contractRead may name a required read as path#fragment of an existing heading.
    const plan = JSON.parse(toolResult(await chat(requester, "agent:main:dashboard:pstack-brief-delegate", "E2E_BRIEF_RENDER_DELEGATE")).replace(/^[^{]*/, ""));
    const reads = (plan.details ?? plan).requiredReads, workflows = reads.find((read) => read.endsWith("/skills/pstack/native/workflows.md"));
    const verdict = async (key, entries) => { const got = JSON.parse(toolResult(await chat(requester, key, "E2E_BRIEF_CHECK " + JSON.stringify(delegateResult(entries)))).replace(/^[^{]*/, "")); return got.details ?? got; };
    const fragment = await verdict("agent:main:dashboard:pstack-brief-fragment", reads.map((read) => read === workflows ? workflows + "#poteto-mode" : read));
    assert.deepEqual([fragment.status, fragment.errors], ["PASS", []], JSON.stringify(fragment));
    const missing = await verdict("agent:main:dashboard:pstack-brief-missing", reads.map((read) => read === workflows ? workflows + "#no-such-heading" : read));
    assert.equal(missing.status, "ISSUES");
    assert.deepEqual(missing.errors, ["contractRead " + JSON.stringify(workflows + "#no-such-heading") + ": #no-such-heading names no heading in skills/pstack/native/workflows.md", "required native contract was not read before work: " + workflows]);
    check("pstack_brief accepts a required read named path#heading and still refuses an unknown heading", { accepted: workflows + "#poteto-mode", refused: missing.errors });
  }

  if (args.host === "old") {
    const key = "agent:main:dashboard:pstack-old";
    assert.match((await chat(requester, key, "/pstack architect")).text, /unavailable in v1/);
    assert.match((await chat(requester, key, "/pstack resume")).text, /unavailable in v1/);
    const at = requests.length;
    await chat(requester, key, "/pstack-interrogate Review the fixture parser change");
    const turn = requests.slice(at).find((r) => r.body.messages);
    assert.ok(JSON.stringify(turn.body).includes("skill-guided, agent-attested continuation"), "v1 skill-guided context reached the model");
    assert.ok(!JSON.stringify(turn.body).includes("Native pstack"), "no native controller on the old host");
    assert.equal(brain.children.length, 0);
    check("old host keeps v1: single-word forms unavailable, routes continue skill-guided, no children");
    {
      const helpKey = "agent:main:dashboard:pstack-old-help", from = requests.length;
      const question = "Which pstack route checks whether delivery stays correct when drains overlap? Does setup start an overnight job?";
      const help = await chat(requester, helpKey, "/pstack-poteto-help " + question);
      assert.match(help.text, /^E2E_HELP_ANSWER/);
      const helpTurn = JSON.stringify(requests.slice(from).find((r) => r.model === "parent").body);
      for (const expected of ["Pstack read-only route /pstack-poteto-help for this turn", question,
        "native controllers (/pstack-architect, -arena, -interrogate, -swarm, -how, -why, -reflect) are unavailable, so those routes run skill-guided",
        "unattended continuation through requester-admitted scheduled command turns (S6) is unavailable, so any unattended or overnight continuation is BLOCKED on this host"])
        assert.ok(helpTurn.includes(expected), "old-host help turn context: " + expected);
      assert.match((await chat(requester, helpKey, "/pstack status")).text, /^Pstack off/);
      check("old host: poteto-help lets the agent answer read-only with the old host's facts; mode stays off", { reply: help.text });
      const setupKey = "agent:main:dashboard:pstack-old-setup", file = join(dir, "workspace/pstack-models.json"), saved = await readFile(file, "utf8");
      const shown = toolResult(await chat(requester, setupKey, "/pstack-setup-pstack Show me the current pstack model setup and role counts. Read-only. Do not run model probes or edit configuration."));
      assert.ok(shown.includes('"interrogate reviewers"'), "the agent read the workspace role file: " + shown.slice(0, 300));
      assert.equal(await readFile(file, "utf8"), saved);
      assert.match((await chat(requester, setupKey, "/pstack status")).text, /^Pstack off/);
      check("old host: setup-pstack reads the workspace role configuration read-only; nothing written, mode stays off");
    }
    assert.match(gatewayLog, /http server listening \(\d+ plugins: [^)]*\bpstack\b/);
    assert.doesNotMatch(gatewayLog, /\[plugins?\][^\n]*pstack[^\n]*(error|fail|reject)/i);
    assert.match((await chat(requester, key, "/pstack status")).text, /Pstack on/);
    check("old host loads the plugin manifest and registrations without capability errors");
  } else if (only) {
    check("partial run: only " + only.join(", "));
  } else {
    // 1. A real panel: both reviewers reach the provider with their routed models, under the S5 profile.
    const key = "agent:main:dashboard:pstack-panel";
    brain.profileProbe = true;
    // The 1.0.0 rerun's interrogate scenario.
    const framed = await chat(requester, key, "/pstack-interrogate Adversarially review the uncommitted isRetryable change and its new test before I commit it. Read-only.");
    const framedResult = toolResult(framed);
    const workflowId = /pw-[a-z0-9]{12}/.exec(framedResult)[0];
    assert.match(framedResult, /"phase":"reviewers"/);
    check("agent framed the native workflow through pstack_workflow", { workflowId });
    const { reply: done, seen: handoffs } = await resumeUntil(requester, key, await chat(requester, key, "/pstack resume"), (r) => r.text.includes("status completed"));
    const reviewers = brain.children.filter((c) => c.role === "interrogate reviewers");
    assert.deepEqual(reviewers.map((c) => c.model).sort(), ["alpha", "beta"]);
    check("real panel children reached the model provider with their routed models", { children: reviewers.map(({ task, ...c }) => c), handoffs });
    // The routed lead judge ran after both reviewers, and its verdict is the command reply, verbatim.
    const lead = brain.children.filter((c) => c.role === "judgment and prose");
    assert.deepEqual(lead.map((c) => [c.slot, c.model]), [["lead:0", "openai/gpt-6-astra"]]);
    assert.ok(lead[0].at > Math.max(...reviewers.map((c) => c.at)), "the lead runs after both reviewers");
    assert.ok(lead[0].task.includes("Reviewer reviewers:0 found no defects.") && lead[0].task.includes("Reviewer reviewers:1 found no defects."), "the lead receives both reviews");
    assert.ok(done.text.includes("**Interrogate lead verdict**, delivered verbatim from the independent child: slot `lead:0`, role `judgment and prose`, model `pstack-router/openai/gpt-6-astra`"), done.text.slice(0, 1500));
    assert.ok(done.text.includes(quoted(brain.verdict)), "verdict quoted verbatim");
    check("interrogate: the routed lead judge's verdict is delivered verbatim, quoted and attributed", { lead: lead.map(({ task, ...c }) => c), reply: done.text.slice(0, 900) });
    const got = JSON.parse(toolResult(await chat(requester, key, "E2E_WORKFLOW_GET " + workflowId)).replace(/^[^{]*/, ""));
    const view = (got.details ?? got).view;
    assert.deepEqual(view.evidenceSource, { frame: "agent-attested", reviewers: "controller", lead: "controller" });
    assert.equal(view.assurance, "deterministic");
    assert.deepEqual(["reviewers:0", "reviewers:1"].map((slot) => view.attempts[slot][0].receipts.at(-1).resolved.model), ["pstack-fixture/alpha", "pstack-fixture/beta"]);
    check("record is deterministic with host selection receipts", { evidenceSource: view.evidenceSource, receipts: ["reviewers:0", "reviewers:1"].map((s) => view.attempts[s][0].receipts) });
    brain.profileProbe = false;
    // S5: the record pins the profile; each reviewer ran with the denied tools removed.
    const reviewerDigest = archiveDigest("skills/pstack/native/agents/panel-reviewer.md");
    const pin = (got.details ?? got).record.setup.profiles?.["interrogate reviewers"];
    assert.deepEqual(pin, { id: "panel-reviewer", instructionsSha256: reviewerDigest });
    // panel-reviewer keeps the shell, so the record says read-only shell use stays prompt-enforced.
    assert.deepEqual(view.enforcement, { "interrogate reviewers": "host-profile-shell", "judgment and prose": "prompt" });
    const parentTools = new Set(requests.filter((r) => r.model === "parent").flatMap((r) => r.tools));
    const denied = ["write", "edit", "apply_patch", "plugins", "sessions_spawn", "sessions_create", "terminal", "portal", "skill_workshop", "pstack_workflow", "pstack_route"];
    assert.ok(["write", "edit", "apply_patch", "sessions_spawn"].every((tool) => parentTools.has(tool)), "the unprofiled parent has the file tools");
    assert.equal(brain.probes.length, 2);
    for (const probe of brain.probes) {
      assert.deepEqual(denied.filter((tool) => probe.tools.includes(tool)), [], "profile-denied tools are absent from " + probe.slot);
      assert.ok(probe.tools.includes("exec") && probe.tools.includes("read"), "panel-reviewer keeps read and the shell");
      assert.match(probe.result ?? "", /name=write\] Tool write not found/, "the host refused the write attempt");
    }
    const probeFiles = spawnSync("find", [dir, "-name", "PROFILE_PROBE-*"], { encoding: "utf8" }).stdout.trim();
    assert.equal(probeFiles, "", "no profiled reviewer wrote a file");
    // The host's own child run record pins the exact instructions bytes it registered.
    const { DatabaseSync } = await import("node:sqlite");
    const stateDb = new DatabaseSync(join(env.OPENCLAW_STATE_DIR, "state/openclaw.sqlite"), { readOnly: true });
    const hostRecords = ["reviewers:0", "reviewers:1"].map((slot) => {
      const row = stateDb.prepare("SELECT payload_json FROM subagent_runs WHERE child_session_key = ?").get(view.attempts[slot][0].childSessionKey);
      return JSON.parse(row.payload_json).subagentProfile;
    });
    stateDb.close();
    for (const receipt of hostRecords)
      assert.deepEqual(receipt, { pluginId: "pstack", id: "panel-reviewer", instructionsFile: "skills/pstack/native/agents/panel-reviewer.md", instructionsSha256: reviewerDigest });
    check("S5 profiled reviewers: denied tools absent, write refused, host run record carries the instructions digest", {
      pin, hostRecords, denied, probes: brain.probes.map(({ slot, model, tools, result }) => ({ slot, model, tools, result })), parentHas: ["write", "edit", "apply_patch", "sessions_spawn"] });

    // Goal admission with the command-runtime plugin loaded (no reply_dispatch hook).
    const goalKey = "agent:main:dashboard:pstack-goal";
    await chat(requester, goalKey, "E2E_GOAL_HISTORY");
    const goalAck = await rpc(requester, "chat.send", { sessionKey: goalKey, message: "Finish this isolated acceptance check.", idempotencyKey: randomUUID(),
      intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() } });
    assert.equal(goalAck.status, "started");
    const goalMutation = (action) => rpc(requester, "sessions.goal.update", { sessionKey: goalKey, sessionId: goalAck.sessionId, goalId: goalAck.goalId, operationId: randomUUID(), issuedAtMs: Date.now(), action });
    await until(async () => (await goalMutation("pause").catch(() => undefined))?.goal?.status === "paused", "Goal pause", 60000);
    const goalResumed = await goalMutation("resume");
    assert.equal(goalResumed.status, "started");
    await until(() => identities.get(requester).frames.some((f) => f.event === "chat" && f.payload?.runId === goalResumed.runId && ["final", "error"].includes(f.payload?.state)), "Goal resumed final");
    assert.equal((await goalMutation("complete")).goal.status, "complete");
    check("Goal start, pause, resume and complete with the native-controller plugin loaded");

    // 2. Handoff, Gateway restart, scheduled continuation, then manual resume.
    const restartKey = "agent:main:dashboard:pstack-restart";
    const second = /pw-[a-z0-9]{12}/.exec(toolResult(await chat(requester, restartKey, "/pstack-interrogate Review the retry path")))[0];
    brain.childDelayMs = 6000;
    const before = brain.children.length;
    const settled = () => requests.filter((r) => r.tools.includes("structured_output") && r.reply === "text").length;
    const settledBefore = settled();
    const handed = await chat(requester, restartKey, "/pstack resume");
    assert.match(handed.text, /still running after a 3s wait; handed off/);
    // P-D: the handoff names its owner, the pending children with run ids, and the exact resume command.
    const handoffLine = handed.text.split("\n").find((line) => line.startsWith("Handoff: "));
    assert.ok(handoffLine, "handoff line in the reply: " + handed.text.slice(0, 1200));
    assert.match(handoffLine, new RegExp("^Handoff: owner session `" + restartKey + "` \\(incarnation [^)]+\\), native interrogate workflow `" + second + "`, phase reviewers\\. Pending children: `reviewers:0` \\(interrogate reviewers, run `[^`]+`\\), `reviewers:1` \\(interrogate reviewers, run `[^`]+`\\)\\. A scheduled continuation collects them unattended \\(next at [0-9T:.-]+Z\\)\\. Resume with `/pstack resume " + second + "`; never respawn these children\\.$"));
    check("handoff reply names the owner, pending children with run ids, the armed continuation and the exact resume command", { handoff: handoffLine });
    await until(async () => settled() >= settledBefore + 2, "children finished", 60000);
    await stop();
    await start();
    await connect(requester);
    await connect(admin);
    check("Gateway restarted with children settled while the workflow waited", { workflowId: second });
    brain.childDelayMs = 0;
    // The occurrence collects the reviewers, runs the lead and appends its verdict to the transcript.
    const continued = await until(async () => (await history(requester, restartKey)).find((m) => m.role === "assistant" && m.text.includes("`" + second + "`") && m.text.includes("**Interrogate lead verdict**")), "scheduled continuation after restart", 240000);
    assert.ok(continued.text.includes(quoted(brain.verdict)));
    check("scheduled continuation survived the restart, collected the children and delivered the verdict unattended", { text: continued.text.slice(0, 400) });
    assert.equal((await chat(requester, restartKey, "/pstack resume")).text, "No native pstack workflow to resume in this session.");
    assert.deepEqual(childrenSince(before).map((c) => c.role), ["interrogate reviewers", "interrogate reviewers", "judgment and prose"], "no child was recreated");
    check("after the restart the workflow completed with exactly its two reviewers and one lead");

    // 3. A demoted requester is refused by the host; restoring the role lets the same record resume.
    const demoteKey = "agent:main:dashboard:pstack-demote";
    const third = /pw-[a-z0-9]{12}/.exec(toolResult(await chat(requester, demoteKey, "/pstack-interrogate Review the cache path")))[0];
    brain.childDelayMs = 6000;
    await chat(requester, demoteKey, "/pstack resume");
    const armed = JSON.parse(toolResult(await chat(requester, demoteKey, "E2E_WORKFLOW_GET " + third)).replace(/^[^{]*/, ""));
    const jobs = ((armed.details ?? armed).view.schedules ?? []).map((schedule) => schedule.jobId);
    assert.ok(jobs.length >= 1, "continuations were armed before demotion");
    const self = await rpc(requester, "users.self", {});
    await rpc(admin, "users.setRole", { profileId: self.profile.id, role: "viewer" });
    await delay(1000);
    await connect(requester);
    const refused = await rpc(requester, "chat.send", { sessionKey: demoteKey, message: "/pstack resume", idempotencyKey: randomUUID() }, { raw: true });
    assert.ok(refused.error, "demoted requester's command must be refused");
    const startedAt = Date.now();
    await until(() => Date.now() - startedAt > 45000, "scheduled occurrence window", 60000);
    const demotedHistory = await history(admin, demoteKey);
    assert.ok(!demotedHistory.some((m) => m.role === "assistant" && m.text.includes("`" + third + "`") && m.text.includes("Collected")), "scheduled continuation must not run the controller for a demoted requester");
    const runs = await rpc(admin, "cron.runs", { id: jobs[0] });
    const entries = runs.entries ?? runs.runs ?? [];
    assert.ok(entries.length >= 1 && entries.every((run) => run.status !== "ok"), "the occurrence ran and was refused: " + JSON.stringify(runs).slice(0, 1500));
    check("demoted requester is refused: direct command rejected and the scheduled occurrence refused by the host", { error: refused.error?.message ?? refused.error, occurrence: entries.map((run) => ({ status: run.status, error: run.error })) });
    const childrenAtDemotion = brain.children.length;
    await rpc(admin, "users.setRole", { profileId: self.profile.id, role: null });
    await delay(1000);
    await connect(requester);
    brain.childDelayMs = 0;
    // Children admitted under the revoked authority do not outlive it. The controller reports
    // them and refuses to respawn; the restored requester cancels and starts a fresh panel.
    const after = await chat(requester, demoteKey, "/pstack resume");
    assert.match(after.text, /BLOCKED: Required child failed: reviewers:0 \(Native child killed/);
    assert.match(after.text, /will not advance or respawn/);
    assert.equal(brain.children.length, childrenAtDemotion, "no child was recreated after demotion");
    check("host-killed children of the demoted requester fail the phase visibly without respawn", { workflowId: third, text: after.text.split("\n").slice(0, 3) });
    assert.match((await chat(requester, demoteKey, "/pstack resume cancel demoted run")).text, /status cancelled/);
    toolResult(await chat(requester, demoteKey, "/pstack-interrogate Review the cache path again"));
    await resumeUntil(requester, demoteKey, await chat(requester, demoteKey, "/pstack resume"), (r) => r.text.includes("status completed"));
    check("restored requester ran a fresh native panel to completion");

  }
  if (args.host === "new") {
    // 4. The 1.0.0 rerun scenarios of every Round 2 lane P-A fix, on this host.
    const plain = (key) => chat(requester, key, "/pstack status");
    if (want("poteto-help")) {
      const helpKey = "agent:main:dashboard:pstack-poteto-help", at = requests.length;
      const question = "Which pstack route checks whether delivery stays correct when drains overlap? Does setup start an overnight job?";
      const help = await chat(requester, helpKey, "/pstack-poteto-help " + question);
      assert.match(help.text, /^E2E_HELP_ANSWER/);
      const turn = JSON.stringify(requests.slice(at).find((r) => r.model === "parent").body);
      for (const expected of ["Pstack read-only route /pstack-poteto-help for this turn", question, "skills/pstack/native/routes.json",
        "unattended continuation through requester-admitted scheduled command turns (S6) is available to native controller workflows only"])
        assert.ok(turn.includes(expected), "help turn context: " + expected);
      assert.match((await plain(helpKey)).text, /^Pstack off/);
      check("poteto-help: the agent answers the user's question read-only with route sources and host facts; mode stays off", { reply: help.text });
    }
    if (want("setup-pstack")) {
      const setupKey = "agent:main:dashboard:pstack-setup", file = join(dir, "workspace/pstack-models.json"), saved = await readFile(file, "utf8");
      const shown = toolResult(await chat(requester, setupKey, "/pstack-setup-pstack Show me the current pstack model setup and role counts. Read-only. Do not run model probes or edit configuration."));
      assert.ok(shown.includes('"interrogate reviewers"') && shown.includes('"judgment and prose"'), "the agent read the workspace role file: " + shown.slice(0, 400));
      assert.equal(await readFile(file, "utf8"), saved);
      assert.match((await plain(setupKey)).text, /^Pstack off/);
      check("setup-pstack: the agent reads the workspace role configuration read-only; nothing written, mode stays off", { shown: shown.slice(0, 300) });
    }
    if (want("architect")) {
      const archKey = "agent:main:dashboard:pstack-architect", at = brain.children.length;
      const first = await chat(requester, archKey, "/pstack-architect design-only Design bounded retries for send(). Ground the design in its callers first. Design only; do not implement.");
      const { seen } = await resumeUntil(requester, archKey, first, finished);
      const spawned = childrenSince(at);
      assert.deepEqual(spawned.map((c) => c.slot.split(":")[0]), ["grounding", "grounding", "designs", "designs", "judge"]);
      assert.deepEqual(spawned.slice(0, 2).map((c) => [c.slot, c.role, c.model]).sort(), [["grounding:how", "how explainer", "alpha"], ["grounding:why", "why synthesizer", "beta"]]);
      for (const runner of spawned.filter((c) => c.role === "architect runners" || c.role === "arena cross-judge pool"))
        assert.ok(runner.task.includes(brain.groundingHow) && runner.task.includes("E2E_GROUNDING_WHY (Supported)"), runner.slot + " received the grounding reports");
      assert.equal(spawned.length, 5);
      const judgeTask = spawned.find((c) => c.role === "arena cross-judge pool").task;
      assert.ok(!judgeTask.includes("E2E_LEAD_SCORES"), "the judge never sees the lead's scores");
      const archRecord = await storedRecordWhere((r) => r.setup?.kind === "architect");
      const leadAt = archRecord.events.findIndex((e) => e.type === "advance" && /^E2E_LEAD_SCORES designs:0: .*designs:1: /.test(e.evidence?.["lead-scores"] ?? ""));
      const judgeAt = archRecord.events.findIndex((e) => e.type === "dispatch" && e.slot === "judge:0");
      assert.ok(archRecord.setup.leadFirst === true && leadAt >= 0 && judgeAt > leadAt, "P-G: the lead's scores were recorded before the judge was dispatched");
      check("architect: independent how and why grounding children ran first and the runners and judge received their reports; P-G: the lead scored both designs before the judge was dispatched", { children: spawned.map(({ task, ...c }) => c), turns: seen.length, leadEvent: leadAt, judgeDispatch: judgeAt });
    }
    if (want("arena")) {
      // P-F: a judge whose structured result is a JSON string with one extra `}` is retried once, under the same routing.
      const arenaKey = "agent:main:dashboard:pstack-arena", at = brain.children.length, sent = requests.length;
      brain.malformedJudgeFirst = true;
      const first = await chat(requester, arenaKey, "/pstack-arena Pick the lighter retry design for send(): two candidates, then one judge.");
      const id = /pw-[a-z0-9]{12}/.exec(first.text)?.[0];
      const { seen } = await resumeUntil(requester, arenaKey, first, finished);
      brain.malformedJudgeFirst = false;
      const judges = childrenSince(at, "arena cross-judge pool");
      assert.equal(judges.length, 2, "one retry judge after the malformed one");
      assert.ok(judges[0].malformed && !judges[1].malformed);
      assert.equal(judges[1].model, judges[0].model, "the retry runs under the same pinned routing");
      assert.ok(judges[1].task.includes("This is the one correction of slot `judge:0`.") && judges[1].task.includes("<root>: must be object") && judges[1].task.includes("E2E_JUDGE_GAVE_UP"),
        "the retry brief names the schema error and carries the first judge's answer");
      assert.equal(childrenSince(at, "arena runners").length, 2, "the candidates are kept, not rerun");
      const context = requests.slice(sent).map((r) => (r.body.messages ?? []).map(text).join("\n")).find((t) => t.includes("Retried or corrected once"));
      assert.ok(context && /- judge:0: the controller retried it once; the first attempt \(run [^)]+\) failed: Failed the controller's check: Native child failed \(schema: <root>: must be object\)/.test(context), "the parent checkpoint context discloses the retry");
      // P-G: the lead's own scores come first; the judge is dispatched only after they are recorded and never sees them.
      const contexts = requests.slice(sent).map((r) => (r.body.messages ?? []).map(text).join("\n"));
      assert.ok(contexts.some((t) => t.includes("Lead scores first. Read every usable candidate end to end") && t.includes("(`candidates:0`, `candidates:1`)")), "the lead checkpoint names both labels");
      assert.ok(contexts.some((t) => t.includes("Your lead scores, recorded before the judge ran (the judge never saw them):\nE2E_LEAD_SCORES candidates:0")), "compare shows the recorded lead scores");
      assert.ok(judges.every((j) => !j.task.includes("E2E_LEAD_SCORES")), "neither judge saw the lead's scores");
      const record = id ? await storedRecord(id) : await storedRecordWhere((r) => r.setup?.kind === "arena");
      assert.ok(record, "the arena record is stored");
      assert.deepEqual(record.events.filter((e) => e.type === "retry").map((e) => e.slot), ["judge:0"]);
      assert.ok(!record.events.some((e) => e.type === "block"), "the workflow did not block");
      assert.ok(record.events.some((e) => e.type === "advance" && e.evidence?.["synthesis-note"]), "the arena reached its verify checkpoint and completed");
      const leadAt = record.events.findIndex((e) => e.type === "advance" && e.evidence?.["lead-scores"]?.startsWith("E2E_LEAD_SCORES candidates:0"));
      const judgeAt = record.events.findIndex((e) => e.type === "dispatch" && e.slot === "judge:0");
      assert.ok(record.setup.leadFirst === true && leadAt >= 0 && judgeAt > leadAt, "P-G: the lead's scores were recorded before the first judge was dispatched");
      check("P-F: an arena judge whose structured result has one extra } is retried once under the same routing, the candidates are kept, and the retry is disclosed", { workflowId: record.id, judges: judges.map(({ task, ...c }) => c), turns: seen.length });
      check("P-G: arena's lead scored every candidate before the controller dispatched the judge; neither judge saw the lead's scores, and compare showed them beside the judge's", { workflowId: record.id, leadEvent: leadAt, judgeDispatch: judgeAt });
    }
    if (want("blind")) {
      // P-G: openclaw #182272 blind children. The route result says whether this host blinds the trial's own prompt.
      const hostBlind = (await readFile(join(host, "src/plugins/runtime/runtime-base.ts"), "utf8")).includes("native-subagent-blind-v1");
      const blindKey = "agent:main:dashboard:pstack-eval-blind";
      const routed = JSON.parse(toolResult(await chat(requester, blindKey, "E2E_ROUTE_BLIND plan the relay trials")).replace(/^[^{]*/, "")), plan = routed.details ?? routed;
      assert.equal(plan.hostBlind.status, hostBlind ? "native" : "unavailable", JSON.stringify(plan.hostBlind));
      assert.ok(plan.spawnArgs.every((a) => a.task === brain.blindTask && (hostBlind ? a.blind === true && a.context === "isolated" : a.blind === undefined)), JSON.stringify(plan.spawnArgs));
      const workspaceDir = join(dir, "workspace");
      // Each trial is spawned from its own parent session, so one trial's completion never lands in the other's turn.
      const trialPrompt = async (args, key) => {
        const sent = requests.length;
        toolResult(await chat(requester, key, "E2E_SPAWN_ARGS " + JSON.stringify(args)));
        // The child's own request: it carries the trial task and none of the parent's markers.
        const child = (r) => { const all = (r.body.messages ?? []).map(text).join("\n"); return all.includes(brain.blindTask) && !all.includes("E2E_SPAWN_ARGS") && !all.includes("E2E_ROUTE_BLIND"); };
        await until(async () => requests.slice(sent).some(child), "trial child request");
        const request = requests.slice(sent).find(child);
        return (request.body.messages ?? []).filter((m) => m.role === "system" || m.role === "developer").map(text).join("\n");
      };
      const blindSystem = await trialPrompt(plan.spawnArgs[0], blindKey + "-trial-a");
      const { blind: _b, context: _c, ...open } = plan.spawnArgs[1];
      const openSystem = await trialPrompt(open, blindKey + "-trial-b");
      if (hostBlind) {
        assert.ok(!blindSystem.includes(workspaceDir) && blindSystem.includes("<workspace>"), "the blind trial's prompt omits the workspace");
        assert.ok(!/Current model identity|\bmodel=pstack-fixture\//.test(blindSystem), "the blind trial's prompt omits its model identity");
        assert.ok(openSystem.includes(workspaceDir), "a trial spawned without blind still sees the workspace (control)");
      }
      check("P-G: pstack_route plans eval trials as host-blind isolated children when the host advertises native-subagent-blind-v1 (" + plan.hostBlind.status + "), and the blind trial's own prompt omits its workspace and model identity", {
        hostBlind: plan.hostBlind, spawnArgs: plan.spawnArgs.map(({ task, ...a }) => a), blindPromptHasWorkspace: blindSystem.includes(workspaceDir), controlPromptHasWorkspace: openSystem.includes(workspaceDir) });
    }
    if (want("yield-guard")) {
      // P-G/P-H: in pstack mode a placeholder acknowledgment is refused by the plugin's hook, with the retry instruction.
      const yieldKey = "agent:main:dashboard:pstack-yield-guard", offKey = "agent:main:dashboard:pstack-yield-off";
      const off = toolResult(await chat(requester, offKey, "E2E_YIELD_WAITFOR")); // gitleaks:allow -- synthetic E2E prompt, not a credential
      assert.ok(!off.includes("Pstack refused this sessions_yield"), "mode off: the host handles the yield: " + off.slice(0, 300));
      assert.match((await chat(requester, yieldKey, "/pstack on")).text, /^Pstack on/);
      const refused = toolResult(await chat(requester, yieldKey, "E2E_YIELD_WAITFOR")); // gitleaks:allow -- synthetic E2E prompt, not a credential
      assert.ok(refused.includes('Pstack refused this sessions_yield because its acknowledgment is a placeholder or status sentence ("UNUSED")') && refused.includes("Retry the same sessions_yield now") && refused.includes("and without waitFor"), refused.slice(0, 600));
      check("P-H: in pstack mode the plugin refuses a placeholder sessions_yield acknowledgment and says to retry the same call at once without waitFor; with mode off the host handles it", { refused: refused.slice(0, 400), off: off.slice(0, 200) });
      // P-H: the r6 shape. A six-line handoff with waitFor, while an announcing child runs, goes through without waitFor.
      for (const [label, mode] of [["off", false], ["on", true]]) {
        const key = "agent:main:dashboard:pstack-yield-handoff-" + label, identity = identities.get(requester), before = identity.frames.length;
        if (mode) assert.match((await chat(requester, key, "/pstack on")).text, /^Pstack on/);
        const at = identity.frames.length;
        const reply = await chat(requester, key, "E2E_YIELD_HANDOFF");
        const transcript = await history(requester, key);
        const yieldResult = transcript.filter((m) => m.role === "toolResult" || m.role === "tool").map((m) => m.text).find((t) => t.includes('"status": "yielded"') || t.includes("Pstack refused")) ?? "";
        const yielded = JSON.parse(yieldResult.slice(0, yieldResult.lastIndexOf("}") + 1) || "{}");
        // The child's completion event resumes the parent in a later turn.
        const waitResume = () => until(() => identity.frames.slice(at).find((f) => f.event === "chat" && f.payload?.sessionKey === key && f.payload?.state === "final" && text(f.payload.message).includes("E2E_RESUMED_BY_CHILD")), "child completion resumes " + key, mode ? 60000 : 30000);
        // In pstack mode the resume is required; the mode-off control records whatever the host does.
        const resumed = mode ? await waitResume() : await waitResume().catch(() => undefined);
        // The acknowledgment is the yielding turn's visible reply: the turn's final text or an assistant message in its history.
        const shown = reply.text.trim() === brain.handoff || transcript.some((m) => m.role === "assistant" && m.text.trim() === brain.handoff) ||
          identity.frames.slice(at).some((f) => f.event === "chat" && f.payload?.sessionKey === key && text(f.payload?.message).trim() === brain.handoff);
        // A host with #184265 (d840b33) notes when it drops waitFor itself; that note appears only when waitFor reached the tool.
        const hostDroppedWaitFor = /waitFor: \\?"message\\?" was not applied/.test(yieldResult);
        const facts = { mode: label, status: yielded.status, acknowledgment: yielded.acknowledgment === brain.handoff, hostDroppedWaitFor, pstackNote: yieldResult.includes("Pstack removed waitFor"),
          acknowledgmentShownAsChatMessage: shown, resumed: resumed ? text(resumed.payload.message).slice(0, 80) : "not resumed within 30 s", yieldResult: yieldResult.slice(0, 700), hostCommit };
        if (mode) {
          assert.equal(yielded.status, "yielded", "the yield went through: " + yieldResult.slice(0, 600));
          assert.equal(yielded.acknowledgment, brain.handoff, "the six-line acknowledgment reached the host's yield");
          assert.ok(!hostDroppedWaitFor, "waitFor never reached the host's tool: " + yieldResult.slice(0, 600));
          assert.ok(facts.pstackNote, "the persisted yield result carries the plugin's note: " + yieldResult.slice(0, 600));
          check("P-H: in pstack mode a six-line handoff sent with waitFor yields with waitFor removed before the host's tool, the persisted result carries the plugin's note, and the announcing child's completion resumes the session", facts);
        } else {
          results.push({ check: "P-H control (mode off, recorded, host-dependent): the same yield with waitFor", ...facts });
        }
      }
    }
    if (want("collect-in-turn")) {
      // P-H: a collector never wakes its parent; it is collected in the turn that spawned it with agents_wait awaitResults.
      const key = "agent:main:dashboard:pstack-collect-in-turn";
      const started = Date.now(), reply = await chat(requester, key, "E2E_COLLECT_IN_TURN");
      assert.ok(reply.text.startsWith("E2E_COLLECTED ") && reply.text.includes("E2E_SLOW_CHILD_DONE"), "the collector's result arrives in the same turn: " + reply.text.slice(0, 600));
      check("P-H: a collector spawned in a turn is collected in that turn with agents_wait and awaitResults: true, without a handoff", { reply: reply.text.slice(0, 300), seconds: (Date.now() - started) / 1000, childMs: brain.slowChildMs });
    }
    // Host subagent run records of a requester session (P-I).
    const runRecords = async (match) => {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(env.OPENCLAW_STATE_DIR, "state/openclaw.sqlite"), { readOnly: true });
      try { return db.prepare("SELECT requester_session_key, payload_json FROM subagent_runs").all().filter(match).map((row) => JSON.parse(row.payload_json)); } finally { db.close(); }
    };
    const runsFor = (key) => runRecords((row) => row.requester_session_key === key);
    if (want("collector-bound")) {
      // P-I (P3-68, P2-1): agents_wait with awaitResults waits until a collector settles, so its runTimeoutSeconds is the only bound.
      // pstack_route gives a planned collector 600 s; the plugin never rewrites a spawn and only refuses a collector asking for more than 900 s.
      const facts = {};
      for (const [label, mode] of [["off", false], ["on", true]]) {
        const key = "agent:main:dashboard:pstack-collector-bound-" + label;
        if (mode) assert.match((await chat(requester, key, "/pstack on")).text, /^Pstack on/);
        const reply = await chat(requester, key, "E2E_COLLECT_IN_TURN");
        assert.ok(reply.text.startsWith("E2E_COLLECTED ") && reply.text.includes("E2E_SLOW_CHILD_DONE"), label + ": the collector's result arrives in the same turn: " + reply.text.slice(0, 600));
        const spawned = (await history(requester, key)).filter((m) => m.role === "toolResult" || m.role === "tool").map((m) => m.text).find((t) => t.includes("runId")) ?? "";
        const runs = await runsFor(key);
        facts[label] = { runTimeoutSeconds: runs.map((r) => r.runTimeoutSeconds ?? null), collect: runs.map((r) => r.collect), pstackNote: spawned.includes("Pstack set runTimeoutSeconds") };
      }
      assert.deepEqual(facts.on.runTimeoutSeconds, facts.off.runTimeoutSeconds, "pstack mode leaves a direct spawn's arguments to the host");
      assert.ok(!facts.on.runTimeoutSeconds.includes(600) && !facts.on.pstackNote && !facts.off.pstackNote, JSON.stringify(facts));
      check("P-I (P2-1): in pstack mode the plugin leaves a collector's spawn arguments unchanged: a direct sessions_spawn collector has the same host run record as with mode off, and no note is added", { ...facts, hostCommit });
      const key = "agent:main:dashboard:pstack-collector-bound-on";
      const routed = JSON.parse(toolResult(await chat(requester, key, "E2E_ROUTE_COLLECTOR")).replace(/^[^{]*/, "")), plan = routed.details ?? routed;
      assert.equal(plan.spawnArgs?.[0]?.runTimeoutSeconds, 600, JSON.stringify(plan).slice(0, 800));
      const known = new Set((await runsFor(key)).map((r) => r.runId));
      const planned = await chat(requester, key, "E2E_COLLECT_IN_TURN E2E_SPAWN_ARGS " + JSON.stringify(plan.spawnArgs[0]));
      assert.ok(planned.text.startsWith("E2E_COLLECTED ") && planned.text.includes("E2E_SLOW_CHILD_DONE"), "the planned collector is collected in the same turn: " + planned.text.slice(0, 600));
      const plannedRuns = (await runsFor(key)).filter((r) => !known.has(r.runId));
      assert.deepEqual(plannedRuns.map((r) => [r.collect, r.runTimeoutSeconds]), [[true, 600]], "the host's run record carries the planner's bound");
      check("P-I (P3-68): a collector spawned with the arguments pstack_route returns runs with runTimeoutSeconds 600 in the host's own run record and is collected in the same turn", { planned: plan.spawnArgs[0].runTimeoutSeconds, record: plannedRuns.map((r) => ({ runTimeoutSeconds: r.runTimeoutSeconds, collect: r.collect, model: r.model })) });
      const before = (await runsFor(key)).length;
      const refused = toolResult(await chat(requester, key, "E2E_COLLECT_LONG"));
      assert.ok(refused.includes("Pstack refused this sessions_spawn") && refused.includes("at most 900 (got 1800)"), refused.slice(0, 600));
      assert.equal((await runsFor(key)).length, before, "the refused collector never started");
      check("P-I: in pstack mode a collector asking for runTimeoutSeconds 1800 is refused before the host's tool runs, with the instruction to spawn a longer phase as an announcing child", { refused: refused.slice(0, 400) });
      const started = Date.now(), bounded = await chat(requester, key, "E2E_COLLECT_BOUNDED"), seconds = (Date.now() - started) / 1000;
      const boundedRun = (await runsFor(key)).find((r) => r.label === "bounded collector child");
      assert.ok(bounded.text.startsWith("E2E_COLLECTED ") && /"status":\s*"timeout"/.test(bounded.text) && !bounded.text.includes("E2E_HANG_DONE"), "the bounded wait returns the timeout in the same turn: " + bounded.text.slice(0, 600));
      assert.ok(seconds < 25, "the 3 s bound, not the child's 30 s of work, ended the wait: " + seconds);
      check("P-I: runTimeoutSeconds bounds agents_wait with awaitResults: a collector with a 3 s bound whose child needs 30 s settles as timeout and the same turn replies", { seconds, runTimeoutSeconds: boundedRun?.runTimeoutSeconds, reply: bounded.text.slice(0, 300) });
    }
    if (want("agents-run") && args.host === "new") {
      // P-I (P2-1): a Code Mode agents.run worker in a pstack-mode session keeps the host's own bound and its launch replay key.
      // The host's own deadline function reads the stored record: no bound means no deadline, so the worker is never cut at 600 s.
      await writeFile(join(dir, "deadline.mjs"), "import {resolveSubagentRunDeadlineMs} from " + JSON.stringify(join(host, "src/agents/subagents/registry/subagent-run-timeout.ts")) +
        "; const r = JSON.parse(process.env.PSTACK_E2E_RUN); const d = resolveSubagentRunDeadlineMs(r); console.log(JSON.stringify({ deadlineMs: d ?? null, boundMs: d === undefined ? null : d - r.execution.startedAt }));");
      const hostDeadline = (record) => {
        const out = spawnSync(process.execPath, ["--import", join(host, "node_modules/tsx/dist/loader.mjs"), join(dir, "deadline.mjs")], { env: { ...env, PSTACK_E2E_RUN: JSON.stringify(record) }, cwd: host, encoding: "utf8", timeout: 60000 });
        if (out.status !== 0) throw Error("host deadline: " + out.stdout + out.stderr);
        return JSON.parse(out.stdout.trim().split("\n").at(-1));
      };
      const facts = {};
      for (const [label, mode] of [["off", false], ["on", true]]) {
        const key = "agent:main:dashboard:pstack-agents-run-" + label;
        const selected = await chat(requester, key, "/model pstack-fixture/coder");
        if (mode) assert.match((await chat(requester, key, "/pstack on")).text, /^Pstack on/);
        const started = Date.now(), reply = await chat(requester, key, "E2E_AGENTS_RUN " + label), seconds = (Date.now() - started) / 1000;
        assert.ok(reply.text.startsWith("E2E_AGENTS_RUN_DONE") && reply.text.includes("E2E_CM_WORKER_DONE"), label + ": the agents.run worker's result returns to its Code Mode cell: " + reply.text.slice(0, 800));
        const runs = await runRecords((row) => JSON.parse(row.payload_json).label === "code mode worker " + label);
        assert.equal(runs.length, 1, label + ": one agents.run worker: " + JSON.stringify(runs).slice(0, 600));
        const run = runs[0];
        facts[label] = { seconds, workerMs: brain.cmWorkerMs, collect: run.collect, runTimeoutSeconds: run.runTimeoutSeconds ?? null, swarmLaunchReplayKey: run.swarmLaunchReplayKey ?? null,
          swarmLaunchRequestFingerprint: run.swarmLaunchRequestFingerprint ?? null, hostDeadline: hostDeadline(run), requesterSessionKey: run.requesterSessionKey, modelSelected: selected.text.slice(0, 120),
          codeModeCalls: requests.filter((q) => ["exec", "wait"].includes(q.reply)).map((q) => q.reply + " (tools: " + q.tools.join(",") + ")") };
      }
      for (const label of ["off", "on"]) {
        const f = facts[label];
        assert.ok(f.collect === true && [null, 0].includes(f.runTimeoutSeconds), label + ": the worker keeps the host's own bound (none): " + JSON.stringify(f));
        assert.ok(typeof f.swarmLaunchReplayKey === "string" && f.swarmLaunchReplayKey.length > 0 && typeof f.swarmLaunchRequestFingerprint === "string", label + ": the launch replay key reached sessions_spawn: " + JSON.stringify(f));
        assert.deepEqual([f.hostDeadline.deadlineMs, f.hostDeadline.boundMs], [null, null], label + ": the host computes no deadline for the worker: " + JSON.stringify(f));
      }
      check("P-I (P2-1): in pstack mode a Code Mode agents.run worker reaches the host unchanged: its run record keeps the launch replay key and has no run bound, so the host's own deadline function gives it no deadline (never 600 s), the same as with mode off", { ...facts, hostCommit });
    }
    if (want("swarm")) {
      const swarmKey = "agent:main:dashboard:pstack-swarm", at = brain.children.length;
      brain.slices = ["p95", "success-rate", "dedupe"].map((id) => ({ id, sha: "24d93b3ce50f03a13d57d99e6d187630f6534679", method: "Partitioned implementation, not a race. Create a task-owned detached git worktree at " + join(dir, "workspace/swarm-slices/" + id) + " from the scratch checkout; make a local commit with only your function and its test." }));
      const configured = await chat(requester, swarmKey, "/pstack-swarm Fix three independent stats defects as parallel slices: p95 must sort numerically, successRate([]) must return 0, and dedupe must run in linear time while keeping the first occurrence and order. Integrate the slices and run the tests.");
      const id = /pw-[a-z0-9]{12}/.exec(toolResult(configured))[0];
      await resumeUntil(requester, swarmKey, await chat(requester, swarmKey, "/pstack resume"), finished);
      const workers = childrenSince(at, "swarm workers");
      assert.deepEqual(workers.map((c) => c.slot).sort(), ["workers:dedupe", "workers:p95", "workers:p95", "workers:success-rate"]);
      for (const worker of workers) {
        assert.ok(worker.task.includes("Write scope: make code changes only where the slice method directs (for example its task-owned worktree)") && !worker.task.includes("Write only under"), worker.slot + " write scope");
        assert.ok(worker.task.includes(join(dir, "workspace/swarm-slices/" + worker.slot.split(":")[1])), worker.slot + " names its worktree");
      }
      const [firstP95, retryP95] = workers.filter((c) => c.slot === "workers:p95");
      assert.ok(!firstP95.task.includes("This is the one retry") && retryP95.task.includes("This is the one retry of this slice.") && retryP95.task.includes("returned BLOCKED: " + brain.conflict), "the retry names the failure");
      const record = await workflow(requester, swarmKey, id);
      assert.equal(record.view.status, "completed");
      assert.equal(record.view.evidence.workers["coverage-gaps"], "workers:p95 failed its one retry: BLOCKED: " + brain.conflict);
      assert.ok(requests.some((r) => r.model === "parent" && JSON.stringify(r.body).includes("Recorded by the controller (report these; a gap is not a pass):")), "the aggregate turn saw the gap");
      check("swarm: slice write scope matches its worktree, the retry names the failure, and the second miss is a recorded coverage gap that reaches aggregate", { workflowId: id, evidence: record.view.evidence, evidenceSource: record.view.evidenceSource });
    }
    if (want("reflect")) {
      const reflectKey = "agent:main:dashboard:pstack-reflect";
      const first = await chat(requester, reflectKey, "/pstack-reflect Reflect on the session digest above. Draft proposals only; no skill edits, tracker posts or automations.");
      const { reply: rows } = await resumeUntil(requester, reflectKey, first, (r) => r.text.includes("**Reflect synthesis: Accepted / Rejected / Backlog rows**"));
      assert.ok(rows.text.includes(quoted(brain.rows)) && rows.text.includes("Nothing is applied before your decision."), "rows shown verbatim before approval");
      assert.match(rows.text, /status awaiting-user/);
      const at = requests.length;
      toolResult(await chat(requester, reflectKey, "/pstack resume approve A1 only; draft text, no edits"));
      const applyTurn = JSON.stringify(requests.slice(at).find((r) => r.model === "parent").body);
      for (const expected of ["User decision(s), from authenticated /pstack resume commands: approve by", "Synthesizer rows the user decided on (verbatim data):", "Rejected (EVERY Rejected row id with the synthesizer's reason)", "Backlog (every Backlog row with its enforcement mechanism"])
        assert.ok(applyTurn.includes(expected), "apply turn context: " + expected);
      assert.ok(finished(await chat(requester, reflectKey, "/pstack resume")));
      check("reflect: the synthesizer's rows are shown verbatim at approval and the apply turn requires the complete post-approval summary", { rows: rows.text.slice(0, 500) });
    }
    if (want("how")) {
      const howKey = "agent:main:dashboard:pstack-how";
      // H-1: the explainer's final text answer exceeds the host's 100 KB collector bound.
      brain.hugeFinal = ["explainer:0"];
      const first = await chat(requester, howKey, "/pstack-how How does the Outbox (flush/drainAll) hand deliveries to an injected sender, how are requests signed, and how are items removed or failures handled? Trace the queue, sender and sign lifecycle in this repo.");
      const { reply } = await resumeUntil(requester, howKey, first, (r) => r.text.includes("status completed"));
      assert.ok(reply.text.includes("**How explanation**, delivered verbatim from the independent child: slot `explainer:0`, role `how explainer`, model `pstack-fixture/alpha`"), reply.text.slice(0, 800));
      const id = /pw-[a-z0-9]{12}/.exec(reply.text)[0], record = await storedRecord(id);
      const stored = record.events.find((e) => e.type === "collect" && e.slot === "explainer:0").result.report;
      assert.equal(stored.length, brain.explanation.length, "the ledger stored the explainer's whole report");
      assert.equal(stored, brain.explanation);
      // The reply is longer than the host's 8,000-character chat display cap; the persisted message is whole.
      const full = await fullReply(requester, howKey);
      assert.ok(full.capped && full.text.startsWith(reply.text.replace(/\n\.\.\.\(truncated\)\.\.\.$/, "")), "the chat view shows a capped prefix of the persisted reply");
      assert.ok(full.text.includes(quoted(brain.explanation)), "the whole " + brain.explanation.length + "-character explanation is delivered verbatim; the persisted reply has " + full.text.length + " characters");
      check("how: the explainer's result is delivered verbatim, quoted and attributed, with no parent rewrite", { characters: brain.explanation.length, storedCharacters: stored.length,
        persistedReplyCharacters: full.text.length, chatViewCapped: full.capped, chatViewCharacters: full.displayed, reply: reply.text.slice(0, 400) });
      brain.hugeFinal = [];
      const evidence = record.events.find((e) => e.type === "collect" && e.slot === "explainer:0").result.evidence;
      assert.match(evidence[0], /^\[pstack: the host marked this child's text answer resultTruncated/, "H-1 marker: " + JSON.stringify(evidence));
      assert.ok(reply.text.includes("Collected explainer:0 (PASS); the host marked its text answer truncated, so the structured result was stored and marked."), reply.text.slice(0, 900));
      check("H-1: the host's resultTruncated on a 110,000-character final answer is recorded in the stored evidence; the structured result is stored whole", { evidence });
    }
    if (want("why")) {
      const whyKey = "agent:main:dashboard:pstack-why";
      const configured = toolResult(await chat(requester, whyKey, "/pstack-why Why does p95 on the basic test return 9 rather than 20, and is the sorting choice explained by this repository's history?"));
      assert.match(configured, /"needsConfigure":false/);
      const { reply } = await resumeUntil(requester, whyKey, await chat(requester, whyKey, "/pstack resume"), (r) => r.text.includes("status completed"));
      assert.ok(reply.text.includes("**Why synthesis**, delivered verbatim from the independent child: slot `synthesizer:0`, role `why synthesizer`, model `pstack-fixture/beta`"), reply.text.slice(0, 800));
      assert.ok(reply.text.includes(quoted(brain.synthesis)));
      check("why: the synthesizer's result is delivered verbatim, quoted and attributed, after its investigator", { reply: reply.text.slice(0, 400) });
    }
    if (want("teach")) {
      const teachKey = "agent:main:dashboard:pstack-teach", at = requests.length;
      await chat(requester, teachKey, "/pstack-teach I'm a new maintainer. Teach me why calling drainAll twice does not make the outbox concurrent or reliable: what the guard and snapshot actually do, and what the history says about the intent.");
      const turn = JSON.stringify(requests.slice(at).find((r) => r.model === "parent").body);
      assert.ok(turn.includes("deliver that collected result verbatim as a quoted block attributed to its role, actual model and run id"), "teach turn carries the verbatim delivery rule");
      check("teach (skill-guided): the routed-result verbatim delivery rule reaches the model; delivery stays agent-attested");
    }
    if (want("correction")) {
      // P-D / P3-38: a BLOCKED lead gets one correction child, and the corrected verdict is delivered.
      const corrKey = "agent:main:dashboard:pstack-correction", at = brain.children.length;
      brain.leadBlockedFirst = true;
      toolResult(await chat(requester, corrKey, "/pstack-interrogate Adversarially review the uncommitted isRetryable change and its new test before I commit it. Read-only."));
      const { reply } = await resumeUntil(requester, corrKey, await chat(requester, corrKey, "/pstack resume"), (r) => r.text.includes("status completed"));
      brain.leadBlockedFirst = false;
      const leads = childrenSince(at, "judgment and prose");
      assert.equal(leads.length, 2);
      assert.ok(leads[1].task.includes("This is the one correction of slot `lead:0`.") && leads[1].task.includes("BLOCKED: E2E the lead could not read the reviews."), "the correction brief names the failure and carries the output");
      assert.equal(leads[1].model, leads[0].model);
      assert.equal(childrenSince(at, "interrogate reviewers").length, 2, "the reviews are kept, not rerun");
      assert.ok(reply.text.includes("Correction: lead:0") && reply.text.includes("This is the one correction of this slot") && reply.text.includes(quoted(brain.verdict)), reply.text.slice(0, 1500));
      check("P3-38: a BLOCKED lead gets one correction under the same routing; the reviews are kept and the corrected verdict is delivered verbatim", { leads: leads.map(({ task, ...c }) => c) });
      // Parent claim check after delivery: one correction record under the same routing and profile.
      const howKey = "agent:main:dashboard:pstack-how-correct", from = brain.children.length;
      brain.wrongExplanation = brain.explanation.replace("flush() sends each item once.", "flush() retries every failure three times.");
      const delivered = await resumeUntil(requester, howKey, await chat(requester, howKey, "/pstack-how How does the Outbox (flush/drainAll) hand deliveries to an injected sender?"), (r) => r.text.includes("status completed"));
      const id = /pw-[a-z0-9]{12}/.exec(delivered.reply.text)[0];
      assert.ok(delivered.reply.text.includes("`/pstack resume " + id + " correct <what is wrong>`"), "the delivered reply names the correction command");
      const errors = "flush() does not retry; it sends each item once (src/queue.ts:12).";
      const corrected = await resumeUntil(requester, howKey, await chat(requester, howKey, "/pstack resume " + id + " correct " + errors), (r) => r.text.includes("status completed"));
      brain.wrongExplanation = undefined;
      const explainers = childrenSince(from, "how explainer");
      assert.equal(explainers.length, 2);
      assert.equal(explainers[1].model, explainers[0].model);
      assert.ok(explainers[1].task.includes("This child is the one correction of the result workflow `" + id + "`") && explainers[1].task.includes(errors) && explainers[1].task.includes("flush() retries every failure three times."), "the correction brief carries the delivered report and the errors");
      const correctionId = /Correction `(pw-[a-z0-9]{12})`/.exec(corrected.reply.text)[1];
      const full = await fullReply(requester, howKey);
      assert.ok(full.text.includes("This is the one correction of `" + id + "`") && full.text.includes(quoted(brain.explanation)), "the corrected explanation is delivered verbatim with the correction attribution");
      const record = await storedRecord(correctionId);
      assert.deepEqual([record.setup.correction.workflowId, record.setup.correction.slot, record.setup.correction.errors], [id, "explainer:0", errors]);
      assert.deepEqual(record.setup.profiles, (await storedRecord(id)).setup.profiles);
      assert.match((await chat(requester, howKey, "/pstack resume " + id + " correct again")).text, /was already corrected once/);
      check("post-delivery correction: one linked correction record under the same routing and profile, delivered verbatim; a second correction is refused", { workflowId: id, correctionId, profiles: record.setup.profiles });
    }
    if (want("family")) {
      // H-2: canonical families from the fixture provider plugin's static catalog.
      const file = join(dir, "workspace/pstack-models.json"), saved = await readFile(file, "utf8");
      const famA = "pstack-fam-a/review-a", famB = "pstack-fam-b/review-b";
      await writeFile(file, JSON.stringify({ ...JSON.parse(saved), presets: { ...JSON.parse(saved).presets, "fam-a": { model: famA }, "fam-b": { model: famB } },
        roles: { ...JSON.parse(saved).roles, "interrogate reviewers": ["fam-a", "fam-b"], "arena cross-judge pool": ["fam-a", "fam-b"] } }));
      try {
        const fromA = JSON.parse(toolResult(await chat(requester, "agent:main:dashboard:pstack-family-route", "E2E_ROUTE_POOL " + famA)).replace(/^[^{]*/, ""));
        const poolPlan = fromA.details ?? fromA;
        assert.deepEqual(poolPlan.snapshot, { version: 1, role: "arena cross-judge pool", source: "config", selections: [{ model: famB }], poolIndex: 1, diversity: "different-family" }, JSON.stringify(poolPlan).slice(0, 1500));
        assert.deepEqual(poolPlan.catalog.map((c) => [c.id, c.family]), [[famB, "fixture-b"]]);
        // A model whose catalog declares no family stays unknown: nothing is inferred from its id.
        const fromUnknown = JSON.parse(toolResult(await chat(requester, "agent:main:dashboard:pstack-family-route-2", "E2E_ROUTE_POOL pstack-fixture/alpha")).replace(/^[^{]*/, ""));
        assert.equal((fromUnknown.details ?? fromUnknown).snapshot.diversity, "unverified");
        check("H-2: pstack_route reads canonical families from the real requester catalog and picks a proven different-family cross-judge", { pool: poolPlan.snapshot, catalog: poolPlan.catalog });
        const famKey = "agent:main:dashboard:pstack-family", at = brain.children.length;
        const framed = toolResult(await chat(requester, famKey, "/pstack-interrogate Adversarially review the uncommitted isRetryable change and its new test before I commit it. Read-only."));
        const id = /pw-[a-z0-9]{12}/.exec(framed)[0];
        const record = await storedRecord(id);
        const reviewersSnapshot = record.setup.snapshots.find((x) => x.role === "interrogate reviewers");
        assert.equal(reviewersSnapshot.diversity, "different-family");
        assert.deepEqual(record.setup.catalog.filter((c) => [famA, famB].includes(c.id)).map((c) => [c.id, c.family]), [[famA, "fixture-a"], [famB, "fixture-b"]]);
        await resumeUntil(requester, famKey, await chat(requester, famKey, "/pstack resume"), (r) => r.text.includes("status completed"));
        const spawned = childrenSince(at);
        assert.deepEqual(spawned.filter((c) => c.role === "interrogate reviewers").map((c) => c.model).sort(), ["review-a", "review-b"]);
        const lead = spawned.find((c) => c.role === "judgment and prose");
        assert.ok(lead.task.includes("interrogate reviewers = different-family (" + famA + ": fixture-a, " + famB + ": fixture-b)"), "the lead brief reports the proven diversity");
        check("H-2: the native interrogate panel on two catalog families is recorded different-family, and the lead is told so", { workflowId: id, diversity: reviewersSnapshot.diversity,
          reviewers: spawned.filter((c) => c.role === "interrogate reviewers").map((c) => c.model) });
      } finally { await writeFile(file, saved); }
    }
  }
  await writeFile(evidence(".json"), JSON.stringify({
    passed: true, host: args.host, scenarios: only ?? "all", hostCommit, hostBuild: buildInfo, archive: tgz, archiveSha256: createHash("sha256").update(await readFile(tgz)).digest("hex"),
    checks: results, providerRequests: requests.length, children: brain.children, realGateway: true, installedFromArchive: true, onlyModelIoStubbed: true,
  }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, host: args.host, checks: results.length }));
} finally {
  await stop();
  if (provider) await new Promise((r) => provider.close(r));
  await writeFile(evidence(".log"), gatewayLog.slice(-400000));
  await writeFile(evidence("-progress.json"), JSON.stringify({ checks: results,
    requests: requests.map(({ body, ...r }) => r), frames: frames.slice(-20).map((f) => ({ user: f.user, type: f.type, event: f.event, ok: f.ok, error: f.error, state: f.payload?.state, text: text(f.payload?.message).slice(0, 500) })) }, null, 2));
  await rm(dir, { recursive: true, force: true });
  console.log("Isolated Gateway, provider and state removed");
}
