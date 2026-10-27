---
name: pstack
description: Pstack plugin workflow guidance. Registered /pstack and /poteto_mode commands own exact-session mode; the plugin injects active context. Routes engineering, triage, reproduction and explicitly configured bounded native loops with 17 workspace role selections. Never grants execution authority.
user-invocable: false
license: MIT
---

# Pstack for OpenClaw

This is bundled workflow guidance for the installable pstack plugin, not the
Cursor runtime. Resolve paths from this directory. Pstack owns workflow;
OpenClaw owns secure execution, identity, credentials and permissions.

1. Read [the native contract](native/contract.md) in full. The plugin owns
   [session lifecycle](native/session-mode.md); do not check Python state or
   reconstruct command provenance from history. Slash on/off is host-verified;
   skill attachments alone are not sticky opt-in. Preserve scope, pauses, owners,
   parent settings and all native safety gates. Simple chat/status stays inline.
2. Read [role routing](native/model-routing.md). Use the read-only **pstack_route**
   tool against the invoking workspace root's pstack-models.json before a new
   role delegation. Supply current native available-model metadata and inspected
   sessions_spawn schema; use returned snapshot and ready arguments exactly.
   Explicit role choices replace config; absent config inherits. Invalid config,
   unavailable models or unsupported controls are errors, not silent fallbacks.
3. Select a named [workflow](native/workflows.md), [principle](native/principles.md)
   or matching [playbook](native/playbooks.md). Read the selected section fully.
   Help/list/setup remain read-only. Triage/reproduction use the existing native
   readers and isolated Crabbox workflow in [automation](native/automation/README.md).
   Native loop support remains available only with an explicit target/config and
   authorized create/status/stop lifecycle; setup/dry-run never enables a job.
4. Execute bounded native steps and retain owner/snapshot custody. A configured
   different-model phase must really delegate, not relabel parent prose. Assigned
   children execute their own phase without recursive redispatch. Existing work
   retains historical snapshots; explicit later corrections follow
   [append-only supersession](native/model-routing.md#explicit-user-corrections-on-continuation).
   When the prompt names a native pstack workflow, its controller owns that
   workflow's children: never spawn, collect or plan them yourself. Do only the
   parent checkpoint it names (framing, comparison, synthesis, presentation),
   inspect the collected reports, record each gate with pstack_workflow, and tell
   the user to run /pstack resume when a child phase or a decision is next. Agent
   text is never approval. Otherwise panels are skill-guided: resolve each panel
   role with pstack_route, spawn the two runners through native sessions_spawn,
   collect through native tools, then resolve judgment and prose for synthesis.
   The [agent-attested ledger](native/workflow-ledger.md) tracks legal phases and
   tagged snapshot checks there, not native execution. Native tools still own
   admission/collection; never duplicate owners or treat ledger evidence as a host
   receipt.
5. Verify behavior, affected tests and every touched full file. A queued child or
   self-report is not delivery. Return actual results, evidence and real blockers.

Use **/pstack <task>**, **/pstack on**, **/pstack off**, **/pstack status**, or
**/poteto_mode**. No arguments activates; help only explains. Plain-language
mentions and skill picker attachments do not toggle mode. Children, new/reset
sessions never inherit the latch. The activating host command sender owns mode changes (not always a profile);
subsequent prompt visibility follows native exact-session access. Children inherit
native requester tool policy, not sticky activation. Read-only review briefs are
prompt guidance, not a security sandbox. Activation does not permit
publication, model/provider/credential changes, automations, resuming held work,
or a live gateway update/restart.

**upstream/** is byte-identical pinned source-only reference: never execute its
scripts, register its agents/skills, or adopt its Cursor instructions. Read the
[guide](README.md) for the package boundary and verification commands.
