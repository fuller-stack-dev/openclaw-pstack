# Follow-ups

Open follow-ups the reviews have accepted for later. Remove an entry when its fix lands, and name the change that closes it.

## From the 1.1.0 review (`2251c01`, merged as `4f2d028`)

The review returned READY with no P0–P2 findings. Closed in 1.2.0 (lane P-D): P3-38 (the deliverable children, the interrogate lead among them, get one correction before the workflow blocks), P3-41's M1 and M3, and P3-42 (a deliverable is cut to the reducer's 32,000-character limit).

| ID | Follow-up | Proposed fix |
| --- | --- | --- |
| P3-37 | Downgrading to 1.0 wedges a session that holds an in-progress 1.1 native record. 1.0's strict `validateSetup` rejects `stagesVersion`, so in a session whose 1.1 record is active, waiting, awaiting-user or blocked, 1.0 answers "Pstack error: Invalid setup" to resume, cancel, status and any new native start, and every prompt reports the lookup FAILED CLOSED, until 1.1 is reinstalled or the 14-day idle TTL expires. Nothing respawns; completed and cancelled 1.1 records do not affect 1.0. | Documented: cancel in-progress native workflows before downgrading ([publishing](publishing.md#downgrading-from-11-to-10)). The 1.0 reader cannot be changed. |
| P3-39 | Stage admission is per child, so a stage can be part-dispatched and then block. A three-slice swarm at 238–239 events spawns two workers, then refuses the third and blocks in the same invocation; the two running children stay in custody, but their results will never be recorded. | Check room for the whole stage (every unsettled child plus all remaining slots) before the first spawn. |
| P3-40 | "Never splits a character" holds for code points, not graphemes: 50 of 64 ZWJ-family reports were cut inside a grapheme cluster. Cosmetic: no lone surrogates, and the marker is honest. | Optional: cut on `Intl.Segmenter` grapheme boundaries. |
| P3-41 | Test gaps from the reviewer's mutants. M1 and M3 are killed in 1.2.0 (lane P-D). M22 (the apply turn's "complete post-approval summary, row by row, dropping none" framing removed) survives; only the clauses are pinned. M19 (no room reserved for the deliverable) survives but is effectively equivalent at realistic sizes. | Add a test that kills M22. |
| P3-43 | Read-only route details. With an empty question, the pending help or setup context is consumed by the next prompt build in that session, whatever that message is. The setup context says "Read-only: do not edit files or configuration" and then that an explicit request authorizes editing `pstack-models.json`. | Bind an empty-question context to the next turn only by message identity, and point the read-only line at setup's explicit-configuration exception. |

Notes from the same round:
- **N-n:** 1.0 swarm records adopt the 1.1 coverage-gap rule. It is not version-gated, but it is replay-safe (a 1.0 ledger can never contain a gap advance), beneficial, and creates no new children.
- **N-o:** the usage text omits the grounding options: `/pstack-architect` with only option words replies "needs a task: /pstack-architect [design-only|checkpoint|implement] <task>", without `how-why|how-only|greenfield`.
- **N-p:** P3-28's room estimate assumes about 3 KiB per unsettled result, while a panel `output` is stored whole. Near 470 KiB a collect can still be refused; the child is then BLOCKED in custody, which is visible and recoverable.
- N-j is broader than reconcile: a required-child failure also prints its BLOCKED line twice. N-m (below) reproduced in three main-pin runs, including an isolated rerun: under load the audit's git steps use up the 200 ms before `du` starts. Use a fake clock or a phase-specific deadline.

## From the lane P-B review (`07fde55`, merged as `fe9a1b7`)

The review returned READY with no P0–P2 findings. Closed in 1.2.4 (lane P-H): P3-36 (a collector is collected in the turn that spawned it, with `agents_wait` and `awaitResults: true`; a child that may be handed off is an announcing child).

| ID | Follow-up | Proposed fix |
| --- | --- | --- |
| P3-32 | pstack_route's blind refusal check is only a literal backstop. It is case-sensitive (`Claude-Opus-5-5` passes), accepts display names ("Opus 5.5"), scans only top-level string arguments (a workspace in `attachAs.mountPath`, or a model in `tags`, passes), compares the workspace as given rather than by realpath, and a judge plan checks only its own selection, so a judge task naming a trial's model passes. An inherit-role plan does not check the parent model. Sanitizing stays the parent's duty under eval steps 1–3. | Accept the trial custody or snapshot on the judge plan; match case-insensitively; scan arguments recursively; compare realpaths; cross-reference eval step 2 to step 6. |
| P3-33 | Routing test gaps from the reviewer's mutants: R2 (`baseArgs` overriding `trialArgs`) and R4 (the per-trial visible-plus-thinking refusal) survive; R11 and R12 (schema typing of `trialArgs` and `blind` removed) survive because the planner still refuses at a later stage; the blind tool test covers only the openai normalization. | Add tests that kill R2, R4, R11 and R12, and cover the other providers' normalizations. |
| P3-34 | The shared-rule requirement guards cover only seven fragments. Deleting any of these operative sentences passes every suite: the bounded wait's "do not re-read sources, start synthesis or spawn a substitute"; the delivery rule's one-correction fallback; "shorten, reorder"; the Recover bullet; the planner call's blind sentence; "a missing [launcher] never blocks a route". | Guard each operative sentence, or pin the shared sections. |
| P3-35 | The skill-guided delivery rule is inconsistent across routes: how's gate still allows "light clarity/context edits" (`workflows.md` how step 4); investigation step 5 has the parent apply unslop to the reply; teach's routed result was structured JSON with a summary and the rule does not say which field is the text; a collection the host truncated has no delivery fallback outside recall step 6; investigation step 8 does not make a missing route-required section a failed check. The native controllers already deliver consistently: they quote the stored `report` of the child's structured result, verbatim and attributed, and a host `resultTruncated` completion is stored from that structured result and marked (1.1.0, lane P-A). | Align the route text with one rule: deliver the structured result's report field verbatim, mark host truncation, and make missing required sections a failed check. |

## From the 1.0.0 delta recheck (`636bf66`, merged as `add71c3`)

The final review round returned READY with no P0–P2 findings. All of these are visible and cancellable; none can wedge a workflow.

Closed in 1.1.0 (lane P-A, see the changelog): P3-26 (stored results fitted by stored bytes and cut on code-point boundaries), P3-28 (a ledger room check before each spawn, and `accept` in the block tier) and N-h (the parent context no longer claims `pstack_workflow get` returns uncut reports).

| ID | Follow-up | Proposed fix |
| --- | --- | --- |
| P3-27 | Schedule receipts spend the progress budget. Each user command re-arms the missing continuations and appends up to four receipts, so about 60 resumes 30 minutes apart, or 120 resumes 3 minutes apart, on one running stage reach 248 events, and collection then blocks. After the cap, each command still creates a host schedule before its receipt write is refused. "A resume that finds the stage still running writes nothing" is true of the controller, not of the command. | Check ledger room before `schedule()`; prune or exempt elapsed schedule receipts; adjust the documented wording. |
| P3-29 | A dispatch's `by` is the command's `senderId`, but the host filters its owned-children list by operator profile. For non-Control-UI gateway clients `senderId` is the client id, so two operator profiles on the same client type can share `by`, and one could respawn the other's unlisted dispatch. This needs a lost acceptance, a shared session and a shared client id. | Record the host requester identity (the operator profile id, if exposed) instead of, or alongside, `senderId`. |
| P3-30 | An unattended continuation's dispatch has no requester. If its spawn never reached the host, the original requester's resume blocks ("dispatched by an unattended continuation"), and the workflow can only be cancelled. This is safe but over-conservative, because the scheduled occurrence runs as the restored requester. | Attribute unattended dispatches to the requester who armed the schedule. |
| P3-31 | Test gaps (the reviewer's surviving mutants). M8: `artifactDigest` taken over the cut result passes. M15: the controller omitting `by` passes, because the requester tests write the dispatch event directly. M16: the spawn-error abandon at the list cap is untested. M18: the near-duplicate schedule guard is untested. | Add behavioural tests that kill M8, M15, M16 and M18. |

Notes from the same round:
- **N-m (1.1.0 local runs):** `tests/script-adapters.test.ts` "warns per worktree when its size measurement fails or times out (P3-15)" uses a 200 ms deadline. It failed in three full local suite runs on a machine with a load average of 8 to 24, and passed every isolated rerun and every CI run. A deadline measured from when the `du` shim starts would remove the dependence on load.
- **N-i:** once agent blocks fill the block tier, a cancel note longer than about 8 KB of multibyte text is refused; a short note works.
- **N-j:** a reconcile block prints its BLOCKED line twice.

## Earlier

- **N-g (1.0.0 review at `bf61812`):** the host-integrated suites that prepare tools through `tests/fixtures/host-tool-schema.ts` also pass with an identity normalizer. pstack's schemas are unchanged by the host step, so these suites prove the schemas survive the step, not that it ran. This predates 1.0.

## From the 1.2.4 review (`9628186`, merged as `9f66d26`)

The review returned READY with no P0–P2 findings. Closed in 1.2.5 (lane P-I): P3-67, P3-68, P3-69, P3-72 F8, C3 and C5, the label formats of P3-71, and (after the 1.2.5 review) the P3-70 false positives. Closed in 1.2.6: P3-70/P3-76 framing contexts and paired subject regressions; P3-71/P3-77 non-empty handoff fields and presentation forms, with spawned visible children excluded by native lineage; P3-72 real-pipeline wait_for and 64-note-bound regressions. Bare subject mentions, including “Other AI models” without measurement context and a ticket’s own acceptance criteria, remain valid by design.

## From the 1.2.5 review (`4f5c2af`)

The review returned REQUEST-CHANGES for P2-1 (the spawn hook capped Code Mode `agents.run` workers at 600 s and dropped their launch replay key). Closed in the same PR: P2-1 (the hook no longer rewrites spawns), P3-73, P3-74, P3-75 (M2, M7 and M14 pinned), the P3-76 false positives and P3-78. Closed in 1.2.6: P3-70/P3-76 framing contexts and paired subject regressions; P3-71/P3-77 non-empty handoff fields and presentation forms, with spawned visible children excluded by native lineage; P3-72 real-pipeline wait_for and 64-note-bound regressions. Bare subject mentions, including “Other AI models” without measurement context and a ticket’s own acceptance criteria, remain valid by design.

### Host issues

**1. Closed upstream: `before_tool_call`: a hook's parameter rewrite drops non-enumerable and symbol-keyed tool parameters.**

[openclaw/openclaw#185127](https://github.com/openclaw/openclaw/issues/185127), opened after duplicate searches, is closed by [PR #185170](https://github.com/openclaw/openclaw/pull/185170), squash-merged 2026-10-26 as `d990291edf5ac014ece4789ca51602a8a620a35d`. Reviewed head `784cba98f904e2df224efb0c1edffcb5623fc8bb` passed CI 40419754946 and security review 40419755390; native independent Anthropic reviews approved. The fix preserves descriptors through the merge, and the real hook/wrapped-tool regression failed before and passed after. No live host installation is part of this release.
- **Where:** `mergeParamsWithApprovalOverrides` (`src/agents/agent-tools.before-tool-call.approval.ts`) returns `{ ...originalParams, ...approvalParams }`; a plugin's returned params are themselves usually a spread copy. Both keep only own enumerable properties.
- **Impact:** Code Mode `agents.run` attaches `SWARM_CODE_MODE_IDEMPOTENCY_KEY` and `SWARM_CODE_MODE_REQUEST_FINGERPRINT` to its `sessions_spawn` input with `Object.defineProperty` (non-enumerable symbols, `code-mode-swarm.runtime.ts`). `sessions_spawn` reads them to set `swarmLaunchReplayKey` and `swarmLaunchRequestFingerprint` on the run (`sessions-spawn-tool.ts`). After any hook rewrite of an `agents.run` spawn they are gone, so the restart replay check (`getSwarmRunByLaunchReplayKey`) cannot find the run and `agents.run` spawns it again.
- **Reproduced:** the real `runBeforeToolCallHook` and `wrapToolWithBeforeToolCallHook` on the 74cb12d and v2026.10.10-beta.2 pins, with a hook that returns `{ params: { ...event.params, runTimeoutSeconds: 600 } }`: the tool receives the bound and no replay key (pstack `tests/plugin.test.ts`, the P2-1 pipeline test's control case). A hook that returns no params keeps both keys.
- **Landed fix:** carry the original's own symbol-keyed and non-enumerable properties onto the merged object (copy `Object.getOwnPropertyDescriptors(originalParams)` for keys the hook did not set), or re-attach host-internal keys after every merge, and test with a non-enumerable symbol key. Alternatively pass host-internal launch identity outside the model-visible params.

**2. Not pursued — Code Mode `agents.run` has no `runTimeoutSeconds` option.**

Not currently planned; no issue or PR is open.
- **Where:** `runAgentsRunBridge` (`code-mode-swarm.runtime.ts`) builds `{ task, collect: true, groupId, label?, model?, thinking?, agentId?, fastMode?, outputSchema? }`.
- **Impact:** an `agents.run` worker is always a collector whose only bound is the host default (`agents.defaults.subagents.runTimeoutSeconds`, 0 = none). A script cannot bound a worker it awaits, and a plugin that wants a bound cannot set one without rewriting the spawn (issue 1).
- **Proposed fix:** accept `runTimeoutSeconds` in `AgentRunOptions`, validate it as `sessions_spawn` does, pass it into the spawn input and include it in the request fingerprint.


## From the 1.2.6 review (candidate 5bf30a9)

The independent Anthropic review requested one P2 change: restore direct answer-value leak refusal for answer keys, reference answers/solutions and pass criteria, without rejecting layout descriptions. Fixed with four failing-before/passing-after paired regressions. Also narrowed newly added another/several-agent and mark-each-case patterns, accepted keycap emoji/en-dash/hyphen handoff forms, replaced the non-discriminating missing-label assertion with its exact diagnostic, and added the visible-child top-level control. Framing pairs now pin the actual diagnostic match; both touched test files were audited in full.

The original P3-70/76 examples are resolved, not a claim of complete natural-language classification. These new heuristic limits remain open and preserve the route author's manual task/withheld review:

| ID | Follow-up | Proposed fix |
| --- | --- | --- |
| P3-81 | Some resource-framing forms still pass: “Rubric: correctness 50%”, “Graded against the rubric”, “A grader will check your work”, “An oracle checks your answer”, “The oracle says 42” and “Oracle: 42”. Bare subject uses intentionally remain valid. | Add narrowly contextual measurement-verb/resource and label forms with near-miss organic-request tests; do not restore a bare-word ban. |
| P3-82 | Domain exceptions remain heuristic: “Record the grade for each answer in the gradebook” is refused although the explicit “gradebook table” form passes; layout/UI exceptions remain deliberately narrow. Answer declarations now preserve the original digit/quote/bracket refusal for lists, units and case qualifiers; only tested layout/UI predicates are exempt. Earlier other-agent/ground-truth false positives remain outside these new-pattern fixes. New context heuristics can also refuse chess-app competition or ability-helper descriptions; a layout/UI exemption does not inspect a later answer disclosure in the same clause. Numeric/quoted expected-output bug-report declarations may still be refused as on main. | Refine each demonstrated context with paired cases rather than pretend to parse all task semantics. |
| P3-84 | The mark-each-case pattern still allows other reporting destinations such as “in the report” or “in your summary”; it refuses an unqualified verdict or “in results”. This wording was already allowed by 1.2.5. | Add contextual reporting-destination cases with a paired real JUnit/reporting implementation request. |
| P3-83 | Literal non-empty example placeholders (such as “Owner: <this session key>” or an ellipsis) still pass the handoff guard. Empty and formatting-only values are refused. A word ending in a period, e.g. “Status. Next: x”, can also be mistaken for a letter-list prefix. | If needed, validate placeholder values separately without confusing legitimate data with presentation syntax. |

Targeted real-model verification: bro PASS; eval output-read behavior PASS, overall PARTIAL because the isolated pinned host lacked native blinding and canonical-family metadata. No route success is claimed for those blocked host gates.


The second 1.2.6 review at d22bfb0 found that a clause-ending value check was too narrow for answer lists and case qualifiers. Restored the original digit/quote/bracket declaration guard with tested layout/UI exemptions, rather than enumerating answer suffixes. Eight reported leaks and six related framing/subject pairs fail before and pass after; expected-answer declarations and results/summary-table self-scoring are covered too. Another/several-agent shared-repository coordination stays allowed, and hyphenated prose no longer masquerades as handoff labels. Remaining new non-blocking mark-case reporting wording is P3-84 above.


The c8f8c55 review found the same short-literal leak under expected-output/result nouns and inline/semicolon/bullet expected-answer labels. The declaration guard now covers expected answers, outputs and results with either is/are or a colon, while retaining the tested field/layout/UI and nonliteral CSS bug-report subjects. Thirteen paired regressions fail before and pass after. This is a contextual heuristic, not proof against arbitrary paraphrases, signed/currency values, bare “Expected:” / “Correct answer:” labels or intentionally adversarial disclosures.

Final targeted outcome: **bro PASS; eval PARTIAL overall**, with the requested output-read correction and native blind/family/planner/collection/path-exposure gates **PASS**. A trial listed only neutral sibling-directory names despite its project-only brief, so strict organic isolation is not claimed; the one judge shortening correction also missed a self-imposed word limit. These are explicitly retained execution limitations, not missing host support or hidden candidate defects. All isolated runtimes were stopped and removed. No full 55-route rerun was performed.


## Final 1.2.6 review (bed5237)

Independent Anthropic verdict **READY**, no P0–P2. The reviewer independently reproduced exactly 13 new failures against c8f8c55 and 107/107 passing at bed5237, rebuilt dist byte-identically, audited the whole touched routing test file, and matched every one of the 324 packed files to the reviewed blobs. CI 40424186561 passed portable and both pinned-host jobs on that exact head. These additional P3 limits are retained, not release-blocking claims of complete language recognition:

| ID | Follow-up | Proposed fix |
| --- | --- | --- |
| P3-85 | Expected-output/result declaration formatting can bypass the literal guard: bold labels/values and “is: 42” forms. Analogous answer-key formats already passed on main. | Normalize only tested emphasis/separator forms, with paired field/layout/UI subject cases; retain manual trial review. |
| P3-86 | Other expected-output forms remain outside the heuristic: qualifiers before the colon, should-be/was or assignment symbols, multiline bullet values, headings/table cells and unquoted/empty labels. A colon value such as “3 rows” can be taken as a layout predicate. | Extend demonstrated framing contexts individually with organic-request controls; do not reinstate the bare-word ban. |
| P3-87 | The declaration-prefix restoration can reject an organic edit such as “Update ground truth: "labels.json" is stale.” | Distinguish the edit context from an answer declaration with a paired regression. |

The review's documentation wording issue was corrected: the declaration guard covers all three expected nouns, while the separate unanchored colon-label rule is expected-answer-only. This follow-up record change does not alter packaged runtime or route guidance.

## From the 1.2.7 public-readiness review

- **P3-85 — privacy backstop coverage:** the guard does not recognize every home-path convention, bare username/session UUID, alternate agent namespace, host spelling, or credential format. Keep human review and independent secret scanning; extend the generic patterns with paired positive/negative fixtures when a concrete gap matters. Private vocabulary must stay outside tracked source, not be encoded or hashed into it. Configured terms beginning or ending outside ASCII word characters can also miss because the matcher uses word boundaries; the currently configured terms are unaffected. A future generic extension should use Unicode-aware boundaries or reject unsupported terms, with paired positive/negative tests. Binary files are currently decoded as text too, so adding a short term can falsely flag random compressed image bytes; a future extension should distinguish text from binary metadata or constrain short terms, with paired fixtures rather than blanket file exemptions.
- Closed in this release: diagnostic partial-run comments, JSON-error dump placement and empty output-directory fallback; obsolete unreferenced sourcemap removal; meaningless private review shorthand; SSH URL exception documentation. The cleanup removed 120 private records plus the unused sourcemap, without deleting behavioral tests.
