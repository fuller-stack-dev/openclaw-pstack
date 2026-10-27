# Workflow ledger

pstack_workflow keeps two kinds of record in one CAS store. Version 1 records are
**agent-attested**: the agent appends every event, and an opt-in tagged spawn guard
checks its spawns. Version 2 records belong to the [native
controllers](session-mode.md#native-controllers), which write child events from host
receipts (see Native controller records below). Native OpenClaw still admits,
executes and collects every child. The complete [workflow
recipes](workflows.md), [routing](model-routing.md) and [authority
contract](contract.md) remain mandatory. Ledger completion alone is not route
completion or behavioral proof.

## Boundary and compatibility

- Keyed-store V2 is required at registration, as for mode. Mutations additionally
  require the native tool context's invocation-current guard. Missing authority
  is BLOCKED, never a synthetic identity or administrator fallback.
- Resolve ownership from the native session entry and canonical workspace, not
  from arguments. Keys bind exact session key, incarnation, workspace and bounded
  workflow ID. Reset/child/workspace records do not inherit a parent's ledger.
- Every view is **agent-attested**. Accepted run/session IDs, artifact digests,
  evidence references, user decisions and supplied catalogs are agent assertions,
  not host-verified execution/control receipts. Verify them using native tools
  and actual artifacts. User decisions here do not grant host authorization.
- Command execution (S1), the requester catalog (S2), owned-child recovery (S4)
  and scheduled continuation (S6) belong to the native controllers. For a version 1
  record, lost native acceptance before persistence cannot be reconciled here
  alone; do not guess IDs or respawn blindly.
- No reply_dispatch hook, installer or product-file writer. Version 1 records have
  no unattended continuation: report it **BLOCKED** when requested. Generic cron is
  not a replacement, and this tool installs no job.

## Tool actions

Arguments are non-coercing and action-specific. Unknown fields fail; nested
setup/events receive full structural reducer validation after schema admission.

1. **create**: workflowId, revision **0**, setup with kind, SHA-256 taskDigest
   and sourceDigest, immutable pstack_route snapshots, their catalog and explicit
   kind-specific options. Existing IDs must be read, not recreated. Digests
   identify the bounded task/frozen source, not permission to act.
2. **get**: workflowId only. Returns replay-validated record, revision, phase,
   jobs, gates, snapshots, blockers and next native action. No state writes.
3. **spawn-plan**: workflowId, slot, bounded task, actual inspected spawnSchema
   and optional baseArgs. Returns one selected native sessions_spawn argument
   object plus tag, not admission or execution evidence. Resolve every new role
   through pstack_route; saved phases preserve their immutable selection.
4. **apply**: workflowId, expected revision, uniquely identified event. Stale
   revisions/CAS conflicts fail without overwriting another writer. Identical
   event-ID replay is read-only; different data under the ID fails. Native-store
   CAS and invocation guards own atomic publication.

## Setup and phase gates

| Kind | Options and mandatory topology |
| --- | --- |
| architect | Explicit intent design-only/checkpoint/implement. Ground how and rationale; two distinct whole-shape packages; cross-judge; lead comparison/red flags; caller-first synthesis. Design-only ends there. Checkpoint requires a user decision; implementation records existing scope authority and verification/deviations. |
| arena | Frame/isolation/rubric; two admitted candidates, both settled before judge. Terminal dropout needs explicit evidence and at least one usable artifact. Judge, independent lead scores, base/grafts/rejections and real-artifact verification remain required. |
| interrogate | Intent/frozen head/rubric; two reviewers; four-bucket verdict, model-attributed agreement map and source validation. |
| swarm | 1–64 unique slices with exact SHA/method; predicate/coverage/race rule; worker per slice; integration/coverage. Reject mismatches, retry once, then block/report gap. |
| how | Explicit simple/complex. Simple needs one independent explainer; complex needs 2–4 explorers collected before it. Present required sections with light edits only. |
| why | All seven source categories and access/irrelevance reasons; one investigator per available source including source control; separate synthesizer; confidence/citations/contradictions/gaps. Trivial exception is outside this ledger: use the complete native recipe explicitly, never fake investigator results. |
| reflect | Three judgment/tooling/divergent lenses; fourth synthesis child; accepted/rejected/backlog and per-row user decisions; approved rows only, skill validation and filed/explicitly blocked backlog. |

Result envelopes require PASS/ISSUES/BLOCKED, SHA-256 artifactDigest and evidence
references. Panel and pool roles also need their closed [output contract](agent-briefs.md#panel-output-contracts)
as `output`; an invalid output is refused and the run stays pending. The two architect
designs must report structurally distinct shapes; the ledger derives each shape
digest from `output.shape` itself, so a runner never computes one (a supplied
`shapeDigest` must equal the derived value). For a cross-judge, spawn-plan lists
the usable candidates (`candidates`) and appends them to the task: each slot id,
which the judge uses verbatim as its label, and the artifact path that runner
reported. Swarm must match its declared SHA/method. These checks do not read artifacts, judge substantive
quality, authenticate approvals or enforce a read-only sandbox. A string labeled
evidence is not independent proof. All native recipe gates remain mandatory.

## Events and continuation

- accept binds slot to actual native runId, childSessionKey and current
  snapshotId. Duplicate slots and reused run/session IDs fail. Never adopt a
  queued/unaccepted child. The guard is not atomic child admission.
- collect/reject settles only that pending accepted run. It may settle while
  waiting/blocked without silently clearing the hold.
- advance needs all required non-BLOCKED results and named checkpoint evidence.
  No parent persona or sequential pass replaces required independent work.
- wait records a **0–30 second bound**, not an actual native wait. Wait for an
  announcing child with the supported native bounded wait and hand off its
  accepted IDs when pending, then resume this same owner/record; a collector is
  collected in the turn that spawned it with `agents_wait` and
  `awaitResults: true`, never handed off. Never respawn. Pending is not completion.
- block/unblock retains reasons and clearing evidence. resume clears only a wait.
  cancel is terminal here but does not kill native children: stop/settle through
  their existing native owner and accepted completion path.
- supersede appends an explicit user-correction instruction and validated
  snapshot. Original snapshots, accepted selections and history remain intact.
  Role, source, pool index, diversity claim and cardinality cannot be relabeled.
  Actual user authorization remains the agent's obligation, not a new API grant.

Budgets are tiered so a full record can always be stopped. Progress events stop at
248 events or 480 KiB; a block still fits up to 255 events or 504 KiB; a cancel up to
256 events or 512 KiB. A refused write names its budget and changes nothing. Preserve
history: block or cancel, then start a new workflow; never truncate history or
remove required gates. Native controllers convert a refused progress write into
BLOCKED themselves, store each child's report and evidence within an even share of
the remaining room (marked when cut, with `artifactDigest` over the full result), and
write nothing on a resume that finds the stage still running. Their dispatch events
record the dispatching command sender (`by`), whose owned-children list alone can
prove a lost dispatch was never accepted.

Retention. The `workflow-v1` namespace is gateway-wide and holds at most 256
live records. Every write refreshes a 14-day idle expiry. The write that makes a
record completed or cancelled sets a 24-hour expiry, so terminal records stay
readable for a day. Records belong to an exact session incarnation, so a
record whose session was reset or deleted can never be read again. Once the
namespace is three-quarters full, a create first sweeps such records (one batch
of 64, or the whole namespace when full). Rows whose session lookup fails are
kept. A namespace full of live records makes create fail with a named BLOCKED
gate and deletes nothing. Finish or cancel workflows you no longer need. These
workflow-state bounds are not package-update/rollback verification budgets.

## Tagged spawn guard

spawn-plan appends one reserved PSTACK_SNAPSHOT tag to task text. Before
sessions_spawn, the guard checks exact owner, active unaccepted slot, latest
snapshot and subagent runtime. Model/thinking/fastMode must match saved selection
fields exactly, including omission. Malformed/unknown/stale/drifted tags block
without rewriting arguments. Other tool names and untagged spawns pass unchanged.
A tag is policy opt-in, not authorization, a signed receipt, a sandbox, or proof
of effective controls. Native lifecycle and tool policy remain authoritative. On a
version 2 record the guard admits a tagged spawn only while the controller's dispatch
for that slot is pending, so an agent cannot spawn a native slot itself; the same
selection the guard checks is the one the controller compares with host receipts.

## Native controller records

A version 2 record is created only by a native controller command on a host that
grants the command runtime; `create` here always writes version 1. Its view reports
`assurance: "deterministic"` and `executor: "native"`, stores the task text bound to
`taskDigest`, and adds these controller-only events:

- dispatch (slot, request id, snapshot) before every spawn. accept needs its own
  pending dispatch, the host run/session IDs and the optional selection receipt.
  abandon clears a dispatch the host proved it never accepted.
- collect and reject carry the host selection receipt. A native collect is refused
  unless the receipts confirm every requested control, so a stored result always
  ran with its routed selection. Results may carry the child's report text.
- configure records deferred swarm slices or why source dispositions once, during
  framing. decide records an authenticated `/pstack resume approve|revise`.
  schedule records an armed continuation receipt.

On a version 2 record the agent may append only configure, a checkpoint advance,
block or cancel. Approval stages refuse advance, spawn-plan is refused, and
`evidenceSource` names whether each stage's evidence came from the controller, the
agent or the user's command. supersede is refused: cancel and start a new workflow
to change routing. Version 1 records refuse every controller-only event.
