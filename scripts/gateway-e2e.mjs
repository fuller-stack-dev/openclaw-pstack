import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { randomUUID, generateKeyPairSync, createHash, sign } from "node:crypto";
import assert from "node:assert/strict";
const host = process.env.OPENCLAW_SOURCE;
if (!host) throw Error("Set OPENCLAW_SOURCE");
const root = resolve(import.meta.dirname, "..");
const buildId = JSON.parse(await readFile(join(host, "dist/build-info.json"), "utf8")).buildId;
const require = createRequire(join(host, "package.json"));
const { WebSocket } = require("ws");
const dir = await mkdtemp(
  join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "pstack-gateway-"),
);
const evidenceDir = resolve(process.env.PSTACK_EVIDENCE_DIR || join(root, "artifacts/diagnostics"));
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("OPENCLAW_")) delete env[k];
Object.assign(env, {
  HOME: join(dir, "home"),
  TMPDIR: join(dir, "tmp"),
  OPENCLAW_STATE_DIR: join(dir, "state"),
  OPENCLAW_CONFIG_PATH: join(dir, "config.json"),
  OPENCLAW_HIDE_BANNER: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  // No LAN advertising from a test Gateway (bonjour is also disabled in config below).
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  TSX_TSCONFIG_PATH: join(host, "tsconfig.json"),
});
let gateway, ws, provider;
let gatewayLog = "";
const requests = [],
  results = [],
  frames = [];
const keys = generateKeyPairSync("ed25519"),
  rawKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32),
  deviceId = createHash("sha256").update(rawKey).digest("hex");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = createNetServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function stop() {
  if (ws) {
    ws.terminate();
    ws = undefined;
  }
  if (gateway && gateway.exitCode === null) {
    const p = gateway;
    p.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => p.once("exit", r)),
      delay(15000).then(() => p.kill("SIGKILL")),
    ]);
  }
  gateway = undefined;
}
// A test Gateway must never advertise on the LAN.
const assertNoLanAdvertising = () => assert.ok(!/_openclaw-gw\._tcp|bonjour: advertis/i.test(gatewayLog), "Gateway advertised on the LAN");
async function until(fn, label, ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    if (gateway?.exitCode !== null && gateway?.exitCode !== undefined)
      throw Error("Gateway exited: " + gatewayLog.slice(-6000));
    await delay(100);
  }
  throw Error("Timed out: " + label + " " + gatewayLog.slice(-5000));
}
let port;
async function start() {
  gateway = spawn(
    process.execPath,
    [join(host, "openclaw.mjs"), "gateway", "run", "--port", String(port), "--bind", "loopback"],
    { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  gateway.stdout.on("data", (b) => {
    gatewayLog += b;
  });
  gateway.stderr.on("data", (b) => {
    gatewayLog += b;
  });
  await until(async () => {
    try {
      return (await fetch("http://127.0.0.1:" + port + "/readyz")).ok;
    } catch {
      return false;
    }
  }, "Gateway ready");
  ws = new WebSocket("ws://127.0.0.1:" + port, {
    headers: {
      origin: "http://127.0.0.1:" + port,
      "x-forwarded-user": "pstack-e2e@example.test",
      "x-forwarded-for": "192.0.2.55",
      "x-forwarded-proto": "https",
    },
  });
  ws.on("message", (b) => {
    try {
      frames.push(JSON.parse(String(b)));
    } catch {}
  });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  await until(() => frames.some((f) => f.event === "connect.challenge"), "challenge");
  const nonce = frames.findLast((f) => f.event === "connect.challenge").payload.nonce,
    signedAt = Date.now(),
    scopes = ["operator.admin", "operator.read", "operator.write"];
  const payload = [
    "v3",
    deviceId,
    "openclaw-control-ui",
    "webchat",
    "operator",
    scopes.join(","),
    String(signedAt),
    "",
    nonce,
    "test",
    "",
  ].join("|");
  const device = {
    id: deviceId,
    publicKey: rawKey.toString("base64url"),
    signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64url"),
    signedAt,
    nonce,
  };
  const hello = await rpc("connect", {
    minProtocol: 4,
    maxProtocol: 4,
    client: {
      id: "openclaw-control-ui",
      version: "pstack-e2e",
      buildId,
      platform: "test",
      mode: "webchat",
    },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    device,
    caps: [],
  });
  results.push({
    check: "Control UI verified personal identity connection",
    helloType: hello.type,
    scopes: hello.auth?.scopes,
  });
}
async function rpc(method, params) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const id = randomUUID();
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    const f = await until(() => frames.find((x) => x.type === "res" && x.id === id), method);
    if (f.ok) return f.payload;
    // These host errors explicitly reject admission; retain the original operation
    // or idempotency key while waiting for startup or the preceding Goal turn drain.
    if (
      f.error?.retryable &&
      ["startup-sidecars", "goal-session-busy"].includes(f.error?.details?.reason)
    ) {
      await delay(f.error.retryAfterMs ?? 500);
      continue;
    }
    throw Error(method + " failed: " + JSON.stringify(f.error));
  }
  throw Error(method + " admission did not become ready within the bounded retry window");
}
function messageText(m) {
  return (m?.content ?? []).map((c) => c.text ?? "").join("\n");
}
async function chat(sessionKey, message, extra = {}) {
  const before = frames.length;
  const ack = await rpc("chat.send", {
    sessionKey,
    message,
    idempotencyKey: randomUUID(),
    ...extra,
  });
  const final = await until(
    () =>
      frames
        .slice(before)
        .find(
          (f) =>
            f.event === "chat" &&
            f.payload?.sessionKey === sessionKey &&
            ["final", "error", "aborted"].includes(f.payload?.state),
        ),
    message,
  );
  if (final.payload.state !== "final") throw Error("Chat failed: " + JSON.stringify(final));
  const text = messageText(final.payload.message);
  results.push({ check: message, ack: ack.status, text });
  return { ack, text };
}
try {
  for (const p of [env.HOME, env.TMPDIR, env.OPENCLAW_STATE_DIR, join(dir, "workspace")])
    await mkdir(p, { recursive: true, mode: 0o700 });
  // Verify the actual host resolver before any Gateway process can open a handoff DB.
  const preflight = join(dir, "preflight.mjs");
  await writeFile(
    preflight,
    "import {resolveManagedUpdateLeaseDatabasePath} from " +
      JSON.stringify(join(host, "src/infra/update-managed-service-handoff-lease.ts")) +
      "; const p=resolveManagedUpdateLeaseDatabasePath(); if(!p.startsWith(" +
      JSON.stringify(env.TMPDIR + "/") +
      '))throw Error("Unisolated handoff path: "+p); console.log(JSON.stringify({handoffPath:p}));',
  );
  const checked = spawnSync(
    process.execPath,
    ["--import", join(host, "node_modules/tsx/dist/loader.mjs"), preflight],
    { env, cwd: host, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (checked.status !== 0)
    throw Error("Handoff resolver preflight: " + checked.stdout + checked.stderr);
  results.push({ check: "actual host handoff resolver", output: checked.stdout.trim() });
  provider = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const data = JSON.parse(b || "{}");
    requests.push({ url: req.url, body: data });
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "pstack-stub", object: "model" }] }));
      return;
    }
    const text = "Isolated model response.";
    if (data.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => ({
        id: "stub-" + randomUUID(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "pstack-stub",
        choices: [{ index: 0, delta, finish_reason }],
      });
      for (const d of [chunk({ role: "assistant" }), chunk({ content: text }), chunk({}, "stop")])
        res.write("data: " + JSON.stringify(d) + "\n\n");
      res.end("data: [DONE]\n\n");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "stub",
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  port = await freePort();
  await writeFile(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: {
        mode: "local",
        port,
        trustedProxies: ["127.0.0.1", "::1"],
        auth: {
          mode: "trusted-proxy",
          identityScopes: {
            "pstack-e2e@example.test": ["operator.admin", "operator.read", "operator.write"],
          },
          trustedProxy: {
            userHeader: "x-forwarded-user",
            allowLoopback: true,
            allowUsers: ["pstack-e2e@example.test"],
            deviceAutoApprove: {
              enabled: true,
              scopes: ["operator.admin", "operator.read", "operator.write"],
            },
          },
        },
        controlUi: { allowedOrigins: ["http://127.0.0.1:" + port] },
      },
      agents: {
        defaults: {
          workspace: join(dir, "workspace"),
          model: { primary: "pstack-fixture/pstack-stub" },
          heartbeat: { every: "0m" },
          skipBootstrap: true,
        },
      },
      models: {
        mode: "merge",
        providers: {
          "pstack-fixture": {
            baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1",
            apiKey: "isolated-not-a-secret",
            api: "openai-completions",
            models: [
              {
                id: "pstack-stub",
                name: "Fixture",
                contextWindow: 128000,
                maxTokens: 256,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      plugins: {
        allow: ["pstack"],
        load: { paths: [root] },
        entries: { pstack: { enabled: true, hooks: { allowConversationAccess: true } }, bonjour: { enabled: false } },
      },
      discovery: { mdns: { mode: "off" } },
      tools: { profile: "minimal" },
    }),
    { mode: 0o600 },
  );
  // Seed only native metadata before Gateway startup; no foreign online DB writes.
  const divergentKey = "agent:main:dashboard:pstack-workspace-divergence";
  const divergentWorkspace = join(dir, "spawned-workspace");
  await mkdir(divergentWorkspace, { mode: 0o700 });
  const fixture = join(dir, "native-fixture.mjs");
  await writeFile(
    fixture,
    "import {captureRuntimeConfigAsyncReader} from " +
      JSON.stringify(join(host, "src/plugin-sdk/runtime-config-snapshot.ts")) +
      ";\n" +
      "import {upsertSessionEntry} from " +
      JSON.stringify(join(host, "src/plugin-sdk/session-store-runtime.ts")) +
      ";\n" +
      "await captureRuntimeConfigAsyncReader()(); await upsertSessionEntry({agentId:'main',env:process.env,sessionKey:" +
      JSON.stringify(divergentKey) +
      ",entry:" +
      JSON.stringify({
        sessionId: randomUUID(),
        updatedAt: Date.now(),
        spawnedWorkspaceDir: divergentWorkspace,
      }) +
      "}); console.log('native workspace fixture prepared');",
  );
  const prepared = spawnSync(
    process.execPath,
    ["--import", join(host, "node_modules/tsx/dist/loader.mjs"), fixture],
    { env, cwd: host, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (prepared.status !== 0)
    throw Error("Native workspace fixture: " + prepared.stdout + prepared.stderr);
  await start();
  assert.match((await chat(divergentKey, "/pstack on")).text, /on \(revision 1\)/);
  assert.match((await chat(divergentKey, "/pstack status")).text, /on.*revision 1/s);
  const divergenceAt = requests.length;
  await chat(divergentKey, "E2E_SPAWNED_WORKSPACE_DIVERGENCE");
  const divergentRequest = requests
    .slice(divergenceAt)
    .filter((r) => r.body.messages)
    .at(-1);
  assert.ok(divergentRequest, "Divergent native workspace reached model");
  assert.ok(
    JSON.stringify(divergentRequest.body).includes(
      "Pstack mode is active for this exact session incarnation",
    ),
  );
  assert.ok(
    JSON.stringify(divergentRequest.body).includes(join(dir, "workspace")),
    "Host run workspace is the configured default, not spawned workspace",
  );
  results.push({
    check: "spawned workspace differs from host run workspace; active injection",
    spawnedWorkspace: divergentWorkspace,
    runWorkspace: join(dir, "workspace"),
    present: true,
  });
  assert.match((await chat(divergentKey, "/pstack off")).text, /off \(revision 2\)/);

  // Prime the online store's missing-value observation with off, the regression
  // shape that foreign CLI writes previously left stale. Import via owner command.
  const migrationKeys = [
    "agent:main:dashboard:pstack-migrate-status",
    "agent:main:dashboard:pstack-migrate-off",
  ];
  const observed = [
    await chat(migrationKeys[0], "/pstack status"),
    await chat(migrationKeys[1], "/pstack off"),
  ];
  for (const result of observed) assert.match(result.text, /off.*revision 0/s);
  const self = await rpc("users.self", {});
  assert.ok(self.profile.id, "Native users.self supplies the migration requester");
  const legacyDir = join(dir, "workspace/.pstack-session-state");
  await mkdir(legacyDir, { mode: 0o700 });
  const sources = [];
  const nativeSessions = (await rpc("sessions.list", { limit: 100 })).sessions;
  for (let n = 0; n < migrationKeys.length; n++) {
    const identity = {
      sessionId: nativeSessions.find((row) => row.key === migrationKeys[n])?.sessionId,
      sessionKey: migrationKeys[n],
      userId: self.profile.id,
      workspace: join(dir, "workspace"),
    };
    assert.ok(identity.sessionId, "Native sessions.list supplies the incarnation");
    const sha = (v) => createHash("sha256").update(v).digest("hex");
    const source = join(legacyDir, sha(JSON.stringify(identity)) + ".json");
    const raw = JSON.stringify({
      version: 2,
      identity,
      active: true,
      revision: 7,
      lastEvent: { id: "legacy-online", timestampMs: 1, seq: 1, digest: sha("legacy-online") },
    });
    await writeFile(source, raw, { mode: 0o600 });
    sources.push({ source, raw });
  }
  const migrationOwnerKey = "agent:main:dashboard:pstack-migration-owner";
  const firstImport = JSON.parse((await chat(migrationOwnerKey, "/pstack migrate")).text);
  assert.deepEqual(
    [firstImport.imported, firstImport.unchanged, firstImport.skipped, firstImport.errors],
    [2, 0, 0, 0],
  );
  const replayImport = JSON.parse((await chat(migrationOwnerKey, "/pstack migrate")).text);
  assert.deepEqual([replayImport.imported, replayImport.unchanged, replayImport.errors], [0, 2, 0]);
  assert.ok(replayImport.outcomes.every((o) => o.imported === false));
  assert.match((await chat(migrationOwnerKey, "/pstack status")).text, /off.*revision 0/s);
  for (const target of migrationKeys) {
    assert.match((await chat(target, "/pstack status")).text, /on.*revision 7/s);
    const at = requests.length;
    await chat(target, "E2E_ONLINE_MIGRATION_FOLLOWUP");
    const request = requests
      .slice(at)
      .filter((r) => r.body.messages)
      .at(-1);
    assert.ok(
      request &&
        JSON.stringify(request.body).includes(
          "Pstack mode is active for this exact session incarnation (revision 7)",
        ),
    );
  }
  for (const { source, raw } of sources) assert.equal(await readFile(source, "utf8"), raw);
  assert.match((await chat(migrationKeys[1], "/pstack off")).text, /off \(revision 8\)/);
  assert.match((await chat(migrationKeys[1], "/pstack on")).text, /on \(revision 9\)/);
  results.push({
    check: "online owner migration publishes to primed Gateway views without restart",
    imported: 2,
    replayUnchanged: 2,
    priorOffObserved: true,
    importedRevision: 7,
    promptInjection: true,
    postImportOffRevision: 8,
    postImportOnRevision: 9,
    sourceUnchanged: true,
  });

  const key = "agent:main:dashboard:pstack-e2e";
  assert.match((await chat(key, "/pstack status")).text, /Pstack off.*revision 0/s);
  assert.match((await chat(key, "/pstack ON")).text, /Pstack on \(revision 1\)/);
  assert.match(
    (await chat(key, "/pstack on ignored task")).text,
    /on \(revision 1\)\. Trailing text was ignored/,
  );
  assert.match(
    (await chat(key, "/pstack help ignored task")).text,
    /Pstack:.*Trailing text was ignored/s,
  );
  assert.match((await chat(key, "/pstack status")).text, /Pstack on.*revision 1/s);
  assert.match((await chat(key, "/poteto_mode oN")).text, /revision 1/);
  const requestAt = requests.length;
  await chat(key, "E2E_ACTIVE_FOLLOWUP");
  const active = requests.slice(requestAt).filter((r) => r.body.messages);
  assert.ok(active.length, "Model provider saw active follow-up");
  assert.ok(
    JSON.stringify(active.at(-1).body).includes(
      "Pstack mode is active for this exact session incarnation",
    ),
    "Real prompt hook injected active context",
  );
  // 1.2.1: the handoff reminder (visible handoff, no waitFor, NO_REPLY to the plan-completion check) reaches the model.
  // 1.2.4: collectors are collected in the turn, and the guard removes waitFor rather than refusing it.
  for (const phrase of ["end the turn with sessions_yield, whose completion events resume this session", "never waitFor", "answer it with exactly NO_REPLY and no tool call",
    "This plugin checks every sessions_yield of this session, route or not: it removes waitFor", "Collect every collector (collect: true) in the turn that spawned it, with agents_wait and awaitResults: true"])
    assert.ok(JSON.stringify(active.at(-1).body).includes(phrase), "Handoff reminder at model boundary: " + phrase);
  results.push({ check: "active prompt injection at real model boundary", present: true, handoffReminder: true });
  assertNoLanAdvertising();
  results.push({ check: "no LAN advertising", bonjourDisabled: true });
  assert.match((await chat(key, "/pstack Off")).text, /Pstack off \(revision 2\)/);
  const offAt = requests.length;
  await chat(key, "E2E_OFF_FOLLOWUP");
  assert.ok(
    !JSON.stringify(requests.slice(offAt).at(-1).body.messages.at(-1)).includes(
      "Pstack mode is active",
    ),
  );
  // Earlier active context remains transcript history; only the current user turn
  // is relevant when checking immediate off, not a substring over the whole history.
  results.push({ check: "off current prompt contribution", present: false });
  assert.match(
    (await chat("agent:main:dashboard:pstack-fresh", "/pstack status")).text,
    /Pstack off.*revision 0/s,
  );
  const taskKey = "agent:main:dashboard:pstack-task";
  const taskAt = requests.length;
  const task = await chat(taskKey, "/pstack Architect a bounded acceptance plan.");
  assert.equal(task.text, "Isolated model response.");
  const taskRequest = requests
    .slice(taskAt)
    .filter((r) => r.body.messages)
    .at(-1);
  assert.ok(taskRequest, "Task reached the real model boundary");
  assert.ok(JSON.stringify(taskRequest.body).includes("Architect a bounded acceptance plan."));
  assert.ok(
    JSON.stringify(taskRequest.body).includes(
      "Pstack mode is active for this exact session incarnation",
    ),
  );
  results.push({
    check: "task continueAgent through real command/skill/hook path",
    activated: true,
    taskSuffixPresent: true,
    promptInjection: true,
  });
  assert.match((await chat(taskKey, "/pstack Status")).text, /Pstack on.*revision 1/s);
  assert.match((await chat(taskKey, "/pstack Off")).text, /Pstack off \(revision 2\)/);
  assert.match((await chat(taskKey, "/pstack Status")).text, /Pstack off.*revision 2/s);
  const goalKey = "agent:main:dashboard:pstack-goal";
  await chat(goalKey, "E2E_GOAL_HISTORY");
  const goal = await chat(goalKey, "Finish this isolated acceptance check.", {
    intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
  });
  assert.equal(goal.ack.status, "started");
  results.push({ check: "Goal start admitted with plugin loaded", accepted: true });
  assert.ok(goal.ack.goalId && goal.ack.sessionId, "Goal ACK has authoritative identity");
  const goalMutation = (action) =>
    rpc("sessions.goal.update", {
      sessionKey: goalKey,
      sessionId: goal.ack.sessionId,
      goalId: goal.ack.goalId,
      operationId: randomUUID(),
      issuedAtMs: Date.now(),
      action,
    });
  assert.equal((await goalMutation("pause")).goal.status, "paused");
  const resumedAt = frames.length;
  const resumed = await goalMutation("resume");
  assert.equal(resumed.status, "started");
  const resumedFinal = await until(
    () =>
      frames
        .slice(resumedAt)
        .find(
          (f) =>
            f.event === "chat" &&
            f.payload?.runId === resumed.runId &&
            ["final", "error"].includes(f.payload?.state),
        ),
    "Goal resumed final",
  );
  assert.equal(resumedFinal.payload.state, "final");
  assert.equal((await goalMutation("complete")).goal.status, "complete");
  results.push({ check: "Goal pause/resume/final/complete with plugin loaded", accepted: true });
  // Restart only our task-owned child process. Ordinary admission must still work.
  await stop();
  frames.length = 0;
  await start();
  assert.match((await chat(key, "/pstack status")).text, /Pstack off.*revision 2/s);
  await chat(key, "E2E_AFTER_RESTART");
  results.push({ check: "ordinary admission after task-owned Gateway restart", accepted: true });
  const reloaded = await rpc("plugins.reload", { plugins: [{ pluginId: "pstack" }] });
  assert.equal(reloaded.restartRequired, false);
  results.push({
    check: "isolated real Gateway plugin reload",
    restartRequired: reloaded.restartRequired,
    runtime: reloaded.runtime,
  });
  assert.match((await chat(key, "/pstack status")).text, /Pstack off.*revision 2/s);
  await writeFile(
    join(evidenceDir, "gateway-e2e.json"),
    JSON.stringify(
      {
        passed: true,
        checks: results,
        providerRequests: requests.length,
        gatewayPort: port,
        pluginPath: root,
        hostBuildId: buildId,
        candidateFiles: Object.fromEntries(
          await Promise.all(
            [
              "package.json",
              "openclaw.plugin.json",
              "dist/index.js",
              "src/index.ts",
              "src/state.ts",
              "skills/pstack/scripts/model-routing.mjs",
              "skills/pstack/scripts/model-routing-cli.mjs",
              "skills/pstack/SKILL.md",
              "skills/pstack/native/contract.md",
              "skills/pstack/native/session-mode.md",
              "skills/pstack/native-manifest.json",
              "skills/poteto-mode/SKILL.md",
            ].map(async (file) => [
              file,
              createHash("sha256")
                .update(await readFile(join(root, file)))
                .digest("hex"),
            ]),
          ),
        ),
        realGateway: true,
        realCommandSkillHookPath: true,
        onlyModelIoStubbed: true,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: results.length,
      providerRequests: requests.length,
      port,
    }),
  );
} finally {
  await stop();
  if (provider) await new Promise((r) => provider.close(r));
  await writeFile(join(evidenceDir, "gateway-e2e.log"), gatewayLog);
  await writeFile(
    join(evidenceDir, "gateway-e2e-progress.json"),
    JSON.stringify(
      {
        checks: results,
        frames: frames.slice(-15).map((f) => ({
          type: f.type,
          event: f.event,
          ok: f.ok,
          error: f.error,
          state: f.payload?.state,
          text: messageText(f.payload?.message),
        })),
        requests: requests.map((r) => ({ url: r.url, messages: r.body.messages?.length })),
      },
      null,
      2,
    ),
  );
  await rm(dir, { recursive: true, force: true });
  console.log("Isolated Gateway, provider and profile removed");
}
