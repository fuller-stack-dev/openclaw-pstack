# openclaw-pstack

Independent MIT-licensed adaptation of **pstack by Lauren Tan** for OpenClaw.
This is **not an official Cursor plugin**, and it does not run the Cursor runtime.
Package: `@fuller-stack-dev/openclaw-pstack` · plugin id: `pstack` · version: `1.3.0` (release candidate).
Maintenance owner: fuller-stack-dev; report bugs through this repository's issues.

Pstack owns workflow; OpenClaw owns secure execution. The plugin supplies
exact-session opt-in, 17-role model planning, 34 workflow routes, 24 principles
and 23 playbooks. It registers two model-readable guidance skills, 57 manual-only
route skills, `/pstack` and `/poteto_mode` plus 57 literal `pstack-` route
commands, read-only pstack_route, pstack_plan_check and pstack_brief, pstack_workflow,
operator-opt-in pstack_trail and pstack_worktree_audit, and before_prompt_build plus
narrowly matched before_tool_call hooks.
No core patch, provider, credential resolver, separate database or scheduler.

**1.0: native controllers on capable hosts, v1 elsewhere.** On a host that grants
the plugin command runtime (requester-bound native subagents, the requester model
catalog, the owned-children list and scheduled command turns), the architect,
arena, interrogate, swarm, how, why and reflect commands run their workflows as
code. Each child phase resolves roles over the host catalog, spawns real children
with the role's output contract, checks the host selection receipt against the
routing snapshot, and writes deterministic CAS records. `/pstack resume` and
scheduled continuations finish a panel after a short bounded wait, survive
Gateway restarts, and never respawn accepted children. On older hosts the same
commands keep the skill-guided v1 path; see
[native controllers](skills/pstack/native/session-mode.md#native-controllers).

**1.1: controller parity.** New native architect records ground the design in
independent how and why children before the runners (`how-only` or `greenfield`
narrows that); interrogate adds a routed `judgment and prose` lead after both
reviewers. How, why and interrogate end with that child: the command reply quotes
its result verbatim with slot, role, host-reported model, run and artifactDigest,
instead of a parent rewrite. Reflect shows its synthesizer's rows verbatim before
waiting for approval. Swarm workers write where their slice method says, a retry
names the failure, and a second miss is a recorded coverage gap that still reaches
aggregate. Records created by 1.0 keep their stages. `/pstack-poteto-help` and
`/pstack-setup-pstack` now let the agent answer the question read-only. On hosts that
report canonical model families (`requester-model-family-v1`), pools and panels
report `different-family` only when both families are known and differ. Route text
now requires a routed child's result to be delivered verbatim and attributed, a
bounded-wait handoff, ordered commits where authorized, and pstack_route blind
mode for blind trials.

**1.2: corrections and visible handoffs.** A native deliverable (how's explanation, why's
synthesis, interrogate's lead verdict, reflect's rows) that the controller rejects, that
comes back BLOCKED, or that lacks a required section gets one correction child under the
same routing snapshot and profile, briefed with its output and the errors. After delivery,
`/pstack resume <id> correct <what is wrong>` runs one correction of a completed how, why or
interrogate result. A reply that hands off pending children names the owner session, each
pending child's run id and the exact `/pstack resume <id>` command. pstack_brief accepts a
required read named `path#heading`.
Literal prefixed route commands and generated manual discovery guides are included. A reviewed
[upstream rule overlay](skills/pstack/native/semantic-overlay.md) maps every
pinned upstream line that states a MUST, required or never rule to the native
requirement gate or guidance text that carries it, or to a justified exclusion.
The doctor fails on an unmapped rule or on drift from the pinned upstream hashes.
That mapping is reviewed text coverage, not proof that a model follows a rule.
See [ledger behavior and limits](skills/pstack/native/workflow-ledger.md). The supplied-source
[plan adapter](skills/pstack/native/plan-adapter.md) exposes the unchanged complete
plan checker through native tool admission. Its PASS is structure-only, not
route execution, acceptance evidence or approval. The optional
[trail](skills/pstack/native/trail-adapter.md) and
[worktree audit](skills/pstack/native/worktree-audit-adapter.md) adapters replace
the source-only upstream `log.sh` and `worktree-audit.sh`. They are exposed only
after the operator allowlists them in `tools.allow`, refuse sandboxed sessions,
and never verify evidence or authorize deletion. The trail also refuses
workspaceOnly or unknown-policy sessions, because plugin tools are not told when
a session is read-only, unless the operator sets
`plugins.entries.pstack.config.trailInRestrictedSessions=true`. The audit never
runs `git status` or any read that converts file content, so repository config
cannot make it start a filter, diff, fsmonitor, signature or transport program,
even when that config is written during the audit.
[Native agent briefs](skills/pstack/native/agent-briefs.md) port the two
upstream agents as labeled templates rendered by read-only pstack_brief. Every
panel and pool role has a closed output contract that pstack_brief checks,
pstack_workflow enforces at collection, and native controllers pass to the host as
`outputSchema`. On hosts with narrow-only subagent profiles (S5), pstack registers
four [host profiles](skills/pstack/native/agent-briefs.md#host-subagent-profiles) and
spawns the native controllers' read-only roles under them, so the host removes
file-editing, spawning and plugin tools from those children and records the
instructions digest. Agent-driven briefs, and every role on other hosts, stay
prompt-enforced: a brief constraint plus inherited tool policy.

## Requirements and compatibility

- OpenClaw **2026.10.5 or newer and keyed-store V2 support**. Version admission
  stays at `>=2026.10.5` so current main builds reporting 2026.10.5 are not excluded.
  The stable v2026.10.5 tag lacks `api.runtime.state.openKeyedStoreV2` and is
  rejected with an actionable error before any full-mode plugin surface registers.
  Host cli-metadata discovery intentionally has no runtime: registration defers
  runtime access in that mode and still exposes the pstack CLI root. CLI execution
  uses full registration and retains the V2 requirement. Use
  OpenClaw 2026.10.10-beta.2 or a current main build exporting that contract.
  Qualification pins `v2026.10.10-beta.2` at
  `2b85c4c25ea98d72ca1d3e93fb0fd9cac8f0ddab`; retest when upgrading.
- Native controllers need a host that advertises `command-native-subagents-v1` and
  `requester-model-catalog-v1`. S4 reconciliation needs `native-subagent-list-v1`;
  unattended continuation needs `command-scheduled-turns-v1`, and restart
  continuity `command-scheduled-turns-restart-v1`. Host-enforced read-only children
  need `native-subagent-profiles-v1` (S5, main at or after `492af55`). These are on
  openclaw main only, in no release yet. Without them the plugin keeps v1 behavior,
  and read-only roles are prompt-enforced.
- Node **24.16+** (or a supported newer OpenClaw Node runtime; current main needs 24.22.1+).
- Python 3 for `openclaw pstack doctor` and integrity verification.
- Authorized internal/webchat commands with host-exported sender authority and
  exact session identity. Other channels are not supported.
- Models and execution tools are supplied/configured by the host, not this plugin.
  Reader/reproduction routes additionally need the named installed tools and
  authorized access. Missing tools are blockers, not permission to install or log in.

## Install

**Not published yet.** The following registry command is for after the owner
chooses to publish and ClawHub verification makes the release available:

```sh
openclaw plugins install clawhub:@fuller-stack-dev/openclaw-pstack@1.2.5
```

For a reviewed local artifact, install the exact tarball printed by `npm run pack`:

```sh
openclaw plugins install npm-pack:/absolute/path/openclaw-pstack-1.2.5-COMMIT.tgz --force
```

The local-source trust gate requires `--force` **only after reviewing that exact
archive**; it does not grant conversation access. Review the host's separate
capability-consent prompt. Add `pstack` to an existing
`plugins.allow` list if you use one, preserving other entries. Enable the plugin
and explicitly consent to the conversation hook:

```sh
openclaw plugins enable pstack
openclaw config set plugins.entries.pstack.hooks.allowConversationAccess true
openclaw plugins inspect pstack --runtime --json
openclaw pstack doctor
```

Do not set `allowPromptInjection: false` for this plugin if you expect active
routing guidance. Config writes/reload affect host plugin and bundle-MCP runtimes;
schedule them outside long active runs. Use the host's supported lifecycle and
approval flow; installation instructions are not authorization to restart a host.
Inspect should show **before_prompt_build** and **before_tool_call**, never
reply_dispatch. The latter only checks reserved pstack-tagged sessions_spawn calls;
untagged calls pass unchanged and arguments are never rewritten. On a capable host,
installation reviews the manifest's `commandRuntimeCapabilities` (`subagents`,
`scheduledTurns`) and `sessionScheduledTurns` (`requester-command`) contracts.
Doctor is read-only; it checks package integrity (including byte-verified npm
`.gitignore` → `.npmignore` relocation), not model availability or a
live session's active prompt. Verify an ordinary active follow-up separately.

## Commands

| Command | Effect |
| --- | --- |
| `/pstack` or `/pstack on` | Activate for this exact native session/incarnation/workspace |
| `/pstack off` | Deactivate; another activating sender cannot be impersonated |
| `/pstack status` | Read-only mode/revision and hook-policy diagnostics |
| `/pstack help` | Explain without activation |
| `/pstack <task>` | Validate, activate, continue through the ordinary host agent |
| `/poteto_mode …` | Alias with the same state and authority |
| `/pstack migrate` | Owner-only online legacy import; see migration notes below |
| `/pstack-<route> [request]` | Select one of 57 routes; task routes use the same authorized exact-session mode |
| `/pstack-architect`, `-arena`, `-interrogate`, `-swarm`, `-how`, `-why`, `-reflect` | Native controller on a capable host (see above); skill-guided otherwise. Optional leading `design-only`/`checkpoint`/`implement` and `how-why`/`how-only`/`greenfield` (architect, either order) or `simple`/`complex[=2-4]` (how) |
| `/pstack resume [id] [approve [notes] \| revise <notes> \| correct <errors> \| cancel]` | Continue, decide or cancel the session's native workflow; never downgrades to v1. `correct` asks for one corrected deliverable: reflect's rows at approval, or the delivered result of a completed how, why or interrogate workflow (named by id) |
| `/pstack-poteto-help` / `/pstack-setup-pstack` | The agent answers your question read-only, from the native sources and current host facts: no activation, config writes, jobs or task execution. Static help only when the invocation cannot continue the agent |

The first control token is case-insensitive; trailing text after on/off/status/help
is ignored with an explicit notice. Exact single-word architect/arena/interrogate
forms report the session's native workflow on capable hosts and explain the v1
limitation elsewhere; neither activates. Multiword tasks such as
`/pstack architect a parser design` work as ordinary skill-guided tasks.
Plain-language mentions, skill attachments, children and new/reset incarnations
do not inherit or enable sticky mode. The original pstack/poteto-mode guidance
skills remain model-readable and non-user-invocable. The 57 generated route skills
are explicitly user-invocable but hidden from model auto-selection. At the pinned
host, picker command names are sanitized to underscores (and can be truncated or
deconflicted). The literal `/pstack-architect` spelling is supplied by native plugin
command registration, not by pretending frontmatter preserves hyphens.

Bare route names are **off by default**. An operator can explicitly opt in with
`plugins.entries.pstack.config.bareRouteAliases=true` under normal configuration
authority. Only the reviewed 57 route names are requested; no `loop` alias or
reserved ownership is requested. Native core-name and existing-plugin collision
checks remain authoritative and never overwrite the incumbent. Inspect registration
diagnostics after opt-in. This is not a command-runtime/subagent capability grant.
See [route command details](skills/pstack/native/route-commands.md).

## Configure role models

Place `pstack-models.json` at the **invoking workspace root**, not in the installed
package or a temporary worker checkout. Absence means native inheritance; invalid
config is an explicit error, not a fallback. Setup/help never writes configuration.
The file contains version 1, optional named presets, and any subset of the exact
17 roles in [the routing guide](skills/pstack/native/model-routing.md).

**Shape example only** — substitute exact models and controls available to your host:

```json
{
  "version": 1,
  "presets": {
    "implementation": { "model": "provider/model-id", "thinking": "high", "fastMode": true }
  },
  "roles": { "feature, refactoring": "implementation", "bug-fix": "implementation" }
}
```

Selections accept only `model`, `thinking` and `fastMode`. Omitted fields inherit;
`"inherit"` drops role overrides. Three panels and one cross-judge pool require
exactly two entries. The routing tool validates the whole config against fresh
host availability and actual `sessions_spawn` schema, returning immutable snapshots
and ready arguments. It does **not** spawn, edit config, call models or switch auth.
A configured different-model prose/judgment phase must actually delegate. Keep
requested, observed and unverified controls separate; a preference does not prove
an upstream service tier. Existing tasks keep their owner and snapshot; explicit
later corrections use the append-only procedure in the routing guide.

## Routes

Use `/pstack <route> <request>` or the literal `/pstack-<route> [request]`.
Both are skill-guided ordinary-agent paths, except the literal commands of the
seven native controllers on a capable host.
`help` aliases `poteto-help`; `setup` aliases `setup-pstack`.

- **Workflows (34):** poteto-mode, poteto-help, setup-pstack, how, why, teach,
  blast-radius, architect, arena, swarm, interrogate, no-comments, statechart, tdd,
  benchmark-checklist, figure-it-out, create-verification-skill,
  maintain-verification-skill, create-formal-verification-skill,
  maintain-formal-verification-skill, recall, ketchup, ketchup-video, in-your-own-words, sharpen,
  bro, unslop, technical-writing, typescript-best-practices, show-me-your-work,
  automate-me, reflect, correct, make-bot-ui.
- **Playbooks (23):** investigation, bug-fix, perf-issue, hillclimb,
  runtime-forensics, trace-forensics, feature, refactoring, prototype,
  visual-parity, authoring-a-skill, eval, babysit, shipping, autonomous-run,
  orchestrate, autopilot-full, autopilot-stack, session-pickup, pause-safely,
  multi-phase-plan, worktree-cleanup, opening-a-pr.
- **Principles (24):** indexed in [native/routes.json](skills/pstack/native/routes.json)
  and [principles](skills/pstack/native/principles.md), with the full `principle-` names.
- **Native extensions:** triage, repro; loop create/status/stop;
  benny setup/dry-run; automation setup/dry-run/status/stop; watch-pr template
  (a [user-installed, read-only PR watch](skills/pstack/native/automation/watch-pr.md)
  that pstack never schedules).

Read the chosen [workflow](skills/pstack/native/workflows.md),
[playbook](skills/pstack/native/playbooks.md) or
[automation guide](skills/pstack/native/automation/README.md) in full before use.
Sharpen rewrites a prompt but never executes it. Formal-verification routes require
project-owned code mapping, explicit bounds and real mutation evidence.
Statechart checks bounded TLA+ behavior and presents reader-visible paths;
ketchup-video renders factual slide evidence, then requires decoded-frame and
caption inspection. Both use separate ordinary-exec [artifact CLIs](skills/pstack/native/artifacts.md),
not Gateway rendering or new native controllers. Autopilot-stack is full without
merging, with stacks only for real dependencies. Current-parent family evidence
for new native architect/arena command admission remains a separate open capability
decision; the qualified tool path and historical continuations are not that proof.

## Security model and limitations

- Only the host's authorized command sender, write/admin scope and exact native
  identity can activate or change mode. Control UI commonly exports a profile;
  macOS/CLI can export client IDs. Cross-client off is not promised: use the
  original activating sender/client. Client-ID binding is not a per-human sandbox.
  Synthetic session suggestions lack command sender authority and are rejected.
- State uses the host's persistent keyed store, keyed by exact session key,
  incarnation and canonical execution workspace. Max 1024 records/reject-new;
  post-transition cleanup is bounded and only removes confirmed stale records.
  Corruption fails closed. No transcript scraping, raw-store edits or background
  cleanup service. Subsequent prompt visibility follows native session access,
  including other participants with access to that same session.
- Sticky mode changes workflow guidance, **not permissions**. Native tool policy,
  source trust, review, consent, holds, credential custody and completion remain
  authoritative. Children inherit native requester policy, not sticky activation.
  Read-only briefs are instructions, not enforced capability restrictions.
- Native controllers use only capabilities the host grants to the current
  authorized command invocation. Children inherit that requester's lineage and tool
  ceiling, receipts come from the host, approvals only from the authenticated
  command sender, and scheduled continuations recheck the original requester at
  every run. A demoted requester is refused by the host and its children do not
  outlive the authority. On other hosts panels are **skill-guided**: resolve roles,
  spawn through native tools, collect, then synthesize; the ledger tracks
  agent-attested phase evidence and does not spawn, collect, approve, wait or
  schedule. No broad `reply_dispatch` hook or trusted-official-only model-catalog
  fallback.
- All 573 files in `skills/pstack/upstream` are pinned, source-only MIT reference.
  Their scripts/tests/agent definitions are neither executed nor registered.
  Only the three manifest roots load (two base skills and 57 manual route guides).
  The original source includes scripts targeting other runtimes; their presence does not advertise native support.
- Optional loop/event builders require separately authorized targets, existing
  non-main owners, explicit budgets/deadlines and verified tools/connectors.
  Install/setup/dry-run creates no job, watcher, box, message, issue, PR or deploy.
- This package makes no covert network/telemetry calls or credential requests.
  Host/model/tool services retain their own behavior and permissions. External
  plugins execute trusted local code; review this package before installing it.

## Troubleshooting and migration

Run `openclaw pstack doctor`. For a source checkout:
`python3 skills/pstack/scripts/verify_install.py skills/pstack`.
If integrity fails, reinstall a reviewed exact artifact; do not bless changed hashes.
If status reports hook policy blocked, inspect `plugins.entries.pstack.hooks` and
runtime registration; a stored on value alone cannot prove prompt contribution.
Missing sender/scope/incarnation is an authorization error, not a migration hint.
Model/control failures need fresh host inventory/schema, not aliases or silent fallback.

For a legacy skill installation, retain source/config and quiesce affected sessions.
Install/consent/inspect the plugin, retire old bootstrap and both old skill roots
as one operator-reviewed cutover, then run **`/pstack migrate` inside the running
host**. Repeat should report unchanged imports; require status at each imported
revision and an active ordinary follow-up before toggling/tasks. Never assume a
fixed legacy record count. The separate CLI `openclaw pstack migrate --offline
--workspace <root> --all-current-active` is **offline only**: the operator must
confirm the host using that state is stopped. Foreign CLI commits do not prove
online visibility. See [session lifecycle](skills/pstack/native/session-mode.md).

## Development, CI and packaging

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm run doctor
npm run test:routing
npm run test:automation
npm run test:python
npm run test:plan
npm run test:workflow
node scripts/sync-routes.mjs --check
npm run test:routes
npm run test:pack
npm run pack
```

Build uses pinned esbuild, leaving public `openclaw/plugin-sdk/*` imports external.
The OpenClaw peer is optional to prevent npm from installing a second host; it is
required at runtime. No install lifecycle script executes. GitHub CI has a portable
build/doctor/routing/Python/automation/extracted-archive lane and a separate pinned
host lane running strict SDK typecheck and **every** Vitest case. The host pin is
`tests/fixtures/openclaw-host.json`: tag `v2026.10.10-beta.2`, commit
`2b85c4c25ea98d72ca1d3e93fb0fd9cac8f0ddab`. The earlier `v2026.10.5` tag lacks
the keyed-store V2 contract required at registration; its strict SDK typecheck
also lacks the read-only current-config clone option. Version admission cannot
distinguish that stable tag from newer main builds still reporting 2026.10.5, so
full registration checks the actual store capability; cli-metadata only discovers
CLI metadata without reading the unavailable runtime Proxy. The build host/SDK
provenance records the exact qualification pin, not the admission floor. Host admission tests call the
pinned host's real minimum-version and plugin-API gates, not npm-default semver.
The qualified pin is not blanket stable-release or future-host runtime proof.

Use a clean, disposable checkout of that exact tag, not a running Gateway tree:

```sh
git clone --depth 1 --branch v2026.10.10-beta.2 https://github.com/openclaw/openclaw.git /path/to/pinned-host
# In /path/to/pinned-host, with its pinned pnpm 12.9.0:
pnpm install --frozen-lockfile --ignore-scripts --package-import-method auto
# Back in this repository:
export OPENCLAW_SOURCE=/path/to/pinned-host
npm run typecheck
node scripts/test-host.mjs
```

The host's SQLite store uses a real Node worker outside Vitest's resolver. The
runner anchors its actual tsx source loader via `TSX_TSCONFIG_PATH` to the pinned
host's tsconfig; Vitest itself consumes the pinned host's source alias factory.
No host build, copied implementation, database mock or dependency-directory
symlink is needed. Local installs keep the supported shared pnpm store/global
graph and auto imports; do not fake `CI`. Hosted CI uses pnpm's normal CI graph.

Both runners verify the tag, exact commit and clean tracked host source, then strip
inherited `OPENCLAW_*` variables. Typecheck extracts exact SDK declarations into
disposable scratch (host emission only is unchecked); plugin checking stays strict.
Vitest establishes private HOME/state/config/TMPDIR and verifies the **actual**
resolved handoff database path before importing host fixtures. Never use production
state for tests. The baseline 151 Vitest cases remain included; planner/schema
qualification covers all 17 workspace roles, actual host install/API admission,
registration capability failures, and both ACP-disabled and ACP-enabled factory
schemas (122 native-ingress cases per schema). The corrected pre-ledger baseline
has 322 host cases: 37 plugin, 244 native-ingress and 41 planner/schema. Actual
host captured-registration covers cli-metadata runtime isolation, capable full
registration and full-mode refusal without V2. The ledger adds native integration
checks and a separate pure reducer/guard suite; exact results accompany each
candidate. No historical result is substituted for a changed candidate.


`tests/fixtures/sessions-spawn.provenance.json` records the source hashes and
capture method: construct the pinned native spawn and wait tools, then use the
host's availability finalizer to expose collector controls. The adjacent
sessions-spawn.acp capture also registers a healthy inert test backend to expose
ACP fields, then unregisters it immediately. Its provenance hashes the registry,
availability and policy sources too. These are factory schemas at the pin, not a
live Gateway effective descriptor; neither native nor ACP spawn executes.
Normal tests compare the current factory schemas and provenance without changing fixtures.
To intentionally recapture after reviewing a new pin, run
`PSTACK_CAPTURE_SPAWN_SCHEMA=1 node scripts/test-host.mjs tests/planner-spawn.test.ts`
with `OPENCLAW_SOURCE` set; capture is refused in CI. A local pass is not evidence
that GitHub-hosted CI has run.

`npm run pack` requires a clean worktree and pins HEAD (or explicit `--commit SHA`).
It copies only the literal `files` allowlist from that commit, emits a plain-ustar
`artifacts/openclaw-pstack-<version>-<12-character-commit>.tgz` with canonical Git
modes, verifies the extracted package and prints its commit/path/SHA-256. It never
overwrites an accepted artifact. Publish this **tarball**, not the checkout:
ordinary npm packing discards upstream `.gitignore` and would break exact source
integrity. ClawHub accepts the supplied tarball unchanged. Adapter tests,
verification dumps, evidence, source maps and local operator docs are excluded;
tests/assets inside the byte-identical upstream reference are deliberately retained.
See [publishing checklist](docs/publishing.md) in the source repository for the
reviewed future command and external readiness gates. No workflow publishes.

## Update upstream

1. Pin a reviewed `cursor/plugins` commit and its `pstack` version. Read changed
   upstream skills, agents and supporting references before adapting behavior.
2. Replace `skills/pstack/upstream` from the exact Git tree, preserving every byte
   and canonical Git mode. Refresh source-manifest commit/tree/blob/digest/size
   records; do not record local checkout paths or credentials.
3. Translate changed behavior into native guides/routes, keeping unsupported
   runtime scripts source-only and authorization boundaries intact. Then run
   `node scripts/sync-overlay.mjs --check`. It lists every upstream MUST,
   mustn't, required or never line that is new, changed or no longer present,
   and every file whose bytes drifted from `native/semantic-overlay.json`. For
   each, read the upstream line and record a native gate, a unique native quote,
   another upstream line with the same rule, or an exclusion with its category
   and reason. Add native text first when nothing carries the rule. Then run
   `node scripts/sync-overlay.mjs` to regenerate `native/semantic-overlay.md`.
   `scripts/sync-routes.mjs` only generates manual discovery guides from existing
   native sections, validates source hashes and all restored gates, and never
   regenerates or shortens the native contract text. Run it after intentional
   reviewed native text changes. CI runs both generators with `--check`, which
   refuses stale or missing output without repairing it.
4. Update package/manifest/changelog versions together. Run
   `node scripts/update-native-manifest.mjs` after adapter edits; user config is
   never fingerprinted or modified. Run all relevant checks and independent review.
5. Commit, pack, inspect archive contents and test isolated install/doctor before
   an operator separately authorizes publication. A fresh hash is not a test.

## License and attribution

MIT; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Vendored pstack is Lauren Tan's
MIT work from `cursor/plugins` v0.15.36 at
`c742dd61706fbacc1b95f1a20b7b988cf096ce6c`. Its original license is preserved in
`skills/pstack/upstream/LICENSE`. Adaptation and maintenance belong to
fuller-stack-dev, with no claim of endorsement by Cursor or the upstream author.

## Repository privacy and diagnostics

The packaging test also scans all tracked files for personal paths, host identities,
session keys, email addresses and common credential formats. Exceptions are limited
to reserved example domains, specific upstream examples, SSH URL examples in host-schema fixtures and explicitly
named synthetic session fixtures; other contents in those files are still scanned. This guard is a
regression backstop, not a substitute for secret scanning or human review.

Private identity terms are supplied as a JSON string array in PSTACK_PRIVACY_TERMS,
not embedded (even encoded or hashed) in the public test. The CI packaging step
requires the same-named repository secret and fails closed if it is unavailable.
A fork PR cannot access repository secrets: after reviewing its code, a maintainer
must run its candidate in a trusted same-repository branch before landing. Do not
use pull_request_target to run untrusted candidate code with secrets. Local tests
without the variable run generic checks and explicitly report the identity-scan gap.
Set PSTACK_REQUIRE_PRIVACY_TERMS=1 locally when a full private-vocabulary scan is required.

The optional gateway E2E and isolated-load scripts require OPENCLAW_SOURCE pointing
at a suitable test host checkout. They write raw diagnostics under the ignored
artifacts/diagnostics directory (or PSTACK_EVIDENCE_DIR when set), creating it when
needed. Treat that output as private: it can contain configuration and prompts.
Do not commit raw run output; publish sanitized summaries instead. Do not point these
scripts at a running service or its state directory.

Deleting private records from the current tree does not remove them from Git history.
Review repository history and hosting metadata separately before changing visibility.
