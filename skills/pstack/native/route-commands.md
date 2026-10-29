# Prefixed route commands and manual guides

The 57 workflow/playbook routes in [routes.json](routes.json) have literal
registered plugin commands named `pstack-<route>`.
For example, `/pstack-architect [request]` selects architect guidance.
The existing `/pstack <route> <request>` and exact-session on/off/status/help/migrate
behavior is preserved. Exact single-word legacy panel/resume forms still explain
the current-host limitation; they do not pretend to invoke a controller.

## Current-host behavior

Task route commands validate the same authorized sender, write/admin scope,
channel, exact incarnation and canonical workspace as ordinary pstack tasks.
They explicitly opt that exact session into mode, then return ordinary-host
agent continuation. The host command body, requester's identity and scope are not
rewritten. A route suffix such as off, status, help or migrate is **task data**,
not a request to mutate mode or import records. No-argument route selection is
also an explicit invocation of that guide. Required independent phases must run
through routing/native delegation and collection or be reported BLOCKED.

`pstack-poteto-help` and `pstack-setup-pstack` only return read-only guidance;
they do not activate, execute task-like suffixes, write configuration or create
jobs. Help text is not authorization to perform setup. Other routes retain the
read-only/external-action limits of their complete native contracts.

Route execution is **skill-guided and agent-attested**, except the seven [native
controllers](session-mode.md#native-controllers) (architect, arena, interrogate, swarm,
how, why, reflect), which request the command runtime only on hosts that advertise it and
run as code only when an invocation is actually granted it. Other route commands request
no command-runtime capability. Pstack never infers a capability from a property name,
claims an unreceipted selection, commits agent-written approval, fabricates an accepted
child or schedules unattended resume outside a native controller workflow.
The optional workflow ledger and narrow spawn guard retain their own limits.
Hand off only announcing children, after a short bounded wait and with the same-owner
resume handoff; a collector is collected in the turn that spawned it. No duplicate children.

## Discovery is not native command spelling

The manifest publishes only the two base guidance roots and the generated
manual-route root. Upstream source-only definitions are never registered.
Base pstack/poteto-mode skills remain model-readable and non-user-invocable.
Generated route skills have user-invocable true and disable-model-invocation true:
they are available for an explicit manual selection, not model auto-selection.
A skill attachment alone never enables sticky mode.

The pinned host sanitizes skill command names to underscores, truncates long
names and deconflicts collisions. Thus a skill picker can expose
`pstack_architect` rather than `pstack-architect` (and a reserved-name set can
add a suffix). Literal hyphens are supplied separately by supported plugin
command registration. Do not describe the picker alias as equivalent proof of
literal command registration or assume its truncated spelling is stable.

## Optional bare aliases and core ownership

Bare route names are disabled by default. An operator may explicitly choose
`plugins.entries.pstack.config.bareRouteAliases=true` under normal configuration
authority. Only those same 57 reviewed routes are requested. Principles and
native extensions are not included: no bare loop, command controls, cron or
administrative alias is requested. No reserved command ownership is claimed.
The host's reserved-name and existing-plugin collision checks stay authoritative;
the incumbent is never replaced. Inspect registration diagnostics after opt-in,
including a route newly reserved by a later host. No global config is written by
this plugin and no silent alternate authority is used on rejection.

## Generated-guide integrity and remaining semantic work

The source-repository `scripts/sync-routes.mjs` is deliberately a **discovery-only**
generator, not the Phase-1 upstream semantic-overlay pipeline. It validates the
complete pinned source inventory, native route sections and all restored
requirements before generating any guide. Each guide points to the complete
existing native section rather than abbreviating or replacing its gates.
Native workflow/playbook text and requirement files are not rewritten.

The generated manifest binds 57 guide hashes, every native input hash, selected
section hashes and all restored gate IDs. Doctor verifies external guide bytes,
exact inventory, no symlink traversal and manual invocation policy; real archive
verification runs that same doctor. CI's check mode fails on stale/missing output
without repairing it. Unexpected generated files block regeneration and are not
deleted. Hashes are integrity evidence, not independent review or execution proof.

The MUST/required/never mapping lives in the reviewed
[upstream rule overlay](semantic-overlay.md), generated by
`scripts/sync-overlay.mjs` and checked by the doctor. The route manifest still
records that this discovery generator did not perform that review. Do not bless
an upstream bump by merely refreshing hashes or cite manual discovery as semantic
parity. Preserve every restored gate; human source/semantic review, exact-head
tests, independent review and applicable runtime acceptance remain separate
release gates.
