# Plugin-owned exact-session mode

The pstack plugin owns slash commands and active routing context. No AGENTS.md
bootstrap, Python every-turn check, core pstackEnabled field, separate database,
credential resolver or agent runtime is needed. Both bundled skills are model-visible
but user-invocable:false, so their names cannot intercept registered plugin commands.

## Command authority and scope

/pstack and /poteto_mode share on/off/status/help and <task>. No arguments means
on. First-token on/off/status/help matching is case-insensitive, including trailing
arguments; their replies explicitly warn that trailing text was ignored. Status/help do not change state; absent off is noncreating.
Owner-only migrate accepts no arguments and imports online without toggling mode. Tasks validate
first, activate, then continueAgent through the ordinary host. The reserved
exact single-word architect/arena/interrogate forms (any case) never change mode. On a host that
grants the command runtime (below) they report the session's native workflow of that kind; on
older hosts they explain that deterministic panels are unavailable. `/pstack resume` follows the
grammar under native controllers. Other multiword tasks starting with those words stay ordinary
tasks, as in v1, with role guidance through pstack_route plus native sessions_spawn/collection.

Only host PluginCommandContext is authority: isAuthorizedSender, senderId,
gatewayClientScopes containing operator.write/admin, exact sessionKey/sessionId.
Pstack accepts internal/webchat only. The one sender-less form is a host scheduled
continuation, `resume <workflow id>`, admitted only with the host's subagent
capability for a native record that armed a schedule. The host exports a personal profile sender for
verified Control UI chat, but macOS/CLI clients normally resolve to client IDs
openclaw-macos/cli, not profiles. State binds the opaque host command sender: a Mac
app activation cannot be turned off by a Control UI profile; use the original
sender/client. Client-ID binding is not a new per-human permission boundary.
Missing senderId (including shared-token Control UI scope without exported sender
authority) is rejected; never borrow administrator identity or infer a profile.
There is no dependency on raw MsgContext.SenderId or a transcript recorder/handoff.

Accepted session suggestions use synthetic clients with no command sender authority;
exported senderId is undefined and their toggles/tasks are rejected, even with author
attribution. Real host context/authorization derivation is covered by the tests.
Plain-language mentions and skill attachments do not toggle mode. Never use the
historical Python helper to bypass a rejection.

## Exact state and prompt lookup

The host persistent plugin keyed store uses exact session key + incarnation +
canonical execution workspace; the value retains the activating command sender.
Another sender cannot mutate its record. A new/reset incarnation or child is inactive.
Commands, hooks and migration use one helper: derive the agent from the native
session key, then realpath(native session entry spawnedWorkspaceDir ?? agent
workspace from live api.runtime.config.current({clone:true})). Ignore hook
ctx.workspaceDir: the host reply path can use a prepared/default run workspace
that differs from the native spawned workspace. It must not change the state key.

before_prompt_build has no Control UI profile, so it resolves this exact native
session and reads its record, without a runContext bridge or reply_dispatch hook.
Native session access controls who sees subsequent active workflow context; shared
session participants may receive that routing context. Activation is not new tool
authority. Children inherit requester tool policy, NOT sticky activation. Read-only
briefs are instructions, not an enforced sandbox or removed write capability.

Inactive sessions receive nothing. Missing/preparation-failed identity receives
nothing plus an operational log, not a false state-corruption prompt. A real
state lookup/schema error contributes an explicit FAILED CLOSED notice. Corruption
is never silently reset, including by off. Current owner assertion and hook
invocation lifetime checks stay host-owned. External installs require
plugins.entries.pstack.hooks.allowConversationAccess=true and must not set
allowPromptInjection:false. Status warns if this public config blocks the hook,
but only runtime inspection/follow-up proves it is loaded and contributing.

## Idempotence, retention and recovery

The public command contract has no native event ID/sequence. Transitions are
value-idempotent: repeated same value leaves revision unchanged; actual on/off
changes monotonically increase it via compareAndApply. The plugin does NOT claim
to recognize an old on-event replay after off; native ingress owns event dedup.

A host bounded persistent namespace (session-mode-v2), hard max 1024/reject-new,
never evicts current records to admit new ones. After a committed command transition,
the owner sweeps at most 64 rows using a moving lexical cursor, best-effort. Only native session
entries confirmed absent or superseded are conditionally removed; lookup errors
or corrupt records are retained. An unrelated lookup/cleanup failure is logged and
cannot block off or on. At capacity, existing off still works and triggers cleanup.
There is no background timer.
Status remains read-only. Revision continuity applies while that incarnation’s
record is current; stale incarnation removal cannot reactivate a new one.

## One-time legacy migration

Use **/pstack migrate** in an authorized native-owner internal/webchat session
whose derived workspace contains the legacy records. It runs inside the Gateway,
using the same plugin store view as on/off/task. It requires host senderIsOwner
and invocation-bound assertOwnerCurrent, which the native store revalidates for
writes. No text-derived permission or custom runtime is introduced.

Bulk import validates native keys and current derived workspaces, skips inactive,
absent/superseded or archived incarnations, and reports each import, identical
replay, skip or error. Independent records continue after a per-record error.
Scan/record bounds are enforced before writes; source is rechecked before import.
Revision/activating sender are preserved and source is never edited. Identical
source AND value/revision/sender replay reports imported:false; divergence refuses
overwrite. A record whose workspace differs from the current native session's
derived workspace is refused instead of creating unreachable state.

Cutover: install/consent/reload, inspect exactly one before_prompt_build hook,
then remove the legacy AGENTS block and both old workspace skills together.
Immediately send /pstack migrate, repeat and require imported:false per eligible
record with errors:0. **Gateway-side /pstack status in every imported session must
show on at its imported revision, followed by an active ordinary follow-up.**
These are the visibility acceptance gate; replay alone is not. No on/off/task in
affected sessions during this window. A stale/wedged session means stop and
escalate for operator-approved recovery/restart, never delete state or use on to
repair it. The config write reloads plugin AND bundle-MCP runtimes Gateway-wide;
schedule outside long runs and require restartRequired:false. No restart needed.

The separate CLI is offline-only and requires explicit --offline:
openclaw pstack migrate --offline --workspace <root> --all-current-active.
A selected exact identity may instead use --user <sender> --session-key <key>
--session-id <incarnation>. The operator must independently confirm the Gateway
using that state is stopped; the flag is not a running-Gateway detector. Do not
use it for online cutover. The Gateway does not poll SQLite for foreign commits
(host docs/plugins/sdk-runtime/state-and-system.md:488-490); primed views may
stay stale even after plugin reload. CLI errors set exit 1; online command errors
are per-record JSON outcomes. Never claim a clean CLI replay proves online state.

Preserve role config and legacy source. Historical Python helpers/tests are
compatibility reference, not runtime activation. Consult the operator’s own migration record for expected inventory and verify it afresh. Never assume another installation’s record count.

## Native controllers

On hosts that advertise `command-native-subagents-v1` and `requester-model-catalog-v1`,
`/pstack-architect`, `-arena`, `-interrogate`, `-swarm`, `-how`, `-why` and `-reflect`
request the command runtime (`runtimeCapabilities: ["subagents", "models"]`, plus
`scheduledTurns` where `command-scheduled-turns-v1` is advertised). The manifest declares
`contracts.commandRuntimeCapabilities` and `contracts.sessionScheduledTurns`. Hosts without
the tokens register the same commands without the opt-in and keep v1 skill-guided behavior;
older hosts ignore the unknown contract keys. The opt-in is never proof of a grant: each
invocation probes `ctx.runtimeContext.subagents` and `.models`. If either is missing, the
route stays skill-guided and continues the agent. A host or requester without the
grant never starts a native workflow.

A native command reads the requester catalog (S2; one retry on a rejected read, and a
pending catalog blocks the start), resolves every role from the workspace pstack-models.json
over it, and creates a version 2 record in the workflow store. Parent work (framing,
checkpoints, comparison, synthesis) continues the agent with the record's context injected
by before_prompt_build; the agent records those gates with pstack_workflow, which accepts
only configure, checkpoint advance, block and cancel on a native record. Child phases run
as code: dispatch, S1 spawn with the role's outputSchema envelope, the host acceptance and
selection receipt, a bounded collect, then settlement. Each step is one compare-and-apply
write. Where the host offers narrow-only subagent profiles (`native-subagent-profiles-v1`),
the record pins a [host profile](agent-briefs.md#host-subagent-profiles) and its
instructions digest for each read-only role, and those children spawn with `profile`; the
host removes the denied tools and records the digest. A pinned role blocks rather than
spawning on an instance without that profile. `panel-reviewer` keeps the shell for git and
grep, so its label is `host-profile-shell` and its children are told read-only shell use is
prompt-enforced. Writer roles, the why roles and every role on other hosts are
prompt-enforced, and read-only children are told so in their brief.
Selection receipts must confirm every requested control (model, thinking, fastMode)
in `resolved`, and in `observed` when present. A mismatch or a missing control rejects the
child and blocks the phase visibly, at acceptance or at collection, in every stage. Nothing
advances on queued, failed, schema-invalid or contract-invalid results; an arena candidate
that fails or returns BLOCKED is a recorded dropout and the judge scores the usable
candidates, but a routing failure is never a dropout; a swarm slice retries once.
Each collected result stores the child's report and evidence within an even share of the
room left in the record (1,000 to 16,000 characters per child); anything cut carries a
marker, and `artifactDigest` covers the child's complete structured result. One native workflow runs per exact session
incarnation. Optional leading words choose architect intent (`design-only`, `checkpoint`
default, `implement`) and how complexity (`simple` default, `complex[=2-4]`). Swarm slices
and why source dispositions are parent framing, recorded once with pstack_workflow
configure.

`/pstack resume [workflow id] [approve [notes] | revise <notes> | cancel [reason]]`
continues from the record. Each collection waits at most `nativeWaitSeconds` (default 20,
at most 30), and one invocation stops waiting after 45 seconds, then hands off (D5).
Accepted children keep native custody and are never respawned. A resume that finds the
stage still running writes nothing. A dispatch whose acceptance was lost is reconciled
through the owned-children list (S4) by its request id. The host lists children only for
their own requester, at most 200, so an unlisted dispatch is abandoned and respawned only
when the requester who dispatched it resumes and the list is below that cap. Another
operator's resume, or a full list, blocks with an explanation; an unattended continuation
leaves it untouched. Without S4 it blocks rather than spawning again. Architect `agree` and reflect `approval` persist as
awaiting-user. Only an authenticated `/pstack resume approve` or `revise` from the command
sender moves them, recorded with that sender; agent text is never approval. `revise` returns
to the preceding parent checkpoint. `cancel` is terminal; accepted children keep native
custody and are listed.

Unattended continuation (D7) uses requester-admitted scheduled command turns (S6). A user
command that leaves a native workflow non-terminal keeps up to four single-occurrence
`/pstack resume <id>` continuations armed, 30 seconds, then 2, 8 and 25 minutes after it
(four is the host's per-invocation limit). A later command arms only the missing ones;
scheduled occurrences cannot schedule more. Each
occurrence restores and rechecks the original requester. The host refuses a demoted or
removed requester before any plugin code runs. A continuation is quiet unless something
changed, never continues the agent, and makes no decisions. Schedules the host says survive
restarts (`command-scheduled-turns-restart-v1`, `survivesRestart: true`) are not
re-armed after a restart. Others, and every schedule after an in-process plugin reload, are
re-armed by the next user command.

Ledger budgets are tiered: progress stops at 248 events or 480 KiB, a block still fits up to
255 events or 504 KiB, and a cancel up to 256 events or 512 KiB. A controller step refused
for budget becomes a visible BLOCKED, so a full workflow can always be cancelled, after which
the session can start a new one.

Downgrade rule: a native record is never continued as v1. Without the subagent grant,
`/pstack resume`, its decision forms and the single-word kind forms refuse with an explicit
BLOCKED message. Nothing is spawned again, and older plugin versions refuse version 2
records outright. `/pstack status` names the session's native workflow and phase.

## Command-runtime controller, not reply_dispatch

An agent-eligible reply_dispatch registration marks Gateway-wide admission
restart-unsafe and blocks fresh Goals even when the hook would ignore the command.
Pstack registers none. The native controller uses the command-scoped runtime facade the host
grants per invocation, so restart-safe chat and Goal admission are unchanged; the isolated
1.0 Gateway acceptance starts, pauses and resumes a Goal with the plugin loaded. Do not
add a broad hook, administrator fallback or fabricated model metadata.
