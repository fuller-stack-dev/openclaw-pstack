import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const host = process.env.OPENCLAW_SOURCE;
if (!host) throw Error("Set OPENCLAW_SOURCE");
const root = resolve(import.meta.dirname, ".."),
  dir = await mkdtemp(
    join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "pstack-load-"),
  );
const evidenceDir = resolve(process.env.PSTACK_EVIDENCE_DIR || join(root, "artifacts/diagnostics"));
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("OPENCLAW_")) delete env[key];
Object.assign(env, {
  HOME: join(dir, "home"),
  TMPDIR: join(dir, "tmp"),
  OPENCLAW_STATE_DIR: join(dir, "state"),
  OPENCLAW_CONFIG_PATH: join(dir, "config.json"),
  OPENCLAW_HIDE_BANNER: "1",
  TSX_TSCONFIG_PATH: join(host, "tsconfig.json"),
});
try {
  for (const p of [env.HOME, env.TMPDIR, env.OPENCLAW_STATE_DIR, join(dir, "workspace")])
    await mkdir(p, { recursive: true, mode: 0o700 });
  await writeFile(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: {
        mode: "local",
        port: 19776,
        auth: { mode: "token", token: randomBytes(24).toString("hex") },
      },
      agents: { defaults: { workspace: join(dir, "workspace") } },
      plugins: {
        allow: ["pstack"],
        entries: { pstack: { enabled: true, hooks: { allowConversationAccess: true } } },
      },
    }),
    { mode: 0o600 },
  );
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const identities = Array.from({ length: 7 }, (_, n) => ({
    sessionId: "isolated-incarnation-" + n,
    sessionKey: "agent:main:dashboard:isolated-" + n,
    userId: "isolated-user",
    workspace: join(dir, "workspace"),
  }));
  const legacyDir = join(dir, "workspace/.pstack-session-state");
  await mkdir(legacyDir, { mode: 0o700 });
  const sources = [];
  for (const identity of identities) {
    const path = join(legacyDir, sha(JSON.stringify(identity)) + ".json");
    const raw = JSON.stringify({
      version: 2,
      identity,
      active: true,
      revision: 7,
      lastEvent: { id: "legacy-event", timestampMs: 1, seq: 1, digest: sha("legacy-event") },
    });
    await writeFile(path, raw, { mode: 0o600 });
    sources.push({ path, raw });
  }
  // Populate native metadata through the public session-store SDK, not a fake
  // plugin lookup. The seventh current incarnation is deliberately archived.
  const fixture = join(dir, "native-fixture.mjs");
  await writeFile(
    fixture,
    "import {captureRuntimeConfigAsyncReader} from " +
      JSON.stringify(join(host, "src/plugin-sdk/runtime-config-snapshot.ts")) +
      ";\n" +
      "import {upsertSessionEntry} from " +
      JSON.stringify(join(host, "src/plugin-sdk/session-store-runtime.ts")) +
      ";\n" +
      "import {resolveManagedUpdateLeaseDatabasePath} from " +
      JSON.stringify(join(host, "src/infra/update-managed-service-handoff-lease.ts")) +
      ";\n" +
      "const handoff=resolveManagedUpdateLeaseDatabasePath(); if(!handoff.startsWith(" +
      JSON.stringify(env.TMPDIR + "/") +
      ")) throw Error('Unisolated handoff: '+handoff);\n" +
      "await captureRuntimeConfigAsyncReader()(); const ids=" +
      JSON.stringify(identities) +
      "; for(let n=0;n<ids.length;n++){const i=ids[n];await upsertSessionEntry({agentId:'main',env:process.env,sessionKey:i.sessionKey,entry:{sessionId:i.sessionId,updatedAt:Date.now(),spawnedWorkspaceDir:i.workspace,...(n===6?{archivedAt:Date.now()}: {})}})}; console.log(JSON.stringify({nativeEntries:ids.length,handoff}));",
  );
  const prepared = spawnSync(
    process.execPath,
    ["--import", join(host, "node_modules/tsx/dist/loader.mjs"), fixture],
    { env, cwd: host, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (prepared.status !== 0)
    throw Error("Native migration fixture failed: " + prepared.stdout + prepared.stderr);
  const fixtureReceipt = JSON.parse(prepared.stdout.trim());
  console.log(JSON.stringify(fixtureReceipt));
  const migrate = [
    "pstack",
    "migrate",
    "--workspace",
    join(dir, "workspace"),
    "--all-current-active",
    "--offline",
  ];
  const commands = [
    ["plugins", "install", "--link", "--force", "--accept-capabilities", root],
    ["plugins", "inspect", "pstack", "--runtime", "--json"],
    ["skills", "list", "--json"],
    ["pstack", "doctor"],
    ["config", "set", "plugins.entries.pstack.hooks.allowConversationAccess", "true"],
    migrate,
    migrate,
  ];
  const receipts = [];
  for (let i = 0; i < commands.length; i++) {
    const args = commands[i],
      r = spawnSync(process.execPath, [join(host, "openclaw.mjs"), ...args], {
        env,
        cwd: root,
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
      });
    await writeFile(
      join(evidenceDir, "load-" + i + ".txt"),
      (r.stdout ?? "") + (r.stderr ?? ""),
    );
    receipts.push({ args, exitCode: r.status, error: r.error?.message });
    console.log(JSON.stringify(receipts.at(-1)));
    if (r.status !== 0) throw Error("Isolated CLI failed; inspect " + evidenceDir + "/load-" + i + ".txt");
  }
  const migrations = [];
  for (const index of [5, 6]) {
    const raw = await readFile(join(evidenceDir, "load-" + index + ".txt"), "utf8");
    const result = JSON.parse(raw.slice(raw.indexOf("{")));
    if (
      result.imported !== (index === 5 ? 6 : 0) ||
      result.unchanged !== (index === 6 ? 6 : 0) ||
      result.skipped !== 1 ||
      result.errors !== 0 ||
      result.outcomes
        .filter((o) => !o.skipped)
        .some((o) => o.imported !== (index === 5) || !o.active || o.revision !== 7)
    )
      throw Error("Real bulk CLI migration assertion failed");
    migrations.push(result);
  }
  for (const source of sources)
    if ((await readFile(source.path, "utf8")) !== source.raw)
      throw Error("Migration changed legacy source");
  const inventoryText = await readFile(join(evidenceDir, "load-2.txt"), "utf8");
  const inventory = JSON.parse(inventoryText.slice(inventoryText.indexOf("{")));
  for (const name of ["pstack", "poteto-mode"]) {
    const row = inventory.skills.find((s) => s.name === name);
    if (!row?.eligible) throw Error("Missing eligible bundled skill " + name);
    if (
      row.source !== "openclaw-extra" ||
      !row.modelVisible ||
      row.userInvocable ||
      row.commandVisible
    )
      throw Error("Plugin skill unavailable: " + name);
  }
  const extras = inventory.skills.filter((s) => s.source === "openclaw-extra");
  if (extras.length !== 2)
    throw Error("Unexpected extra/source-only skills: " + extras.map((s) => s.name));
  const inspectText = await readFile(join(evidenceDir, "load-1.txt"), "utf8"),
    inspect = JSON.parse(inspectText.slice(inspectText.indexOf("{")));
  if (
    inspect.plugin.status !== "loaded" ||
    !inspect.plugin.imported ||
    inspect.plugin.hookCount !== 1 ||
    JSON.stringify(inspect.typedHooks.map((h) => h.name)) !==
      JSON.stringify(["before_prompt_build"]) ||
    !inspect.plugin.commands.includes("pstack") ||
    !inspect.plugin.commands.includes("poteto_mode") ||
    !inspect.plugin.toolNames.includes("pstack_route")
  )
    throw Error("Runtime registration proof failed");
  await writeFile(
    join(evidenceDir, "load-receipt.json"),
    JSON.stringify(
      {
        isolated: true,
        liveStateTouched: false,
        gatewayStarted: false,
        commands: receipts,
        sourceOnlyEntries: 0,
        migration: { fixture: fixtureReceipt, runs: migrations, sourceUnchanged: true },
        skills: inventory.skills.filter((s) => ["pstack", "poteto-mode"].includes(s.name)),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
  console.log("Isolated profile removed");
}
