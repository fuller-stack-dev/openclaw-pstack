# Pstack plugin workflow bundle

This installable openclaw-pstack bundle supplies model-visible (not user-invocable)
pstack and poteto-mode workflow skills, 32 routes, 24 principles, 23 playbooks,
17 role definitions, and native triage/loop/delegation guidance. Only these two
skill roots are registered. The 172 pinned upstream files remain byte-identical,
source-only MIT reference; never execute or independently register them.

Use registered /pstack or /poteto_mode commands: on (also no arguments), off,
status, help, or <task>. A task validates, activates and continues the ordinary
agent. Status/help do not activate. On hosts that grant the command runtime,
/pstack-architect, -arena, -interrogate, -swarm, -how, -why and -reflect are
[native controllers](native/session-mode.md#native-controllers): their child phases
run as code with host receipts, `/pstack resume [approve|revise|cancel]` continues
them, and scheduled continuations finish them unattended. Elsewhere those routes,
and every other route, stay skill-guided with pstack_route and native
sessions_spawn/collection; the exact single-word architect/arena/interrogate/resume
forms then explain that panels are unavailable and never mutate mode. The
[workflow ledger](native/workflow-ledger.md) records agent-attested phase evidence
for skill-guided work and deterministic records for native controllers.

See [session lifecycle](native/session-mode.md) for internal/webchat verified
command-sender authority (Control UI profile, macOS/CLI client IDs; synthetic
suggestions rejected), exact-session/incarnation state, bulk current-active legacy import,
value-idempotent revisions, bounded storage and prompt-only active context.
No AGENTS.md bootstrap, transcript parsing, helper subprocess or reply_dispatch
hook is used. Plain-language mentions and skill attachments do not toggle mode.

[Role routing](native/model-routing.md) reads only workspace-root pstack-models.json.
The tool returns immutable snapshots, ready sessions_spawn args and evidence-aware
confirmation, without executing children or editing configuration. The skill’s
scripts/model-routing.mjs is the plugin’s single routing implementation.

Children inherit native requester tool policy, NOT sticky activation. Read-only
review briefs are guidance, not enforced capability restrictions. Preserve scope,
pauses, source custody, owners, review/test gates and deployment restrictions.
Pstack cannot enlarge host permission. Recurring/loop work still needs a separately
authorized explicit target/config and the actual native scheduler contract;
installation creates no job, watcher or service.

Integrity: openclaw pstack doctor, or python3 scripts/verify_install.py <this-dir>.
The source manifest pins upstream v0.15.29; native-manifest.json covers changed adapter files
and alias. Historical Python state helpers remain compatibility source, never active plugin state. Keep both bundled folders together.
Implementation tests and operator-only historical records stay in the source repository, outside the shipped package. Consult the package README for installation; historical receipts never prove current installation.
