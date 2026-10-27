#!/usr/bin/env node
/**
 * User-installed, read-only pull-request watcher template.
 *
 * pstack never schedules, installs, enables or runs this script. A user who
 * wants a recurring watch copies the line printed by `template` into a
 * scheduler they own (crontab, launchd, a systemd user timer). Each `run` is
 * one bounded observation: `gh auth status` plus fixed GraphQL queries through
 * the user's own gh login. No GitHub write exists in this file, and local
 * writes happen only inside an explicit --state-dir.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = Object.freeze({
  observed: 0,
  usage: 2,
  blocked: 3,
  readFailed: 4,
  finished: 5,
  state: 6,
});
/** The only gh subcommands this file may start. The doctor pins this list. */
export const READ_ONLY_COMMANDS = [["auth", "status"], ["api", "graphql"]];
export const LIMITS = Object.freeze({
  defaultMaxRuns: 500,
  maxRunsCap: 5000,
  horizonDays: 30,
  defaultTimeoutMs: 20000,
  minTimeoutMs: 1000,
  maxTimeoutMs: 120000,
  outputBytes: 2 * 1024 * 1024,
  threadPages: 10,
  stateBytes: 64 * 1024,
  listedChecks: 20,
});
export const EVERY_MINUTES = [5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440];
export const VERDICTS = [
  "merged", "closed", "draft", "conflict", "incomplete", "review-threads", "ready",
  "unstable", "checks-failing", "checks-pending", "changes-requested",
  "review-required", "behind", "blocked", "computing", "unknown",
];

const CONTEXTS = "contexts(first:100){totalCount nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}";
export const WATCH_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state isDraft mergeable mergeStateStatus reviewDecision headRefOid commits(last:1){nodes{commit{oid statusCheckRollup{state ${CONTEXTS}}}}} reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{isResolved}}}}}`;
export const THREAD_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved}}}}}`;

class Usage extends Error {}
class StateError extends Error {}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const FLAGS = {
  "--repo": "repo", "--pr": "pr", "--until": "until", "--hostname": "hostname",
  "--gh": "gh", "--state-dir": "stateDir", "--max-runs": "maxRuns",
  "--timeout-ms": "timeoutMs", "--every": "every", "--quiet-unchanged": "quietUnchanged",
};
const USAGE = "Usage: watch-pr.mjs run|template --repo OWNER/NAME --pr N --until ISO-TIME [--state-dir ABS-DIR [--max-runs N]] [--gh ABS-PATH] [--hostname HOST] [--timeout-ms MS] [--quiet-unchanged] [--every MINUTES (template)]";

function integer(value, flag, min, max) {
  if (!/^\d{1,10}$/.test(value ?? "")) throw new Usage(`${flag} must be an integer`);
  const n = Number(value);
  if (n < min || n > max) throw new Usage(`${flag} must be ${min}..${max}`);
  return n;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "run" && command !== "template") throw new Usage(USAGE);
  const raw = {};
  for (let i = 0; i < rest.length; i++) {
    const key = FLAGS[rest[i]];
    if (!key) throw new Usage(`Unknown argument: ${JSON.stringify(rest[i])}`);
    if (key in raw) throw new Usage(`Duplicate ${rest[i]}`);
    if (key === "quietUnchanged") { raw[key] = true; continue; }
    if (i + 1 >= rest.length) throw new Usage(`${rest[i]} needs a value`);
    raw[key] = rest[++i];
  }
  for (const value of Object.values(raw))
    if (typeof value === "string" && /[\0-\x1f\x7f]/.test(value)) throw new Usage("Arguments must not contain control characters");
  if (!REPO.test(raw.repo ?? "")) throw new Usage("--repo must be OWNER/NAME");
  const pr = integer(raw.pr, "--pr", 1, 2147483647);
  if (!ISO.test(raw.until ?? "") || !Number.isFinite(Date.parse(raw.until))) throw new Usage("--until must be an ISO time with a zone, for example 2026-11-01T00:00:00Z; every watch has an end");
  const hostname = (raw.hostname ?? "github.com").toLowerCase();
  if (!HOST.test(hostname)) throw new Usage("--hostname must be a host name");
  for (const flag of ["gh", "stateDir"])
    if (raw[flag] !== undefined && !isAbsolute(raw[flag])) throw new Usage(`--${flag === "gh" ? "gh" : "state-dir"} must be an absolute path`);
  if (raw.maxRuns !== undefined && raw.stateDir === undefined) throw new Usage("--max-runs needs --state-dir to count runs");
  if (raw.every !== undefined && command !== "template") throw new Usage("--every is a template option; the scheduler owns the cadence");
  const every = raw.every === undefined ? 15 : integer(raw.every, "--every", 1, 1440);
  if (!EVERY_MINUTES.includes(every)) throw new Usage(`--every must be one of ${EVERY_MINUTES.join(", ")} minutes`);
  return {
    command, repo: raw.repo, pr, until: raw.until, untilMs: Date.parse(raw.until), hostname,
    gh: raw.gh, stateDir: raw.stateDir,
    maxRuns: raw.maxRuns === undefined ? LIMITS.defaultMaxRuns : integer(raw.maxRuns, "--max-runs", 1, LIMITS.maxRunsCap),
    maxRunsExplicit: raw.maxRuns !== undefined,
    timeoutMs: raw.timeoutMs === undefined ? LIMITS.defaultTimeoutMs : integer(raw.timeoutMs, "--timeout-ms", LIMITS.minTimeoutMs, LIMITS.maxTimeoutMs),
    quietUnchanged: raw.quietUnchanged === true, every,
  };
}

const CURSOR = /^[^\0-\x1f\x7f]{1,1024}$/;
/** Each variable's only accepted flag and value form. `-F` reads `@file` values, so only the number uses it. */
const VARIABLES = {
  owner: ["-f", /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/], name: ["-f", /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/],
  number: ["-F", /^[1-9]\d{0,9}$/], after: ["-f", CURSOR],
};
/** Throws unless argv is one of the fixed read-only gh invocations, with each variable in its only form. */
export function assertReadOnly(args, hostname) {
  const allowed = READ_ONLY_COMMANDS.find(([a, b]) => args[0] === a && args[1] === b);
  if (!allowed || args[2] !== "--hostname" || args[3] !== hostname) throw Error("Refused gh invocation: " + JSON.stringify(args.slice(0, 2)));
  if (args[0] === "auth") {
    if (args.length !== 4) throw Error("Refused gh auth arguments");
    return true;
  }
  const query = args[5]?.startsWith("query=") ? args[5].slice(6) : undefined;
  if (args[4] !== "-f" || (query !== WATCH_QUERY && query !== THREAD_QUERY) || !/^query\(/.test(query)) throw Error("Refused GraphQL document");
  const vars = new Set();
  for (let i = 6; i < args.length; i += 2) {
    const [, name, value] = /^(owner|name|number|after)=([\s\S]*)$/.exec(args[i + 1] ?? "") ?? [];
    if (!name || args[i] !== VARIABLES[name][0] || !VARIABLES[name][1].test(value) || vars.has(name)) throw Error("Refused GraphQL argument");
    vars.add(name);
  }
  if (vars.has("after") !== (query === THREAD_QUERY) || vars.size !== (query === THREAD_QUERY ? 4 : 3)) throw Error("Refused GraphQL variables");
  return true;
}

const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;
// An Authorization value is redacted to the end of its line, whatever its scheme; a known scheme name is kept.
const AUTHORIZATION = /\b(Authorization["']?\s*[:=]\s*)(?:(Bearer|token|Basic)\s+)?[^\r\n]*/gi;
const BEARER = /\b(Bearer)\s+\S+/gi;
const TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
/** The exact token values gh may use from the environment, so a token of any format is redacted. */
export const tokenValues = (env) => TOKEN_VARIABLES.map((key) => env?.[key]).filter((value) => typeof value === "string" && value.length >= 8);
/** Removes GitHub token patterns, any Authorization value, Bearer values, and the exact `secrets` given. */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join("[redacted]");
  return out.replace(TOKEN, "[redacted]").replace(AUTHORIZATION, (_, prefix, scheme) => prefix + (scheme ? scheme + " " : "") + "[redacted]").replace(BEARER, "$1 [redacted]").replace(/[\0-\x08\x0b-\x1f\x7f]/g, "").slice(0, 400).trim();
}
const label = (value) => String(value ?? "").replace(/[\0-\x1f\x7f]+/g, " ").slice(0, 200);

export function childEnv(env) {
  const out = { ...env };
  for (const key of ["GH_DEBUG", "DEBUG", "GH_HOST", "GH_REPO"]) delete out[key];
  return Object.assign(out, {
    GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_SPINNER_DISABLED: "1", NO_COLOR: "1", CLICOLOR: "0", GH_PAGER: "cat", PAGER: "cat",
  });
}

function gh(executable, args, options) {
  assertReadOnly(args, options.hostname);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, { env: childEnv(options.env), stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    } catch (error) {
      resolve({ error }); return;
    }
    const out = [], err = [];
    let bytes = 0, overflow = false, timedOut = false, settled = false;
    // Closing the pipes before the kill means a descendant that keeps them open cannot hold the result.
    const stop = () => { child.stdout.destroy(); child.stderr.destroy(); child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > LIMITS.outputBytes) { overflow = true; stop(); } else out.push(chunk);
    });
    child.stderr.on("data", (chunk) => { if (err.reduce((n, c) => n + c.length, 0) < 16384) err.push(chunk); });
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    child.on("error", (error) => finish({ error }));
    child.on("close", (code) => finish({ code, timedOut, overflow, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

export function findGh(env) {
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, "gh");
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  return undefined;
}

const fail = (code, reason, detail) => ({ code, status: code === EXIT.blocked ? "blocked" : "read-failed", reason, ...(detail ? { detail } : {}) });
function callFailure(result, step, hide) {
  if (result.error) return ["ENOENT", "EACCES", "ENOTDIR"].includes(result.error.code) ? fail(EXIT.blocked, "gh-missing", "gh could not be started") : fail(EXIT.readFailed, "gh-start-failed", hide(result.error.message));
  if (result.timedOut) return fail(EXIT.readFailed, "timeout", `${step} exceeded the per-call time limit`);
  if (result.overflow) return fail(EXIT.readFailed, "output-limit", `${step} output exceeded ${LIMITS.outputBytes} bytes`);
  return undefined;
}

function parseGraphql(result, hide) {
  const early = callFailure(result, "GraphQL read", hide);
  if (early) return early;
  let body;
  try { body = JSON.parse(result.stdout); } catch { body = undefined; }
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const text = result.stderr + "\n" + errors.map((e) => e?.message).join("\n");
  if (/HTTP 401|Bad credentials|gh auth login|authentication token|not logged in/i.test(text)) return fail(EXIT.blocked, "gh-auth", hide(result.stderr || text));
  if (errors.some((e) => e?.type === "NOT_FOUND")) return fail(EXIT.readFailed, "not-found", "The repository or pull request was not found, or this gh account cannot see it");
  if (result.code !== 0 || errors.length) return fail(EXIT.readFailed, `gh-exit-${result.code}`, hide(result.stderr || text));
  if (!body || typeof body !== "object") return fail(EXIT.readFailed, "malformed-response", "gh did not return JSON");
  return { body };
}

const one = (value, allowed) => (allowed.includes(value) ? value : undefined);
/** Strictly maps the first GraphQL page; any unexpected shape is a read failure, never a verdict. */
export function snapshotFrom(body) {
  const pr = body?.data?.repository?.pullRequest;
  if (!pr || typeof pr !== "object") return undefined;
  const state = one(pr.state, ["OPEN", "CLOSED", "MERGED"]);
  const head = typeof pr.headRefOid === "string" && /^[0-9a-f]{40}$/.test(pr.headRefOid) ? pr.headRefOid : undefined;
  const commits = pr.commits?.nodes;
  const threads = pr.reviewThreads;
  if (!state || !head || typeof pr.isDraft !== "boolean" || !Array.isArray(commits) || commits.length > 1 || !threadPage(threads)) return undefined;
  const commit = commits[0]?.commit;
  const rollup = commit?.statusCheckRollup ?? null;
  const failing = [], pendingNames = [];
  let checks = 0;
  if (rollup !== null) {
    if (!one(rollup.state, ["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]) || !Array.isArray(rollup.contexts?.nodes) || !Number.isSafeInteger(rollup.contexts.totalCount)) return undefined;
    for (const node of rollup.contexts.nodes) {
      const name = label(node?.__typename === "CheckRun" ? node.name : node?.context);
      const kind = node?.__typename === "CheckRun"
        ? node.status !== "COMPLETED" ? "pending" : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(node.conclusion) ? "pass" : "fail"
        : node?.__typename === "StatusContext"
          ? node.state === "SUCCESS" ? "pass" : ["PENDING", "EXPECTED"].includes(node.state) ? "pending" : "fail"
          : "fail";
      checks++;
      if (kind === "fail") failing.push(name);
      if (kind === "pending") pendingNames.push(name);
    }
    checks = Math.max(checks, rollup.contexts.totalCount);
  }
  return {
    state, head, isDraft: pr.isDraft, commitHead: commit?.oid ?? null,
    mergeable: one(pr.mergeable, ["MERGEABLE", "CONFLICTING", "UNKNOWN"]) ?? "UNKNOWN",
    mergeStateStatus: one(pr.mergeStateStatus, ["BEHIND", "BLOCKED", "CLEAN", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"]) ?? "UNKNOWN",
    reviewDecision: one(pr.reviewDecision, ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]) ?? null,
    rollup: rollup?.state ?? null, checks, checksListed: rollup?.contexts.nodes.length ?? 0,
    failing: failing.sort(), pending: pendingNames.length,
    unresolved: threads.nodes.filter((t) => t.isResolved === false).length,
    threadsComplete: !threads.pageInfo.hasNextPage, cursor: threads.pageInfo.endCursor, headStable: commit?.oid === undefined || commit.oid === head,
  };
}
function threadPage(threads) {
  return threads && Array.isArray(threads.nodes) && threads.nodes.every((t) => typeof t?.isResolved === "boolean") &&
    typeof threads.pageInfo?.hasNextPage === "boolean" && (!threads.pageInfo.hasNextPage || CURSOR.test(threads.pageInfo.endCursor ?? ""));
}

/**
 * Conservative forge-first classification. Unknown or partial facts never become `ready`,
 * and neither does CLEAN contradicted by a failing or pending check or a blocking review.
 */
export function classify(s) {
  const checksFailing = ["FAILURE", "ERROR"].includes(s.rollup) || (s.failing?.length ?? 0) > 0;
  const checksPending = ["PENDING", "EXPECTED"].includes(s.rollup) || (s.pending ?? 0) > 0;
  const reviewBlocking = ["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(s.reviewDecision);
  if (s.state === "MERGED") return "merged";
  if (s.state === "CLOSED") return "closed";
  if (s.isDraft || s.mergeStateStatus === "DRAFT") return "draft";
  if (s.mergeable === "CONFLICTING" || s.mergeStateStatus === "DIRTY") return "conflict";
  if (!s.threadsComplete || !s.headStable) return "incomplete";
  if (s.unresolved > 0) return "review-threads";
  if (s.mergeable === "MERGEABLE" && ["CLEAN", "HAS_HOOKS"].includes(s.mergeStateStatus) && !checksFailing && !checksPending && !reviewBlocking) return "ready";
  if (s.mergeable === "MERGEABLE" && s.mergeStateStatus === "UNSTABLE") return "unstable";
  if (checksFailing) return "checks-failing";
  if (checksPending) return "checks-pending";
  if (s.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  if (s.reviewDecision === "REVIEW_REQUIRED") return "review-required";
  if (s.mergeStateStatus === "BEHIND") return "behind";
  if (s.mergeStateStatus === "BLOCKED") return "blocked";
  if (s.mergeable === "UNKNOWN" || s.mergeStateStatus === "UNKNOWN") return "computing";
  return "unknown";
}

async function observe(opts, env) {
  const executable = opts.gh ?? findGh(env);
  if (!executable) return fail(EXIT.blocked, "gh-missing", "gh was not found; pass --gh with an absolute path (cron has a short PATH)");
  const call = (args) => gh(executable, args, { env, hostname: opts.hostname, timeoutMs: opts.timeoutMs });
  const hide = (text) => redact(text, tokenValues(env));
  const auth = await call(["auth", "status", "--hostname", opts.hostname]);
  const authFailure = callFailure(auth, "gh auth status", hide);
  if (authFailure) return authFailure;
  if (auth.code !== 0) return fail(EXIT.blocked, "gh-auth", hide(auth.stderr || auth.stdout) || `gh auth status exited ${auth.code}`);
  const [owner, name] = opts.repo.split("/");
  const base = ["--hostname", opts.hostname];
  const vars = ["-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${opts.pr}`];
  const first = parseGraphql(await call(["api", "graphql", ...base, "-f", `query=${WATCH_QUERY}`, ...vars]), hide);
  if (!first.body) return first;
  const snapshot = snapshotFrom(first.body);
  if (!snapshot) return fail(EXIT.readFailed, "malformed-response", "The pull request response did not have the expected shape");
  for (let page = 1; !snapshot.threadsComplete && page < LIMITS.threadPages && snapshot.headStable; page++) {
    const next = parseGraphql(await call(["api", "graphql", ...base, "-f", `query=${THREAD_QUERY}`, ...vars, "-f", `after=${snapshot.cursor}`]), hide);
    if (!next.body) return next;
    const pr = next.body?.data?.repository?.pullRequest;
    if (!threadPage(pr?.reviewThreads)) return fail(EXIT.readFailed, "malformed-response", "A review-thread page did not have the expected shape");
    if (pr.headRefOid !== snapshot.head) snapshot.headStable = false;
    snapshot.unresolved += pr.reviewThreads.nodes.filter((t) => t.isResolved === false).length;
    snapshot.threadsComplete = !pr.reviewThreads.pageInfo.hasNextPage;
    snapshot.cursor = pr.reviewThreads.pageInfo.endCursor;
  }
  return { snapshot };
}

const stateName = (opts) => "watch-pr-" + createHash("sha256").update(`${opts.hostname}\n${opts.repo.toLowerCase()}\n${opts.pr}`).digest("hex").slice(0, 24);
export async function checkStateDir(dir) {
  let info;
  try { info = await lstat(dir); } catch { throw new StateError("--state-dir does not exist"); }
  // lstat: a link to a directory is not itself a directory, so links are refused here.
  if (!info.isDirectory()) throw new StateError("--state-dir must be a real directory, not a link");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new StateError("--state-dir must be owned by the user running the watch");
  if ((info.mode & 0o022) !== 0) throw new StateError("--state-dir must not be group- or world-writable");
}

async function readState(path, key) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) {
    if (error.code === "ENOENT") return { schema: 1, key, runs: 0, terminal: false, lastDigest: null, lastVerdict: null, lastHead: null };
    throw new StateError("State file cannot be opened safely: " + error.code);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > LIMITS.stateBytes) throw new StateError("State file is not a small regular file");
    let s;
    try { s = JSON.parse(await handle.readFile("utf8")); } catch { throw new StateError("State file is not valid JSON; inspect or delete it"); }
    if (s?.schema !== 1 || s.key !== key || !Number.isSafeInteger(s.runs) || s.runs < 0 || typeof s.terminal !== "boolean" ||
        !(s.lastDigest === null || /^[0-9a-f]{64}$/.test(s.lastDigest)) || !(s.lastVerdict === null || VERDICTS.includes(s.lastVerdict)) ||
        !(s.lastHead === null || /^[0-9a-f]{40}$/.test(s.lastHead)) || !(s.endReported === undefined || typeof s.endReported === "boolean"))
      throw new StateError("State file does not match this watch; inspect or delete it");
    return s;
  } finally { await handle.close(); }
}

async function writeState(path, state) {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(state) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temp, path); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
/** A steal guard older than this was left by a run that died mid-steal. */
export const GUARD_STALE_MS = 30000;
async function lock(path, staleMs, now) {
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: now })); } finally { await handle.close(); }
      return token;
    } catch (error) {
      if (error.code !== "EEXIST") throw new StateError("Lock cannot be created: " + error.code);
    }
    const info = await lockInfo(path);
    if (!info) continue;
    const raw = await readLock(path);
    if (raw === undefined) continue;
    let held;
    try { held = JSON.parse(raw); } catch { held = undefined; }
    if (!held) {
      // A lock another run created but has not written yet is still held.
      if (Date.now() - info.mtimeMs < staleMs) return undefined;
    } else if (Number.isSafeInteger(held.pid) && alive(held.pid) && Number.isFinite(held.startedAt) && now - held.startedAt < staleMs) return undefined;
    if (!(await steal(path, info, raw))) return undefined;
  }
  return undefined;
}
/**
 * Removes the exact stale lock judged above, under a guard file. Runs that judged the same
 * lock stale take the guard one at a time and re-check it, so none can remove a lock that
 * another run has since taken. A run that finds the guard taken skips this time.
 */
async function steal(path, judged, raw) {
  const guard = path + ".steal";
  let handle;
  try { handle = await open(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch (error) {
    if (error.code !== "EEXIST") throw new StateError("Lock guard cannot be created: " + error.code);
    const info = await lstat(guard).catch(() => undefined);
    // A guard that is not a regular file would block recovery forever, like such a lock.
    if (info && !info.isFile()) throw new StateError("Lock guard is not a regular file; inspect or delete it");
    if (info && Date.now() - info.mtimeMs >= GUARD_STALE_MS) await unlink(guard).catch(() => {});
    return false;
  }
  try {
    await handle.close();
    const now = await lockInfo(path);
    if (!now || now.ino !== judged.ino || now.mtimeMs !== judged.mtimeMs || (await readLock(path)) !== raw) return false;
    await unlink(path).catch(() => {});
    return true;
  } finally { await unlink(guard).catch(() => {}); }
}
/** The lock's lstat, or undefined once it is gone. A lock that is not a regular file is a state error, never "held". */
async function lockInfo(path) {
  let info;
  try { info = await lstat(path); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new StateError("Lock cannot be inspected: " + error.code);
  }
  if (!info.isFile()) throw new StateError("Lock is not a regular file; inspect or delete it");
  return info;
}
async function readLock(path) {
  try { return await readFile(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new StateError("Lock cannot be read: " + error.code);
  }
}
async function unlock(path, token) {
  try {
    const held = JSON.parse(await readFile(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
    if (held?.token === token) await unlink(path);
  } catch {}
}

/**
 * Records that this watch's end was reported, so later firings can stay quiet. Returns true
 * when it already was. A watch that never recorded a run writes nothing.
 */
async function endReported(file, state) {
  if (state.runs === 0) return false;
  if (state.endReported === true) return true;
  await writeState(file, { ...state, endReported: true });
  return false;
}
const stateFiles = (opts) => ({
  file: join(opts.stateDir, stateName(opts) + ".json"), lockFile: join(opts.stateDir, stateName(opts) + ".lock"),
  key: `${opts.hostname}/${opts.repo.toLowerCase()}#${opts.pr}`, staleMs: opts.timeoutMs * (LIMITS.threadPages + 2) + 60000,
});
/** After the deadline: no read; with --state-dir, only the end-reported mark, best effort. */
async function deadlineReported(opts, started) {
  try {
    await checkStateDir(opts.stateDir);
    const { file, lockFile, key, staleMs } = stateFiles(opts);
    const token = await lock(lockFile, staleMs, started);
    if (!token) return false;
    try { return await endReported(file, await readState(file, key)); } finally { await unlock(lockFile, token); }
  } catch { return false; }
}

export async function run(opts, { env = process.env, now = () => Date.now() } = {}) {
  const started = now();
  const base = { schema: 1, kind: "pstack-watch-pr", repo: opts.repo, pr: opts.pr, hostname: opts.hostname, observedAt: new Date(started).toISOString(), until: opts.until };
  const done = (code, fields) => ({ code, report: { ...base, ...fields } });
  const repeated = (already) => (already ? { repeated: true } : {});
  if (started >= opts.untilMs)
    return done(EXIT.finished, { status: "finished", reason: "deadline", removeSchedule: true, ...repeated(opts.stateDir ? await deadlineReported(opts, started) : false) });
  if (!opts.stateDir) {
    const result = await observe(opts, env);
    if (!result.snapshot) return done(result.code, { status: result.status, reason: result.reason, detail: result.detail });
    return done(EXIT.observed, describe(result.snapshot, null, { run: 1 }));
  }
  try { await checkStateDir(opts.stateDir); } catch (error) { return done(EXIT.state, { status: "state-error", reason: error.message }); }
  const { file, lockFile, key, staleMs } = stateFiles(opts);
  let token;
  try { token = await lock(lockFile, staleMs, started); } catch (error) { return done(EXIT.state, { status: "state-error", reason: error.message }); }
  if (!token) return done(EXIT.observed, { status: "skipped", reason: "another run for this pull request is still in progress" });
  try {
    let state;
    try { state = await readState(file, key); } catch (error) { return done(EXIT.state, { status: "state-error", reason: error.message }); }
    if (state.terminal) return done(EXIT.finished, { status: "finished", reason: "terminal", verdict: state.lastVerdict, head: state.lastHead, removeSchedule: true, ...repeated(await endReported(file, state)) });
    if (state.runs >= opts.maxRuns) return done(EXIT.finished, { status: "finished", reason: "max-runs", runs: state.runs, maxRuns: opts.maxRuns, removeSchedule: true, ...repeated(await endReported(file, state)) });
    // A newly counted run starts a new end: a raised cap ends the watch again, and that end is reported.
    const { endReported: _ended, ...counted } = state;
    state = { ...counted, runs: state.runs + 1 };
    await writeState(file, state);
    const result = await observe(opts, env);
    if (!result.snapshot) {
      await writeState(file, { ...state, lastFailure: { at: base.observedAt, reason: result.reason } });
      return done(result.code, { status: result.status, reason: result.reason, detail: result.detail, run: state.runs, maxRuns: opts.maxRuns });
    }
    const report = describe(result.snapshot, state, { run: state.runs, maxRuns: opts.maxRuns });
    await writeState(file, { schema: 1, key, runs: state.runs, terminal: report.terminal, lastDigest: report.digest, lastVerdict: report.verdict, lastHead: report.head, lastObservedAt: base.observedAt });
    return done(EXIT.observed, report);
  } catch (error) {
    return done(EXIT.state, { status: "state-error", reason: redact(error.message, tokenValues(env)) });
  } finally {
    await unlock(lockFile, token);
  }
}

function describe(s, prior, counters) {
  const verdict = classify(s);
  const digest = createHash("sha256").update(JSON.stringify([verdict, s.head, s.failing, s.unresolved, s.mergeStateStatus, s.reviewDecision])).digest("hex");
  const terminal = verdict === "merged" || verdict === "closed";
  return {
    status: "observed", verdict, head: s.head, terminal, removeSchedule: terminal,
    changed: prior ? prior.lastDigest !== digest : true, previousVerdict: prior?.lastVerdict ?? null, digest,
    forge: { state: s.state, mergeable: s.mergeable, mergeStateStatus: s.mergeStateStatus, reviewDecision: s.reviewDecision, checks: s.rollup },
    checks: { total: s.checks, listed: s.checksListed, pending: s.pending, failing: s.failing.slice(0, LIMITS.listedChecks), failingTruncated: s.failing.length > LIMITS.listedChecks || s.checksListed < s.checks },
    unresolvedThreads: s.unresolved, threadsComplete: s.threadsComplete, ...counters,
  };
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
/** Prints a crontab line for the user to install. Never edits a crontab or runs gh. */
export async function template(opts, { now = () => Date.now(), script = fileURLToPath(import.meta.url), node = process.execPath } = {}) {
  const t = now();
  if (opts.untilMs <= t) throw new Usage("--until is already past");
  if (opts.untilMs > t + LIMITS.horizonDays * 86400000) throw new Usage(`--until must be within ${LIMITS.horizonDays} days; schedule a new watch after that`);
  if (!opts.gh) throw new Usage("template needs --gh with an absolute path; cron does not use your shell PATH");
  try { accessSync(opts.gh, constants.X_OK); } catch { throw new Usage("--gh is not an executable file"); }
  if (!opts.stateDir) throw new Usage("template needs --state-dir so the schedule can count runs and stop");
  try { await checkStateDir(opts.stateDir); } catch (error) { throw new Usage(error.message); }
  // Without an explicit cap, allow exactly the runs the cadence needs before --until, at most maxRunsCap.
  const needed = Math.ceil((opts.untilMs - t) / (opts.every * 60000)) + 1;
  const maxRuns = opts.maxRunsExplicit ? opts.maxRuns : Math.min(LIMITS.maxRunsCap, needed);
  const capped = maxRuns < needed
    ? [`# Note: the cadence needs ${needed} runs before --until, but this watch is capped at ${maxRuns}, so it ends near ${new Date(t + (maxRuns - 1) * opts.every * 60000).toISOString()}.`]
    : [];
  const args = [node, script, "run", "--repo", opts.repo, "--pr", String(opts.pr), "--until", opts.until, "--hostname", opts.hostname,
    "--gh", opts.gh, "--state-dir", opts.stateDir, "--max-runs", String(maxRuns), "--timeout-ms", String(opts.timeoutMs), "--quiet-unchanged"];
  if (args.some((a) => /[%\0-\x1f\x7f]/.test(a))) throw new Usage("cron treats % and control characters specially; use paths without them");
  const schedule = opts.every < 60 ? `*/${opts.every} * * * *` : opts.every === 1440 ? "0 0 * * *" : `0 */${opts.every / 60} * * *`;
  return [
    `# pstack watch-pr for ${opts.repo}#${opts.pr}: user-installed; pstack never schedules or edits this.`,
    "# Read-only: gh auth status plus fixed GraphQL queries. Prints only on a change, a failure or the end of the watch.",
    `# Ends by itself at ${opts.until} or after ${maxRuns} runs, or once the PR merges or closes (exit 5); the end prints once. Then remove this line.`,
    ...capped,
    `${schedule} ${args.map(quote).join(" ")}`,
  ].join("\n");
}

async function cli(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) {
    if (!(error instanceof Usage)) throw error;
    console.error(error.message); return EXIT.usage;
  }
  if (opts.command === "template") {
    try { console.log(await template(opts)); return EXIT.observed; } catch (error) {
      if (!(error instanceof Usage)) throw error;
      console.error(error.message); return EXIT.usage;
    }
  }
  const { code, report } = await run(opts);
  const quiet = opts.quietUnchanged && ((code === EXIT.observed && (report.status === "skipped" || (report.status === "observed" && report.changed === false))) ||
    (code === EXIT.finished && report.repeated === true));
  if (!quiet) console.log(JSON.stringify(report));
  if (code !== EXIT.observed && code !== EXIT.finished) console.error(`watch-pr ${report.status}: ${report.reason}${report.detail ? " (" + report.detail + ")" : ""}`);
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(redact(error?.message ?? error, tokenValues(process.env))); process.exitCode = 1; });
