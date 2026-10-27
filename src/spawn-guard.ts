import { workflowView, ownedRecord, workflowKey, type Owner, type RecordV1, type Selection, type View } from "./workflow.ts";

export const spawnTag = (key: string, snapshotId: string, slot: string) => "[PSTACK_SNAPSHOT:" + key + ":" + snapshotId + ":" + slot + "]";
export function parseSpawnTag(params: Record<string, unknown>) {
  if (typeof params.task !== "string" || !params.task.includes("[PSTACK_SNAPSHOT:")) return undefined;
  const matches = [...params.task.matchAll(/\[PSTACK_SNAPSHOT:([a-f0-9]{64}):([a-f0-9]{64}):([a-z0-9:-]{1,128})\]/g)];
  if (matches.length !== 1 || params.task.split("[PSTACK_SNAPSHOT:").length !== 2) throw Error("Malformed or ambiguous pstack snapshot tag");
  return { key: matches[0]![1]!, snapshotId: matches[0]![2]!, slot: matches[0]![3]! };
}
/**
 * The routing selection a slot must run with. The guard compares spawn arguments with
 * it and the native controller compares host receipts with it, so both use one source.
 */
export function requestedSelection(view: View, slot: string): { role: string; snapshotId: string; requested: Selection } {
  const job = view.jobs.find(x => x.id === slot);
  if (!job) throw Error("Unknown pstack workflow slot");
  const snapshotId = view.currentSnapshots[job.role]!;
  const requested = view.snapshots[snapshotId]!.selections[job.index];
  if (!requested) throw Error("Snapshot selection index is unavailable");
  return { role: job.role, snapshotId, requested };
}
export function checkSpawnRecord(value: unknown, owner: Owner, tag: NonNullable<ReturnType<typeof parseSpawnTag>>, params: Record<string, unknown>) {
  const record = value as RecordV1;
  if (!record) throw Error("Unknown pstack snapshot record");
  ownedRecord(record, owner, record.id);
  if (workflowKey(owner, record.id) !== tag.key) throw Error("Snapshot key mismatch");
  const view = workflowView(record), job = view.jobs.find(x => x.id === tag.slot);
  if (view.status !== "active" || !job || view.attempts[job.id]) throw Error("Tagged spawn is not an active unaccepted slot");
  // A native record is spawned only by its controller, which records the dispatch first.
  if (view.executor === "native" && !view.dispatches[job.id]) throw Error("Native workflow slots are spawned by the pstack controller, not by tagged sessions_spawn");
  const { snapshotId, requested } = requestedSelection(view, job.id);
  if (snapshotId !== tag.snapshotId) throw Error("Unknown or superseded routing snapshot");
  if (params.runtime !== "subagent") throw Error("Native subagent selection required");
  for (const key of ["model", "thinking", "fastMode"] as const)
    if (params[key] !== requested[key]) throw Error("Pstack snapshot drift: " + key + "; blocked without rewriting arguments");
}
