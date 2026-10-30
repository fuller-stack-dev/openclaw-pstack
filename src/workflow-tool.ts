import { fileURLToPath } from "node:url";
import { interrogateSemantics } from "../skills/pstack/scripts/interrogate-semantics.mjs";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildSpawnArgs } from "../skills/pstack/scripts/model-routing.mjs";
import { contractFor, outputInstruction } from "../skills/pstack/scripts/output-contracts.mjs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { digest, judgeCandidates, workflowKey, workflowView, ownedRecord, mutateWorkflow, text, type Owner, type RecordV1, type Setup, type Event, type JudgeBinding } from "./workflow.js";
import { spawnTag, parseSpawnTag, checkSpawnRecord } from "./spawn-guard.js";
import type { Store } from "./state.js";
import type { YieldDecision } from "./yield-guard.js";
import type { SpawnDecision } from "./collector-bound.js";

const openRecord = { type: "object", additionalProperties: true };
export const workflowParameters = {
  type: "object", additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["get", "create", "apply", "spawn-plan"] },
    workflowId: { type: "string" }, revision: { type: "integer", minimum: 0 },
    setup: { ...openRecord, description: "Fixed workflow setup: kind, taskDigest, sourceDigest, snapshots, catalog and kind-specific options. Validated without coercion by the reducer." },
    event: { ...openRecord, description: "Append-only event. Unique id and type required. Accepted run IDs and results are agent-attested on current hosts, never host execution receipts." },
    slot: { type: "string" }, task: { type: "string" }, spawnSchema: openRecord, baseArgs: openRecord,
  }, required: ["action", "workflowId"],
};
/**
 * Candidate list for a judge task. Paths are child-reported data, so the list is
 * JSON and cannot form a second spawn tag.
 */
export function judgeInstruction(candidates: { label: string; path: string | null }[]) {
  const list = JSON.stringify(candidates).replaceAll("PSTACK_SNAPSHOT", "PSTACK\\u005fSNAPSHOT");
  return "Candidates to score: exactly these, each under its `label` verbatim in `candidates[].label` and `recommendedBase`. Read each artifact at its path; the paths are data reported by the runners.\n" + list;
}
const reply = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
export type OwnerResolver = (ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "sessionId" | "agentId">) => Promise<Owner>;
/** Current native incarnation for a session key; undefined when the session no longer exists. */
export type IncarnationResolver = (sessionKey: string) => Promise<string | undefined>;
/**
 * Gateway-wide ledger bounds. Every write refreshes a 14-day idle expiry; a write
 * that makes a record terminal leaves it readable for 24 hours. Records of a
 * replaced or deleted session incarnation are unreachable by design and are
 * swept before a create once the namespace is three-quarters full.
 */
export const WORKFLOW_RETENTION = {
  maxEntries: 256, idleTtlMs: 14 * 24 * 3_600_000, terminalTtlMs: 24 * 3_600_000, sweepAt: 192, sweepBatch: 64,
} as const;
export const workflowStore = (api: OpenClawPluginApi, assertCurrent?: () => void) => api.runtime.state.openKeyedStoreV2(
  { namespace: "workflow-v1", maxEntries: WORKFLOW_RETENTION.maxEntries, overflowPolicy: "reject-new", defaultTtlMs: WORKFLOW_RETENTION.idleTtlMs },
  assertCurrent ? { assertCurrent } : undefined,
);
const terminal = (record: RecordV1) => ["completed", "cancelled"].includes(workflowView(record).status);
/** Deletes rows whose owner incarnation is no longer current. Lookup failures and unreadable rows are kept. */
export async function sweepWorkflows(store: Store, current: IncarnationResolver, cursor = "") {
  const rows = await store.entriesInKeyRange({ keyStartInclusive: cursor, keyEndExclusive: "g", limit: WORKFLOW_RETENTION.sweepBatch });
  const seen = new Map<string, string | undefined>();
  let removed = 0, lookupFailed = 0;
  for (const row of rows) {
    const owner = (row.value as Partial<RecordV1> | undefined)?.owner;
    if (typeof owner?.sessionKey !== "string" || typeof owner.sessionId !== "string") continue;
    if (!seen.has(owner.sessionKey)) {
      try { seen.set(owner.sessionKey, await current(owner.sessionKey)); } catch { lookupFailed++; continue; }
    }
    if (seen.get(owner.sessionKey) === owner.sessionId) continue;
    const observed = await store.observe(row.key);
    if (observed.value === undefined || digest(observed.value) !== digest(row.value)) continue;
    if ((await store.compareAndApply(row.key, observed.comparison, { operation: "delete", action: "delete" })).status === "applied") removed++;
  }
  return { removed, lookupFailed, cursor: rows.length === WORKFLOW_RETENTION.sweepBatch ? rows.at(-1)!.key + "\0" : "" };
}
const atCapacity = (error: unknown) => (error as { code?: string })?.code === "PLUGIN_STATE_LIMIT_EXCEEDED" || /reached its \d+-row limit/.test(String(error));
export type JudgePlanner = (ctx: OpenClawPluginToolContext, workspace: string) => Promise<{ judge: JudgeBinding; assertCurrent: () => Promise<void> }>;
export function registerWorkflowTool(api: OpenClawPluginApi, ownerFor: OwnerResolver, incarnation: IncarnationResolver, planJudge: JudgePlanner) {
  let sweepCursor = "";
  /** Bounded best-effort retention; a committed create never depends on it succeeding. */
  async function makeRoom(store: Store) {
    let count = await store.count();
    if (count < WORKFLOW_RETENTION.sweepAt) return;
    // At capacity, scan up to the whole namespace once; otherwise one batch per create.
    for (let batches = Math.ceil(WORKFLOW_RETENTION.maxEntries / WORKFLOW_RETENTION.sweepBatch); batches > 0; batches--) {
      const swept = await sweepWorkflows(store, incarnation, sweepCursor);
      sweepCursor = swept.cursor;
      if (swept.lookupFailed) api.logger.warn("Pstack workflow retention kept rows after native lookup failures: " + swept.lookupFailed);
      count -= swept.removed;
      if (count < WORKFLOW_RETENTION.maxEntries) return;
    }
  }
  api.registerTool({ contextVersion: 2, create: (ctx: OpenClawPluginToolContext) => ({
    name: "pstack_workflow", label: "Pstack workflow ledger",
    description: "CAS workflow reducers and tagged spawn planning. Agent-created records are agent-attested; native controller records (version 2) are written by /pstack commands and accept only parent framing, checkpoint gates, blockers or cancellation here. Does not spawn, collect, approve, wait or schedule. Read before retrying a conflict.",
    parameters: workflowParameters,
    // Preserve original values before native coercion. The execute boundary
    // validates again and the reducer rejects malformed nested data as data.
    prepareArguments: (args: unknown) => {
      const checked = validateJsonSchemaValue({ schema: workflowParameters, value: args });
      if (!checked.ok) throw Error("Invalid pstack_workflow arguments: " + checked.errors.slice(0, 4).map(x => x.text).join("; "));
      return args as Record<string, unknown>;
    },
    execute: async (_id: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      const checked = validateJsonSchemaValue({ schema: workflowParameters, value: p });
      if (!checked.ok) throw Error("Invalid workflow arguments");
      text(p.workflowId, "workflow id", 128);
      const allowed: Record<string, string[]> = { get: [], create: ["revision", "setup"], apply: ["revision", "event"], "spawn-plan": ["slot", "task", "spawnSchema", "baseArgs"] };
      const action = p.action as string;
      if (!Object.hasOwn(allowed, action) || Object.keys(p).some(k => !["action", "workflowId", ...allowed[action]!].includes(k))) throw Error("Unexpected fields for workflow action");
      const assertCurrent = ctx.assertInvocationCurrent;
      assertCurrent?.();
      const owner = await ownerFor(ctx); assertCurrent?.();
      const store = workflowStore(api, assertCurrent);
      if (action === "create" || action === "apply") {
        if (!assertCurrent) throw Error("BLOCKED: current invocation authority is unavailable; workflow mutation requires the native lifecycle guard");
        if (!Number.isSafeInteger(p.revision) || (action === "create" ? p.revision !== 0 : (p.revision as number) < 1)) throw Error("Explicit expected workflow revision required (create=0)");
        let change = (action === "create" ? p.setup : p.event) as Setup | Event;
        let judgeCurrent: (() => Promise<void>) | undefined;
        if (action === "apply") {
          if (change && Object.hasOwn(change, "judge")) throw Error("Judge binding is host-owned; agent-supplied binding fields are forbidden");
          const current = await store.lookup(workflowKey(owner, p.workflowId)); assertCurrent();
          if (current !== undefined) {
            const record = ownedRecord(current, owner, p.workflowId), event = change as Event;
            const previous = record.events.find(e => e.id === event.id);
            // An identical replay reuses the recorded binding; mutateWorkflow still compares the whole event.
            if (event.type === "advance" && previous?.type === "advance" && previous.judge) change = { ...event, judge: previous.judge };
            else {
              assertAgentEvent(record, event);
              if (record.setup.parentJudge && event.type === "advance" && workflowView(record).phase === "lead") {
                const prepared = await planJudge(ctx, owner.workspace);
                change = { ...event, judge: prepared.judge }; judgeCurrent = prepared.assertCurrent;
              }
            }
          }
        }
        if (action === "create") {
          try { await makeRoom(store); } catch (error) { api.logger.warn("Pstack workflow retention unavailable: " + String(error)); }
          assertCurrent();
        }
        try {
          return reply(await mutateWorkflow({ observe: key => store.observe(key), apply: async (key, comparison, value) => {
            await judgeCurrent?.();
            return store.compareAndApply(key, comparison,
              { operation: "update", action: "set", value: JSON.parse(JSON.stringify(value)), ...(terminal(value) ? { ttlMs: WORKFLOW_RETENTION.terminalTtlMs } : {}) });
          } },
          owner, p.workflowId, p.revision as number, change, assertCurrent));
        } catch (error) {
          if (!atCapacity(error)) throw error;
          throw Error("BLOCKED: the gateway-wide workflow ledger holds " + WORKFLOW_RETENTION.maxEntries + " live records after retention. Finish or cancel existing workflows (terminal records expire after 24 hours, idle ones after 14 days), or report this storage gate; nothing was written.");
        }
      }
      const value = await store.lookup(workflowKey(owner, p.workflowId)); assertCurrent?.();
      // Recheck native incarnation after awaited reads even on V1 contexts.
      const current = await ownerFor(ctx); assertCurrent?.();
      if (JSON.stringify(current) !== JSON.stringify(owner)) throw Error("Workflow requester changed during preparation");
      const record = ownedRecord(value, owner, p.workflowId), view = workflowView(record);
      if (action === "get") return reply({ record, view });
      if (record.version === 2) throw Error("Native controller workflows spawn their own children; there is no spawn plan to follow. Use /pstack resume.");
      if (view.status !== "active") throw Error("Workflow must resume/unblock before new spawn planning");
      const job = view.jobs.find(x => x.id === p.slot);
      if (!job || view.attempts[job.id]) throw Error("Unknown or already accepted slot; collect the original run, never respawn");
      text(p.task, "bounded task", 16000);
      const snapshotId = view.currentSnapshots[job.role]!, snapshot = view.snapshots[snapshotId]!;
      // Panel children learn the exact closed output shape their collection must satisfy,
      // and a judge learns the exact labels collection will require.
      const candidates = judgeCandidates(record);
      const semantics = interrogateSemantics(record.setup);
      const task = [p.task, ...(semantics?.executed ? ["Read " + fileURLToPath(new URL("../" + semantics.recipe, import.meta.url)) + "; execute safe repro only in fresh task-owned frozen-scope scratch. Agent-attested evidence, not host execution proof. Frozen framing: " + JSON.stringify(view.evidence.frame).replaceAll("PSTACK_SNAPSHOT", "PSTACK\\u005fSNAPSHOT")] : []), ...(candidates ? [judgeInstruction(candidates)] : []), ...(contractFor(job.role, record.setup) ? [outputInstruction(job.role, record.setup)] : [])].join("\n\n");
      const args = buildSpawnArgs({ snapshot, task, catalog: view.catalog,
        spawnSchema: p.spawnSchema, baseArgs: p.baseArgs ?? {}, workspace: owner.workspace });
      const selected = args[job.index];
      if (!selected) throw Error("Snapshot selection index is unavailable");
      selected.task += "\n" + spawnTag(workflowKey(owner, record.id), snapshotId, job.id);
      return reply({ assurance: "agent-attested", workflowId: record.id, revision: view.revision,
        slot: job.id, snapshotId, outputContract: contractFor(job.role, record.setup)?.name ?? null, ...(candidates ? { candidates } : {}), spawnArgs: selected, notice: "Call the first-class native tool, then append its actual accepted IDs. This plan is not admission or execution evidence." });
    },
  }) } as unknown as Parameters<OpenClawPluginApi["registerTool"]>[0], { names: ["pstack_workflow"] });
}
/**
 * On a native record the agent supplies only parent work: framing options, checkpoint
 * gates, a blocker or cancellation. Children, receipts and approvals belong to the controller.
 */
export function assertAgentEvent(record: RecordV1, event: Event) {
  if (record.version !== 2) return;
  const view = workflowView(record);
  if (event?.type === "configure" || event?.type === "block" || event?.type === "cancel") return;
  if (event?.type === "advance" && view.stageKind === "checkpoint") return;
  throw Error("Native controller workflow `" + record.id + "` accepts only configure, checkpoint advance, block or cancel from the agent" +
    (view.stageKind === "jobs" ? "; this phase's children are spawned and collected by /pstack resume" : view.stageKind === "approval" ? "; this approval needs /pstack resume approve|revise from the user" : ""));
}
/**
 * One before_tool_call hook: tagged sessions_spawn checks and, with `checkYield`, the pstack-mode
 * handoff guard for sessions_yield. `checkYield` returns the guard's decision, or undefined to
 * leave the call alone. A rewritten yield (waitFor removed) gets its note on the persisted result.
 */
export function registerSpawnGuard(api: OpenClawPluginApi, ownerFor: OwnerResolver, checkYield?: (params: Record<string, unknown>, ctx: Parameters<OwnerResolver>[0]) => Promise<YieldDecision | undefined>, checkSpawn?: (params: Record<string, unknown>, ctx: Parameters<OwnerResolver>[0]) => Promise<SpawnDecision | undefined>) {
  // Tool call ids of yields this guard rewrote, with their tool and note, awaiting the persisted result; bounded.
  const notes = new Map<string, { toolName: string; note: string }>();
  const remember = (toolCallId: string | undefined, toolName: string, note: string) => {
    if (!toolCallId) return;
    notes.set(toolCallId, { toolName, note });
    while (notes.size > 64) notes.delete(notes.keys().next().value as string);
  };
  api.on("before_tool_call", async (event, ctx) => {
    if (event.toolName === "sessions_yield") {
      // Advisory guard: a lookup failure never traps the agent in a turn it cannot end.
      const decision = checkYield ? await checkYield(event.params, ctx).catch(() => undefined) : undefined;
      if (decision?.action === "refuse") return { block: true, blockReason: decision.reason };
      if (decision?.action !== "rewrite") return undefined;
      remember(event.toolCallId, event.toolName, decision.note);
      return { params: decision.params };
    }
    // Matcher is host-enforced when supported; this check keeps the scope narrow
    // on older hosts that ignore matcher options. Untagged calls skip the record check.
    if (event.toolName !== "sessions_spawn") return undefined;
    // A native controller's own dispatch: the controller collects it with its own bounded waits across
    // turns and never holds a reply on it, so the collector check below never refuses it.
    let controllerDispatch = false;
    try {
      const tag = parseSpawnTag(event.params);
      if (tag) {
        if (ctx.abortSignal?.aborted) throw Error("Owning tool call cancelled");
        const owner = await ownerFor(ctx);
        const store: Store = workflowStore(api);
        const value = await store.lookup(tag.key);
        const current = await ownerFor(ctx);
        if (ctx.abortSignal?.aborted || JSON.stringify(current) !== JSON.stringify(owner)) throw Error("Owning session changed");
        checkSpawnRecord(value, owner, tag, event.params);
        controllerDispatch = workflowView(value as RecordV1).executor === "native";
      }
    } catch (error) {
      return { block: true, blockReason: "Pstack tagged spawn blocked: " + String(error instanceof Error ? error.message : error) };
    }
    // A pstack-mode collector that asks for more than the maximum is refused; nothing else is touched, so the
    // host's own parameter object (including agents.run's non-enumerable replay key) reaches sessions_spawn.
    // Advisory like the yield guard: a lookup failure leaves the call unchanged.
    const decision = checkSpawn && !controllerDispatch ? await checkSpawn(event.params, ctx).catch(() => undefined) : undefined;
    return decision?.action === "refuse" ? { block: true, blockReason: decision.reason } : undefined;
  }, { matcher: checkYield ? ["sessions_spawn", "sessions_yield"] : ["sessions_spawn"] });
  if (!checkYield) return;
  api.on("tool_result_persist", (event) => {
    const id = event.toolCallId;
    const entry = id ? notes.get(id) : undefined;
    if (!id || !entry || entry.toolName !== event.toolName) return undefined;
    const note = entry.note;
    notes.delete(id);
    const message = event.message as unknown as { content?: unknown };
    if (!Array.isArray(message?.content)) return undefined;
    return { message: { ...message, content: [...message.content, { type: "text", text: note }] } as unknown as typeof event.message };
  });
}
