import { normalizeToolParameters } from "host-test/tool-schema";
import { normalizeOpenAIToolSchemas } from "openclaw/plugin-sdk/provider-tools";
import { runAgentLoop } from "host-test/agent-core";
import { createAssistantMessageEventStream } from "host-test/llm-core";
import { loadPluginManifest } from "host-test/plugin-manifest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, chmodSync, existsSync, utimesSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { register } from "../src/index.ts";
import { CREATOR_LINK_WAIT_MS, TRAIL_HEADER } from "../src/trail-tool.ts";
import { KILL_GRACE_MS, LISTING_LIMIT, MAX_SUBMODULE_DEPTH, auditWorktree, dirtyState, parseIndexDebug, parseWorktreeList, run, statUnchanged } from "../src/worktree-audit-tool.ts";
import { build } from "./fixtures/tool-factory.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temporary(prefix: string) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(path);
  return path;
}
function registrations(pluginConfig?: Record<string, unknown>) {
  const captured: { factory: any; options: any }[] = [];
  register(createTestPluginApi({ id: "pstack", pluginConfig,
    runtime: { state: { openKeyedStoreV2() { throw Error("script adapters must not open state"); } } },
    registerTool: (factory: any, options: any) => captured.push({ factory, options }),
  } as any));
  return captured;
}
function tool(name: string, context: any, pluginConfig?: Record<string, unknown>) {
  const found = registrations(pluginConfig).map(({ factory }) => build(factory, context)).find(candidate => candidate.name === name);
  expect(found, name + " must be registered").toBeDefined();
  return found;
}
/** Host-shaped context of an unrestricted (full permission) session unless the test overrides fsPolicy. */
const trailTool = (context: any, pluginConfig?: Record<string, unknown>) =>
  tool("pstack_trail", { fsPolicy: { workspaceOnly: false }, ...context }, pluginConfig);
const row = (overrides: Record<string, unknown> = {}) => ({ log: "decisions", phase: "frame",
  decision: "counted the work first", why: "wanted the size before a long run", evidence: "commit 3a9f1c2",
  result: "found 5 things to sort out", ...overrides });
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

describe("registration", () => {
  it("registers both script adapters as optional, matching the real host manifest parse", () => {
    const captured = registrations();
    const options = Object.fromEntries(captured.map(({ factory, options }) => [build(factory, {}).name, options]));
    expect(options.pstack_trail).toEqual({ names: ["pstack_trail"], optional: true });
    expect(options.pstack_worktree_audit).toEqual({ names: ["pstack_worktree_audit"], optional: true });
    // Read-only and pure helpers stay required; only file effects and repo reads need opt-in.
    expect(options.pstack_plan_check?.optional).toBeUndefined();
    const manifest = loadPluginManifest(resolve(import.meta.dirname, ".."), false) as any;
    expect(manifest.ok, manifest.error).toBe(true);
    expect(manifest.manifest.contracts.tools).toEqual(expect.arrayContaining(["pstack_trail", "pstack_worktree_audit"]));
    expect(manifest.manifest.toolMetadata).toEqual({
      pstack_trail: { optional: true, sideEffecting: true },
      pstack_worktree_audit: { optional: true, replaySafe: true },
    });
  });
});

describe("pstack_trail", () => {
  it("creates the canonical header once, sanitizes cells and only ever appends", async () => {
    const workspace = temporary("trail-ws-");
    const trail = trailTool({ workspaceDir: workspace });
    const first = await trail.execute("a", row({
      decision: "=HYPERLINK(\"http://x\")\tsplit\nline", why: "+1 sum\u2028next", evidence: "-cmd|calc\u2029", result: "@SUM(A1)\r",
    }));
    const file = join(workspace, ".audit/decisions.tsv");
    expect(first.details).toMatchObject({ status: "APPENDED", log: ".audit/decisions.tsv", attestation: "agent-attested" });
    expect(first.details.row.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const body = readFileSync(file, "utf8");
    expect(body.startsWith(TRAIL_HEADER)).toBe(true);
    const cells = lines(file)[1]!.split("\t");
    expect(cells).toEqual([first.details.row.ts, "frame", "'=HYPERLINK(\"http://x\") split line", "'+1 sum next", "'-cmd|calc ", "'@SUM(A1) "]);
    await trail.execute("b", row({ phase: "start", decision: "picked up the run", evidence: "session 1061" }));
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(body)).toBe(true);
    expect(lines(file)).toHaveLength(3);
    expect(lines(file)[2]!.split("\t").slice(1)).toEqual(["start", "picked up the run", "wanted the size before a long run", "session 1061", "found 5 things to sort out"]);
    expect(statSync(join(workspace, ".audit")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(workspace, ".audit"))).toEqual(["decisions.tsv"]);
  });

  it("keeps exactly one header and every row for many tool instances sharing a new log (in-process, sequential)", async () => {
    const workspace = temporary("trail-race-");
    const trails = Array.from({ length: 24 }, () => trailTool({ workspaceDir: workspace }));
    await Promise.all(trails.map((trail, i) => trail.execute("r" + i, row({ log: "race", decision: "row " + i }))));
    const all = lines(join(workspace, ".audit/race.tsv"));
    expect(all.filter(line => line + "\n" === TRAIL_HEADER)).toHaveLength(1);
    expect(all[0] + "\n").toBe(TRAIL_HEADER);
    expect(all.slice(1).map(line => line.split("\t")[2]).sort()).toEqual(Array.from({ length: 24 }, (_, i) => "row " + i).sort());
    for (const line of all) expect(line.split("\t")).toHaveLength(6);
    expect(readdirSync(join(workspace, ".audit"))).toEqual(["race.tsv"]);
  });

  /** Real OS processes released together by a barrier file; any refusal fails its process. */
  async function processWriters(workspace: string, writers: number, count: number, mode: "shared" | "fresh") {
    const go = join(workspace, "go"), host = process.env.PSTACK_TEST_HOST_SOURCE!;
    const running = Array.from({ length: writers }, (_, id) => new Promise<number>((done, fail) => {
      const child = spawn(process.execPath, ["--import", join(host, "node_modules/tsx/dist/esm/index.mjs"),
        resolve(import.meta.dirname, "fixtures/trail-writer.ts"), workspace, go, String(id), String(count), mode],
        { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TSX_TSCONFIG_PATH: join(host, "tsconfig.json") }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", fail);
      child.on("exit", code => code === 0 ? done(code) : fail(Error("writer " + id + " exited " + code + ": " + stderr)));
    }));
    await new Promise(r => setTimeout(r, 1500));
    writeFileSync(go, "");
    await Promise.all(running);
    rmSync(go);
  }

  it("keeps one header and every row across concurrent OS processes", async () => {
    const workspace = temporary("trail-processes-");
    await processWriters(workspace, 8, 15, "shared");
    const all = lines(join(workspace, ".audit/shared.tsv"));
    expect(all[0] + "\n").toBe(TRAIL_HEADER);
    expect(all.filter(line => line + "\n" === TRAIL_HEADER)).toHaveLength(1);
    expect(all).toHaveLength(1 + 8 * 15);
    for (const line of all.slice(1)) expect(line.split("\t")).toHaveLength(6);
    expect(new Set(all.slice(1).map(line => line.split("\t")[2])).size).toBe(120);
    expect(readdirSync(join(workspace, ".audit"))).toEqual(["shared.tsv"]);
  });

  it("accepts every concurrent first writer across many fresh logs created by racing OS processes", async () => {
    // Each log has its own creation window, where a creator's temporary second link briefly exists.
    const workspace = temporary("trail-fresh-"), writers = 12, logs = 150;
    await processWriters(workspace, writers, logs, "fresh");
    const names = readdirSync(join(workspace, ".audit")).sort();
    expect(names).toEqual(Array.from({ length: logs }, (_, i) => "fresh-" + i + ".tsv").sort());
    for (const name of names) {
      const all = lines(join(workspace, ".audit", name));
      expect(all[0] + "\n").toBe(TRAIL_HEADER);
      expect(all.filter(line => line + "\n" === TRAIL_HEADER)).toHaveLength(1);
      expect(all.slice(1).map(line => line.split("\t")[2]).sort())
        .toEqual(Array.from({ length: writers }, (_, id) => "process " + id + " row " + name.slice(6, -4)).sort());
    }
  });

  it("starts a new line after a torn earlier append without changing its bytes", async () => {
    const workspace = temporary("trail-torn-");
    const trail = trailTool({ workspaceDir: workspace });
    await trail.execute("a", row());
    const file = join(workspace, ".audit/decisions.tsv");
    appendFileSync(file, "2026-10-21T00:00:00Z\tpartial");
    const torn = readFileSync(file, "utf8");
    await trail.execute("b", row({ decision: "after tear" }));
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(torn + "\n")).toBe(true);
    expect(lines(file).at(-1)!.split("\t")[2]).toBe("after tear");
  });

  it("refuses unsafe targets and leaves every file unchanged", async () => {
    const outside = temporary("trail-outside-");
    const victim = join(outside, "victim.tsv");
    writeFileSync(victim, TRAIL_HEADER);
    const digest = () => createHash("sha256").update(readFileSync(victim)).digest("hex");
    const before = digest();
    const linkedDirectory = temporary("trail-link-dir-");
    symlinkSync(outside, join(linkedDirectory, ".audit"));
    await expect(trailTool({ workspaceDir: linkedDirectory }).execute("x", row({ log: "victim" })))
      .rejects.toThrow(".audit must be a real directory");
    const linkedFile = temporary("trail-link-file-");
    mkdirSync(join(linkedFile, ".audit"));
    symlinkSync(victim, join(linkedFile, ".audit/decisions.tsv"));
    await expect(trailTool({ workspaceDir: linkedFile }).execute("x", row())).rejects.toThrow("must be a regular file");
    const hardLinked = temporary("trail-hard-");
    mkdirSync(join(hardLinked, ".audit"));
    linkSync(victim, join(hardLinked, ".audit/decisions.tsv"));
    await expect(trailTool({ workspaceDir: hardLinked }).execute("x", row())).rejects.toThrow("single-link regular file");
    expect(digest()).toBe(before);
    const foreign = temporary("trail-foreign-");
    mkdirSync(join(foreign, ".audit"));
    writeFileSync(join(foreign, ".audit/notes.tsv"), "name\tvalue\nkeep\tme\n");
    await expect(trailTool({ workspaceDir: foreign }).execute("x", row({ log: "notes" }))).rejects.toThrow("not a pstack decision trail");
    expect(readFileSync(join(foreign, ".audit/notes.tsv"), "utf8")).toBe("name\tvalue\nkeep\tme\n");
    // Longer than the header, same column count, one changed name: content, not length, decides.
    const lookalike = "ts\tphase\tdecision\twhy\tevidence\toutcome\n2026-10-21T00:00:00Z\tframe\tkeep\tme\tsha\tok\n";
    writeFileSync(join(foreign, ".audit/lookalike.tsv"), lookalike);
    await expect(trailTool({ workspaceDir: foreign }).execute("x", row({ log: "lookalike" }))).rejects.toThrow("not a pstack decision trail");
    expect(readFileSync(join(foreign, ".audit/lookalike.tsv"), "utf8")).toBe(lookalike);
    const sandboxed = temporary("trail-sandbox-");
    await expect(trailTool({ workspaceDir: sandboxed, sandboxed: true }).execute("x", row())).rejects.toThrow("sandboxed");
    await expect(trailTool({}).execute("x", row())).rejects.toThrow("workspace is unavailable");
    const confined = temporary("trail-root-");
    await expect(trailTool({ workspaceDir: confined, fsPolicy: { workspaceOnly: true, root: outside } }, { trailInRestrictedSessions: true }).execute("x", row()))
      .rejects.toThrow("outside the effective filesystem root");
    for (const dir of [sandboxed, confined]) expect(existsSync(join(dir, ".audit"))).toBe(false);
  });

  for (const args of [null, {}, row({ log: "../escape" }), row({ log: "a/b" }), row({ log: "Upper" }), row({ log: "" }),
    row({ evidence: "   " }), row({ result: 7 }), row({ why: { text: "x" } }), row({ path: "/tmp/x" }), row({ decision: "x".repeat(2001) })])
    it("refuses malformed trail arguments before coercion and at execution: " + JSON.stringify(args)?.slice(0, 60), async () => {
      const workspace = temporary("trail-invalid-");
      const trail = trailTool({ workspaceDir: workspace });
      expect(() => trail.prepareArguments(args)).toThrow("Invalid pstack_trail");
      await expect(trail.execute("bad", args)).rejects.toThrow("Invalid pstack_trail");
      expect(existsSync(join(workspace, ".audit"))).toBe(false);
    });

  it("fails closed in workspaceOnly or unknown-policy sessions unless the operator opted in", async () => {
    const workspace = temporary("trail-restricted-");
    const confinedHere = { workspaceOnly: true, root: workspace };
    for (const context of [{ workspaceDir: workspace, fsPolicy: confinedHere }, { workspaceDir: workspace, fsPolicy: undefined }]) {
      await expect(trailTool(context).execute("x", row())).rejects.toThrow("does not expose read-only mode to plugin tools");
      // Only an exact boolean opt-in counts.
      await expect(trailTool(context, { trailInRestrictedSessions: "true" }).execute("x", row())).rejects.toThrow("trailInRestrictedSessions");
    }
    await expect(trailTool({ workspaceDir: workspace, fsPolicy: confinedHere }).execute("x", row())).rejects.toThrow("filesystem policy is workspaceOnly");
    await expect(trailTool({ workspaceDir: workspace, fsPolicy: undefined }).execute("x", row())).rejects.toThrow("filesystem policy is unknown");
    expect(existsSync(join(workspace, ".audit"))).toBe(false);
    const allowed = await trailTool({ workspaceDir: workspace, fsPolicy: confinedHere }, { trailInRestrictedSessions: true }).execute("x", row());
    expect(allowed.details.status).toBe("APPENDED");
    await trailTool({ workspaceDir: workspace, fsPolicy: undefined }, { trailInRestrictedSessions: true }).execute("y", row());
    expect(lines(join(workspace, ".audit/decisions.tsv"))).toHaveLength(3);
    // The opt-in never lifts the sandbox refusal.
    await expect(trailTool({ workspaceDir: workspace, sandboxed: true, fsPolicy: confinedHere }, { trailInRestrictedSessions: true }).execute("z", row()))
      .rejects.toThrow("sandboxed");
  });

  it("waits a bounded time for a creator's temporary link, and refuses one that stays", async () => {
    const workspace = temporary("trail-creator-");
    await trailTool({ workspaceDir: workspace }).execute("seed", row({ log: "held" }));
    const file = join(workspace, ".audit/held.tsv"), creator = join(workspace, ".audit/.held." + "c".repeat(36) + ".tmp");
    linkSync(file, creator);
    setTimeout(() => rmSync(creator), 60);
    const started = Date.now();
    await trailTool({ workspaceDir: workspace }).execute("released", row({ log: "held", decision: "after release" }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(lines(file).at(-1)!.split("\t")[2]).toBe("after release");
    linkSync(file, creator);
    const held = readFileSync(file, "utf8");
    const waited = Date.now();
    await expect(trailTool({ workspaceDir: workspace }).execute("held", row({ log: "held" }))).rejects.toThrow("single-link regular file");
    expect(Date.now() - waited).toBeGreaterThanOrEqual(CREATOR_LINK_WAIT_MS);
    expect(readFileSync(file, "utf8")).toBe(held);
    rmSync(creator);
    // An unrelated creator-named file does not excuse a second link elsewhere.
    writeFileSync(join(workspace, ".audit/.held." + "g".repeat(36) + ".tmp"), TRAIL_HEADER);
    linkSync(file, join(workspace, ".audit/copy.tsv"));
    const unrelated = Date.now();
    await expect(trailTool({ workspaceDir: workspace }).execute("x", row({ log: "held" }))).rejects.toThrow("single-link regular file");
    expect(Date.now() - unrelated).toBeLessThan(CREATOR_LINK_WAIT_MS);
    rmSync(join(workspace, ".audit/copy.tsv")); rmSync(join(workspace, ".audit/.held." + "g".repeat(36) + ".tmp"));
    // A second link that is not this log's creator sibling is refused at once, as is a third link.
    for (const name of [".other." + "d".repeat(36) + ".tmp", "copy.tsv"]) {
      linkSync(file, join(workspace, ".audit", name));
      const at = Date.now();
      await expect(trailTool({ workspaceDir: workspace }).execute("x", row({ log: "held" }))).rejects.toThrow("single-link regular file");
      expect(Date.now() - at).toBeLessThan(CREATOR_LINK_WAIT_MS);
      rmSync(join(workspace, ".audit", name));
    }
    linkSync(file, creator); linkSync(file, join(workspace, ".audit/.held." + "e".repeat(36) + ".tmp"));
    const at = Date.now();
    await expect(trailTool({ workspaceDir: workspace }).execute("x", row({ log: "held" }))).rejects.toThrow("single-link regular file");
    expect(Date.now() - at).toBeLessThan(CREATOR_LINK_WAIT_MS);
    expect(readFileSync(file, "utf8")).toBe(held);
  });

  it("refuses when .audit or the log is swapped after validation, writing nothing", async () => {
    // The creator-link wait gives a deterministic window between validation and the append.
    const name = ".swap." + "f".repeat(36) + ".tmp";
    const swap = async (change: (audit: string) => void) => {
      const workspace = temporary("trail-swap-"), audit = join(workspace, ".audit");
      await trailTool({ workspaceDir: workspace }).execute("seed", row({ log: "swap" }));
      linkSync(join(audit, "swap.tsv"), join(audit, name));
      // Each change also drops the creator link, so only the swap can cause the refusal.
      setTimeout(() => change(audit), 30);
      await expect(trailTool({ workspaceDir: workspace }).execute("x", row({ log: "swap", decision: "must not land" })))
        .rejects.toThrow("changed during the append");
      return workspace;
    };
    const symlinked = await swap(audit => { renameSync(audit, audit + "-real"); symlinkSync(audit + "-real", audit); rmSync(join(audit + "-real", name)); });
    expect(readFileSync(join(symlinked, ".audit-real/swap.tsv"), "utf8")).not.toContain("must not land");
    const replacedDir = await swap(audit => { renameSync(audit, audit + "-old"); rmSync(join(audit + "-old", name));
      mkdirSync(audit, { mode: 0o700 }); writeFileSync(join(audit, "swap.tsv"), TRAIL_HEADER); });
    for (const dir of [".audit-old", ".audit"]) expect(readFileSync(join(replacedDir, dir, "swap.tsv"), "utf8")).not.toContain("must not land");
    const replacedLog = await swap(audit => { renameSync(join(audit, "swap.tsv"), join(audit, "old.tsv")); rmSync(join(audit, name));
      writeFileSync(join(audit, "swap.tsv"), TRAIL_HEADER); });
    for (const log of ["old.tsv", "swap.tsv"]) expect(readFileSync(join(replacedLog, ".audit", log), "utf8")).not.toContain("must not land");
    // Control: the same window without a swap appends normally.
    const control = await (async () => {
      const workspace = temporary("trail-swap-control-"), audit = join(workspace, ".audit");
      await trailTool({ workspaceDir: workspace }).execute("seed", row({ log: "swap" }));
      linkSync(join(audit, "swap.tsv"), join(audit, name));
      setTimeout(() => rmSync(join(audit, name)), 30);
      await trailTool({ workspaceDir: workspace }).execute("x", row({ log: "swap", decision: "lands" }));
      return readFileSync(join(audit, "swap.tsv"), "utf8");
    })();
    expect(control).toContain("lands");
  });

  it("writes nothing when the invocation is revoked before the final append", async () => {
    const workspace = temporary("trail-revoked-");
    await trailTool({ workspaceDir: workspace }).execute("seed", row());
    const file = join(workspace, ".audit/decisions.tsv"), before = readFileSync(file, "utf8");
    const late = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw Error("revoked"); });
    await expect(trailTool({ workspaceDir: workspace, assertInvocationCurrent: late }).execute("late", row())).rejects.toThrow("revoked");
    expect(late).toHaveBeenCalledTimes(2);
    const early = vi.fn(() => { throw Error("already revoked"); });
    await expect(trailTool({ workspaceDir: workspace, assertInvocationCurrent: early }).execute("early", row())).rejects.toThrow("already revoked");
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: process.env.HOME!,
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
}
/** Origin with main; linked worktrees covering each classification. */
function repository() {
  const workspace = temporary("audit-ws-");
  const origin = join(temporary("audit-origin-"), "origin.git");
  git(workspace, "init", "--bare", "-b", "main", origin);
  const repo = join(workspace, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", origin);
  const trees = join(workspace, "trees");
  const add = (name: string, ...args: string[]) => { git(repo, "worktree", "add", ...args, join(trees, name)); return join(trees, name); };
  const merged = add("merged", "-b", "merged");
  writeFileSync(join(merged, "m.txt"), "m\n"); git(merged, "add", "m.txt"); git(merged, "commit", "-m", "merged");
  // A stat-only change makes ordinary git status rewrite this worktree's index.
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(join(merged, "m.txt"), past, past);
  git(repo, "merge", "--ff-only", "merged");
  git(repo, "push", "origin", "main", "merged");
  const wip = add("wip", "-b", "wip");
  writeFileSync(join(wip, "a.txt"), "changed\n");
  const scratchTree = add("scratch", "-b", "scratch");
  writeFileSync(join(scratchTree, "b.txt"), "b\n"); git(scratchTree, "add", "b.txt"); git(scratchTree, "commit", "-m", "unmerged");
  writeFileSync(join(scratchTree, "untracked.txt"), "x".repeat(200_000));
  const ahead = add("ahead", "-b", "ahead");
  git(ahead, "push", "origin", "ahead");
  writeFileSync(join(ahead, "c.txt"), "c\n"); git(ahead, "add", "c.txt"); git(ahead, "commit", "-m", "ahead");
  const detached = join(trees, "detached");
  git(repo, "worktree", "add", "--detach", detached, "HEAD");
  // Unborn HEAD: porcelain reports the null object id, so ancestry is unknown, not "no".
  const orphan = add("orphan", "--orphan", "-b", "orphan");
  const gone = add("gone", "-b", "gone");
  rmSync(gone, { recursive: true, force: true });
  git(repo, "fetch", "origin");
  return { workspace, origin, repo, merged, wip, scratchTree, ahead, detached, orphan, gone };
}
/** A repository with one commit and no remote, for audits that need only a few linked worktrees. */
function smallRepository() {
  const workspace = temporary("audit-small-"), repo = join(workspace, "repo");
  mkdirSync(repo); git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n"); git(repo, "add", "a.txt"); git(repo, "commit", "-qm", "base");
  return { workspace, repo };
}
function fingerprint(repo: string) {
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) walk(path);
    else { const s = statSync(path); files.push(path + ":" + s.size + ":" + s.mtimeMs + ":" + createHash("sha256").update(readFileSync(path)).digest("hex")); }
  } };
  walk(join(repo, ".git"));
  return files.sort().join("\n");
}

describe("pstack_worktree_audit", () => {
  it("classifies every linked worktree without writing, fetching or starting the configured fsmonitor", async () => {
    const r = repository();
    // A newer origin commit must stay invisible: the adapter never fetches.
    const pusher = join(temporary("audit-pusher-"), "clone");
    git(r.workspace, "clone", "-q", r.origin, pusher);
    writeFileSync(join(pusher, "n.txt"), "n\n"); git(pusher, "add", "n.txt"); git(pusher, "commit", "-m", "newer"); git(pusher, "push", "-q", "origin", "main");
    const sentinel = join(temporary("audit-sentinel-"), "ran");
    const hook = join(r.workspace, "fsmonitor.sh");
    writeFileSync(hook, "#!/bin/sh\necho ran > '" + sentinel + "'\nexit 1\n", { mode: 0o755 });
    git(r.repo, "config", "core.fsmonitor", hook);
    const localMain = git(r.repo, "rev-parse", "origin/main");
    const before = fingerprint(r.repo);
    const indexes = [r.merged, r.wip, r.scratchTree].map(wt => statSync(join(r.repo, ".git/worktrees", wt.split("/").at(-1)!, "index")).mtimeMs);

    const audit = tool("pstack_worktree_audit", { workspaceDir: r.workspace });
    const result = await audit.execute("audit", { repo: "repo" });
    const d = result.details;
    expect(d).toMatchObject({ status: "AUDITED", base: "origin/main", mainWorktree: r.repo, audited: 7, listed: 7, complete: true });
    expect(d.warnings.join(" ")).toContain("without fetching");
    const by = Object.fromEntries(d.worktrees.map((w: any) => [w.worktree, w]));
    expect(by[r.merged]).toMatchObject({ merged: "YES", dirty: "clean", remote: "pushed", branch: "merged", bucket: "verify-activity", pr: "not-checked", lastActivity: "not-checked" });
    expect(by[r.wip]).toMatchObject({ merged: "YES", dirty: "wip:1", remote: "no-remote", bucket: "hold-wip" });
    expect(by[r.scratchTree]).toMatchObject({ merged: "no", dirty: "scratch:1", remote: "no-remote", bucket: "review" });
    expect(by[r.ahead]).toMatchObject({ merged: "no", remote: "ahead1/behind0", bucket: "review" });
    expect(by[r.detached]).toMatchObject({ remote: "detached", branch: null, merged: "YES", bucket: "verify-activity" });
    expect(by[r.orphan]).toMatchObject({ merged: "unknown", ageDays: null, branch: "orphan", remote: "no-remote", bucket: "review" });
    expect(by[r.gone]).toMatchObject({ dirty: "missing", sizeKiB: null, bucket: "review" });
    expect(d.worktrees.some((w: any) => w.bucket === "safe")).toBe(false);
    expect(d.worktrees[0].worktree).toBe(r.scratchTree);
    for (const w of d.worktrees.slice(0, -1)) expect(w.sizeKiB).toEqual(expect.any(Number));
    expect(by[r.merged].ageDays).toBe(0);
    expect(d.notice).toContain("No bucket authorizes deletion");

    expect(git(r.repo, "rev-parse", "origin/main")).toBe(localMain);
    expect(existsSync(sentinel)).toBe(false);
    expect(fingerprint(r.repo)).toBe(before);
    expect([r.merged, r.wip, r.scratchTree].map(wt => statSync(join(r.repo, ".git/worktrees", wt.split("/").at(-1)!, "index")).mtimeMs)).toEqual(indexes);
    expect(existsSync(r.gone)).toBe(false);
    expect(git(r.repo, "worktree", "list", "--porcelain")).toContain(r.gone);
    expect(JSON.parse(result.content[0].text)).toEqual(d);
    // Controls: plain git status does rewrite the stat-changed index and does run the hook.
    const mergedIndex = join(r.repo, ".git/worktrees/merged/index"), indexBefore = readFileSync(mergedIndex);
    execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain"], { cwd: r.merged, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GIT_CONFIG_NOSYSTEM: "1" } });
    expect(readFileSync(mergedIndex).equals(indexBefore)).toBe(false);
    execFileSync("git", ["status", "--porcelain"], { cwd: r.wip, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GIT_CONFIG_NOSYSTEM: "1" } });
    expect(existsSync(sentinel)).toBe(true);
  });

  it("never runs repository-configured filter or signature programs, even for stat-changed and racily clean files", async () => {
    const r = repository();
    const markers = temporary("audit-markers-"), ran = (name: string) => existsSync(join(markers, name));
    const program = (name: string) => {
      const path = join(markers, name + ".sh");
      writeFileSync(path, "#!/bin/sh\necho ran >> '" + join(markers, name) + "'\ncat >/dev/null\nexit 1\n", { mode: 0o755 });
      return path;
    };
    // A tracked file under a clean filter with a stat-only change: plain status must re-read it through the filter.
    const filtered = join(r.workspace, "trees/filtered");
    git(r.repo, "worktree", "add", "-b", "filtered", filtered);
    writeFileSync(join(filtered, ".gitattributes"), "f.txt filter=evil\n");
    writeFileSync(join(filtered, "f.txt"), "f\n");
    git(filtered, "add", ".gitattributes", "f.txt"); git(filtered, "commit", "-m", "filtered");
    git(r.repo, "config", "filter.evil.clean", program("filter"));
    const past = new Date(Date.now() - 7_200_000);
    utimesSync(join(filtered, "f.txt"), past, past);
    // An index no newer than its entries makes every entry racily clean, which plain status re-reads through the filter.
    const filteredIndex = join(r.repo, ".git/worktrees/filtered/index");
    utimesSync(filteredIndex, new Date(Date.now() - 10_800_000), new Date(Date.now() - 10_800_000));
    // A signed-looking commit with signature display on: plain log runs gpg.program.
    const signed = join(r.workspace, "trees/signed");
    git(r.repo, "worktree", "add", "-b", "signed", signed);
    const tree = git(signed, "rev-parse", "HEAD^{tree}"), parent = git(signed, "rev-parse", "HEAD"), when = Math.floor(Date.now() / 1000);
    const body = "tree " + tree + "\nparent " + parent + "\nauthor t <t@example.invalid> " + when + " +0000\ncommitter t <t@example.invalid> " + when + " +0000\n"
      + "gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\nsigned\n";
    const commit = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: signed, input: body, encoding: "utf8" }).trim();
    git(r.repo, "update-ref", "refs/heads/signed", commit);
    git(r.repo, "config", "log.showSignature", "true");
    git(r.repo, "config", "gpg.program", program("gpg"));
    const before = fingerprint(r.repo);

    const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("x", { repo: "repo" })).details;
    expect(ran("filter")).toBe(false);
    expect(ran("gpg")).toBe(false);
    expect(fingerprint(r.repo)).toBe(before);
    expect(d).toMatchObject({ status: "AUDITED", audited: 9, complete: true });
    const by = Object.fromEntries(d.worktrees.map((w: any) => [w.worktree, w]));
    // The raw bytes still match the index, so the stat-changed, racily clean file is not a change.
    expect(by[filtered]).toMatchObject({ dirty: "clean", merged: "no", bucket: "review" });
    expect(by[signed]).toMatchObject({ ageDays: 0, merged: "no", branch: "signed", dirty: "clean" });
    expect(by[r.wip]).toMatchObject({ dirty: "wip:1", bucket: "hold-wip" });
    expect(by[r.scratchTree]).toMatchObject({ dirty: "scratch:1", bucket: "review" });

    // Controls: the same config does run both programs through ordinary git.
    const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: signed, env, stdio: "ignore" });
    expect(ran("gpg")).toBe(true);
    try { execFileSync("git", ["status", "--porcelain"], { cwd: filtered, env, stdio: "ignore" }); } catch { /* the filter exits 1 */ }
    expect(ran("filter")).toBe(true);
  });

  it("never lazily fetches missing objects of a partial clone, even when repository config re-allows file transport", async () => {
    const r = repository();
    git(r.workspace, "-C", r.origin, "config", "uploadpack.allowFilter", "true");
    const partial = join(r.workspace, "partial");
    git(r.workspace, "clone", "-q", "--filter=tree:0", "file://" + r.origin, partial);
    const lazy = join(r.workspace, "trees/lazy");
    git(partial, "worktree", "add", "-q", "-b", "lazy", lazy, "origin/main");
    const pusher = join(temporary("audit-lazy-pusher-"), "clone");
    git(r.workspace, "clone", "-q", r.origin, pusher);
    writeFileSync(join(pusher, "z.txt"), "z\n"); git(pusher, "add", "z.txt"); git(pusher, "commit", "-m", "newer tree"); git(pusher, "push", "-q", "origin", "main");
    git(partial, "fetch", "-q", "origin");
    const tip = git(partial, "rev-parse", "origin/main");
    git(partial, "update-ref", "refs/heads/lazy", tip);
    git(partial, "config", "protocol.file.allow", "always");
    const tree = git(pusher, "rev-parse", "HEAD^{tree}");
    const present = () => { try { execFileSync("git", ["cat-file", "-e", tree], { cwd: partial, stdio: "ignore",
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1" } }); return true; } catch { return false; } };
    expect(present()).toBe(false);
    const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("x", { repo: "partial" })).details;
    expect(d.worktrees.find((w: any) => w.worktree === lazy)).toMatchObject({ dirty: "unknown", bucket: "hold-wip", branch: "lazy" });
    expect(present()).toBe(false);
    // Control: ordinary status in that worktree does fetch the missing tree.
    execFileSync("git", ["status", "--porcelain"], { cwd: lazy, stdio: "ignore", env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GIT_CONFIG_NOSYSTEM: "1" } });
    expect(present()).toBe(true);
  });

  it("never runs a program from config written at any point during the audit", async () => {
    // Deterministic race: a git shim appends program config just before the k-th git call, for every k.
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    function fixture() {
      const r = smallRepository();
      const tree = join(r.workspace, "trees/raced");
      git(r.repo, "worktree", "add", "-q", "-b", "raced", tree);
      writeFileSync(join(tree, ".gitattributes"), "* filter=evil diff=evil\n");
      writeFileSync(join(tree, "f.txt"), "f\n");
      git(tree, "add", ".gitattributes", "f.txt"); git(tree, "commit", "-m", "raced");
      const hour = new Date(Date.now() - 3_600_000), older = new Date(Date.now() - 7_200_000);
      utimesSync(join(tree, "f.txt"), hour, hour);
      utimesSync(join(r.repo, ".git/worktrees/raced/index"), older, older);
      const control = temporary("audit-race-");
      const marker = join(control, "ran"), program = join(control, "program.sh"), hooks = join(control, "hooks");
      writeFileSync(program, "#!/bin/sh\necho \"$0 $*\" >> '" + marker + "'\ncat >/dev/null\nexit 1\n", { mode: 0o755 });
      mkdirSync(hooks);
      for (const hook of ["post-index-change", "pre-auto-gc", "reference-transaction", "post-checkout"]) writeFileSync(join(hooks, hook), readFileSync(program), { mode: 0o755 });
      const inject = join(control, "inject");
      writeFileSync(inject, ["[filter \"evil\"]", "\tclean = " + program, "\tprocess = " + program, "\trequired = true",
        "[diff]", "\texternal = " + program, "[diff \"evil\"]", "\ttextconv = " + program, "\tcommand = " + program,
        "[core]", "\tfsmonitor = " + program, "\thooksPath = " + hooks, "\tpager = " + program,
        "[log]", "\tshowSignature = true", "[gpg]", "\tprogram = " + program, ""].join("\n"));
      const bin = join(control, "bin");
      mkdirSync(bin);
      writeFileSync(join(control, "count"), "0");
      writeFileSync(join(bin, "git"), ["#!/bin/sh", "n=$(($(cat '" + join(control, "count") + "') + 1))", "echo $n > '" + join(control, "count") + "'",
        "if [ \"$n\" = \"$(cat '" + join(control, "at") + "')\" ]; then cat '" + inject + "' >> '" + join(r.repo, ".git/config") + "'; fi",
        "exec '" + realGit + "' \"$@\"", ""].join("\n"), { mode: 0o755 });
      return { r, tree, control, marker, bin };
    }
    async function audit(at: number) {
      const f = fixture();
      writeFileSync(join(f.control, "at"), String(at));
      const path = process.env.PATH;
      process.env.PATH = f.bin + ":" + path;
      try { return { ...f, d: (await tool("pstack_worktree_audit", { workspaceDir: f.r.workspace }).execute("race", { repo: "repo" })).details,
        calls: Number(readFileSync(join(f.control, "count"), "utf8")) }; }
      finally { process.env.PATH = path; }
    }
    const baseline = await audit(0);
    expect(baseline.calls).toBeGreaterThan(8);
    expect(baseline.d.worktrees.find((w: any) => w.worktree === baseline.tree)).toMatchObject({ dirty: "clean" });
    for (let at = 1; at <= baseline.calls; at++) {
      const run = await audit(at);
      expect(run.calls, "call " + at).toBe(baseline.calls);
      expect(readFileSync(join(run.r.repo, ".git/config"), "utf8"), "call " + at).toContain("[filter \"evil\"]");
      expect(existsSync(run.marker), "a program ran when config appeared before git call " + at).toBe(false);
      // Classification never depends on when the config appeared.
      expect(run.d.worktrees.map((w: any) => [w.worktree, w.dirty, w.bucket])).toEqual(baseline.d.worktrees.map((w: any) => [w.worktree, w.dirty, w.bucket]).map(([w, dirty, bucket]: any) => [w.replace(baseline.r.workspace, run.r.workspace), dirty, bucket]));
    }
    // Control: with the same config in place, plain git status does run the filter.
    const control = await audit(1);
    // The long-running filter protocol waits on the program, so the control is bounded.
    try { execFileSync("git", ["status", "--porcelain"], { cwd: control.tree, stdio: "ignore", timeout: 10_000, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GIT_CONFIG_NOSYSTEM: "1" } }); } catch { /* the program fails or is stopped */ }
    expect(existsSync(control.marker)).toBe(true);
  }, 60_000);

  it("writes no trace file even when the global config names a trace2 target", async () => {
    const r = smallRepository();
    git(r.repo, "worktree", "add", "-q", "-b", "traced", join(r.workspace, "trees/traced"));
    const home = temporary("audit-home-"), target = join(temporary("audit-trace-"), "trace.log");
    writeFileSync(join(home, ".gitconfig"), "[trace2]\n\tnormalTarget = " + target + "\n\teventTarget = " + target + "\n");
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("t", { repo: "repo" })).details;
      expect(d).toMatchObject({ status: "AUDITED", audited: 1 });
      expect(existsSync(target)).toBe(false);
      // Control: ordinary git with that HOME does write the trace.
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.repo, stdio: "ignore", env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
      expect(existsSync(target)).toBe(true);
    } finally { process.env.HOME = saved; }
  });

  it("matches git status on tracked, staged, untracked, mode, symlink, intent-to-add, skip-worktree, symlinked-parent and unmerged states", async () => {
    const r = smallRepository();
    const tree = join(r.workspace, "trees/states");
    git(r.repo, "worktree", "add", "-b", "states", tree);
    for (const name of ["same.txt", "edited.txt", "touched.txt", "mode.txt", "gone.txt", "skip.txt", "itl-base.txt"]) writeFileSync(join(tree, name), name + "\n");
    mkdirSync(join(tree, "sub")); writeFileSync(join(tree, "sub/x.txt"), "x\n");
    symlinkSync("same.txt", join(tree, "link"));
    git(tree, "add", "."); git(tree, "commit", "-m", "states");
    const audit = async () => (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("s", { repo: "repo" })).details.worktrees.find((w: any) => w.worktree === tree).dirty;
    const statusCount = () => { const out = execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { cwd: tree, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" } }).split("\0").filter(Boolean);
      return { tracked: out.filter(e => !e.startsWith("?? ")).length, untracked: out.filter(e => e.startsWith("?? ")).length }; };
    const expected = () => { const c = statusCount(); return c.tracked ? "wip:" + c.tracked : c.untracked ? "scratch:" + c.untracked : "clean"; };
    expect(await audit()).toBe("clean");
    // Same size, same content, new timestamps: not a change.
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(tree, "touched.txt"), past, past);
    expect(await audit()).toBe("clean");
    const steps: [string, () => void][] = [
      ["same-size edit", () => { writeFileSync(join(tree, "edited.txt"), "EDITED.TXT\n"); }],
      ["mode change", () => { execFileSync("chmod", ["+x", join(tree, "mode.txt")]); }],
      ["deletion", () => { rmSync(join(tree, "gone.txt")); }],
      ["symlink retarget", () => { rmSync(join(tree, "link")); symlinkSync("edited.txt", join(tree, "link")); }],
      ["staged only", () => { writeFileSync(join(tree, "staged.txt"), "s\n"); git(tree, "add", "staged.txt"); }],
      ["intent to add", () => { writeFileSync(join(tree, "itl.txt"), "i\n"); git(tree, "add", "-N", "itl.txt"); }],
      ["skip-worktree edit is hidden", () => { git(tree, "update-index", "--skip-worktree", "skip.txt"); writeFileSync(join(tree, "skip.txt"), "hidden\n"); }],
      ["untracked file", () => { writeFileSync(join(tree, "new.txt"), "n\n"); }],
      // git never follows a symlinked parent: the tracked file counts as deleted even though identical bytes are reachable.
      ["parent directory replaced by a symlink", () => { const elsewhere = temporary("audit-elsewhere-"); writeFileSync(join(elsewhere, "x.txt"), "x\n");
        rmSync(join(tree, "sub"), { recursive: true }); symlinkSync(elsewhere, join(tree, "sub")); }],
    ];
    for (const [name, step] of steps) { step(); expect(await audit(), name).toBe(expected()); }
    expect(await audit()).toMatch(/^wip:\d+$/);
    // Unmerged paths after a conflicting merge.
    const conflict = join(r.workspace, "trees/conflict");
    git(r.repo, "worktree", "add", "-b", "c1", conflict, "states");
    writeFileSync(join(conflict, "same.txt"), "one\n"); git(conflict, "commit", "-qam", "one");
    git(conflict, "checkout", "-q", "-b", "c2", "states");
    writeFileSync(join(conflict, "same.txt"), "two\n"); git(conflict, "commit", "-qam", "two");
    try { git(conflict, "merge", "c1"); } catch { /* the conflict is the fixture */ }
    const conflicted = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("c", { repo: "repo" })).details.worktrees.find((w: any) => w.worktree === conflict);
    expect(conflicted, JSON.stringify(conflicted)).toMatchObject({ dirty: "wip:1", bucket: "hold-wip" });
    // Untracked only.
    const only = join(r.workspace, "trees/untracked-only");
    git(r.repo, "worktree", "add", "-b", "untracked-only", only);
    mkdirSync(join(only, "dir")); writeFileSync(join(only, "dir/a"), "a"); writeFileSync(join(only, "b"), "b");
    const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("u", { repo: "repo" })).details;
    expect(d.worktrees.find((w: any) => w.worktree === only)).toMatchObject({ dirty: "scratch:2", bucket: "review" });
  });

  it("matches git status inside a populated submodule: modified, untracked, staged, new commit, nested and unpopulated", async () => {
    const r = smallRepository();
    const library = (name: string, ...files: string[]) => {
      const dir = join(r.workspace, name); mkdirSync(dir); git(dir, "init", "-q", "-b", "main");
      for (const file of files) writeFileSync(join(dir, file), file + "\n");
      git(dir, "add", "."); git(dir, "commit", "-qm", name); return dir;
    };
    const inner = library("inner", "i.txt"), lib = library("lib", "l.txt", "m.txt");
    git(lib, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "deep"); git(lib, "commit", "-qm", "nested");
    const tree = join(r.workspace, "trees/super");
    git(r.repo, "worktree", "add", "-q", "-b", "super", tree);
    git(tree, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "sub");
    git(tree, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init", "--recursive");
    git(tree, "commit", "-qm", "with submodule");
    const sub = join(tree, "sub"), deep = join(sub, "deep");
    const audit = async () => (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("s", { repo: "repo" })).details.worktrees.find((w: any) => w.worktree === tree);
    const status = () => execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { cwd: tree, encoding: "utf8",
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" } }).split("\0").filter(Boolean);
    const expected = () => { const out = status(); const tracked = out.filter(e => !e.startsWith("?? ")).length;
      return tracked ? "wip:" + tracked : out.length ? "scratch:" + out.length : "clean"; };
    expect(status()).toEqual([]);
    expect(await audit()).toMatchObject({ dirty: "clean", bucket: "review" });
    const reset = () => { git(sub, "reset", "-q", "--hard"); git(sub, "clean", "-qfd"); git(deep, "reset", "-q", "--hard"); git(deep, "clean", "-qfd"); };
    const steps: [string, () => void][] = [
      ["same-size tracked edit inside the submodule", () => { writeFileSync(join(sub, "l.txt"), "L.TXT\n"); }],
      ["untracked file inside the submodule", () => { writeFileSync(join(sub, "new.txt"), "n\n"); }],
      ["staged change inside the submodule", () => { writeFileSync(join(sub, "staged.txt"), "s\n"); git(sub, "add", "staged.txt"); }],
      ["tracked edit inside a nested submodule", () => { writeFileSync(join(deep, "i.txt"), "I.TXT\n"); }],
      ["untracked file inside a nested submodule", () => { writeFileSync(join(deep, "x.txt"), "x\n"); }],
    ];
    for (const [name, step] of steps) {
      step();
      expect(status(), name).toEqual([" M sub"]);
      expect(await audit(), name).toMatchObject({ dirty: "wip:1", bucket: "hold-wip" });
      reset();
      expect(await audit(), name + " undone").toMatchObject({ dirty: "clean" });
    }
    // A new commit inside the submodule moves its HEAD away from the recorded gitlink.
    writeFileSync(join(sub, "m.txt"), "changed\n"); git(sub, "commit", "-qam", "moved");
    expect(await audit()).toMatchObject({ dirty: expected(), bucket: "hold-wip" });
    expect(expected()).toBe("wip:1");
    git(sub, "reset", "-q", "--hard", "HEAD~1");
    expect(await audit()).toMatchObject({ dirty: "clean" });
    // An empty commit changes no content, but the submodule HEAD no longer equals the recorded commit.
    git(sub, "commit", "-q", "--allow-empty", "-m", "empty");
    expect(status()).toEqual([" M sub"]);
    expect(await audit()).toMatchObject({ dirty: "wip:1", bucket: "hold-wip" });
    git(sub, "reset", "-q", "--hard", "HEAD~1");
    expect(await audit()).toMatchObject({ dirty: "clean" });
    // Unpopulated: git status reports nothing, and neither does the audit.
    git(tree, "submodule", "deinit", "-q", "-f", "--all");
    expect(status()).toEqual([]);
    expect(await audit()).toMatchObject({ dirty: "clean" });
  }, 60_000);

  it("reports a populated submodule nested deeper than the bound as unknown, with a warning, never clean", async () => {
    const r = smallRepository();
    // A chain one level deeper than MAX_SUBMODULE_DEPTH: worktree -> s1 -> s2 -> s3 -> s4.
    let child = "";
    for (let level = MAX_SUBMODULE_DEPTH + 1; level >= 1; level--) {
      const dir = join(r.workspace, "s" + level); mkdirSync(dir); git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "f.txt"), "f\n"); git(dir, "add", "f.txt");
      if (child) git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "s" + (level + 1));
      git(dir, "commit", "-qm", "level " + level); child = dir;
    }
    const tree = join(r.workspace, "trees/chain");
    git(r.repo, "worktree", "add", "-q", "-b", "chain", tree);
    git(tree, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "s1");
    git(tree, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init", "--recursive");
    git(tree, "commit", "-qm", "chain");
    const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("d", { repo: "repo" })).details;
    expect(d.worktrees.find((w: any) => w.worktree === tree)).toMatchObject({ dirty: "unknown", bucket: "hold-wip" });
    expect(d.warnings).toContain("Submodule " + join(tree, "s1/s2/s3/s4") + " is nested deeper than " + MAX_SUBMODULE_DEPTH
      + " levels; its content was not compared, so dirty is unknown and the worktree is held.");
    // Only the deep worktree is affected; a sibling without submodules stays clean.
    const plain = join(r.workspace, "trees/plain");
    git(r.repo, "worktree", "add", "-q", "-b", "plain", plain);
    const again = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("d", { repo: "repo" })).details;
    expect(again.worktrees.find((w: any) => w.worktree === plain)).toMatchObject({ dirty: "clean" });
  }, 60_000);

  it("warns, naming the cap, when a listing exceeds the output limit, instead of a silent unknown", async () => {
    const r = smallRepository();
    const tree = join(r.workspace, "trees/large");
    git(r.repo, "worktree", "add", "-q", "-b", "large", tree);
    const saved = LISTING_LIMIT.bytes;
    LISTING_LIMIT.bytes = 64;
    try {
      const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("l", { repo: "repo" })).details;
      expect(d.worktrees.find((w: any) => w.worktree === tree)).toMatchObject({ dirty: "unknown", bucket: "hold-wip" });
      expect(d.warnings).toContain("The index listing of " + tree + " exceeds the 64 byte listing cap; dirty is unknown and the worktree is held.");
    } finally { LISTING_LIMIT.bytes = saved; }
    expect(saved).toBe(256 * 1024 * 1024);
    const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("l", { repo: "repo" })).details;
    expect(d.worktrees.find((w: any) => w.worktree === tree)).toMatchObject({ dirty: "clean" });
    expect(d.warnings).toEqual([expect.stringContaining("merged is unknown")]);
    // A listing cut off by the time budget is labelled a timeout, not an over-cap listing.
    expect(await dirtyState(tree, git(tree, "rev-parse", "HEAD"), { at: Date.now() - 1 }))
      .toEqual({ state: "unknown", warning: "The index listing of " + tree + " timed out; dirty is unknown and the worktree is held." });
    expect(await dirtyState(tree, git(tree, "rev-parse", "HEAD"), { at: Date.now() + 60_000 })).toEqual({ state: "clean" });
  });

  it("labels a timeout whichever budget check the deadline expires at, never a silent unknown or clean", async () => {
    // The deadline expires after exactly `limit` budget reads, independent of host speed or git start-up time.
    const counted = (limit: number) => { let reads = 0;
      return { reads: () => reads, deadline: { get at() { return reads++ < limit ? Number.MAX_SAFE_INTEGER : 0; } } }; };
    const r = smallRepository();
    const lib = join(r.workspace, "lib"); mkdirSync(lib); git(lib, "init", "-q", "-b", "main");
    writeFileSync(join(lib, "l.txt"), "l\n"); git(lib, "add", "."); git(lib, "commit", "-qm", "lib");
    const tree = join(r.workspace, "trees/timed");
    git(r.repo, "worktree", "add", "-q", "-b", "timed", tree);
    git(tree, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "sub");
    git(tree, "commit", "-qm", "with submodule");
    const sub = join(tree, "sub"), head = git(tree, "rev-parse", "HEAD");
    // Old timestamps on unchanged files make every tracked file a hashing candidate, deterministically.
    for (const file of [join(tree, "a.txt"), join(tree, ".gitmodules"), join(sub, "l.txt")]) utimesSync(file, 1e9, 1e9);
    const full = counted(Infinity);
    expect(await dirtyState(tree, head, full.deadline)).toEqual({ state: "clean" });
    const steps: string[] = [];
    for (let limit = 0; limit < full.reads(); limit++) {
      const result = await dirtyState(tree, head, counted(limit).deadline);
      const m = /^The (.+) of (.+) timed out; dirty is unknown and the worktree is held\.$/.exec(result.warning ?? "");
      expect(result.state, "budget spent after " + limit + " reads").toBe("unknown");
      expect(m, "budget spent after " + limit + " reads: " + result.warning).not.toBeNull();
      steps.push(m![1] + " of " + (m![2] === tree ? "tree" : m![2] === sub ? "sub" : m![2]));
    }
    // The step each budget read belongs to, in order, so a swapped or misplaced label fails. Entries are
    // .gitmodules, a.txt and sub; each small file is hashed in one chunk plus the end-of-file read.
    const listings = (of: string) => ["index listing", "index path lookup", "staged listing", "core.fileMode read"].map(step => step + " of " + of);
    const hashed = (of: string) => ["file comparison", "file hashing", "file hashing"].map(step => step + " of " + of);
    expect(steps).toEqual([...listings("tree"), ...hashed("tree"), ...hashed("tree"), "file comparison of tree", "submodule HEAD lookup of sub",
      ...listings("sub"), ...hashed("sub"), "untracked listing of sub", "untracked listing of tree"]);
  });

  it("treats a result seen after its time limit as a timeout, even when the process exited in time", async () => {
    // A blocked event loop delivers an exit late. A faked clock stands in for that block, with no sleep or race.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const late = run("/bin/echo", ["late"], tmpdir(), 1_000);
      vi.setSystemTime(Date.now() + 2_000);
      expect(await late).toEqual({ ok: false, code: "ETIMEDOUT", stdout: "" });
      expect(await run("/bin/echo", ["on time"], tmpdir(), 1_000)).toEqual({ ok: true, code: 0, stdout: "on time\n" });
    } finally { vi.useRealTimers(); }
    // A limit timer that fires before the result is handled is a timeout, whatever the process does afterwards.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fired = run("/bin/sleep", ["5"], tmpdir(), 1_000);
      vi.advanceTimersByTime(1_000);
      expect(await fired).toEqual({ ok: false, code: "ETIMEDOUT", stdout: "" });
      // A run given no time left never starts its process; with the limit timer held, a started one would finish.
      const marker = join(temporary("audit-no-time-"), "started");
      expect(await run("/usr/bin/touch", [marker], tmpdir(), 0)).toEqual({ ok: false, code: "ETIMEDOUT", stdout: "" });
      expect(existsSync(marker)).toBe(false);
      // A run that finishes, or fails, before its limit leaves no limit timer behind.
      expect(await run("/bin/echo", ["on time"], tmpdir(), 1_000)).toEqual({ ok: true, code: 0, stdout: "on time\n" });
      expect(vi.getTimerCount(), "timers left after a finished run").toBe(0);
      expect(await run("/usr/bin/false", [], tmpdir(), 1_000)).toEqual({ ok: false, code: 1, stdout: "" });
      expect(vi.getTimerCount(), "timers left after a failed run").toBe(0);
    } finally { vi.useRealTimers(); }
  });

  // Bounded: a regression waits on the descendant's 30 s sleep, so the race below gives up after 5 s instead of hanging.
  it("returns at its limit when a descendant keeps the output pipe open after the kill", async () => {
    const pidFile = join(temporary("audit-held-pipe-"), "pid");
    let descendant = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // The shell is the direct child and is killed at the limit; the background sleep inherits stdout and keeps it open.
      const result = run("/bin/sh", ["-c", '/bin/sleep 30 & echo $! > "$1.tmp" && mv "$1.tmp" "$1"; wait', "sh", pidFile], tmpdir(), 1_000);
      const tick = () => new Promise(next => setImmediate(next));
      for (const until = Date.now() + 5_000; !existsSync(pidFile);) { if (Date.now() > until) throw Error("descendant did not start"); await tick(); }
      descendant = Number(readFileSync(pidFile, "utf8"));
      expect(process.kill(descendant, 0)).toBe(true);
      vi.advanceTimersByTime(1_000);
      let settled = false;
      const outcome = await Promise.race([result.finally(() => { settled = true; }), (async () => {
        for (const until = Date.now() + 5_000; !settled && Date.now() < until;) await tick();
        return "still waiting on the held pipe";
      })()]);
      expect(outcome).toEqual({ ok: false, code: "ETIMEDOUT", stdout: "" });
      expect(vi.getTimerCount(), "timers left after a killed run").toBe(0);
    } finally {
      vi.useRealTimers();
      if (descendant) try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("holds a worktree whose listing result arrives after its limit, never reading it clean", async () => {
    const r = smallRepository();
    const tree = join(r.workspace, "trees/late");
    git(r.repo, "worktree", "add", "-q", "-b", "late", tree);
    writeFileSync(join(tree, "new-work.ts"), "w\n");
    const head = git(tree, "rev-parse", "HEAD");
    expect(await dirtyState(tree, head, { at: Number.MAX_SAFE_INTEGER })).toEqual({ state: "scratch:1" });
    // Each budget read k is followed by a clock jump past every per-call limit, landing between that call's
    // start and its result, as an event loop blocked across git's exit would.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const steps: string[] = [];
      for (let k = 0; ; k++) {
        let reads = 0;
        const deadline = { get at() { if (reads++ === k) queueMicrotask(() => vi.setSystemTime(Date.now() + 60_000)); return Number.MAX_SAFE_INTEGER; } };
        const result = await dirtyState(tree, head, deadline);
        if (k >= reads) { expect(result).toEqual({ state: "scratch:1" }); break; }
        expect(result.state, "late result after read " + k).not.toBe("clean");
        if (result.state === "unknown") steps.push(/^The (.+) of /.exec(result.warning ?? "")?.[1] ?? "silent");
        else expect(result).toEqual({ state: "scratch:1" });
      }
      expect(steps).toEqual(["index listing", "index path lookup", "staged listing", "core.fileMode read", "untracked listing"]);
    } finally { vi.useRealTimers(); }
  });

  it("holds a worktree whose HEAD, branch or upstream lookup times out, never reading it clean or mislabelling its remote", async () => {
    // Every file staged for deletion leaves an empty index: read as an unborn HEAD, that is clean (P3-12).
    const r = smallRepository();
    const tree = join(r.workspace, "trees/gone");
    git(r.repo, "worktree", "add", "-q", "-b", "gone", tree);
    // One commit ahead of its origin ref, so the ahead/behind count runs too.
    git(r.repo, "update-ref", "refs/remotes/origin/gone", "gone");
    writeFileSync(join(tree, "b.txt"), "b\n"); git(tree, "add", "b.txt"); git(tree, "commit", "-qm", "ahead");
    git(tree, "rm", "-q", "-r", ".");
    expect(git(tree, "status", "--porcelain")).toBe("D  a.txt\nD  b.txt");
    const head = git(tree, "rev-parse", "HEAD"), base = git(r.repo, "rev-parse", "main");
    const entry = { path: tree, head, branch: "gone", detached: false, bare: false, prunable: false, locked: false };
    const audit = async (deadline: { at: number }) =>
      auditWorktree(entry, base, Math.floor(Date.now() / 1000), { deadline: Number.MAX_SAFE_INTEGER, exhausted: false }, deadline);
    const full = await audit({ at: Number.MAX_SAFE_INTEGER });
    expect(full).toMatchObject({ warnings: [], row: { dirty: "wip:2", bucket: "hold-wip", merged: "no", branch: "gone", remote: "ahead1/behind0", ageDays: 0 } });
    // Each budget read k is followed by a clock jump past every per-call limit, landing between that call's start and its result.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const outcomes: string[] = [];
      for (let k = 0; ; k++) {
        let reads = 0;
        const deadline = { get at() { if (reads++ === k) queueMicrotask(() => vi.setSystemTime(Date.now() + 60_000)); return Number.MAX_SAFE_INTEGER; } };
        const { row, warnings } = await audit(deadline);
        if (k >= reads) { expect(row).toEqual(full.row); break; }
        expect(row.dirty, "late result after read " + k).not.toBe("clean");
        expect(row.bucket, "late result after read " + k).toBe("hold-wip");
        expect(["ahead1/behind0", "unknown"], "late result after read " + k).toContain(row.remote);
        expect(row.branch).toBe("gone");
        const changed = (["dirty", "merged", "remote", "ageDays"] as const).filter(key => row[key] !== full.row[key]);
        outcomes.push(changed.map(key => key + "=" + row[key]).join(",") + " " + warnings.map(w => /^The (.+) of /.exec(w)?.[1]).join("|"));
      }
      expect(outcomes).toEqual([
        "dirty=unknown HEAD lookup", "ageDays=null ", "merged=unknown ",
        "dirty=unknown index listing", "dirty=unknown index path lookup", "dirty=unknown staged listing",
        "dirty=unknown core.fileMode read", "dirty=unknown untracked listing",
        "remote=unknown branch lookup", "remote=unknown upstream lookup", "remote=unknown ahead/behind count",
      ]);
    } finally { vi.useRealTimers(); }
  });

  /** Puts an executable `name` that runs `body` (sh) first on PATH for the audit's own commands. */
  function shim(name: string, body: string) {
    const dir = temporary("audit-shim-");
    writeFileSync(join(dir, name), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
    vi.stubEnv("PATH", dir + ":" + process.env.PATH);
  }
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const listed = (path: string, branch: string) => ({ path, head: undefined, branch, detached: false, bare: false, prunable: false, locked: false });
  const unbounded = () => [{ deadline: Number.MAX_SAFE_INTEGER, exhausted: false }, { at: Number.MAX_SAFE_INTEGER }] as const;

  it("holds a worktree whose HEAD lookup fails other than as an unborn HEAD, never reading it clean (P3-14)", async () => {
    const r = smallRepository();
    const tree = join(r.workspace, "trees/broken");
    git(r.repo, "worktree", "add", "-q", "-b", "broken", tree);
    git(tree, "rm", "-q", "-r", ".");
    const audit = () => auditWorktree(listed(tree, "broken"), undefined, Math.floor(Date.now() / 1000), ...unbounded());
    expect((await audit()).row).toMatchObject({ dirty: "wip:1", bucket: "hold-wip" });
    try {
      for (const [how, failure] of [["exits 128", "exit 128"], ["is killed", "kill -9 $$"]]) {
        shim("git", 'case "$*" in *" rev-parse --verify --quiet HEAD") ' + failure + ';; esac\nexec "' + realGit + '" "$@"');
        const { row, warnings } = await audit();
        expect(row, how).toMatchObject({ dirty: "unknown", bucket: "hold-wip", branch: "broken" });
        expect(warnings, how).toEqual(["The HEAD lookup of " + tree + " failed; dirty is unknown and the worktree is held."]);
        vi.unstubAllEnvs();
      }
    } finally { vi.unstubAllEnvs(); }
    // Exit 1 is an unborn HEAD, whose index is still compared: a staged file in an orphan worktree is a tracked change.
    const orphan = join(r.workspace, "trees/orphan");
    git(r.repo, "worktree", "add", "-q", "--orphan", "-b", "orph", orphan);
    writeFileSync(join(orphan, "n.txt"), "n\n"); git(orphan, "add", "n.txt");
    const unborn = await auditWorktree(listed(orphan, "orph"), undefined, Math.floor(Date.now() / 1000), ...unbounded());
    expect(unborn).toMatchObject({ warnings: [], row: { dirty: "wip:1", bucket: "hold-wip", branch: "orph", remote: "no-remote" } });
  });

  it("holds a worktree whose branch ref is corrupt, though its HEAD lookup exits 1 as for an unborn HEAD (N-c)", async () => {
    const r = smallRepository();
    const tree = join(r.workspace, "trees/corrupt");
    git(r.repo, "worktree", "add", "-q", "-b", "corrupt", tree);
    // Every file staged for deletion leaves an empty index, which an unborn HEAD would read as clean.
    git(tree, "rm", "-q", "-r", ".");
    const audit = () => auditWorktree(listed(tree, "corrupt"), undefined, Math.floor(Date.now() / 1000), ...unbounded());
    expect((await audit()).row).toMatchObject({ dirty: "wip:1", bucket: "hold-wip" });
    const loose = git(r.repo, "rev-parse", "--git-path", "refs/heads/corrupt");
    writeFileSync(isAbsolute(loose) ? loose : join(r.repo, loose), "garbage\n");
    expect(spawnSync(realGit, ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: tree }).status, "git cannot tell this from an unborn HEAD by exit code").toBe(1);
    const { row, warnings } = await audit();
    expect(row).toMatchObject({ dirty: "unknown", bucket: "hold-wip" });
    expect(warnings).toEqual(["The HEAD lookup of " + tree + " failed; dirty is unknown and the worktree is held."]);
    // An unborn HEAD is confirmed only by a missing branch ref (show-ref exit 2). A failed or timed-out
    // confirmation holds even a real orphan worktree, here with nothing staged, so it can never read clean.
    const orphan = join(r.workspace, "trees/orphan");
    git(r.repo, "worktree", "add", "-q", "--orphan", "-b", "orph", orphan);
    const unborn = (deadline = { at: Number.MAX_SAFE_INTEGER }) =>
      auditWorktree(listed(orphan, "orph"), undefined, Math.floor(Date.now() / 1000), { deadline: Number.MAX_SAFE_INTEGER, exhausted: false }, deadline);
    expect(await unborn()).toMatchObject({ warnings: [], row: { dirty: "clean", branch: "orph" } });
    try {
      shim("git", 'case "$*" in *" show-ref --exists refs/heads/orph") exit 1;; esac\nexec "' + realGit + '" "$@"');
      expect(await unborn()).toMatchObject({ warnings: ["The HEAD lookup of " + orphan + " failed; dirty is unknown and the worktree is held."], row: { dirty: "unknown", bucket: "hold-wip" } });
      vi.unstubAllEnvs();
      shim("git", 'case "$*" in *" show-ref --exists refs/heads/orph") exec /bin/sleep 10;; esac\nexec "' + realGit + '" "$@"');
      const timed = await unborn({ at: Date.now() + 3_000 });
      expect(timed.row).toMatchObject({ dirty: "unknown", bucket: "hold-wip" });
      expect(timed.warnings).toContain("The unborn HEAD check of " + orphan + " timed out; dirty is unknown and the worktree is held.");
    } finally { vi.unstubAllEnvs(); }
  });

  it("warns per worktree when its size measurement fails or times out (P3-15)", async () => {
    const r = smallRepository();
    const tree = join(r.workspace, "trees/sized");
    git(r.repo, "worktree", "add", "-q", "-b", "sized", tree);
    const audit = (budget: { deadline: number; exhausted: boolean }) =>
      auditWorktree(listed(tree, "sized"), undefined, Math.floor(Date.now() / 1000), budget, { at: Number.MAX_SAFE_INTEGER });
    const measured = await audit({ deadline: Number.MAX_SAFE_INTEGER, exhausted: false });
    expect(measured.warnings).toEqual([]);
    expect(measured.row.sizeKiB).toEqual(expect.any(Number));
    try {
      shim("du", "exit 1");
      expect(await audit({ deadline: Number.MAX_SAFE_INTEGER, exhausted: false }))
        .toMatchObject({ warnings: ["The size measurement of " + tree + " failed; sizeKiB is null."], row: { sizeKiB: null } });
      vi.unstubAllEnvs();
      shim("du", "exec /bin/sleep 5");
      const budget = { deadline: Date.now() + 200, exhausted: false };
      expect(await audit(budget)).toMatchObject({ warnings: ["The size measurement of " + tree + " timed out; sizeKiB is null."], row: { sizeKiB: null } });
      expect(budget.exhausted, "a timed-out du is reported for its row, not as the spent total budget").toBe(false);
      // Through the tool, the row's warning reaches the result.
      vi.unstubAllEnvs();
      shim("du", "exit 1");
      const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("x", { repo: "repo" })).details;
      expect(d.warnings).toContain("The size measurement of " + tree + " failed; sizeKiB is null.");
    } finally { vi.unstubAllEnvs(); }
    // A spent total budget stays one result-level warning, with no per-row warning.
    expect(await audit({ deadline: Date.now() - 1, exhausted: false })).toMatchObject({ warnings: [], row: { sizeKiB: null } });
  });

  it("reads the branch as its full ref, so a tag of the same name cannot change its remote (P3-16)", async () => {
    const r = smallRepository();
    const tree = join(r.workspace, "trees/amb");
    git(r.repo, "worktree", "add", "-q", "-b", "amb", tree);
    git(r.repo, "tag", "amb", "refs/heads/amb");
    git(r.repo, "update-ref", "refs/remotes/origin/amb", "refs/heads/amb");
    const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("x", { repo: "repo", base: "main" })).details;
    expect(d.worktrees.find((w: any) => w.worktree === tree)).toMatchObject({ branch: "amb", remote: "pushed" });
  });

  // Bounded: a regression waits on the 30 s sleep, so the race below gives up after 5 s instead of hanging.
  it("sends SIGKILL to a timed-out child that ignores SIGTERM, after a short grace (N-a)", async () => {
    const marker = join(temporary("audit-term-"), "pid");
    let pid = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // The direct child ignores SIGTERM; the ignored disposition survives the exec into sleep.
      const result = run("/bin/sh", ["-c", 'trap "" TERM; echo $$ > "$1.tmp" && mv "$1.tmp" "$1"; exec /bin/sleep 30', "sh", marker], tmpdir(), 1_000);
      const tick = () => new Promise(next => setImmediate(next));
      for (const until = Date.now() + 5_000; !existsSync(marker);) { if (Date.now() > until) throw Error("child did not start"); await tick(); }
      pid = Number(readFileSync(marker, "utf8"));
      vi.advanceTimersByTime(1_000);
      for (let i = 0; i < 50; i++) await tick();
      expect(() => process.kill(pid, 0), "the SIGTERM was ignored").not.toThrow();
      let settled = false;
      result.finally(() => { settled = true; });
      for (let i = 0; i < 50 && !settled; i++) await tick();
      expect(settled, "still waiting during the grace").toBe(false);
      vi.advanceTimersByTime(KILL_GRACE_MS ?? 500);
      const outcome = await Promise.race([result, (async () => {
        for (const until = Date.now() + 5_000; !settled && Date.now() < until;) await tick();
        return "still waiting on a child that ignores SIGTERM";
      })()]);
      expect(outcome).toEqual({ ok: false, code: "ETIMEDOUT", stdout: "" });
      expect(() => process.kill(pid, 0), "the child is gone").toThrow();
      expect(vi.getTimerCount(), "no grace timer is left").toBe(0);
    } finally {
      vi.useRealTimers();
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  // Root can read a mode-000 file, so the read error cannot be produced there.
  it.skipIf(process.getuid?.() === 0)("reports a file that cannot be read as a plain unknown, not as a timeout", async () => {
    const r = smallRepository();
    const tree = join(r.workspace, "trees/unreadable");
    git(r.repo, "worktree", "add", "-q", "-b", "unreadable", tree);
    const file = join(tree, "a.txt");
    utimesSync(file, 1e9, 1e9); chmodSync(file, 0o000);
    try {
      expect(await dirtyState(tree, git(tree, "rev-parse", "HEAD"), { at: Number.MAX_SAFE_INTEGER })).toEqual({ state: "unknown", warning: undefined });
    } finally { chmodSync(file, 0o644); }
  });

  it("labels a process killed by its time limit as a timeout", async () => {
    // A process that outlives its limit is killed: a slow listing, without racing git's start-up time.
    const started = Date.now();
    expect(await run("/bin/sleep", ["5"], tmpdir(), 50)).toEqual({ ok: false, code: "ETIMEDOUT", stdout: "" });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(await run("/bin/sleep", ["0"], tmpdir(), 0)).toEqual({ ok: false, code: "ETIMEDOUT", stdout: "" });
    expect(await run("/bin/sleep", ["0"], tmpdir(), 5_000)).toEqual({ ok: true, code: 0, stdout: "" });
  });

  it("uses an explicit base, reports unknown merge state without one, and rejects a missing base", async () => {
    const r = repository();
    const audit = tool("pstack_worktree_audit", { workspaceDir: r.workspace });
    const pinned = (await audit.execute("base", { repo: "repo", base: "scratch" })).details;
    expect(pinned).toMatchObject({ base: "scratch", warnings: [] });
    expect(pinned.worktrees.find((w: any) => w.worktree === r.scratchTree).merged).toBe("YES");
    await expect(audit.execute("missing", { repo: "repo", base: "origin/nope" })).rejects.toThrow("base ref not found locally");
    git(r.repo, "remote", "remove", "origin");
    const none = (await audit.execute("none", { repo: "repo" })).details;
    expect(none.base).toBeNull();
    expect(none.warnings.join(" ")).toContain("merged is unknown");
    for (const w of none.worktrees) { expect(w.merged).toBe("unknown"); expect(w.bucket).not.toBe("verify-activity"); }
  });

  it("refuses repositories outside the workspace and unsafe sessions", async () => {
    const r = repository();
    const outside = temporary("audit-outside-");
    symlinkSync(r.repo, join(outside, "linked"));
    const audit = (context: any) => tool("pstack_worktree_audit", context);
    const ws = temporary("audit-empty-ws-");
    symlinkSync(join(outside, "linked"), join(ws, "escape"));
    await expect(audit({ workspaceDir: ws }).execute("x", { repo: "escape" })).rejects.toThrow("outside the requester workspace");
    await expect(audit({ workspaceDir: ws }).execute("x", {})).rejects.toThrow("not a git repository");
    await expect(audit({ workspaceDir: r.workspace, sandboxed: true }).execute("x", { repo: "repo" })).rejects.toThrow("sandboxed");
    await expect(audit({ workspaceDir: r.workspace, fsPolicy: { workspaceOnly: true } }).execute("x", { repo: "repo" })).rejects.toThrow("workspaceOnly");
    await expect(audit({}).execute("x", {})).rejects.toThrow("workspace is unavailable");
  });

  for (const args of [null, { repo: "/etc" }, { repo: "../x" }, { repo: "a/../../x" }, { base: "--output=/tmp/x" },
    { base: "main;rm" }, { repo: 1 }, { prune: true }, { repo: "   " }])
    it("refuses malformed audit arguments: " + JSON.stringify(args), async () => {
      const audit = tool("pstack_worktree_audit", { workspaceDir: temporary("audit-invalid-") });
      expect(() => audit.prepareArguments(args)).toThrow("Invalid pstack_worktree_audit");
      await expect(audit.execute("bad", args)).rejects.toThrow("Invalid pstack_worktree_audit");
    });

  it("reports null sizes with a warning once the total size budget is spent, without failing", async () => {
    const r = repository();
    const real = Date.now.bind(Date);
    let offset = 0, calls = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    try {
      // Guard call 3 precedes the second worktree; jump past the 120 s size budget there, inside the 300 s audit budget.
      const guard = () => { if (++calls === 3) offset = 180_000; };
      const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace, assertInvocationCurrent: guard }).execute("x", { repo: "repo" })).details;
      expect(d).toMatchObject({ status: "AUDITED", audited: 7, complete: true });
      expect(d.warnings.join(" ")).toContain("Size budget of 120s exhausted");
      const measured = d.worktrees.filter((w: any) => w.sizeKiB !== null);
      expect(measured).toHaveLength(1);
      expect(d.worktrees.filter((w: any) => w.sizeKiB === null && w.dirty !== "missing")).toHaveLength(5);
      for (const w of d.worktrees) expect(w.merged).not.toBeUndefined();
    } finally { clock.mockRestore(); }
  });

  it("returns a partial audit once the total time budget is spent, listing the rest as unaudited", async () => {
    const r = repository();
    const real = Date.now.bind(Date);
    let offset = 0, calls = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    try {
      const guard = () => { if (++calls === 3) offset = 301_000; };
      const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace, assertInvocationCurrent: guard }).execute("x", { repo: "repo" })).details;
      expect(d).toMatchObject({ status: "AUDITED", audited: 1, listed: 7, complete: false });
      expect(d.unaudited).toHaveLength(6);
      expect(new Set([d.worktrees[0].worktree, ...d.unaudited]).size).toBe(7);
      expect(d.warnings.join(" ")).toContain("Audit time budget of 300s exhausted after 1 worktrees");
    } finally { clock.mockRestore(); }
  });

  it("reports the HEAD and branch lookups of a worktree audited as the budget runs out as held, each with its warning", async () => {
    const r = smallRepository();
    const tree = join(r.workspace, "trees/spent");
    git(r.repo, "worktree", "add", "-q", "-b", "spent", tree);
    git(tree, "rm", "-q", "-r", ".");
    const real = Date.now.bind(Date);
    let guards = 0, reads = 0;
    // The budget runs out just after the check before this worktree, so its HEAD lookup is the first call without time.
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + (guards >= 2 && ++reads >= 2 ? 301_000 : 0));
    try {
      const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace, assertInvocationCurrent: () => { guards++; } }).execute("x", { repo: "repo" })).details;
      expect(d.worktrees).toEqual([expect.objectContaining({ worktree: tree, dirty: "unknown", bucket: "hold-wip", remote: "unknown", branch: "spent" })]);
      expect(d.warnings).toEqual(expect.arrayContaining([
        "The HEAD lookup of " + tree + " timed out; dirty is unknown and the worktree is held.",
        "The branch lookup of " + tree + " timed out; remote is unknown.",
      ]));
    } finally { clock.mockRestore(); }
  });

  it("stops between worktrees when the invocation is revoked", async () => {
    const r = repository();
    const guard = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => {}).mockImplementation(() => { throw Error("revoked"); });
    await expect(tool("pstack_worktree_audit", { workspaceDir: r.workspace, assertInvocationCurrent: guard }).execute("x", { repo: "repo" })).rejects.toThrow("revoked");
    expect(guard).toHaveBeenCalledTimes(3);
  });

  it("trusts index stat data only when it matches and the entry is not racily clean", () => {
    const entry = { mode: "100644", oid: "a".repeat(40), stage: 0, path: "f", ctime: [100, 5] as [number, number], mtime: [100, 5] as [number, number], ino: 7, size: 3, flags: 0 };
    const file = { size: 3, mtime: [100, 5] as [number, number], ctime: [100, 5] as [number, number], ino: 7 };
    expect(statUnchanged(entry, file, [101, 0])).toBe(true);
    // Racily clean: the index was written in the same tick as (or before) the entry's mtime.
    expect(statUnchanged(entry, file, [100, 5])).toBe(false);
    expect(statUnchanged(entry, file, [99, 0])).toBe(false);
    for (const changed of [{ size: 4 }, { mtime: [100, 6] }, { ctime: [101, 5] }, { ino: 8 }])
      expect(statUnchanged(entry, { ...file, ...changed } as any, [101, 0]), JSON.stringify(changed)).toBe(false);
    // An index without sub-second times matches on seconds only.
    expect(statUnchanged({ ...entry, mtime: [100, 0], ctime: [100, 0] }, file, [101, 0])).toBe(true);
    // Such an entry is racy whenever the index was written in the same second: git compares seconds alone there,
    // so an index time of [100, 9] does not make an entry stamped [100, 0] older than the index.
    expect(statUnchanged({ ...entry, mtime: [100, 0], ctime: [100, 0] }, file, [100, 9])).toBe(false);
    expect(statUnchanged({ ...entry, mtime: [100, 0], ctime: [100, 0] }, file, [100, 0])).toBe(false);
    expect(statUnchanged({ ...entry, mtime: [100, 0], ctime: [100, 0] }, file, [99, 999])).toBe(false);
  });

  it("reports dirty state unknown, and holds the worktree, when its index cannot be read", async () => {
    const r = smallRepository();
    const tree = join(r.workspace, "trees/corrupt");
    git(r.repo, "worktree", "add", "-q", "-b", "corrupt", tree);
    writeFileSync(join(r.repo, ".git/worktrees/corrupt/index"), "not an index");
    const d = (await tool("pstack_worktree_audit", { workspaceDir: r.workspace }).execute("c", { repo: "repo" })).details;
    expect(d.worktrees.find((w: any) => w.worktree === tree)).toMatchObject({ dirty: "unknown", bucket: "hold-wip" });
  });

  it("parses porcelain worktree records and exact index listings", () => {
    expect(parseWorktreeList("worktree /a b\0HEAD 1\0branch refs/heads/x\0\0worktree /c\0HEAD 2\0detached\0prunable gitdir file points to non-existent location\0\0"))
      .toEqual([{ path: "/a b", head: "1", branch: "x", detached: false, bare: false, prunable: false, locked: false },
        { path: "/c", head: "2", detached: true, bare: false, prunable: true, locked: false }]);
    const block = (path: string) => "100644 " + "a".repeat(40) + " 0\t" + path + "\0  ctime: 1:2\n  mtime: 3:4\n  dev: 5\tino: 6\n  uid: 7\tgid: 8\n  size: 9\tflags: 40000000\n";
    expect(parseIndexDebug(block("a b\nc") + block("d"))).toEqual([
      { mode: "100644", oid: "a".repeat(40), stage: 0, path: "a b\nc", ctime: [1, 2], mtime: [3, 4], ino: 6, size: 9, flags: 0x40000000 },
      { mode: "100644", oid: "a".repeat(40), stage: 0, path: "d", ctime: [1, 2], mtime: [3, 4], ino: 6, size: 9, flags: 0x40000000 }]);
    expect(parseIndexDebug("")).toEqual([]);
    expect(parseIndexDebug(block("d").slice(0, -2))).toBeUndefined();
    expect(parseIndexDebug(block("d") + "trailing")).toBeUndefined();
  });
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
  const messages = await runAgentLoop([{ role: "user", content: "Bounded adapter fixture", timestamp: Date.now() }],
    { systemPrompt: "No model or native child execution", messages: [], tools: [tool] },
    { model: { id: "fixture", name: "Fixture", api: "fixture", provider: "fixture", baseUrl: "http://localhost:0", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 } as any,
      convertToLlm: (messages: any) => messages }, () => {}, undefined, streamFn as any);
  expect(turns).toBe(2);
  const result = messages.find((message: any) => message.role === "toolResult") as any;
  expect(result?.toolCallId).toBe("ingress");
  return result;
}
const normalized = (t: any, provider: string) => normalizeOpenAIToolSchemas({ provider,
  modelId: provider === "google" ? "gemini-3.1-pro" : provider === "anthropic" ? "claude-opus-5-5" : "gpt-6.1-sol",
  modelApi: provider === "google" ? "google-generative-ai" : provider === "anthropic" ? "anthropic-messages" : "openai-responses",
  tools: [normalizeToolParameters(t, { modelProvider: provider })] })[0];
for (const provider of ["openai", "anthropic", "google"])
  it("admits adapter data and rejects coercion through actual " + provider + " native ingress", async () => {
    const workspace = temporary("ingress-" + provider + "-");
    const trail = normalized(trailTool({ workspaceDir: workspace }), provider);
    const ok = await ingress(trail, row({ log: provider }));
    expect(ok.isError, JSON.stringify(ok.content)).toBe(false);
    expect(ok.details).toMatchObject({ status: "APPENDED", log: ".audit/" + provider + ".tsv" });
    for (const bad of [row({ log: provider, result: 5 }), row({ log: provider, path: "/tmp/x" }), row({ log: "../" + provider })]) {
      const refused = await ingress(trail, bad);
      expect(refused.isError).toBe(true);
    }
    expect(lines(join(workspace, ".audit", provider + ".tsv"))).toHaveLength(2);
    const audit = normalized(tool("pstack_worktree_audit", { workspaceDir: workspace }), provider);
    const refused = await ingress(audit, { repo: "../outside" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("Invalid pstack_worktree_audit");
  });
