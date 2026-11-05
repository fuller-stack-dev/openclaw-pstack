import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { hash, type Scope } from "./state.js";
import { READ_ONLY_ROUTES, type RouteName } from "./route-commands.js";

const TTL_MS = 5 * 60_000;
// Namespace options are immutable across registrations, independent of Mode.
const STORE = Object.freeze({ namespace: "read-only-turn-v1", maxEntries: 1024, overflowPolicy: "reject-new", defaultTtlMs: TTL_MS } as const);
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const keyOf = (scope: Pick<Scope, "sessionKey" | "sessionId">) => hash(JSON.stringify([scope.sessionKey, scope.sessionId]));
const open = (api: OpenClawPluginApi, assertCurrent?: () => void) =>
  api.runtime.state.openKeyedStoreV2(STORE, assertCurrent ? { assertCurrent } : undefined);
type Turn = Scope & { version: 1; route: RouteName; question: string; expires: number };
export type ReadOnlyTurnOutcome =
  | { kind: "none" }
  | { kind: "claimed"; route: RouteName; workspace: string }
  | { kind: "refused"; notice: string };
const code = (error: unknown) => {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : "unavailable";
};
const unavailable = (reason: string): ReadOnlyTurnOutcome => ({ kind: "refused", notice:
  "Pstack could not verify a pending read-only route command for this turn (" + reason + "). If the user's message is a /pstack-poteto-help or /pstack-setup-pstack request, answer it read-only, without editing files or configuration, and say its route context was unavailable; suggest running it again. In every case, do not start, continue or resume Pstack work or its children, create Pstack schedules or automations, or toggle pstack mode from this turn. No command has been replayed." });
function parse(value: unknown, scope: Pick<Scope, "sessionKey" | "sessionId">): Turn | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Turn;
  if (Object.keys(row).sort().join(",") !== "expires,question,route,sessionId,sessionKey,version,workspace" ||
      row.version !== 1 || row.sessionKey !== scope.sessionKey || row.sessionId !== scope.sessionId ||
      ![row.sessionKey, row.sessionId, row.workspace].every(v => typeof v === "string" && v.trim() && v.length <= 4096) ||
      !READ_ONLY_ROUTES.includes(row.route) || typeof row.question !== "string" || row.question.length > 400 ||
      !Number.isSafeInteger(row.expires) || row.expires < 0 || row.expires > Date.now() + TTL_MS) return undefined;
  return row;
}
export async function recordReadOnlyTurn(api: OpenClawPluginApi, scope: Scope, route: RouteName, suffix: string, assertCurrent?: () => void): Promise<void> {
  assertCurrent?.();
  const value: Turn = { version: 1, ...scope, route, question: squash(suffix).slice(0, 400), expires: Date.now() + TTL_MS };
  if (!parse(value, scope)) throw Error("Invalid pstack read-only route scope");
  try {
    await open(api, assertCurrent).register(keyOf(scope), value);
  } catch (error) {
    assertCurrent?.();
    if (code(error) === "PLUGIN_STATE_LIMIT_EXCEEDED")
      throw Error("Pstack read-only route unavailable: 1024 pending route turns are retained; retry in a few minutes. Mode was not changed.");
    throw error;
  }
  assertCurrent?.();
}
export async function takeReadOnlyTurn(
  api: OpenClawPluginApi, turn: Pick<Scope, "sessionKey" | "sessionId"> & { workspace?: string }, message: string,
  fence: { assertActive?: () => void; resolveScope: () => Promise<Scope> },
): Promise<ReadOnlyTurnOutcome> {
  const current = async () => {
    fence.assertActive?.();
    const scope = await fence.resolveScope();
    fence.assertActive?.();
    if (scope.sessionKey !== turn.sessionKey || scope.sessionId !== turn.sessionId) throw Error("scope");
    return scope;
  };
  try {
    fence.assertActive?.();
    const store = open(api, fence.assertActive), key = keyOf(turn), request = squash(message);
    let observed = await store.observe(key);
    fence.assertActive?.();
    for (let attempt = 0; attempt < 4; attempt++) {
      if (observed.value === undefined) return { kind: "none" };
      const row = parse(observed.value, turn);
      if (!row) return unavailable("unreadable");
      if (row.expires <= Date.now() || (row.question && !request.includes(row.question))) return { kind: "none" };
      const pre = turn.workspace === undefined ? undefined : await current();
      fence.assertActive?.();
      if (row.expires <= Date.now()) return { kind: "none" };
      const result = await store.compareAndApply(key, observed.comparison, { operation: "delete", action: "delete" });
      fence.assertActive?.();
      if (result.status === "unchanged") return { kind: "none" };
      if (result.status === "conflict") { observed = result.current; continue; }
      if (!pre) return unavailable("scope");
      const post = await current();
      if (row.expires <= Date.now()) return { kind: "none" };
      if (pre.workspace !== row.workspace || post.workspace !== row.workspace) return { kind: "refused", notice:
        "Pstack read-only route /pstack-" + row.route + " was not applied: this session's workspace changed after the command. Answer the user's question read-only. Do not edit files or configuration, start, continue or resume Pstack work, spawn children, create schedules or automations, or toggle pstack mode. Say the route context was not applied and suggest running the command again." };
      return { kind: "claimed", route: row.route, workspace: post.workspace };
    }
    return unavailable("contended");
  } catch (error) {
    // A retired invocation must escape, not manufacture a supposedly active refusal.
    fence.assertActive?.();
    api.logger.warn("Pstack read-only route lookup unavailable: " + code(error));
    return unavailable(code(error));
  }
}
