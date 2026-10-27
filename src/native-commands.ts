import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { randomBytes } from "node:crypto";
import { CORRECTABLE, deliverableSlotOf, digest, KINDS, mutateWorkflow, ownedRecord, workflowKey, workflowView, type Event, type EventInput, type Kind, type Owner, type RecordV1, type Setup, type View } from "./workflow.js";
import { deliverable, ensureContinuation, nativeContext, nativeSetup, parseNativeTask, runNative, type WorkflowStore } from "./controller.js";
import { readRequesterCatalog, type HostProfiles, type Invocation } from "./native-runtime.js";
import { WORKFLOW_RETENTION, workflowStore } from "./workflow-tool.js";
import type { Store } from "./state.js";

export const CONTROLLER_KINDS: readonly string[] = KINDS;
const WORKFLOW_ID = /^pw-[a-z0-9]{12}$/;
/** One in-progress native workflow per exact session incarnation keeps resume unambiguous. */
const indexStore = (api: OpenClawPluginApi, assertCurrent?: () => void) => api.runtime.state.openKeyedStoreV2(
  { namespace: "native-active-v1", maxEntries: 1024, overflowPolicy: "reject-new", defaultTtlMs: WORKFLOW_RETENTION.idleTtlMs },
  assertCurrent ? { assertCurrent } : undefined,
);
type IndexValue = { version: 1; owner: Owner; workflowId: string; kind: Kind };
const indexKey = (owner: Owner) => digest(["native-active", owner.sessionKey, owner.sessionId, owner.workspace]);
const terminal = (view: View) => ["completed", "cancelled"].includes(view.status);
const adapter = (store: Store): WorkflowStore => ({
  observe: (key) => store.observe(key),
  apply: (key, comparison, value) => store.compareAndApply(key, comparison as never, {
    operation: "update", action: "set", value: JSON.parse(JSON.stringify(value)),
    ...(terminal(workflowView(value)) ? { ttlMs: WORKFLOW_RETENTION.terminalTtlMs } : {}),
  }),
});

/** The session's in-progress native record; terminal or missing records clear the pointer. */
export async function activeNative(api: OpenClawPluginApi, owner: Owner, assertCurrent?: () => void) {
  const index = indexStore(api, assertCurrent), key = indexKey(owner);
  const observed = await index.observe(key);
  const pointer = observed.value as IndexValue | undefined;
  if (!pointer) return undefined;
  if (pointer.version !== 1 || digest(pointer.owner) !== digest(owner) || !WORKFLOW_ID.test(pointer.workflowId)) throw Error("Corrupt native workflow pointer; refusing to guess");
  const value = await workflowStore(api, assertCurrent).lookup(workflowKey(owner, pointer.workflowId));
  if (value !== undefined) {
    const record = ownedRecord(value, owner, pointer.workflowId), view = workflowView(record);
    if (!terminal(view)) return { record, view };
  }
  await index.compareAndApply(key, observed.comparison, { operation: "delete", action: "delete" });
  return undefined;
}
async function lookupNative(api: OpenClawPluginApi, owner: Owner, id: string, assertCurrent: () => void) {
  const value = await workflowStore(api, assertCurrent).lookup(workflowKey(owner, id));
  if (value === undefined) return undefined;
  const record = ownedRecord(value, owner, id);
  return { record, view: workflowView(record) };
}

export type ResumeRequest = { workflowId?: string; action?: "approve" | "revise" | "cancel" | "correct"; notes?: string };
/** Undefined means the text is an ordinary task, as in v1. */
export function parseResume(arg: string): ResumeRequest | undefined {
  const words = arg.trim().split(/\s+/);
  if (words[0]?.toLowerCase() !== "resume") return undefined;
  let at = 1;
  const request: ResumeRequest = {};
  if (words[at] && WORKFLOW_ID.test(words[at]!)) request.workflowId = words[at++];
  const action = words[at]?.toLowerCase();
  if (action === "approve" || action === "revise" || action === "cancel" || action === "correct") { request.action = action; at++; }
  else if (words[at]) return undefined;
  const notes = words.slice(at).join(" ").trim();
  if (notes) request.notes = notes;
  if ((request.action === "revise" || request.action === "correct") && !request.notes) return undefined;
  return request;
}

export type NativeHost = {
  api: OpenClawPluginApi; root: string; instance: { pid: number; load: string }; profiles: HostProfiles;
  /** The host advertises canonical model families in the requester catalog. */
  family?: boolean;
  waitSeconds?: number; budgetMs?: number;
};
type Reply = { text?: string; continueAgent?: boolean; suppressReply?: boolean };
/**
 * The handoff a reply carries while accepted children are still running: the owner, the pending
 * children with their run ids, the armed continuation, and the exact command that resumes it.
 */
export function handoff(record: RecordV1, view: View, now = Date.now()) {
  const pending = Object.entries(view.attempts).filter(([slot, a]) => !slot.endsWith(":previous") && a.at(-1) && !a.at(-1)!.result && !a.at(-1)!.rejected);
  if (!pending.length || terminal(view)) return undefined;
  const next = view.schedules.filter(s => s.atMs > now).map(s => s.atMs).sort((a, b) => a - b)[0];
  return "Handoff: owner session `" + record.owner.sessionKey + "` (incarnation " + record.owner.sessionId + "), native " + record.setup.kind + " workflow `" + record.id + "`, phase " + view.phase + ". Pending children: " +
    pending.map(([slot, a]) => "`" + slot + "` (" + (view.snapshots[a.at(-1)!.snapshotId]?.role ?? "unknown role") + ", run `" + a.at(-1)!.runId + "`)").join(", ") + ". " +
    (next !== undefined ? "A scheduled continuation collects them unattended (next at " + new Date(next).toISOString() + "). " : "No scheduled continuation is armed. ") +
    "Resume with `/pstack resume " + record.id + "`; never respawn these children.";
}
/** The command reply; a due deliverable is quoted verbatim, since the host delivers this text unedited. */
const summary = (record: RecordV1, view: View, notes: string[]) => {
  const delivered = deliverable(record, view), handedOff = handoff(record, view);
  return [
    "Pstack native " + record.setup.kind + " `" + record.id + "`: phase " + view.phase + ", status " + view.status + " (revision " + view.revision + ").",
    ...notes, ...(handedOff ? [handedOff] : []), ...(delivered ? ["", delivered, ""] : []), view.next,
  ].join("\n");
};

/**
 * Starts a deterministic native workflow. Checkpoints hand off to the agent with
 * continueAgent; panels run here; pending children are handed to resume.
 */
export async function startNative(host: NativeHost, ctx: PluginCommandContext, kind: Kind, args: string, owner: Owner, native: Invocation): Promise<Reply> {
  const assertCurrent = () => ctx.assertOwnerCurrent?.();
  const parsed = parseNativeTask(kind, args);
  if (!parsed.task) return { text: "Pstack native " + kind + " needs a task: /pstack-" + kind + " " + (kind === "architect" ? "[design-only|checkpoint|implement] " : kind === "how" ? "[simple|complex[=2-4]] " : "") + "<task>." };
  if (parsed.task.length > 16000) return { text: "Pstack rejected: task exceeds 16000 characters." };
  const existing = await activeNative(host.api, owner, assertCurrent);
  if (existing) return { text: "A native " + existing.record.setup.kind + " workflow `" + existing.record.id + "` is already in progress in this session (phase " + existing.view.phase + "). Use /pstack resume, or /pstack resume cancel before starting another. Nothing was spawned." };
  let catalog;
  try { catalog = await readRequesterCatalog(native.models!, { family: host.family }); } catch (error) {
    return { text: "BLOCKED: the requester model catalog is temporarily unavailable (" + String(error instanceof Error ? error.message : error) + "). Nothing was spawned; retry the command." };
  }
  if (catalog.state !== "prepared") return { text: "BLOCKED: the requester model catalog is still pending, which is not proof of availability. Nothing was spawned; retry shortly." };
  let setup;
  try { setup = await nativeSetup(kind, parsed.task, parsed.options, owner, catalog.catalog, host.profiles); } catch (error) {
    return { text: "BLOCKED: routing over the requester catalog failed: " + String(error instanceof Error ? error.message : error) + ". Nothing was spawned." };
  }
  assertCurrent();
  const id = "pw-" + randomBytes(6).toString("hex");
  const store = adapter(workflowStore(host.api, assertCurrent));
  let { record } = await mutateWorkflow(store, owner, id, 0, setup, assertCurrent, 2);
  const registered = await indexStore(host.api, assertCurrent).registerIfAbsent(indexKey(owner), { version: 1, owner, workflowId: id, kind } satisfies IndexValue);
  if (!registered) {
    const { record: cancelled } = await mutateWorkflow(store, owner, id, workflowView(record).revision, { id: "cancel-race", type: "cancel", reason: "Another native workflow started concurrently in this session" }, assertCurrent);
    return { text: "Another native workflow started concurrently in this session; `" + cancelled.id + "` was cancelled before spawning anything." };
  }
  return drive(host, ctx, owner, record, native, true, parsed.defaulted ? [parsed.defaulted] : []);
}

/** `/pstack resume [workflowId] [approve|revise|cancel] [notes]`, from the user or a scheduled continuation. */
export async function resumeNative(host: NativeHost, ctx: PluginCommandContext, request: ResumeRequest, owner: Owner, native: Invocation, unattended: boolean): Promise<Reply> {
  const assertCurrent = () => ctx.assertOwnerCurrent?.();
  const found = request.workflowId ? await lookupNative(host.api, owner, request.workflowId, assertCurrent) : await activeNative(host.api, owner, assertCurrent);
  if (!found) return unattended ? {} : { text: "No native pstack workflow to resume in this session." };
  let { record, view } = found;
  if (record.version !== 2) return { text: "`" + record.id + "` is an agent-attested ledger, not a native controller workflow; continue it with pstack_workflow." };
  if (unattended && (request.action || !view.schedules.length)) return {};
  if (!native.subagents) return { text: downgradeRefusal(record, view) };
  if (request.action === "correct" && view.status === "completed") return startCorrection(host, ctx, { record, view }, request.notes!, owner, native);
  if (terminal(view)) return unattended ? {} : { text: summary(record, view, []) };
  const store = adapter(workflowStore(host.api, assertCurrent));
  const append = async (event: EventInput) => {
    ({ record, view } = await mutateWorkflow(store, owner, record.id, view.revision, { id: event.type + "-" + view.revision + "-" + randomBytes(3).toString("hex"), ...event } as Event, assertCurrent));
  };
  if (request.action === "cancel") {
    const pending = Object.values(view.attempts).map(a => a.at(-1)!).filter(a => !a.result && !a.rejected).map(a => a.runId);
    await append({ type: "cancel", reason: "Cancelled by " + ctx.senderId + " via /pstack resume cancel" + (request.notes ? ": " + request.notes : "") });
    await activeNative(host.api, owner, assertCurrent);
    return { text: summary(record, view, pending.length ? ["Accepted children keep native custody and were not stopped: " + pending.join(", ") + "."] : []) };
  }
  if (request.action === "correct") {
    // Reflect's rows wait at approval: one corrected synthesis before anything is applied.
    if (record.setup.kind === "reflect" && view.status === "awaiting-user" && view.phase === "approval") {
      try { await append({ type: "retry", slot: deliverableSlotOf(record.setup)!, reason: "Correction requested by " + ctx.senderId + ": " + request.notes!.slice(0, 3800) }); }
      catch (error) { return { text: "Correction refused: " + String(error instanceof Error ? error.message : error) }; }
      return drive(host, ctx, owner, record, native, true, ["Correction of synthesizer:0 requested by " + ctx.senderId + "; one correction child is spawned with the rows and your notes attached."]);
    }
    return { text: "`" + record.id + "` (phase " + view.phase + ", status " + view.status + ") has no delivered result to correct: correct reflect's rows at approval, or a completed how, why or interrogate workflow by its id. Nothing was recorded." };
  }
  if (request.action) {
    if (view.status !== "awaiting-user") return { text: "`" + record.id + "` is not awaiting a decision (phase " + view.phase + ", status " + view.status + "); nothing was recorded." };
    try { await append({ type: "decide", decision: request.action, by: ctx.senderId!, ...(request.notes ? { notes: request.notes } : {}) }); }
    catch (error) { return { text: "Decision refused: " + String(error instanceof Error ? error.message : error) }; }
  }
  return drive(host, ctx, owner, record, native, !unattended, [], unattended);
}

/**
 * `/pstack resume <id> correct <errors>` on a completed how, why or interrogate workflow: one new
 * correction record for its delivered slot, under the same pinned routing snapshot and profile,
 * then driven like any native workflow. Its id derives from the corrected one, so a result is
 * corrected at most once while that record lasts; the completed record itself is unchanged.
 */
async function startCorrection(host: NativeHost, ctx: PluginCommandContext, source: { record: RecordV1; view: View }, errors: string, owner: Owner, native: Invocation): Promise<Reply> {
  const assertCurrent = () => ctx.assertOwnerCurrent?.();
  const { record: done, view: doneView } = source, slot = deliverableSlotOf(done.setup), spec = CORRECTABLE[done.setup.kind];
  if (done.setup.correction) return { text: "`" + done.id + "` is already the one correction of `" + done.setup.correction.workflowId + "`; it is not corrected again. Nothing was spawned." };
  const attempt = slot && spec && slot === spec.slot ? doneView.attempts[slot]?.at(-1) : undefined, result = attempt?.result;
  if (!attempt || !result?.report) return { text: "`" + done.id + "` has no delivered how, why or interrogate result to correct. Nothing was spawned." };
  if (errors.length > 8000) return { text: "Pstack rejected: correction notes exceed 8000 characters." };
  const existing = await activeNative(host.api, owner, assertCurrent);
  if (existing) return { text: "A native " + existing.record.setup.kind + " workflow `" + existing.record.id + "` is already in progress in this session (phase " + existing.view.phase + "). Finish or cancel it before correcting `" + done.id + "`. Nothing was spawned." };
  const snapshot = doneView.snapshots[attempt.snapshotId]!, pin = done.setup.profiles?.[snapshot.role];
  const models = new Set(snapshot.selections.map(x => x.model).filter(Boolean));
  const setup: Setup = { kind: done.setup.kind, task: done.setup.task!, taskDigest: done.setup.taskDigest, sourceDigest: done.setup.sourceDigest, snapshots: [snapshot],
    catalog: done.setup.catalog.filter(c => models.has(c.id)), options: doneView.options, ...(pin ? { profiles: { [snapshot.role]: pin } } : {}), stagesVersion: 2,
    correction: { workflowId: done.id, slot: slot!, runId: attempt.runId, artifactDigest: result.artifactDigest, report: result.report, errors, by: ctx.senderId! } };
  const id = "pw-" + digest(["pstack-correction", done.id]).slice(0, 12);
  const store = adapter(workflowStore(host.api, assertCurrent));
  let record: RecordV1;
  try { ({ record } = await mutateWorkflow(store, owner, id, 0, setup, assertCurrent, 2)); }
  catch (error) {
    if (/already exists/.test(String(error))) return { text: "`" + done.id + "` was already corrected once, as `" + id + "`; a result gets one correction. Nothing was spawned." };
    throw error;
  }
  const registered = await indexStore(host.api, assertCurrent).registerIfAbsent(indexKey(owner), { version: 1, owner, workflowId: id, kind: done.setup.kind } satisfies IndexValue);
  if (!registered) {
    const { record: cancelled } = await mutateWorkflow(store, owner, id, workflowView(record).revision, { id: "cancel-race", type: "cancel", reason: "Another native workflow started concurrently in this session" }, assertCurrent);
    return { text: "Another native workflow started concurrently in this session; correction `" + cancelled.id + "` was cancelled before spawning anything." };
  }
  return drive(host, ctx, owner, record, native, true, ["Correction `" + id + "` of `" + done.id + "` slot " + slot + " (run " + attempt.runId + ") requested by " + ctx.senderId + "; one correction child is spawned under the same routing snapshot" + (pin ? " and host profile `" + pin.id + "`" : "") + "."]);
}

/** Never continue a native record with skill-guided v1 behavior or new children. */
export function downgradeRefusal(record: RecordV1, view: View) {
  return "BLOCKED: native " + record.setup.kind + " workflow `" + record.id + "` (phase " + view.phase + ", status " + view.status + ") needs the host's command subagent capability, which this invocation lacks. It was not downgraded to skill-guided v1 and no child was recreated. Resume from a host and requester that grant it, or /pstack resume cancel.";
}

async function drive(host: NativeHost, ctx: PluginCommandContext, owner: Owner, start: RecordV1, native: Invocation, interactive: boolean, notes: string[], unattended = false): Promise<Reply> {
  const assertCurrent = () => ctx.assertOwnerCurrent?.();
  const store = adapter(workflowStore(host.api, assertCurrent));
  const before = workflowView(start);
  const step = await runNative({ store, owner, root: host.root, assertCurrent, subagents: native.subagents!, profiles: host.profiles,
    ...(unattended ? {} : { requester: ctx.senderId }), waitSeconds: host.waitSeconds, budgetMs: host.budgetMs }, start);
  let { record, view } = step;
  notes.push(...step.notes);
  if (!unattended && native.scheduledTurns) {
    try {
      const append = async (event: EventInput) => {
        ({ record, view } = await mutateWorkflow(store, owner, record.id, view.revision, { id: "schedule-" + view.revision + "-" + randomBytes(3).toString("hex"), ...event } as Event, assertCurrent));
      };
      const armed = await ensureContinuation({ record, view, scheduledTurns: native.scheduledTurns, instance: host.instance, append });
      if (armed.armed) notes.push("Armed " + armed.armed + " scheduled continuation(s) for unattended collection.");
    } catch (error) {
      notes.push("Scheduled continuation unavailable (" + String(error instanceof Error ? error.message : error) + "); run /pstack resume to continue.");
    }
  } else if (!unattended && !["completed", "cancelled"].includes(view.status)) notes.push("Unattended continuation needs the host scheduled-turn capability; run /pstack resume to continue.");
  if (terminal(view)) await activeNative(host.api, owner, assertCurrent);
  const parentTurn = view.status === "active" && (view.stageKind === "checkpoint" || view.needsConfigure);
  if (interactive && parentTurn) return { continueAgent: true, suppressReply: true };
  if (unattended) {
    // Quiet unless the record changed: a still-running stage writes nothing and says nothing.
    if (view.revision === before.revision) return {};
    return { text: summary(record, view, notes) + (parentTurn ? "\nThe parent checkpoint is ready: run /pstack resume." : "") };
  }
  return { text: summary(record, view, notes) };
}

/** Prompt context for the agent turn following a native command, or any turn while a native workflow is in progress. */
export async function nativePromptContext(api: OpenClawPluginApi, owner: Owner, root: string, assertCurrent?: () => void) {
  const active = await activeNative(api, owner, assertCurrent);
  return active ? nativeContext(active.record, active.view, root) : undefined;
}
