# Changelog

## 1.2.8 — 2026-10-27

- First public ClawHub release, published from the public repository. No code changes from 1.2.7; the earlier unreviewed ClawHub uploads (1.2.5–1.2.7) were withdrawn and their version numbers stay reserved.

## 1.2.7 — 2026-10-27

- Rename the plugin display name to `openclaw-pstack`; keep plugin id pstack, package identity, commands and tools unchanged.
- Remove private operator history, run records and raw diagnostic evidence. Keep the public follow-up list; diagnostic scripts now write to ignored output configurable with PSTACK_EVIDENCE_DIR.
- Extend the packaging tests with a tracked-file privacy guard, narrow fixture/upstream exceptions, and rejection tests for private paths, identities and credentials. The existing CI packaging job runs the guard.

## 1.2.6 — unreleased

- **Blind framing (P3-70, P3-76):** require measurement context for rubric, grader, oracle and expected-output terms, preserve ordinary subjects and ticket acceptance criteria, and reject the remaining attempt-grading, competitor, hidden-reference and per-case scoring phrases. Paired organic-request regressions exercise both sides.
- **Yield handoffs (P3-71, P3-77):** require non-empty field values; accept table, checkbox, letter/Roman-numeral, multi-digit, emoji, full-width-colon and em-dash labels. Spawned visible children retain requester-message waits based on native spawn lineage, not their dashboard key.
- **Yield regressions (P3-72):** exercise the wait_for alias through the actual host hook/yield pipeline and the 64-entry result-note eviction boundary.
- **bro and eval:** compare every claim and recheck the one correction before delivering bro; read every eval artifact through EOF after truncation and keep native-blinding limitations explicit.

## 1.2.5 — unreleased

Round 7b, lane P-I: two route-text conflicts from the 1.2.4 review (P3-67, P3-69) that rerun 7 would likely hit, and the missing bound on a collector's wait (P3-68); then the 1.2.5 review's change request (P2-1, P3-73 to P3-76, P3-78). 6 new gates, for 49 routes and 845 gates.

- **Every route that may hand off spawns announcing children (P3-67).** maintain-verification-skill step 9 forbade collecting in the turn ("never … wait on an unbounded `awaitResults`"), which contradicted the 1.2.4 collector rule; its r6 run handed off on collectors three times. That step, prototype step 9, opening-a-pr step 16, trace-forensics step 9 and the shared "For long routed phases" line (20 routes) now say to spawn the waited children as announcing children (without `collect`) and to collect a collector in the turn that spawned it, never hand it off. prototype and opening-a-pr use investigation's six-line handoff wording. The review's residues (P3-73) say the same: teach steps 6 and 7, babysit step 8, runtime-forensics step 9, shipping step 6, autonomous-run step 1, the workflow-ledger `wait` bullet, route-commands and the contract's visible-handoff sentence. A test now checks every paragraph of the native guidance that hands off after a wait, not only the sections with the shared line.
- **A collector's wait is bounded (P3-68, P2-1, P3-74, P3-75).** `agents_wait` with `awaitResults: true` waits until the child settles, and the host default `runTimeoutSeconds` (0) means no limit, so only the parent's 48-hour turn timeout bounded it. `pstack_route` now gives a collector's spawn arguments `runTimeoutSeconds: 600` when they have none (or 0, `null` or a blank string) and refuses more than 900, reading the value as the host does (a numeric string, or the `run_timeout_seconds` alias). In pstack mode the plugin's `before_tool_call` hook only refuses a `sessions_spawn` collector that asks for more than 900; it never changes a spawn's arguments. Code Mode `agents.run` spawns and a native controller's own dispatch are never refused. 600 s covered every collector in the 1.2.3 rerun (84 runs, longest 595 s); the bound counts from the child's own start, so queue time is extra; a longer phase is an announcing child, which hands off visibly after a 60-second wait, and a structured-output phase, which must be a collector, has at most 900 s.
- **The spawn hook no longer rewrites spawns (P2-1).** The first 1.2.5 draft also rewrote every unbounded pstack-mode collector to 600 s. That included Code Mode `agents.run` workers, which cannot ask for more, and the rewrite went through the host's parameter merge, which keeps only enumerable keys, so it dropped `agents.run`'s launch replay key and a restart would have spawned the worker again. Now the hook returns no parameters for any spawn; a real-pipeline test on both pinned hosts sends an `agents.run`-shaped call with its non-enumerable keys and checks that `sessions_spawn` receives them unchanged. Host issues are drafted in `docs/follow-ups.md`.
- **Attention and readiness come before the six handoff lines (P3-69).** "Nothing follows the six lines" conflicted with show-me-your-work ("every reply … ends with Attention") and with opening-a-pr's closing readiness line. In a handoff reply those blocks now go immediately before the six lines, which still end the reply; the contract, both routes and the per-turn context say so.
- **P3-70, P3-76:** blind trials also refuse "this is an eval / part of a benchmark / an experiment", "you are being tested", "other assistants / LLMs" doing the task, being checked against a "reference solution", "success criteria: …", "the answer key says …", "record a score (or pass/fail) for each case", "you are one of three candidates", "ground truth: …" and "the gold answer is …". Each pattern needs framing context (the end of the clause, a verb, or the noun as a clause's subject), so ordinary tasks still plan: "This is an evaluation order bug", "This is a benchmark regression", "Fix the answer key lookup", "Update the reference solution in docs/…", "List other LLMs supported", "Print the pass/fail for each case in the test runner summary", "You are being tested by the CI matrix", as well as a benchmark file, an eval harness or a CLI's reference output.
- **P3-71:** the yield guard also accepts numbered, heading, `+ ` bullet, code and bold-italic handoff labels.
- **P3-72:** tests for F8 (`fast` is not found in "faster") and pins for trace-forensics step 10 and session-pickup's collect-in-turn sentence (C3, C5).

## 1.2.4 — unreleased

Round 7, lane P-H: the fixes for the 1.2.3 per-route rerun (43 pass / 12 partial / 0 fail), which missed the gate on unslop (below its 1.0.0 grade) and bro (below its 0.1.0 grade). 10 new gates and one more guarded route (unslop), for 49 routes and 839 gates.

- **unslop: a file edit is delivered as a file, not as the child's words (P3-66).** When a routed child's deliverable is a file edit, the parent quotes the child's own report verbatim as the child's text and shows the edited file or diff separately, labelled with its path. The rule is in `delegation.md` and unslop's new step 4; unslop now has a requirements guard.
- **bro: names stay as written, and the child gets the original.** The r6 parent briefed the child with its own paraphrase ("observed ordering could still be serial") and checked the result against that paraphrase, and the child renamed `concurrent-drain` to `parallel-drain`. The route now keeps every name exactly as the original spells it, gives the child the original message and no parent gloss, and checks the restatement against the original's own words.
- **Yield guard: waitFor is removed, not refused.** On hosts whose `sessions_yield` schema still advertises `waitFor` (794d650), the 1.2.3 guard refused 79 of 79 parent yields. The plugin's `before_tool_call` hook now returns the same call without `waitFor`, so the yield goes through, and adds a note to that yield's persisted result. The host merges hook params the same way at 74cb12d, v2026.10.6 and current main. A placeholder or status-sentence acknowledgment is still refused, and the refusal now says to retry the same `sessions_yield` at once.
- **P3-64:** the guard accepts list-marker, quoted, bold and lowercase handoff labels; its reason no longer depends on the host version; and the contract and per-turn context say it covers every `sessions_yield` of a top-level session in pstack mode, not only route handoffs.
- **Collectors are collected in the turn that spawned them (openclaw#184290, P3-36).** A collector never wakes its parent, so a handoff on a pending collector waited for the user (session-pickup in r6). The bounded-wait rule now makes a child that may be handed off an announcing child, ended with `sessions_yield`, and collects every collector in the same turn with `agents_wait` and `awaitResults: true`. session-pickup delivers the verdict in the pickup turn, and trace-forensics no longer hands off on a collector.
- **investigation: the handoff ends the reply.** Step 9 named only the yield acknowledgment; with its yields refused, the r6 parent sent the handoff with a message tool and ended on "remains pending …". The step now names the six lines for both the acknowledgment and the final reply text, and the contract says nothing follows them and a handoff is never sent with a message tool.
- **1.2.3 review follow-ups:**
  - P3-62: blind `arena runners` trials refuse measurement framing (a rubric, grader, oracle or expected output, scoring each case, telling the trial it is judged or compared, competitors), not the subject words of an organic request such as a regression test or an expression evaluator.
  - P3-63: `withheld` items match whole words, so `fast` no longer matches `breakfast`; the eval route says to pass each criterion separately and still read the task, because a paraphrase passes; a host-blind plan refuses `visible: true`.
  - P3-65: tests for the surviving mutants W4 (framing in `trialArgs`), Y1 (a subagent in pstack mode), Y5 (a lookup failure never blocks) and Y7 (the hook's matcher), plus a test through the pinned host's real `before_tool_call` pipeline and `sessions_yield` tool.

## 1.2.3 — unreleased

Round 6, lane P-G: the fixes for the 1.2.2 per-route rerun (43 pass / 11 partial / 1 fail). 6 new gates, for 48 routes and 829 gates.

- **Arena and architect: the lead scores before the judge, enforced by the controller.** New native arena and architect records (`leadFirst`) put a `lead` checkpoint between the candidates (or designs) and the judge. The parent records its own score for every usable candidate there, under each exact label; the controller refuses scores that skip a label and spawns the judge only afterwards. The judge never sees the lead's scores. `compare` then shows the recorded lead scores beside the judge's and records only the comparison (and red flags); the lead's scores cannot be rewritten after the judge's are visible. Records created before 1.2.3 keep their stages.
- **Eval: trials and the judge get only what they should see.**
  - `pstack_route` blind plans take `withheld`: the judge-only rubric, expected results or oracle, or the parent's own results. A blind task or argument that contains one is refused. Blind `arena runners` trials need `withheld`, and their task may not name the measurement (eval, test, judge, rubric, score, compare and the rest of the route's list).
  - Host blind children (openclaw #182272): when the host advertises `native-subagent-blind-v1` and its `sessions_spawn` schema has `blind`, blind plans return `blind: true` and `context: "isolated"`, so the host omits the trial's model identity and workspace from its own prompt. Otherwise the result's `hostBlind` says blinding is unavailable and the trial must not be called blind.
  - The eval route says the trial task never states the success criteria, oracle or a required harness, and the judge's task carries only the labels or outputs and the rubric.
- **automate-me:** the only exemption from "a one-off preference is a note" is a convention the user explicitly asks, now, to keep as a standing rule. A current preference that resembles a one-slice detail does not promote it, and a brief's summary is not a second slice. (1.2.2's P3-55 sentence was too broad.)
- **waitFor and placeholder acknowledgments: a plugin-side guard.** In pstack mode, a top-level parent's `sessions_yield` that sets `waitFor`, or whose acknowledgment lacks the six handoff lines (such as `UNUSED`), is refused by the plugin's `before_tool_call` hook, with the correct two-field call to send instead. Subagents and sessions without pstack mode are untouched. The per-turn context adds the concrete wrong call.
- **ketchup:** step 2 runs the PR, check and worker reads itself; a seeded state is a claim to check, and `unverified` is only for a read that cannot run.
- **unslop:** runner variance; no route change (see the owner doc).
- **1.2.2 review follow-ups:**
  - P3-56: a correction record's failed child blocks; it is not retried with a second correction child.
  - P3-57: a deliverable the host killed or timed out is not corrected either; the stage blocks visibly.
  - P3-58: arena dropout evidence and downstream briefs record a rejected child's reason without its stored answer.
  - P3-59: no retry is spent when a failed sibling that cannot be retried will block the stage anyway.
  - P3-60: tests for a lone schema-failed candidate, the checkpoint context while a stored answer is held, and a refused retry of a passing child.
  - P3-61: the contract no longer says the host's schema turns a `waitFor` acknowledgment into pause-notice text; the context heading is "Retried or corrected once" and names a user's reflect correction as the user's; the 1.2.2 notes below now say one gate's text changed, and the P-F owner doc counts 67 tests.

## 1.2.2 — unreleased

Round 5, lane P-F: the fix for the 1.2.1 per-route rerun (41 pass / 14 partial / 0 fail), where arena fell from pass to partial. Its judge scored both candidates, but passed its result to `structured_output` as a JSON string with one extra `}` on both of its tries; the host rejected the result, and the controller blocked instead of retrying the judge. The same slip happened in 1.2.0's architect run. No gates were added (48 routes and 823 gates); the automate-me one-off gate's text changed with P3-55.

- **The arena and architect judges get one retry.** A judge whose structured result is rejected, invalid or missing, or that is BLOCKED, gets one retry before the workflow blocks. This is the one-correction path lane P-D gave the how, why, interrogate and reflect deliverables. The retry is a fresh child under the same pinned routing snapshot and host profile, briefed with the first attempt's answer and the errors. It is one `retry` ledger entry, and its dispatch goes through the existing room check. A second failure blocks, naming "after its one retry".
- **Every other native child whose failure would block gets the same retry:** the interrogate reviewers, the architect grounding children and design runners, the how explorers, the why investigators, the reflect lenses, and the arena candidates when both fail. A lone arena candidate failure is still a dropout, and swarm slices keep their coverage-gap retry. A child the host killed or timed out is not retried, and a routing mismatch still blocks at once.
- **The retry is disclosed.** The command reply names it, and every later parent checkpoint context lists it under "Retried once by the controller", so that the parent names it in its reply and in the delivered result. A rejected child's answer is kept, bounded, in the rejection, so that its retry can see it; it is left out of the reply, the context and the block reason.
- **Wording (1.2.1 review follow-ups):**
  - P3-53: `waitFor` only matters when the caller is itself a subagent, paused for its requester's message.
  - P3-54: the plan-completion check is about the run's saved plan, not the session's; the per-turn handoff reminder applies to skill-guided routes.
  - P3-55: automate-me exempts a preference the user stated explicitly.
- **Isolated native e2e:** a new arena scenario, in which the first judge sends the extra-brace result, runs on a real Gateway.

## 1.2.1 — unreleased

Round 4, lane P-E: the fixes for the 1.2.0 per-route rerun (42 pass / 13 partial / 0 fail), where blast-radius, automate-me and shipping fell below 1.0.0. 7 new gates, for 48 routes and 823 gates; all 816 earlier gates are unchanged.

- **The plan-completion check no longer reopens a handoff.** A turn that hands off as its final reply text passes the host's plan-completion check ("This run’s latest successfully saved plan still has unfinished steps … Continue feasible work …"). A new `contract.md` section, [plan-completion check after a handoff](skills/pstack/native/contract.md#plan-completion-check-after-a-handoff), says to answer it with exactly `NO_REPLY` and nothing else. The host still delivers the handoff. To avoid the check altogether, a runner can save a markdown-only progress card that names the pending child. Checked against host `74cb12d`, `v2026.10.6` and `794d650`.
- **Every `sessions_yield` is a handoff** with the six lines, including a yield that only waits for a finished child's completion delivery (shipping). The yield call has two fields, `acknowledgment` and `message`, never `waitFor`; the contract explains why the host's "must set waitFor" sentence is for subagents. P3-52: any status other than `yielded` means the handoff goes in the reply text, and the yielding turn has no other reply text or message send.
- **The active-mode context now carries the handoff reminder on every turn** (`src/index.ts`): the visible handoff, no `waitFor`, and `NO_REPLY` to the plan-completion check.
- **The claim check catches escaping artifacts:** a quote must match the child's text byte for byte, with JSON escapes decoded (recall).
- **Routes:**
  - blast-radius: likelihood and cheapest check for every listed risk, checked before delivery;
  - automate-me: a one-off preference is a note at most, never a code fix or automation;
  - shipping: a new handoff step;
  - autonomous-run: stop and hand off at a pending wait;
  - figure-it-out: each trail row right after its commit.
- **Test Gateways never advertise on the LAN:** both e2e scripts disable bonjour (environment, `discovery.mdns.mode: "off"` and the bundled plugin entry) and assert that nothing was advertised.

## 1.2.0 — unreleased

Round 3 of the parity program: the fixes for the 1.1.0 per-route rerun (34 pass / 21 partial / 0 fail). Lane P-C changes route text; lane P-D changes the native controllers and plugin scripts.

### Route text (lane P-C)

Lane P-C first closes the five routes below a baseline (ketchup, bug-fix, runtime-forensics, prototype and session-pickup), then the remaining plugin-classified partials. Every new route sentence has a requirement gate: 27 new gates in 19 routes, with new requirement records for ketchup and poteto-help. That makes 48 guarded routes and 816 gates; all 789 earlier gates are unchanged.

- **The handoff is in the visible reply.** A new shared rule, [visible handoff](skills/pstack/native/contract.md#visible-handoff): a turn that ends with `sessions_yield` puts the whole handoff in its `acknowledgment` field, the visible waiting reply, in a fixed six-line form (handoff, owner, pending run and session, done so far, snapshot, next action). The `message` field is private and never counts as the reply. A handoff comes only after one bounded wait, and the turn then does no more work. The host shows the acknowledgment only for an otherwise-silent turn and only when `sessions_yield` returns `yielded`, so the yielding turn writes no other reply text (or puts the whole handoff in it), and any other yield status puts the handoff in the final reply text; `waitFor` is never set for routed children. Gates: runtime-forensics, prototype, teach, investigation, trace-forensics and opening-a-pr.
- **Verbatim delivery is checked for accuracy first.** A new shared rule, [checking facts before delivery](skills/pstack/native/delegation.md#checking-facts-before-delivery): the parent checks the child's claims against the evidence. A wrong claim goes to ONE fresh correction child (a collector child is one-shot and refuses `sessions_send`), or the quote is delivered unchanged with a `Parent verification:` section listing each discrepancy. The parent never silently rewrites the quote, and never delivers known-false text without that section. Gates: ketchup and session-pickup. teach and recall now limit a same-owner correction to an announcing child that is still open and send a collector's correction to one fresh child under this rule (gates `teach-collector-correction`, `recall-collector-correction`).
- **session-pickup:** the judgment child picks the verdict label from all four; the parent never names, ranks or hints at one in the task, and only validates the child's line. Step 11 says the judgment child writes that line (gate `session-pickup-child-writes-verdict`).
- **bug-fix:** the reply pastes the captured failing assertion output verbatim, never a summary such as `9 !== 20`.
- **A rejected delegate report reruns as a fresh child** (shared rule in `agent-briefs.md`; gates in poteto-mode and orchestrate). The delegate brief now asks for `contractRead` entries exactly as the required paths, without anchors. Plain paths remain the brief's form; lane P-D's `pstack_brief` check (below) also accepts a `path#heading` entry.
- **Other partials:**
  - show-me-your-work: no BLOCKED claim while records exist, and Attention on interim replies;
  - poteto-mode: a visible, fully marked checklist and claim labels;
  - autopilot-full and autopilot-stack: re-read the playbooks at every audit boundary and refresh finished owner records;
  - hillclimb: no invented attempt minimum;
  - refactoring: alternatives differ in shape, and a same-shape result is reframed;
  - visual-parity: every pinned state is re-diffed after each change;
  - poteto-help: a `/pstack <route> <request>` example;
  - recall: Problems lists symptoms, and coverage gaps go on their own line;
  - opening-a-pr: an explicit `Readiness:` line.

### Native controllers and plugin scripts (lane P-D)

- One correction for a verbatim deliverable. The report the controller delivers verbatim (how's explainer, why's synthesizer, interrogate's lead, reflect's synthesizer rows) gets one correction child when the controller rejects it (failed, killed, timed out, no structured result or an invalid result), when it is BLOCKED, or when it lacks a section the controller requires of that kind (how: Overview, How It Works, Where Things Live; why: The Question, What We Found, What We Don't Know, Sources Consulted, Confidence Summary; interrogate: Intent, Reviewers, Act on, Consider, Noted, Dismissed, Agreement Map; reflect: Accepted, Rejected, Backlog).
  - Collectors cannot be continued, so the correction is a new child under the same pinned routing snapshot and host profile. Its brief carries the first attempt's output and the errors. The ledger records it as a `retry`, within the room check, and the reply says so; the delivered result names the correction and the first attempt's failure.
  - A second rejection or BLOCKED result blocks the workflow, naming the correction. A report that still lacks a section after its correction is delivered with the gap named.
- P3-38: the interrogate lead is retried once in this way before the workflow blocks, and both reviews are kept.
- The parent's claim check. A completed how, why or interrogate reply now ends with the command that corrects it: `/pstack resume <id> correct <what is wrong>` creates one correction record for the delivered slot (same snapshot, profile and inputs, the delivered report and the errors), runs it and delivers its report verbatim, attributed as the correction. The completed record is unchanged; a result is corrected once, and a correction is not corrected again. At reflect's approval, `/pstack resume correct <notes>` asks for one corrected synthesis before anything is applied (the earlier `revise` hint for reflect named a decision its approval refused).
- Visible handoffs. A reply that ends with children still pending names the owner session and incarnation, the workflow and phase, each pending child's role and run id, the next armed scheduled continuation (or that none is armed) and the exact `/pstack resume <id>` command.
- pstack_brief: a delegate's `contractRead` may name a required read as `path#fragment`, with the path absolute as rendered or literal repo-relative (`skills/pstack/native/workflows.md#poteto-mode`), when the fragment names an existing heading of that file and the read's own section where it has one. Every other form is refused as before, with the reason added for a fragment that names no heading or the wrong section.
- P3-41: tests now kill the surviving mutants M1 (the surrogate guard) and M3 (the room check ignoring unsettled children). P3-42: a deliverable report over 32,000 characters is cut to the reducer's limit instead of blocking.

## 1.1.0 — unreleased

Round 2 of the parity program: the fixes for the 1.0.0 per-route rerun (22 pass / 31 partial / 2 fail), in two lanes. Lane P-B fixes route text and routing; lane P-A fixes the native controllers and command handling.

### Route text and routing (lane P-B)

These fix the plugin-classified route-text defects of the 55-route rerun. Each new route sentence has a requirement gate; there are now 46 guarded routes and 789 gates, and all 766 earlier gates are unchanged.

- Verbatim delivery. A routed child's user-facing text is delivered verbatim, quoted and attributed, never as a parent paraphrase (shared rule in `delegation.md`; gates in bro, investigation, poteto-mode and teach). bro also checks that the restatement is shorter and keeps every qualifier.
- Bounded-wait handoff. A shared rule in `contract.md`: every in-turn wait has a timeout of at most 60 seconds, and once a wait returns with a required child pending, the turn ends with a handoff. Gates in maintain-verification-skill, trace-forensics, prototype, opening-a-pr, teach and recall.
- feature and refactoring make their ordered commits when local commit authority was granted, and list them.
- recall collects every reader and investigator before synthesizing.
- session-pickup reads its trail with the session tools, routes its judgment and verdict, and writes one of four labels: `continue`, `ship`, `ratify or override` or `postmortem`.
- create-verification-skill names maintain-verification-skill in the handback itself.
- Planner call. A shared rule: plan with `role`, `task` and `spawnSchema`; a role-only call routes nothing, and a planned phase is spawned or named BLOCKED. Gates close the gaps in eval, visual-parity and poteto-mode.
- pstack_route blind mode. With `blind: true`, trial tasks carry no routing snapshot, model IDs, role or workspace; the custody comes back separately as `custody`. A task or argument that names a selected model or the workspace is refused. `trialArgs` gives each trial its own spawn arguments, such as its `cwd`. The eval route uses it for trials and the judge.
- The unshipped workstream-launcher skill is no longer required: the needed launch rules are inlined in `delegation.md`.

### Native controllers and commands (lane P-A)

The native controller fixes from the rerun, plus follow-ups P3-26 and P3-28, and use of the round-2 host fixes H-1 (complete collector results) and H-2 (canonical model families).

- `/pstack-poteto-help` and `/pstack-setup-pstack` run the agent on the user's question again. 1.0 replaced them with a static banner, so neither question was answered (both routes failed the rerun). The command now continues the agent without activating mode. The turn that carries the command's question gets a one-time read-only context: the route section, the native README and route index (help) or the workspace `pstack-models.json` and model-routing setup (setup), and the host facts the plugin probed: native controllers, unattended scheduled turns (S6, BLOCKED when absent) and registered profiles (S5). An invocation that cannot continue the agent (no authorized webchat/internal sender with operator.write, or no exact session) gets the static help with that reason.
- Records created from 1.1 carry `stagesVersion: 2`. Records created by 1.0 keep the stages they were admitted with.
  - Architect grounds the design in independent children: a `how explainer` and a `why synthesizer` that returns Preserve / Change / Avoid / Risk constraints. Their reports go to both runners and the cross-judge verbatim. A leading `how-only` keeps only the how child; `greenfield` keeps the parent `ground` checkpoint. Default `how-why`.
  - Interrogate adds a `lead` stage: one routed `judgment and prose` child gets the framing and both reviews with their host-reported models. It validates every finding and returns the four buckets and the model-attributed agreement map. This replaces the parent `verdict` checkpoint.
  - How, why and interrogate end with their deliverable child (explainer, synthesizer, lead) instead of a parent `present`/`verdict` checkpoint. The command reply, which the host delivers unedited, quotes that child's stored report verbatim, attributed with slot, role, host-reported model, run and artifactDigest. A scheduled continuation that completes the workflow delivers it to the transcript the same way. A plain `/pstack resume <id>` shows it again. A reply longer than the host's 8,000-character chat display cap (the rerun's how and why results were 9,838 and 11,793 characters) is shown capped in the chat view; the persisted message stays whole, and the Control UI recovers it through `chat.message.get`.
- Reflect shows the synthesizer's full Accepted / Rejected / Backlog rows, verbatim and attributed, in the reply that reaches the approval step, and on each `/pstack resume` while waiting. The synthesizer numbers every row for row-by-row approval. After approval, the apply turn gets the decision, the full rows and a required post-approval summary: applied, not applied, every rejected row with its reason, every backlog row with its mechanism and filed/blocked status, and validation.
- Swarm:
  - Worker briefs no longer say "Write only under" the artifact directory. That contradicted the slice method's own worktree, so both p95 attempts in the rerun returned BLOCKED. Workers now change code only where their slice method directs and keep notes under the artifact directory.
  - The one retry gets an amended brief that names the previous attempt's failure.
  - A slice that also fails its retry is recorded as `coverage-gaps` evidence (controller-sourced, never a pass), and the workflow continues to `aggregate` with the usable slices. The aggregate context lists the gap. A workflow blocks only when every slice failed, since nothing is left to aggregate.
- P3-26: stored child results are fitted by stored bytes (JSON-encoded UTF-8, as the ledger budget counts them), not UTF-16 code units, and cut only on code-point boundaries. The share is 2–16 KiB per child. The deliverable child gets up to 96 KiB, and earlier stages leave room for it. A 64-slice swarm of 8,000-character CJK reports now reaches `aggregate`; before, it blocked partway.
- P3-28: the controller spawns only when the ledger can still record that child's dispatch, accept, the stage's wait and resume, and a result for every unsettled child. Otherwise it blocks before spawning. `accept` may also use the block tier, so a child the host already runs is always recorded and named in the cancel's custody note. Before, 245 or 247 events let the host accept a child the ledger then refused to record.
- Skill-guided mode context (for example teach, bro and investigation) now tells the agent to deliver a routed child's result verbatim, quoted and attributed, instead of a parent rewrite. This is prompt guidance; skill-guided delivery stays agent-attested.
- Child briefs escape embedded spawn-tag text in tasks and child reports, and the parent context no longer claims `pstack_workflow get` returns uncut reports (N-h).
- H-2 canonical model families. On hosts advertising `requester-model-family-v1`, the requester catalog's `family` is copied into the planner catalog (well-formed tokens only), so pstack_route returns it with the selected records and native records store it. Families are compared only for equality, and an absent family is unknown, never different.
  - A pool reports `different-family` only when the chosen entry's family and the parent's are both known and differ. Before, an entry with no family beside a known parent family reported `not-established`; it now reports `unverified`.
  - A panel now reports its two entries' diversity the same way (`different-family`, `not-established` when both are known and equal or one model twice, otherwise `unverified`), instead of `not-applicable`. Panel snapshots recorded before keep `not-applicable` and stay valid.
  - The native parent context lists each panel and pool role's diversity with the reported families, and the interrogate lead is told the reviewers' diversity. A native controller does not know the parent's model, so its cross-judge pool stays `unverified` against the parent.
  - Without the capability, families are ignored, as before.
- H-1 complete collector results. A native completion the host marks `resultTruncated` (its text answer over 100 KB or no longer available) is collected from its structured result as before, with a marker as the first stored evidence entry and a note in the reply; a truncated completion without a structured result is rejected with that reason. The controller never read the 4,096-character text preview, so there was no preview workaround to remove.
- Tests: each fix has a behavioural test that fails on 1.0 (`add71c3`), using the rerun's scenarios, plus reducer tests for stage versions, coverage gaps and the accept tier; the H-1 and H-2 tests fail on the first 1.1 head (`e00aa92`). The isolated Gateway e2e runs each route's rerun scenario against the built archive on openclaw main `74cb12d` (which has H-1, H-2 and H-3), including a fixture provider catalog with two declared families and a 110,000-character final answer, and reruns the old-host checks on OpenClaw 2026.10.5 (`034856a`). The main host pin moves to `74cb12d`.

## 1.0.0 — unreleased

Phase 3 of the v2 plan: real host-run panels on hosts that grant the plugin command runtime, with v1 kept everywhere else (parity gaps G4, G5, G6, G7, G9 and G11). It includes the 0.3.2 fixes below.

- Native controllers. `/pstack-architect`, `-arena`, `-interrogate`, `-swarm`, `-how`, `-why` and `-reflect` request the command runtime (`subagents`, `models` and, where advertised, `scheduledTurns`) only on hosts that advertise `command-native-subagents-v1` and `requester-model-catalog-v1`. Each invocation still probes `ctx.runtimeContext`; without both grants the route stays skill-guided. The manifest declares `contracts.commandRuntimeCapabilities` and `contracts.sessionScheduledTurns`, which older hosts ignore.
  - Every child phase resolves its roles from pstack-models.json over the host requester catalog, records a dispatch, then spawns through the host with the role's output contract as `outputSchema`. The host acceptance and its selection receipt come next, then a bounded collect and settlement, each one CAS write in a version 2 record whose view is `deterministic`.
  - A child is collected only when `selection.resolved` (and `observed` when present) confirms every requested model, thinking and fastMode. A mismatch, a missing control, a failed/killed/timed-out child, a schema failure or a contract-invalid result rejects the child and blocks the phase visibly. A routing failure blocks at acceptance and at collection in every stage; it is never an arena dropout. Arena records dropouts and judges only usable candidates; a swarm slice retries once.
  - Parent checkpoints continue the agent with the record's context. On a native record pstack_workflow accepts only framing (`configure`), checkpoint gates, block and cancel. Swarm slices and why source dispositions are recorded once at framing.
- Resume and continuation (D5, D7). `/pstack resume [id] [approve [notes] | revise <notes> | cancel [reason]]` continues from the CAS record. Collection waits at most `nativeWaitSeconds` (default 20) and hands off. Lost acceptances are reconciled through the owned-children list (S4) by request id, and block rather than respawn without it.
  - Architect `agree` and reflect `approval` persist as awaiting-user. Only an authenticated `/pstack resume approve|revise` from the command sender moves them.
  - Each user command arms the documented cadence of single-occurrence scheduled continuations (S6), 30 seconds, then 2, 8 and 25 minutes, up to the host's limit of four; a later command arms only the missing ones. They are quiet unless the record changed and never continue the agent. They are re-armed after a reload, and after a restart unless the host reported `survivesRestart`.
  - A resume that finds the stage still running writes nothing.
  - A lost dispatch is abandoned and respawned only when its own requester resumes and the host list (filtered by requester, at most 200) is below its cap. Another operator's resume or a full list blocks with an explanation, and an unattended continuation leaves it untouched.
- Ledger budgets are tiered: progress stops at 248 events or 480 KiB, a block still fits to 255 events or 504 KiB, and a cancel to 256 events or 512 KiB. A controller step refused for budget becomes BLOCKED, so a full workflow can always be cancelled and replaced. Stored child reports and evidence are fitted to an even share of the remaining room, marked when cut, with `artifactDigest` over the full result.
- G9: the controller, with its keyed-store record and scheduled continuations, is the native replacement for upstream `orch`. Plan check, trail and worktree audit keep their 0.3 adapters; watch-pr remains a user-installed template.
- Downgrade rule. A native record is never continued as skill-guided work or given new children. Without the subagent grant, resume, decisions and the single-word kind forms refuse with an explicit BLOCKED message. On capable hosts the single-word architect/arena/interrogate/resume forms work; `/pstack status` names the session's native workflow.
- pstack_route (G6). It reads the host requester catalog through its version 2 tool context and returns `catalogSource`, `availability` and the selected catalog records. Without any catalog, configured models now resolve with `availability: "unverified"`. Before, a call without a caller catalog failed with `Unavailable native model: clawrouter/openai/gpt-6-astra`, because the planner treated a missing catalog as an empty one. A caller-supplied catalog stays strict, even when empty.
- Spawn guard (G11). For a native record the guard admits a tagged spawn only while the controller's dispatch is pending. Guard and controller share one requested-selection lookup, and the controller compares that selection with host receipts.
- Host subagent profiles (S5). Where the host advertises `native-subagent-profiles-v1` and offers `api.agent.registerSubagentProfile`, pstack registers four narrow-only profiles, declared in `contracts.subagentProfiles`:
  - `panel-reviewer` and `panel-judge` (new instruction files) for the controllers' read-only roles: interrogate reviewers, how, reflect, and the cross-judge. Both remove file editing, spawning, messaging, automation, UI and all plugin tools; `panel-judge` also removes the shell.
  - `comment-sicko` and `poteto-agent` from their brief templates, with their closed output contracts.
  - A native record pins each read-only role's profile and instructions digest at creation. Those children spawn with `profile`, and the host records the digest on the child run. A pinned role blocks rather than spawning on an instance without the profile.
  - Agent-driven briefs stay prompt-enforced (sessions_spawn cannot select a profile), and pstack_brief reports `enforcement: "prompt-enforced"` with the host profile's registration. On hosts without S5, nothing is registered and read-only children are told their restrictions are prompt-enforced.
  - `checkContracts` and the doctor reject allow lists, empty or duplicate deny lists, non-local or duplicate ids, writer roles under a panel profile, and panel profiles that keep any file-editing or plugin tool.
- Docs: session-mode, contract, delegation, workflow ledger, model routing, agent briefs, route commands, SKILL, README, ADAPTATION and the shared continuation gate in the route recipes and their requirement guards.
- Tests: a fake `NativeSubagentRuntime` through the real registered commands and keyed store covers order, schema and contract failure, mismatch, unverified receipts, partial failure, cancellation, aborted collection, S4 reconciliation, restart and reload re-arming, approvals, the downgrade rule, and profile registration, pinning and loss. The host-integrated suite now also loads on openclaw main: tests prepare tools through the host's exported `finalizeAgentTools` instead of a helper main made private, and `planner-spawn` keeps one schema capture per host pin and asserts the host's own collector guard. New reducer tests cover version 2 records. A routing test reproduces the 0.3.1 error. Isolated real-Gateway runs install the built archive on OpenClaw 2026.10.5 (`034856a`) and on openclaw main (`d87b585`).

## 0.3.2 — unreleased

Follow-ups from the 0.3.1 review. Each fix has a behavioural test that fails on 0.3.1 (`2e2d48c`); P3-19 adds tests for behaviour that was already correct and is proven by killing the reviewer's surviving mutants.

- watch-pr:
  - A `.steal` guard that is not a regular file (a directory or a link) is a `state-error` (exit 6) instead of blocking stale-lock recovery forever (P3-17).
  - A newly counted run clears the end-reported mark, so after a raised `--max-runs` and a failed read the next end is printed instead of silenced as a repeat (P3-18).
  - New tests pin the steal's inode and mtime re-check (a lock replaced or touched while still empty), a malformed review-thread cursor as `malformed-response` (exit 4, with and without `--state-dir`), and the `Authorization: token`/`Basic` forms (P3-19).
  - Any `Authorization` value is redacted to the end of its line, whatever its scheme (N-d).
- pstack_worktree_audit: exit 1 from the HEAD lookup is an unborn HEAD only when `git show-ref --exists` reports the branch ref missing; a corrupt branch ref is `unknown` and held with a "HEAD lookup failed" warning (N-c).

## 0.3.1 — unreleased

Follow-ups from the 0.3 reviews. Each fix has a behavioural test that fails on 0.3.0 (`20ac00d`).

- watch-pr:
  - A stale lock is taken over under a short-lived guard and re-checked first, so concurrent runs cannot both take it and a run is never lost (P3-1).
  - A lock that is a directory or a link is a `state-error` (exit 6) instead of being held forever (P3-2).
  - The read-only guard accepts each GraphQL variable in one form only: `-f` strings and `-F number=<digits>`, with the values re-validated (P3-3).
  - `ready` also requires no failing or pending check and no blocking review decision; CLEAN contradicted by those facts falls through to the matching verdict (P3-4).
  - At the per-call limit, gh's output pipes are closed before the kill, so a descendant that keeps them open cannot hold the run (P3-5).
  - Redaction also covers the exact values of the gh token environment variables and `Authorization`/`Bearer` values, and the guide says exactly what is redacted (P3-6).
  - The end of a watch prints once under `--quiet-unchanged`. The template notes when the 5000-run cap ends a watch before `--until`, and the guide says so. A hostile-path round-trip test pins the crontab quoting (P3-7).
- pstack_brief: `check` repeats the render-time scope advisory, so an empty report over a diff label is never a silent PASS. Scope entries with C1 controls or U+2028/U+2029 are refused (P3-8).
- pstack_worktree_audit:
  - Only exit 1 from the worktree's HEAD lookup means an unborn HEAD. Any other failure is `unknown` and held with a "HEAD lookup failed" warning, never clean (P3-14).
  - A timed-out or failed `du` adds a per-worktree warning; the adapter doc lists the remaining unwarned fields (P3-15).
  - The branch is read as the full `refs/heads/` ref, so a tag of the same name no longer turns `pushed` into `no-remote` (P3-16).
  - A timed-out direct child that ignores SIGTERM is sent SIGKILL after 500 ms (N-a).
- Docs: the 0.3.0 testing note now gives the old ahead/behind timeout output correctly as `ahead?/behind` (N-b).

## 0.3.0-dev.1 — unreleased, partial phase 1

- Add seven pure workflow reducers, native CAS keyed-store ledger and
  pstack_workflow get/create/apply/spawn-plan actions.
- Preserve exact-incarnation ownership, immutable snapshots, append-only
  corrections, accepted child custody, bounded wait handoffs and explicit blockers.
- Add narrowly tagged sessions_spawn control-drift blocking without rewriting
  arguments. Untagged calls and existing exact-session mode are unchanged.
- Add 55 literal prefixed route commands, opt-in bare route aliases, and 55
  manual-only generated discovery guides. Qualify actual host registration,
  reserved/collision checks, skill visibility and picker-name sanitization.
- Verify generated external skill bytes and input hashes in doctor/real archives;
  CI refuses stale guides. Preserve all 759 restored text gates unchanged.
- Add read-only pstack_plan_check for supplied Markdown, preserving all native
  plan gates and original-line diagnostics without opening label paths or state.
  Native provider ingress rejects coercion and unknown fields. PASS explicitly
  means plan structure only, never route execution, acceptance or approval.
- Add optional (operator-allowlisted) pstack_trail and pstack_worktree_audit
  adapters for the source-only upstream log.sh and worktree-audit.sh. The trail
  appends sanitized rows under `.audit/` with an atomic single header and refuses
  symlinked, hard-linked or foreign files. It waits up to 500 ms for a
  concurrent creator's temporary link instead of refusing that writer, and fails
  closed in workspaceOnly or unknown-policy sessions (which include host
  read-only mode) unless the operator sets `trailInRestrictedSessions`. The
  audit never writes or fetches, disables fsmonitor, signature verification and
  every transport, and never runs `git status` or any read that converts file
  content: it compares index stat data and raw file hashes itself, so config
  written at any point during the audit cannot start a filter or diff program.
  A populated submodule is compared the same way, recursively up to three
  levels, so modified, staged or untracked content inside it is WIP, as git
  reports it; a deeper one, an over-cap listing or a budget spent at any step
  is `unknown` with a warning naming the step; a call whose limit has passed
  when its result is handled counts as timed out. A timed-out HEAD lookup is
  held as `unknown`, not read as an unborn HEAD, and a timed-out branch or
  upstream lookup gives remote `unknown`, not `detached` or `no-remote`. A call's
  output pipes close at its limit, so a descendant holding them cannot stall it. Same-second edits under an index without sub-second times are hashed.
  The remaining differences from git status are documented. It has a 300 s
  total budget and never emits a deletion-safe bucket. Both refuse sandboxed
  sessions.
- Port upstream comment-sicko and poteto-agent as labeled native brief templates
  rendered by read-only pstack_brief, which also checks returned reports. The
  comment reviewer stays report-only and in the parent's scope, keeps doubt open
  instead of deleting, and needs a MUST KILL finding for a correctness or safety
  suppression on the same symbol. Review scope is literal repo-relative file
  paths, so `app/[id]/page.tsx` and `pages/[...slug].tsx` are accepted as
  written. Only a blank, absolute, `..`-segment, control-character,
  pathspec-magic or trailing-slash entry is refused; an entry that reads like a
  diff label or glob gets a non-blocking warning to expand it. Task text is
  fenced, and sectioned required reads list the literal file path. Delegates
  must report the native reads they were given and real principle ids, and
  cannot report PASS over a failing check or over changes without a check.
- Add closed output contracts for all four panel and pool roles. pstack_workflow
  spawn plans append the role's schema, and collection refuses a missing or
  invalid output without changing the record. The ledger derives each architect
  shape digest from the reported shape, a judge's spawn plan lists the exact
  candidate labels and artifact paths it must score, the cross-judge must score
  exactly those usable candidates on every criterion, and reviewer status must
  agree with its findings. Doctor
  verifies contract closure, panel coverage, upstream provenance and route wiring.
  Five new route steps carry requirement guards, raising the total to 764.
- The workflow ledger no longer exhausts permanently: every write refreshes a
  14-day idle expiry, terminal records stay readable for 24 hours, and records of
  replaced or deleted session incarnations are swept before a create once the
  256-row namespace is three-quarters full. A ledger full of live records
  reports a named BLOCKED gate and deletes nothing.
- pstack_plan_check prose scanning is linear, so long lines of `<`, `![` or
  `](` no longer stall the gateway event loop.
- Add a reviewed upstream rule overlay. Each of the 328 lines in the 93 pinned
  upstream files that states a MUST, required or never rule maps to a native
  requirement gate, a unique native quote, the same rule elsewhere upstream, or
  an exclusion with a category and reason. Five rules had no native carrier, so
  native text now states them: evidence labels for claims, banned procedure
  words, justified features, stale-recognizable leftovers and target-app
  identity in report reproduction. Two of these are new requirement guards,
  raising the total to 766. `scripts/sync-overlay.mjs` regenerates
  `native/semantic-overlay.md` deterministically and its `--check` refuses a
  stale or missing document. The doctor repeats the extraction and fails on an
  unmapped rule, drift from the pinned upstream hashes, a missing gate, missing
  or ambiguous native text, an unjustified exclusion or a stale document. A
  test pins the exclusion set and the rules that point at an excluded rule, so a
  refresh cannot quietly widen them. The mapping is reviewed text coverage, not
  proof that a model follows the rules.
- Add a user-installed, read-only PR watch template (`scripts/watch-pr.mjs`,
  guide entry `watch-pr template`). pstack schedules nothing: `template` prints
  a crontab line for the user's own scheduler, and each `run` is one bounded
  observation through the user's own gh login (`gh auth status` plus two fixed
  GraphQL queries; a guard refuses anything else). Every watch has an end
  (`--until`, at most 30 days for a template), a run cap and a per-call time and
  output limit, and stops once the PR merges or closes. Verdicts follow
  GitHub's own merge state in babysit order and never read partial facts as
  ready. Missing gh or login is reported as BLOCKED with its own exit code.
  Without `--state-dir` a run writes nothing; with it, reruns are idempotent and
  print only on a change or failure. Doctor checks the guide entry, the fixed
  read-only commands and queries, the single guarded process call and the
  documented exit codes. S6 unattended continuation stays BLOCKED.
- Evidence remains agent-attested, not deterministic native execution receipts.
  Host capability adapters are not delivered. Route discovery generation does
  not claim semantic parity review.
  No live install, scheduler, publication or PR.

## 0.2.2 — 2026-10-20

- Restore all 21 P2 route output contracts and branches, plus four P3 wording fixes,
  without weakening the required independent-phase or authority gates from 0.2.1.
- Extend route-local, deletion-sensitive text regression guards to all P2 contracts;
  these protect instructions, not model-execution behavior.
- Preserve short-wait/resume collection, current-host unattended-continuation BLOCKED
  verdicts, source-only upstream scripts, and explicit publication boundaries.
- Requalify the same pinned-host strict typecheck, complete Vitest suite, portable
  checks, committed build and verified release artifact. No live deployment.

## 0.2.1 — 2026-10-20

- Restore the 24 P1 workflow/playbook contracts from the pinned upstream text.
  Required independent phases use native routing and delegation or report BLOCKED;
  no sequential parent pass can silently satisfy an independent gate.
- Add per-route requirement records and deletion-sensitive text regression guards.
  These guards protect instructions; they are not proof that a model followed them.
- Add a read-only native multi-phase plan checker and behavior/failure-path tests,
  including the filled shipped skeleton and native playbooks.md anchors.
- Qualify strict plugin typechecking and the complete host-integrated Vitest suite
  in CI against a pinned OpenClaw release, including planner-to-spawn coverage for
  every configured role against a captured real host schema.
- Compatibility: retain the >=2026.10.5 version floor to admit current main
  builds reporting 2026.10.5; fail closed in full registration without keyed-store V2.
  CLI metadata discovery defers runtime access as required by the host; real
  captured-registration tests cover the throwing Proxy and full/no-V2 refusal.
  Build host/SDK provenance records the exact 2026.10.10-beta.2 qualification pin,
  independently of the unchanged admission floors.
  Stable v2026.10.5 lacks that method and receives an actionable error; the
  qualified v2026.10.10-beta.2 pin and capable main builds can register.
- Preserve short-wait/resume handoffs; current hosts explicitly block the future
  unattended command/panel continuation capability. No ad-hoc scheduler is created.
- Keep upstream scripts source-only, publication separate and live hosts unchanged.

## 0.2.0 — 2026-10-20

- Port pinned cursor/plugins pstack v0.15.29: 172 source-only files, 56 source
  skills, 32 native workflows, 24 principles and 23 playbooks.
- Add native project-owned formal-verification create/maintain guidance; refine
  prompt-only sharpen, complete pending-decision ketchup and validated branding.
- Prepare @fuller-stack-dev/openclaw-pstack for a separately authorized ClawHub
  release: compatible package metadata, narrow shipping allowlist, portable build,
  CI, attribution, public installation/security docs and clean generic guidance.
- Keep plugin id pstack, exact-session authority and runtime semantics unchanged.
  Remove local history/verification from shipped files; preserve it in operator
  docs in the source repository. Generalize append-only continuation corrections.
- Ship pinned upstream source intact via the verified commit-bound tarball;
  ordinary npm pack omits its .gitignore. No publication is part of this change.

## 0.1.0 — 2026-10-20

- Initial standalone OpenClaw plugin conversion of the native workflow adapter
  (original upstream v0.15.25), with shared /pstack and /poteto_mode commands.
- Host-verified exact-session/incarnation/workspace state, bounded persistent
  keyed storage, consent-gated before_prompt_build and owner-only legacy import.
- Read-only 17-role routing, native tool delegation and skill-guided panels.
- Preserve source-only upstream scripts and native authorization boundaries;
  no reply_dispatch hook, deterministic panel controller or implicit automation.
