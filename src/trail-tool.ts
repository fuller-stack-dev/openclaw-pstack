import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync,
  realpathSync, unlinkSync, writeSync, type Stats,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";

// Native replacement for upstream show-me-your-work/scripts/log.sh. The script
// is source only; this adapter reimplements its row contract without running it.
export const TRAIL_COLUMNS = ["ts", "phase", "decision", "why", "evidence", "result"] as const;
export const TRAIL_HEADER = TRAIL_COLUMNS.join("\t") + "\n";
const cell = (description: string) => ({ type: "string", minLength: 1, maxLength: 2000, pattern: "\\S", description });
export const trailParameters = {
  type: "object", additionalProperties: false,
  properties: {
    log: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
      description: "Trail slug. The row is appended to <requester workspace>/.audit/<log>.tsv; never a path." },
    phase: cell("Phase or workstream. Use start only for a run's first row after another run's rows."),
    decision: cell("What was chosen or done, one line."),
    why: cell("The reason in plain words."),
    evidence: cell("A resolvable pointer: commit SHA, PR, file:line or artifact path. Never prose."),
    result: cell("Outcome or predicate state, such as tests green, reverted, INCONCLUSIVE or open."),
  },
  required: ["log", "phase", "decision", "why", "evidence", "result"],
};
type TrailArgs = { log: string; phase: string; decision: string; why: string; evidence: string; result: string };
function assertArguments(value: unknown): asserts value is TrailArgs {
  const checked = validateJsonSchemaValue({ schema: trailParameters, value });
  if (!checked.ok) throw Error("Invalid pstack_trail arguments: " + checked.errors.slice(0, 4).map(e => e.text).join("; "));
}
/** Single-line cell; spreadsheet formula leaders become literal text, as upstream log.sh does. */
export function cleanCell(value: string) {
  const line = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ");
  return /^[=+\-@]/.test(line) ? "'" + line : line;
}
function within(root: string, path: string) {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
/** Bounded wait for a concurrent creator to drop its temporary second link. */
export const CREATOR_LINK_WAIT_MS = 500;
export type TrailOptions = { restrictedSessions?: boolean };
function trailDirectory(ctx: OpenClawPluginToolContext, options: TrailOptions) {
  if (ctx.sandboxed === true)
    throw Error("pstack_trail refused: the session is sandboxed and this host-side writer would bypass the sandbox. Use the native write tool inside the sandbox.");
  // Plugin tools are not told whether a session is read-only: the host's read-only
  // permission mode only removes core write tools and reaches plugins as workspaceOnly.
  if (ctx.fsPolicy?.workspaceOnly !== false && options.restrictedSessions !== true)
    throw Error("pstack_trail refused: this session's filesystem policy is " + (ctx.fsPolicy ? "workspaceOnly" : "unknown")
      + " and the host does not expose read-only mode to plugin tools. Use native file tools, or have the operator set plugins.entries.pstack.config.trailInRestrictedSessions only when no read-only session can call pstack_trail.");
  if (!ctx.workspaceDir) throw Error("pstack_trail refused: requester workspace is unavailable");
  const workspace = realpathSync(ctx.workspaceDir);
  if (ctx.fsPolicy?.workspaceOnly && ctx.fsPolicy.root && !within(realpathSync(ctx.fsPolicy.root), workspace))
    throw Error("pstack_trail refused: requester workspace is outside the effective filesystem root");
  const directory = join(workspace, ".audit");
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = realDirectory(directory);
  if (!stat || realpathSync(directory) !== directory)
    throw Error("pstack_trail refused: .audit must be a real directory inside the requester workspace");
  return { workspace, directory, stat };
}
function realDirectory(directory: string) {
  const stat = lstatSync(directory);
  return stat.isSymbolicLink() || !stat.isDirectory() ? undefined : stat;
}
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
/** Create the log with its header atomically, so concurrent first writers never duplicate or precede it. */
function ensureLog(directory: string, file: string, slug: string) {
  const temporary = join(directory, "." + slug + "." + randomUUID() + ".tmp");
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeSync(fd, TRAIL_HEADER); } finally { closeSync(fd); }
    try { linkSync(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally { unlinkSync(temporary); }
}
/** True only while the one extra link is a creator's temporary sibling of this exact file inside .audit. */
function creatorLinkPresent(directory: string, slug: string, opened: Stats) {
  const prefix = "." + slug + ".";
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    try { if (sameFile(lstatSync(join(directory, name)), opened)) return true; } catch { /* already removed */ }
  }
  return false;
}
async function singleLink(fd: number, directory: string, slug: string) {
  const deadline = Date.now() + CREATOR_LINK_WAIT_MS;
  for (;;) {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return false;
    if (stat.nlink === 1) return true;
    // Any other extra link may point outside .audit: refuse at once. A creator may
    // have just removed its link between the fstat and the directory scan.
    if (stat.nlink !== 2 || Date.now() >= deadline) return false;
    if (!creatorLinkPresent(directory, slug, stat)) return fstatSync(fd).nlink === 1;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
export function registerTrailTool(api: OpenClawPluginApi, options: TrailOptions = {}) {
  api.registerTool(ctx => ({
    name: "pstack_trail", label: "Pstack append-only decision trail",
    description: "Append one sanitized decision row to the requester workspace's .audit/<log>.tsv. Append-only; never rewrites, reads elsewhere or verifies evidence. Rows are agent-attested.",
    parameters: trailParameters,
    prepareArguments: args => { assertArguments(args); return args as Record<string, unknown>; },
    execute: async (_id, params) => {
      ctx.assertInvocationCurrent?.();
      assertArguments(params);
      const { directory, workspace, stat: validated } = trailDirectory(ctx, options);
      const file = join(directory, params.log + ".tsv");
      const existing = (() => { try { return lstatSync(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      } })();
      if (existing && !existing.isFile())
        throw Error("pstack_trail refused: " + params.log + ".tsv must be a regular file, not a link or directory");
      if (!existing) ensureLog(directory, file, params.log);
      const fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        // Hard links would let the append land in a file outside .audit.
        if (!(await singleLink(fd, directory, params.log)))
          throw Error("pstack_trail refused: " + params.log + ".tsv must be a single-link regular file");
        // The path open follows a .audit swapped for a symlink after validation; the
        // opened file must still be the one at the validated real directory's path.
        // Checking the directory on both sides of the name lookup leaves only a double swap
        // inside that window, which Node cannot close without openat (documented).
        const before = realDirectory(directory), named = lstatSync(file), after = realDirectory(directory);
        if (!before || !after || !sameFile(before, validated) || !sameFile(after, validated) || !sameFile(named, fstatSync(fd)))
          throw Error("pstack_trail refused: .audit or " + params.log + ".tsv changed during the append; nothing was written");
        const header = Buffer.alloc(TRAIL_HEADER.length);
        if (readSync(fd, header, 0, header.length, 0) !== header.length || header.toString("utf8") !== TRAIL_HEADER)
          throw Error("pstack_trail refused: " + params.log + ".tsv is not a pstack decision trail; it was not changed");
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, fstatSync(fd).size - 1);
        const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        const row = { ts, phase: cleanCell(params.phase), decision: cleanCell(params.decision), why: cleanCell(params.why),
          evidence: cleanCell(params.evidence), result: cleanCell(params.result) };
        // A torn earlier append keeps its bytes; this row still starts on its own line.
        const text = (last.toString("utf8") === "\n" ? "" : "\n") + TRAIL_COLUMNS.map(c => row[c]).join("\t") + "\n";
        ctx.assertInvocationCurrent?.();
        writeSync(fd, text);
        const details = { status: "APPENDED", log: relative(workspace, file), row, attestation: "agent-attested",
          notice: "Append-only trail row. The tool does not verify that evidence resolves or that the row matches the transcript; audit and cross-family review remain required." };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      } finally { closeSync(fd); }
    },
  }), { names: ["pstack_trail"], optional: true });
}
/** The operator opt-in lives in plugin config; models cannot set it. */
export function trailOptions(config: Record<string, unknown> | undefined): TrailOptions {
  return { restrictedSessions: config?.trailInRestrictedSessions === true };
}
