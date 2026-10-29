# Adaptation boundary

This independent OpenClaw plugin adapts pstack by Lauren Tan from cursor/plugins
v0.15.36, commit c742dd61706fbacc1b95f1a20b7b988cf096ce6c (MIT).
It is not an official Cursor plugin or Cursor runtime.

## Preserved source

All 573 vendored files, including 58 skills and two agent definitions, retain
upstream bytes and canonical Git modes. source-manifest.json records exact commit,
Git tree, blobs, sizes and digests. These files are source-only reference: do not
execute scripts, register agents/skills or adopt Cursor-specific instructions.
The source tree intentionally retains upstream tests and assets as attribution
and integrity material; the adapter's tests and local receipts are not shipped.

## Native translation

Two bundled skill roots avoid generic command collisions. The native guide maps
34 workflows, 24 principles and 23 playbooks; setup/help are read-only. Role
planning validates all 17 role labels, preserves omitted native controls and
immutable evidence, and applies explicit continuation corrections append-only.
Native tools retain identity, permissions, execution, review and completion.
On hosts that grant the command-runtime facade (subagents, requester model
catalog, owned-child list, scheduled command turns), the architect, arena,
interrogate, swarm, how, why and reflect controllers run the CAS reducers as code:
each child phase spawns through the host with its output contract, checks the host
selection receipt against the routing snapshot and records deterministic evidence.
Parent checkpoints stay with the agent; approvals come only from an authenticated
`/pstack resume` decision. On older hosts, and for every other route, panels remain
skill-guided, and the CAS ledger records agent-attested phase evidence and blocks
tagged snapshot drift without admitting, executing, collecting or authenticating
approval. A native workflow is never downgraded to skill-guided work.

Host-verified commands own exact-session/incarnation/workspace state. Only
before_prompt_build supplies active context, with explicit host consent. Children
inherit requester tool policy, not sticky mode. No reply_dispatch hook, separate
database, custom model catalog, credential resolver or scheduler is installed; the
controller uses only the host's requester-bound command capabilities.
Read-only briefs are guidance, not sandbox enforcement. The narrow
before_tool_call guard blocks only reserved pstack-tagged sessions_spawn calls;
it never rewrites arguments or affects untagged calls.

Manual report triage/reproduction reuses installed readers, current GitHub and
authorized isolated execution. Optional loop/event builders are dormant until
separately authorized with explicit target, owner, bounds and verified tools.
Installation never creates a job, publishes a verdict or changes providers.

## v0.15.36 migration dispositions

The exact mirror contains 573 files, 58 skills and two agents at tree
4719e1c4b4c43bac85d4206a8b41dd2899769c1c. Relative assets, dotfiles, modes and
MIT text remain original. The 408 added source files are 407 statechart files
and one ketchup-video guide, not 408 callable native skills. Native discovery
now has 34 workflows plus 23 playbooks. Version selection/release is separate.

| Changed source | Native disposition |
| --- | --- |
| Cursor plugin metadata (both manifests) and README marketplace instructions | Source version only; no Cursor registration, updater, install script or auto-update side effect. Native attribution and discovery change together. |
| arena and setup-pstack | Exact two-seat native panels and ordered judge pool, canonical other-family evidence, no inherited judge. Cursor slug guessing, rejected-model defaults, seat replenishment and skip/unknown-family-to-success fallbacks are excluded. New tool plans require trusted current-turn proof; native command admission is still an explicit open capability decision. Existing records and controls are not rewritten. |
| interrogate and design/recipe guide wording | New records use [executed proof](native/interrogate-executed.md): user scope or merge-base through working tree, intent, real scratch runs, independent lead reruns, merged root causes and complete per-origin Findings/Dropped. No arena winner selection or automatic fixes. Removed legacy references remain byte-identical under native/legacy/interrogate for old-record replay; links no longer target removed source paths. |
| create-formal-verification-skill | Every TLA+ result, including pass, resolves the native Statechart guide by name without copied version/machine commands. Existing mutation and code-mapping gates remain. |
| statechart and verify/ship guide | [Native route](native/workflows.md#statechart) carries reader rules, pure views, flat/hierarchy/parallel forms, hiding constraints, marks, bounded-rule honesty, original TLC output, 500-state drawing budget, later 100,000-state rechecks and real-code replay. Separate verified native toolchain/Pele CLIs replace the source launcher/mise; rendering is not proof and renderer errors retain Mermaid. |
| ketchup-video and recipe guide | [Native route](native/workflows.md#ketchup-video) carries the current invocation window, factual artifacts, private slide plan, ten-slide bound, evolving pictures, complete calls, separate captions, slide-derived silent video and measured decoded-frame holds. Native PNG/letterboxing and conservative word-count limits are explicit, not claims of agent factual/story quality. |
| poteto-help and recipe discovery | Both artifact routes appear in native help, index, literal commands and model-hidden manual guides. Autopilot examples mean no merge, not a forced stack. Guide examples are explanatory text, not new execution authority. |
| poteto-mode and explain-the-number | Existing current-goal/brief/PR Why/final guidance and pre-measurement decision/noise-floor rule are retained. Native accepted completion modes replace background Task/steer flags. No default model or control rewriting. |
| reflect | Existing destination-before-row-approval and no installed/cache edits, push or PR remain. Cursor copy paths become canonical user-owned native source, with explicit approval. |
| autonomous-run | Goal-supporting discoveries only; native predicate/scope rule already carries this. No unrelated work grant. |
| orchestrate and overnight guide | One PR owner is its only writer/rebaser/retargeter, coordinator checks artifacts/live PRs, every PR has a different-family verifier, fresh independent work with built-state continuation only, bounded rolling workers and three levels, pilot, all-worker accounting, cause-based two-retry limit and late-result reconciliation. Existing native records/tools replace deleted helper-store/queue ceremony. Dependency reports and native child collection remain necessary; no new topology/CAS/continuation mechanism. |
| autopilot-full | Push finished units only with authority, rebase for known concurrent same-file landing, wording-only exception only to extra workflow verification, demonstrated-head or wrong-shipped-doc blockers, base defects only when copied/newly reached, and parked follow-ups. User/repository/security/review/CI gates are not waived. |
| autopilot-stack | Full minus merge. Independent PRs stay on trunk; stack real dependencies only. Each owner rebases its own branch, lower-head changes restack dependents, unchanged patch-id can carry evidence but each head needs CI. Verified handoff freezes pushes until operator go. No forced linear topology or root-only branch writer. |
| babysit, multi-phase-plan and opening-a-pr | Match owner rebase authority, merge-vs-handoff choice, same-file/wording/blocking rules and real dependencies. Remove only the upstream automatic subagent-interrogate trigger; explicit review and contested-design gates survive. Plan skeleton uses verified handoff, not root append. |
| swarm | Numbering/reference/result-table correction already matched native sequential steps and consolidated table; no new runtime change. |
| check-plan and tests (#803) | Existing native matching-length backtick scanner and regressions carry the change. Source-only Bun tests are not executed. |
| watch-pr github/types/tests (#801) | Native accepts an explicit repo/PR with fixed GraphQL documents, with no branch discovery/byHead/fork descent. No equivalent collision path; no unused fields added. |
| watch-pr policy/tests (#802) | Native is one-shot with no polling/retry sleeps. Its until value is an admission cutoff, not in-flight cancellation; per-call timeout/hung-child checks remain. No hard-deadline parity is claimed. |
| worktree-audit (#805) | Native uses Git epoch arithmetic, no GNU/BSD stat/date branch. lastActivity stays not-checked and no bucket grants safe deletion; no transcript scanning added. |
| removed orch helper/store/tests and script package command | Removed only from exact source mirror. Native controllers, CAS, stores, authority and continuation tests remain; no live record migration/deletion. |

The line-based overlay covers 363 MUST/required/never lines in 117 files.
New statechart source identifier/type/diagnostic/test/corpus matches are classified
as non-normative individually, not a blanket exclusion of the native statechart
workflow. The map is reviewed text coverage, never a model-execution verdict.
Requirements were consolidated for the replaced orchestrate/stack semantics;
52 guarded routes retain 796 text gates. Counts are not a substitute for review.

## Integrity and verification

native-manifest.json fingerprints the shipped adapter guidance/helpers and paired
alias. It contains no user's role config, local skill inventory or deployment
receipts. Doctor checks pinned source bytes, adapter hashes, route/link coverage
and alias integrity; source tests exercise actual failure paths separately.
The doctor also re-extracts every upstream line that states a MUST, mustn't,
required or never rule and checks it against the reviewed
[upstream rule overlay](native/semantic-overlay.md): each rule must map to a
current native requirement gate, a unique native quote, the same rule elsewhere
upstream, or an exclusion with a category and reason, at the pinned upstream
hash. A doctor pass proves content integrity and reviewed text coverage, not live
model execution, authorization, connector readiness or completion of every
workflow.
