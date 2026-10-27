import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, realpathSync } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";

// Native replacement for upstream poteto-mode/scripts/worktree-audit.sh. The
// script stays source only. This adapter never fetches, prunes, deletes, runs
// gh/origin or reads chat transcripts; those signals are reported as unchecked.
export const MAX_AUDITED_WORKTREES = 200;
const GIT_TIMEOUT_MS = 15_000;
const SIZE_TIMEOUT_MS = 30_000;
/** How long a timed-out process may ignore SIGTERM before it is sent SIGKILL. */
export const KILL_GRACE_MS = 500;
/** Total size-measurement budget; later worktrees report sizeKiB null instead of failing the audit. */
export const SIZE_BUDGET_MS = 120_000;
/** Total wall-clock budget; worktrees not reached are listed as unaudited and complete is false. */
export const AUDIT_BUDGET_MS = 300_000;
/** Nested submodule levels compared inside one worktree; a deeper populated submodule makes the worktree unknown. */
export const MAX_SUBMODULE_DEPTH = 3;
/**
 * Output cap for the index, staged and untracked listings (about a million
 * tracked paths). Exceeding it reports dirty unknown with a warning naming the
 * cap, never a silent unknown. Mutable only so tests can lower it.
 */
export const LISTING_LIMIT = { bytes: 256 * 1024 * 1024 };
const OVER_CAP = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
const TIMED_OUT = "ETIMEDOUT";
export const worktreeAuditParameters = {
  type: "object", additionalProperties: false,
  properties: {
    repo: { type: "string", minLength: 1, maxLength: 1024, pattern: "^(?!/)(?!.*(^|/)\\.\\.(/|$)).*\\S",
      description: "Repository directory relative to the requester workspace. Defaults to the workspace itself." },
    base: { type: "string", minLength: 1, maxLength: 200, pattern: "^(?!-)[A-Za-z0-9._/@{}^~-]+$",
      description: "Existing ref for the merged check, such as origin/main. Never fetched. Defaults to origin/HEAD, origin/main, then origin/master." },
  },
};
type AuditArgs = { repo?: string; base?: string };
function assertArguments(value: unknown): asserts value is AuditArgs {
  const checked = validateJsonSchemaValue({ schema: worktreeAuditParameters, value });
  if (!checked.ok) throw Error("Invalid pstack_worktree_audit arguments: " + checked.errors.slice(0, 4).map(e => e.text).join("; "));
}
function within(root: string, path: string) {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
/**
 * Inherited GIT_* variables could redirect the repository or run commands; only the host PATH and HOME survive.
 * The GIT_TRACE2 variables override any trace2 target in the global config, so no trace file is written.
 */
function gitEnvironment() {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent", LANG: "C", LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_PROTOCOL_FROM_USER: "0",
    GIT_TRACE2: "0", GIT_TRACE2_EVENT: "0", GIT_TRACE2_PERF: "0" };
}
// Command-line config outranks every config file, whenever that file is written,
// so repository config cannot start an fsmonitor daemon, pager, signature
// verifier or any transport (including partial-clone lazy fetches) through these reads.
const READ_ONLY_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.pager=cat",
  "-c", "log.showSignature=false", "-c", "protocol.allow=never",
  // Per-protocol keys override protocol.allow, so repository config cannot re-enable one.
  ...["file", "git", "ssh", "http", "https", "ext"].flatMap(name => ["-c", "protocol." + name + ".allow=never"]), "--no-optional-locks"];
type Run = { ok: boolean; code: number | string | null; stdout: string };
/**
 * Runs one bounded read. The time limit is owned here, not by execFile: Node's
 * own timer destroys the output pipes and kills, yet reports success with the
 * truncated output when the process had already exited, as happens when the
 * event loop is blocked across the exit. So a run whose limit fired, or had
 * passed by the time its result is seen, has code ETIMEDOUT and no output,
 * whatever the process did. A run given no time left is the same. When the limit
 * fires, the output pipes are destroyed before the kill, as Node's own timer did, so a
 * descendant that keeps them open cannot hold the result past the limit. A direct child
 * that ignores the SIGTERM is sent SIGKILL after KILL_GRACE_MS. Exported for tests.
 */
export function run(file: string, args: string[], cwd: string, timeout = GIT_TIMEOUT_MS, maxBuffer = 16 * 1024 * 1024): Promise<Run> {
  if (timeout <= 0) return Promise.resolve({ ok: false, code: TIMED_OUT, stdout: "" });
  const started = Date.now();
  return new Promise(done => {
    let expired = false, escalation: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(file, args, { cwd, env: gitEnvironment(), maxBuffer, encoding: "utf8" }, (error, stdout) => {
      clearTimeout(timer); clearTimeout(escalation);
      if (expired || Date.now() - started >= timeout) return done({ ok: false, code: TIMED_OUT, stdout: "" });
      // Node reports an over-cap listing as code ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
      const failure = error as { code?: number | string } | null;
      done({ ok: !error, code: !failure ? 0 : failure.code ?? null, stdout: String(stdout ?? "") });
    });
    const timer = setTimeout(() => {
      expired = true; child.stdout?.destroy(); child.stderr?.destroy(); child.kill();
      escalation = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeout);
  });
}
/** Audit deadline in epoch milliseconds; every budget check reads `at` afresh. */
export type Deadline = { at: number };
const remaining = (deadline?: Deadline) => deadline ? Math.min(GIT_TIMEOUT_MS, deadline.at - Date.now()) : GIT_TIMEOUT_MS;
const gitWithin = (deadline: Deadline | undefined, cwd: string, ...args: string[]) => run("git", [...READ_ONLY_CONFIG, ...args], cwd, remaining(deadline));
const listingWithin = (deadline: Deadline, cwd: string, ...args: string[]) => run("git", [...READ_ONLY_CONFIG, ...args], cwd, remaining(deadline), LISTING_LIMIT.bytes);
const git = (cwd: string, ...args: string[]) => gitWithin(undefined, cwd, ...args);
export type Listed = { path: string; head?: string; branch?: string; detached: boolean; bare: boolean; prunable: boolean; locked: boolean };
export function parseWorktreeList(output: string): Listed[] {
  const listed: Listed[] = [];
  let current: Listed | undefined;
  for (const field of output.split("\0")) {
    if (field === "") { if (current) listed.push(current); current = undefined; continue; }
    const space = field.indexOf(" ");
    const key = space < 0 ? field : field.slice(0, space), value = space < 0 ? "" : field.slice(space + 1);
    if (key === "worktree") { if (current) listed.push(current); current = { path: value, detached: false, bare: false, prunable: false, locked: false }; }
    else if (!current) continue;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "prunable") current.prunable = true;
    else if (key === "locked") current.locked = true;
  }
  if (current) listed.push(current);
  return listed;
}
export type IndexEntry = { mode: string; oid: string; stage: number; path: string;
  ctime: Time; mtime: Time; ino: number; size: number; flags: number };
const ENTRY = /(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([^\0]+)\0  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: \d+\tino: (\d+)\n  uid: \d+\tgid: \d+\n  size: (\d+)\tflags: ([0-9a-f]+)\n/y;
/** Parses `git ls-files --stage --debug -z`; undefined when the output does not have that exact shape. */
export function parseIndexDebug(output: string): IndexEntry[] | undefined {
  const entries: IndexEntry[] = [];
  ENTRY.lastIndex = 0;
  while (ENTRY.lastIndex < output.length) {
    const m = ENTRY.exec(output);
    if (!m) return undefined;
    const n = (i: number) => Number(m[i]);
    entries.push({ mode: m[1]!, oid: m[2]!, stage: n(3), path: m[4]!, ctime: [n(5), n(6)], mtime: [n(7), n(8)], ino: n(9), size: n(10), flags: Number.parseInt(m[11]!, 16) });
  }
  return entries;
}
const ASSUME_VALID = 0x8000, INTENT_TO_ADD = 0x20000000, SKIP_WORKTREE = 0x40000000;
const U32 = 2n ** 32n;
type Time = [number, number];
const later = (a: Time, b: Time) => a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
const split = (ns: bigint): Time => [Number(ns / 1_000_000_000n), Number(ns % 1_000_000_000n)];
/** An index without sub-second times (nanoseconds 0) matches on seconds. */
const sameTime = (index: Time, file: Time) => index[0] === file[0] && (index[1] === 0 || index[1] === file[1]);
/**
 * Racily clean, as git decides: the entry's mtime is not earlier than the index
 * file's. An entry without sub-second time is compared on seconds alone, so an
 * edit in the same second as the index write still counts as racy.
 */
const racy = (entry: Time, index: Time) => entry[1] === 0 ? entry[0] >= index[0] : later(entry, index);
export type FileStat = { size: number; mtime: Time; ctime: Time; ino: number };
/**
 * True only when the index's stat data proves the file unchanged. A racily
 * clean entry (written no earlier than the index file itself) never qualifies,
 * as in git: a same-size edit within one timestamp tick keeps its stat data.
 */
export function statUnchanged(entry: IndexEntry, file: FileStat, indexTime: Time) {
  return entry.size === file.size && sameTime(entry.mtime, file.mtime) && sameTime(entry.ctime, file.ctime)
    && entry.ino === file.ino && !racy(entry.mtime, indexTime);
}
/** Git object id of raw bytes, never through a filter or line-ending conversion. */
const blobHash = (oid: string, size: number) => createHash(oid.length === 64 ? "sha256" : "sha1").update("blob " + size + "\0");
const blobId = (oid: string, bytes: Buffer) => blobHash(oid, bytes.length).update(bytes).digest("hex");
class BudgetSpent extends Error {}
async function rawFileId(path: string, oid: string, deadline: Deadline) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const hash = blobHash(oid, info.size);
    const buffer = Buffer.allocUnsafe(1 << 20);
    let total = 0;
    for (;;) {
      if (Date.now() >= deadline.at) throw new BudgetSpent();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); total += bytesRead;
    }
    return total === info.size ? hash.digest("hex") : undefined;
  } finally { await handle.close(); }
}
type Dirty = { state: string; warning?: string };
const unknown = (warning?: string): Dirty => ({ state: "unknown", warning });
/** Every unknown caused by the audit deadline names the step and the worktree, whichever step the budget runs out in. */
const timedOut = (wt: string, what: string) => unknown("The " + what + " of " + wt + " timed out; dirty is unknown and the worktree is held.");
const listingFailure = (wt: string, what: string, result: Run) => result.code === OVER_CAP
  ? unknown("The " + what + " of " + wt + " exceeds the " + (LISTING_LIMIT.bytes % 1048576 ? LISTING_LIMIT.bytes + " byte" : LISTING_LIMIT.bytes / 1048576 + " MiB") + " listing cap; dirty is unknown and the worktree is held.")
  : result.code === TIMED_OUT ? timedOut(wt, what) : unknown();
/**
 * Dirty state without `git status` or any read that converts file content.
 * Status re-reads a stat-changed or racily clean file through the clean filter
 * named in config and attributes, so it can start a program whenever that
 * config appears. Here git only lists the index and the untracked paths; this
 * process compares stat data itself and hashes candidate files raw. A file under
 * a filter or line-ending conversion whose timestamps changed can therefore
 * count as a tracked change although its content did not: the safe direction.
 * Two further differences from git status:
 * - A file whose raw bytes equal its blob but which git would now normalise
 *   (for example committed CRLF under a later `text` attribute) reads clean
 *   here and modified in git. No bytes differ from the commit.
 * - With core.symlinks=false a link is checked out as a plain file, which reads
 *   as a change here and clean in git: the safe direction.
 * A populated submodule at its recorded commit is compared recursively, up to
 * MAX_SUBMODULE_DEPTH levels, so modified, staged or untracked content inside it
 * counts as one change, as ` M sub` does in git. Its ignore settings
 * (submodule.<name>.ignore, diff.ignoreSubmodules) are not honoured, so such
 * content still counts: the safe direction.
 */
export async function dirtyState(wt: string, head: string, deadline: Deadline, depth = 0): Promise<Dirty> {
  const g = (...args: string[]) => gitWithin(deadline, wt, ...args);
  const index = await listingWithin(deadline, wt, "ls-files", "--stage", "--debug", "-z");
  if (!index.ok) return listingFailure(wt, "index listing", index);
  const entries = parseIndexDebug(index.stdout);
  const located = await g("rev-parse", "--git-path", "index");
  if (located.code === TIMED_OUT) return timedOut(wt, "index path lookup");
  const indexPath = located.stdout.trim();
  if (!entries || !indexPath) return unknown();
  const changed = new Set<string>();
  if (head) {
    const staged = await listingWithin(deadline, wt, "diff-index", "--cached", "--no-renames", "--name-only", "-z", head, "--");
    if (!staged.ok) return listingFailure(wt, "staged listing", staged);
    for (const path of staged.stdout.split("\0")) if (path) changed.add(path);
  } else for (const entry of entries) changed.add(entry.path);
  const fileMode = await g("config", "--type=bool", "--get", "core.fileMode");
  if (fileMode.code === TIMED_OUT) return timedOut(wt, "core.fileMode read");
  if (!fileMode.ok && fileMode.code !== 1) return unknown();
  const checkMode = fileMode.stdout.trim() !== "false";
  let indexTime: Time;
  try { indexTime = split((await lstat(resolve(wt, indexPath), { bigint: true })).mtimeNs); } catch { return unknown(); }
  const directories = new Map<string, boolean>();
  async function plainDirectory(dir: string): Promise<boolean> {
    if (dir === ".") return true;
    if (!directories.has(dir)) {
      const parent = await plainDirectory(dirname(dir));
      let plain = false;
      if (parent) try { plain = (await lstat(join(wt, dir))).isDirectory(); } catch { plain = false; }
      directories.set(dir, plain);
    }
    return directories.get(dir)!;
  }
  try {
    for (const entry of entries) {
      if (Date.now() >= deadline.at) return timedOut(wt, "file comparison");
      if (changed.has(entry.path) || entry.flags & (SKIP_WORKTREE | ASSUME_VALID)) continue;
      if (entry.stage !== 0 || entry.flags & INTENT_TO_ADD || !(await plainDirectory(dirname(entry.path)))) { changed.add(entry.path); continue; }
      const path = join(wt, entry.path);
      let st;
      try { st = await lstat(path, { bigint: true }); } catch { changed.add(entry.path); continue; }
      if (entry.mode === "160000") {
        if (!st.isDirectory()) { changed.add(entry.path); continue; }
        if (!existsSync(join(path, ".git"))) continue;
        const sub = await gitWithin(deadline, path, "rev-parse", "--verify", "--quiet", "HEAD");
        if (sub.code === TIMED_OUT) return timedOut(path, "submodule HEAD lookup");
        if (!sub.ok || sub.stdout.trim() !== entry.oid) { changed.add(entry.path); continue; }
        // At the recorded commit, git status still reports " M sub" for any modified,
        // staged or untracked content inside it: compare that content the same way.
        if (depth >= MAX_SUBMODULE_DEPTH)
          return unknown("Submodule " + path + " is nested deeper than " + MAX_SUBMODULE_DEPTH + " levels; its content was not compared, so dirty is unknown and the worktree is held.");
        const inner = await dirtyState(path, entry.oid, deadline, depth + 1);
        if (inner.state === "unknown") return inner;
        if (inner.state !== "clean") changed.add(entry.path);
        continue;
      }
      if (entry.mode === "120000") {
        if (!st.isSymbolicLink()) { changed.add(entry.path); continue; }
        const target = await readlink(path, { encoding: "buffer" });
        if (blobId(entry.oid, target) !== entry.oid) changed.add(entry.path);
        continue;
      }
      if (!st.isFile() || (checkMode && ((st.mode & 0o100n) !== 0n) !== (entry.mode === "100755"))) { changed.add(entry.path); continue; }
      const size = Number(st.size % U32);
      if (entry.size !== 0 && size !== entry.size) { changed.add(entry.path); continue; }
      if (statUnchanged(entry, { size, mtime: split(st.mtimeNs), ctime: split(st.ctimeNs), ino: Number(st.ino % U32) }, indexTime)) continue;
      if ((await rawFileId(path, entry.oid, deadline)) !== entry.oid) changed.add(entry.path);
    }
  } catch (error) { return error instanceof BudgetSpent ? timedOut(wt, "file hashing") : unknown(); }
  const untracked = await listingWithin(deadline, wt, "ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "-z");
  if (!untracked.ok) return listingFailure(wt, "untracked listing", untracked);
  const scratch = untracked.stdout.split("\0").filter(Boolean).length;
  return { state: changed.size ? "wip:" + changed.size : scratch ? "scratch:" + scratch : "clean" };
}
async function resolveBase(repo: string, requested?: string) {
  if (requested) {
    const ok = (await git(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", requested + "^{commit}")).ok;
    if (!ok) throw Error("pstack_worktree_audit: base ref not found locally (it is never fetched): " + requested);
    return { base: requested, warning: undefined };
  }
  const head = (await git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")).stdout.trim();
  for (const candidate of [head, "origin/main", "origin/master"].filter(Boolean))
    if ((await git(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", candidate + "^{commit}")).ok)
      return { base: candidate, warning: "No base given; merged checks use local " + candidate + " without fetching, so it may be stale." };
  return { base: undefined, warning: "No local origin/HEAD, origin/main or origin/master; merged is unknown. Pass base." };
}
export type SizeBudget = { deadline: number; exhausted: boolean };
/** A null size from a spent total budget is reported once by the caller; a timed-out or failed `du` warns per row. */
async function sizeKiB(path: string, budget: SizeBudget): Promise<{ kib: number | null; warning?: string }> {
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) { budget.exhausted = true; return { kib: null }; }
  const result = await run("du", ["-sk", path], "/", Math.min(SIZE_TIMEOUT_MS, remaining));
  const kib = Number.parseInt(result.stdout, 10);
  if (result.ok && Number.isFinite(kib)) return { kib };
  return { kib: null, warning: "The size measurement of " + path + (result.code === TIMED_OUT ? " timed out" : " failed") + "; sizeKiB is null." };
}
/**
 * The dirty state of a worktree whose HEAD lookup exited 1. Only a branch ref that
 * `show-ref --exists` reports missing (exit 2) is an unborn HEAD; a corrupt ref
 * (exit 1), a detached HEAD or an older git without `--exists` is held as unknown.
 */
async function unbornDirty(wt: string, deadline: Deadline): Promise<Dirty> {
  const symbolic = await gitWithin(deadline, wt, "symbolic-ref", "--quiet", "HEAD");
  const ref = symbolic.stdout.trim();
  const exists = symbolic.code === TIMED_OUT || !ref.startsWith("refs/heads/") ? undefined : await gitWithin(deadline, wt, "show-ref", "--exists", ref);
  if (symbolic.code === TIMED_OUT || exists?.code === TIMED_OUT) return timedOut(wt, "unborn HEAD check");
  if (exists?.code === 2) return dirtyState(wt, "", deadline);
  return unknown("The HEAD lookup of " + wt + " failed; dirty is unknown and the worktree is held.");
}
/**
 * Audits one linked worktree. Only exit 1 from the HEAD lookup, with HEAD's branch
 * ref confirmed absent (git also exits 1 for a corrupt ref), means an unborn
 * HEAD, whose staged comparison is skipped. A timed-out or otherwise failed HEAD
 * lookup leaves the dirty state unknown and held, with a warning. A timed-out
 * branch, upstream or ahead/behind lookup gives remote `unknown` with a warning,
 * never `detached` or `no-remote`. The branch is read as the full ref and
 * stripped of `refs/heads/`, so a tag of the same name cannot change it. Exported for tests.
 */
export async function auditWorktree(entry: Listed, base: string | undefined, now: number, budget: SizeBudget, deadline: Deadline) {
  if (entry.prunable || !existsSync(entry.path))
    return { row: { worktree: entry.path, sizeKiB: null, ageDays: null, merged: "unknown", dirty: "missing", remote: "unknown",
      branch: entry.branch ?? null, pr: "not-checked", lastActivity: "not-checked", locked: entry.locked, bucket: "review" }, warnings: [] as string[] };
  const wt = entry.path;
  const g = (...args: string[]) => gitWithin(deadline, wt, ...args);
  const resolved = await g("rev-parse", "--verify", "--quiet", "HEAD");
  const head = (resolved.ok ? resolved.stdout.trim() : "") || entry.head || "";
  const committed = Number.parseInt((await g("log", "-1", "--format=%ct", "HEAD")).stdout, 10);
  const ageDays = Number.isFinite(committed) ? Math.floor((now - committed) / 86400) : null;
  // merge-base exits 1 for "not an ancestor"; any other failure is unknown, never "no".
  const ancestry = !base || !head ? undefined : await g("merge-base", "--is-ancestor", head, base);
  const merged = !ancestry ? "unknown" : ancestry.ok ? "YES" : ancestry.code === 1 ? "no" : "unknown";
  const { state: dirty, warning } = resolved.code === TIMED_OUT ? timedOut(wt, "HEAD lookup")
    : resolved.ok ? await dirtyState(wt, head, deadline)
    : resolved.code === 1 ? await unbornDirty(wt, deadline)
    : unknown("The HEAD lookup of " + wt + " failed; dirty is unknown and the worktree is held.");
  const warnings = warning ? [warning] : [];
  const remoteTimedOut = (what: string) => { warnings.push("The " + what + " of " + wt + " timed out; remote is unknown."); return "unknown"; };
  const symbolic = await g("symbolic-ref", "--quiet", "HEAD");
  const ref = symbolic.stdout.trim();
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : symbolic.code === TIMED_OUT ? entry.branch ?? null : null;
  let remote = symbolic.code === TIMED_OUT ? remoteTimedOut("branch lookup") : "detached";
  if (branch && remote === "detached") {
    const upstream = await g("rev-parse", "--verify", "--quiet", "--end-of-options", "refs/remotes/origin/" + branch);
    const tip = upstream.stdout.trim();
    if (upstream.code === TIMED_OUT) remote = remoteTimedOut("upstream lookup");
    else if (!tip) remote = "no-remote";
    else if (tip === head) remote = "pushed";
    else {
      const counted = await g("rev-list", "--left-right", "--count", "refs/remotes/origin/" + branch + "...HEAD");
      const [behind, ahead] = counted.stdout.trim().split(/\s+/);
      remote = counted.code === TIMED_OUT ? remoteTimedOut("ahead/behind count") : "ahead" + (ahead ?? "?") + "/behind" + (behind ?? "?");
    }
  }
  // Upstream "safe" also needs PR and recent-chat signals this adapter does not read.
  const bucket = dirty.startsWith("wip:") || dirty === "unknown" ? "hold-wip" : merged === "YES" ? "verify-activity" : "review";
  const size = await sizeKiB(wt, budget);
  if (size.warning) warnings.push(size.warning);
  return { warnings, row: { worktree: wt, sizeKiB: size.kib, ageDays, merged, dirty, remote, branch, pr: "not-checked",
    lastActivity: "not-checked", locked: entry.locked, bucket } };
}
function auditRepository(ctx: OpenClawPluginToolContext, requested?: string) {
  if (ctx.sandboxed === true)
    throw Error("pstack_worktree_audit refused: the session is sandboxed and host-side git would bypass the sandbox.");
  if (ctx.fsPolicy?.workspaceOnly === true)
    throw Error("pstack_worktree_audit refused: tools.fs.workspaceOnly is set and linked worktrees can live outside the workspace.");
  if (!ctx.workspaceDir) throw Error("pstack_worktree_audit refused: requester workspace is unavailable");
  const workspace = realpathSync(ctx.workspaceDir);
  const repo = realpathSync(resolve(workspace, requested ?? "."));
  if (!within(workspace, repo)) throw Error("pstack_worktree_audit refused: repo resolves outside the requester workspace");
  return repo;
}
export function registerWorktreeAuditTool(api: OpenClawPluginApi) {
  api.registerTool(ctx => ({
    name: "pstack_worktree_audit", label: "Pstack read-only worktree audit",
    description: "Classify linked git worktrees of a workspace repository by size, age, merged state, dirty state and remote state, with a suggested bucket. Never writes, fetches, prunes, deletes, contacts GitHub or reads transcripts. Never runs git status or any content-converting read, so repository config cannot start a filter, diff, fsmonitor, signature or transport program at any point in the audit. Deletion stays human-gated.",
    parameters: worktreeAuditParameters,
    prepareArguments: args => { assertArguments(args); return args as Record<string, unknown>; },
    execute: async (_id, params) => {
      ctx.assertInvocationCurrent?.();
      assertArguments(params);
      const repo = auditRepository(ctx, params.repo);
      const top = await git(repo, "rev-parse", "--show-toplevel");
      if (!top.ok) throw Error("pstack_worktree_audit: not a git repository: " + repo);
      const listed = await git(repo, "worktree", "list", "--porcelain", "-z");
      if (!listed.ok) throw Error("pstack_worktree_audit: git worktree list failed");
      const [main, ...linked] = parseWorktreeList(listed.stdout);
      const { base, warning } = await resolveBase(repo, params.base);
      const now = Math.floor(Date.now() / 1000);
      const rows = [], dirtyWarnings: string[] = [], budget: SizeBudget = { deadline: Date.now() + SIZE_BUDGET_MS, exhausted: false };
      const deadline: Deadline = { at: Date.now() + AUDIT_BUDGET_MS };
      const selected = linked.slice(0, MAX_AUDITED_WORKTREES);
      for (const entry of selected) {
        ctx.assertInvocationCurrent?.();
        if (Date.now() >= deadline.at) break;
        const audited = await auditWorktree(entry, base, now, budget, deadline);
        rows.push(audited.row);
        dirtyWarnings.push(...audited.warnings);
      }
      const timedOut = rows.length < selected.length;
      rows.sort((a, b) => (b.sizeKiB ?? -1) - (a.sizeKiB ?? -1));
      ctx.assertInvocationCurrent?.();
      const details = { status: "AUDITED", base: base ?? null, mainWorktree: main?.path ?? null, worktrees: rows,
        audited: rows.length, listed: linked.length, complete: linked.length <= MAX_AUDITED_WORKTREES && !timedOut,
        unaudited: selected.slice(rows.length).map(entry => entry.path),
        warnings: [warning, linked.length > MAX_AUDITED_WORKTREES ? "Audited the first " + MAX_AUDITED_WORKTREES + " of " + linked.length + " worktrees." : undefined,
          budget.exhausted ? "Size budget of " + SIZE_BUDGET_MS / 1000 + "s exhausted; remaining sizeKiB values are null." : undefined,
          timedOut ? "Audit time budget of " + AUDIT_BUDGET_MS / 1000 + "s exhausted after " + rows.length + " worktrees; the rest are listed as unaudited." : undefined, ...dirtyWarnings].filter(Boolean),
        unchecked: ["pr", "lastActivity", "remote freshness (no fetch)"],
        notice: "Read-only classification. No bucket authorizes deletion: verify-activity means merged into the local base but PR state and recent session activity were not checked. Removal stays a human-gated step through supported cleanup." };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  }), { names: ["pstack_worktree_audit"], optional: true });
}
