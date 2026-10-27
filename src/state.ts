import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
export type Store = ReturnType<OpenClawPluginApi["runtime"]["state"]["openKeyedStoreV2"]>;
export type Identity = { userId: string; sessionKey: string; sessionId: string; workspace: string };
export type Scope = Omit<Identity, "userId">;
export type Mode = {
  version: 2;
  identity: Identity;
  active: boolean;
  revision: number;
  migration?: string;
};
export const MAX_RECORDS = 1024;
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
// Prompt hooks lack a Control UI profile. Store the activating requester in the
// value; native exact-session access controls subsequent context visibility.
export const keyOf = (i: Scope) => hash(JSON.stringify([i.sessionKey, i.sessionId, i.workspace]));
export function validateIdentity(i: Identity) {
  if (
    !i ||
    Object.keys(i).sort().join(",") !== "sessionId,sessionKey,userId,workspace" ||
    Object.values(i).some((v) => typeof v !== "string" || !v.trim() || v.length > 4096)
  )
    throw Error("Pstack identity is incomplete");
  if (!parseAgentSessionKey(i.sessionKey))
    throw Error("Pstack requires a native agent session key");
  return i;
}
export function validateMode(value: unknown, scope: Scope): Mode | undefined {
  if (value === undefined) return undefined;
  const v = value as Mode;
  try {
    validateIdentity(v.identity);
    if (
      v.version !== 2 ||
      Object.keys(v).some(
        (k) => !["version", "identity", "active", "revision", "migration"].includes(k),
      ) ||
      v.identity.sessionKey !== scope.sessionKey ||
      v.identity.sessionId !== scope.sessionId ||
      v.identity.workspace !== scope.workspace ||
      typeof v.active !== "boolean" ||
      !Number.isSafeInteger(v.revision) ||
      v.revision < 1 ||
      (v.migration !== undefined && !/^[0-9a-f]{64}$/.test(v.migration))
    )
      throw Error("invalid record");
  } catch {
    throw Error("Corrupt pstack session state; refusing activation or mutation");
  }
  return v;
}
export async function readMode(store: Store, scope: Scope) {
  return validateMode(await store.lookup(keyOf(scope)), scope);
}
export async function transition(store: Store, identity: Identity, active: boolean) {
  validateIdentity(identity);
  const key = keyOf(identity);
  for (let attempt = 0; attempt < 8; attempt++) {
    const observed = await store.observe(key);
    const previous = validateMode(observed.value, identity);
    if (previous && previous.identity.userId !== identity.userId)
      throw Error("Pstack mode belongs to another activating requester");
    // No invented native event IDs. Native ingress owns event replay; duplicate
    // desired values are idempotent, not old-event-after-off replay protection.
    if (previous?.active === active) return previous;
    if (!previous && !active) return undefined;
    if (!previous && (await store.count()) >= MAX_RECORDS)
      throw Error(
        "Pstack retained-state limit reached; /pstack off remains available and triggers bounded stale-incarnation cleanup. Current records are never evicted.",
      );
    if (previous?.revision === Number.MAX_SAFE_INTEGER) throw Error("Pstack revision exhausted");
    const next: Mode = { version: 2, identity, active, revision: (previous?.revision ?? 0) + 1 };
    const result = await store.compareAndApply(key, observed.comparison, {
      operation: "update",
      action: "set",
      value: next,
    });
    if (result.status !== "conflict") return next;
  }
  throw Error("Pstack state changed concurrently; retry the command");
}
// Owner-driven bounded cleanup; no timer and no arbitrary active-row eviction.
export async function cleanupStale(
  store: Store,
  current: (sessionKey: string) => Promise<string | undefined>,
  cursor = "",
) {
  const rows = await store.entriesInKeyRange({
    keyStartInclusive: cursor,
    keyEndExclusive: "g",
    limit: 64,
  });
  let removed = 0;
  let lookupFailed = 0;
  for (const row of rows) {
    let mode: Mode | undefined;
    try {
      const v = row.value as Mode;
      mode = validateMode(v, v.identity);
    } catch {
      continue;
    }
    if (!mode) continue;
    let id: string | undefined;
    try {
      id = await current(mode.identity.sessionKey);
    } catch {
      lookupFailed++;
      continue;
    }
    if (id === mode.identity.sessionId) continue;
    const observed = await store.observe(row.key);
    if (JSON.stringify(observed.value) !== JSON.stringify(row.value)) continue;
    if (
      (
        await store.compareAndApply(row.key, observed.comparison, {
          operation: "delete",
          action: "delete",
        })
      ).status === "applied"
    )
      removed++;
  }
  return {
    removed,
    lookupFailed,
    cursor: rows.length === 64 ? rows[rows.length - 1]!.key + "\0" : "",
  };
}
// Matches Python ensure_ascii=True / sort_keys=True, including surrogate escapes.
function canonical(value: Record<string, string>) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
  ).replace(
    /[\u007f-\uffff]/g,
    (c) => String.fromCharCode(92) + "u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
async function legacyRoot(workspace: string) {
  const root = join(workspace, ".pstack-session-state"),
    dir = await lstat(root);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (dir.mode & 0o077) !== 0 ||
    dir.uid !== process.getuid?.()
  )
    throw Error("Unsafe legacy state directory");
  return root;
}
async function readLegacy(root: string, file: string, workspace: string, expected?: Identity) {
  if (!/^[0-9a-f]{64}\.json$/.test(file)) throw Error("Invalid legacy filename");
  const fd = await open(join(root, file), constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const st = await fd.stat();
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.size > 32768 ||
      (st.mode & 0o077) !== 0 ||
      st.uid !== process.getuid?.()
    )
      throw Error("Unsafe legacy record");
    raw = await fd.readFile("utf8");
  } finally {
    await fd.close();
  }
  const old = JSON.parse(raw!);
  const identity = validateIdentity(old.identity);
  if (
    ![1, 2].includes(old.version) ||
    identity.workspace !== workspace ||
    file !== hash(canonical(identity)) + ".json" ||
    (expected && canonical(identity) !== canonical(expected)) ||
    typeof old.active !== "boolean" ||
    !Number.isSafeInteger(old.revision) ||
    old.revision < 1 ||
    !old.lastEvent ||
    !Number.isSafeInteger(old.lastEvent.timestampMs) ||
    !Number.isSafeInteger(old.lastEvent.seq ?? 0) ||
    (old.lastEvent.seq ?? 0) < 0 ||
    Object.keys(old).sort().join(",") !== "active,identity,lastEvent,revision,version"
  )
    throw Error("Invalid legacy record");
  if (
    typeof old.lastEvent.id !== "string" ||
    !old.lastEvent.id ||
    !Number.isSafeInteger(old.lastEvent.timestampMs) ||
    old.lastEvent.timestampMs < 0 ||
    !/^[0-9a-f]{64}$/.test(old.lastEvent.digest)
  )
    throw Error("Invalid legacy event");
  const mode: Mode = {
    version: 2,
    identity,
    active: old.active,
    revision: old.revision,
    migration: hash(raw!),
  };
  validateMode(mode, identity);
  return mode;
}
async function importMode(store: Store, mode: Mode) {
  const identity = mode.identity;
  if ((await store.count()) >= MAX_RECORDS && !(await store.lookup(keyOf(identity))))
    throw Error("Pstack retained-state limit reached");
  if (await store.registerIfAbsent(keyOf(identity), mode)) return { imported: true, mode };
  const current = await readMode(store, identity);
  if (
    current &&
    current.migration === mode.migration &&
    current.active === mode.active &&
    current.revision === mode.revision &&
    current.identity.userId === identity.userId
  )
    return { imported: false, mode: current };
  throw Error("Destination state already exists; refusing overwrite");
}
export async function importLegacy(store: Store, input: Identity) {
  validateIdentity(input);
  const identity = { ...input, workspace: await realpath(input.workspace) };
  const root = await legacyRoot(identity.workspace);
  return importMode(
    store,
    await readLegacy(root, hash(canonical(identity)) + ".json", identity.workspace, identity),
  );
}
type CurrentEntry = { sessionId: string; workspace: string; archivedAt?: number };
type ImportOutcome = {
  file: string;
  identity?: Identity;
  imported?: boolean;
  active?: boolean;
  revision?: number;
  skipped?: string;
  error?: string;
};
export async function importCurrentLegacy(
  store: Store,
  workspace: string,
  current: (key: string) => Promise<CurrentEntry | undefined>,
) {
  workspace = await realpath(workspace);
  const root = await legacyRoot(workspace);
  const files: string[] = [];
  let scanned = 0;
  for await (const file of await opendir(root)) {
    if (++scanned > 8192) throw Error("Legacy directory scan limit exceeded; no records imported");
    if (file.name.endsWith(".json")) files.push(file.name);
    if (files.length > MAX_RECORDS)
      throw Error("Legacy record limit exceeded; no records imported");
  }
  const outcomes: ImportOutcome[] = [];
  for (const file of files.sort()) {
    const outcome: ImportOutcome = { file };
    try {
      const mode = await readLegacy(root, file, workspace);
      outcome.identity = mode.identity;
      if (!mode.active) outcome.skipped = "inactive";
      else {
        const entry = await current(mode.identity.sessionKey);
        if (!entry || entry.sessionId !== mode.identity.sessionId)
          outcome.skipped = "absent or superseded incarnation";
        else if (entry.archivedAt !== undefined) outcome.skipped = "archived";
        else {
          if (entry.workspace !== mode.identity.workspace)
            throw Error(
              "Legacy workspace differs from the current native session workspace; refusing unreachable import",
            );
          // Re-read immediately before publication; never silently migrate a source
          // changed during native metadata preparation. The cutover excludes commands.
          const checked = await readLegacy(root, file, workspace, mode.identity);
          if (checked.migration !== mode.migration)
            throw Error("Legacy source changed during migration; retry after quiescence");
          const result = await importMode(store, checked);
          outcome.imported = result.imported;
          outcome.active = result.mode.active;
          outcome.revision = result.mode.revision;
        }
      }
    } catch (error) {
      outcome.error = String(error instanceof Error ? error.message : error);
    }
    outcomes.push(outcome);
  }
  return {
    imported: outcomes.filter((o) => o.imported === true).length,
    unchanged: outcomes.filter((o) => o.imported === false).length,
    skipped: outcomes.filter((o) => o.skipped !== undefined).length,
    errors: outcomes.filter((o) => o.error !== undefined).length,
    outcomes,
  };
}
