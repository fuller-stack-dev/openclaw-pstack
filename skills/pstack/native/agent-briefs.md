# Native agent briefs and output contracts

Upstream registers two custom agents, comment-sicko and poteto-agent, and lets panel children answer in free prose. Pstack ships them as labeled brief templates plus closed output contracts in [contracts.json](agents/contracts.json). A brief rendered by pstack_brief is **agent-attested and prompt-enforced**: guidance plus the requester's inherited native tool policy.

## Host subagent profiles

On hosts that advertise `native-subagent-profiles-v1` and offer `api.agent.registerSubagentProfile`, pstack registers four narrow-only host profiles, declared in the manifest's `contracts.subagentProfiles`. Each one is package-relative instructions plus a tool deny list, with no model, auth, sandbox or allow fields; `subagentProfiles()` in `scripts/output-contracts.mjs` builds them from contracts.json.

| Profile | Instructions | Removes | Keeps | Used by |
| --- | --- | --- | --- | --- |
| `panel-reviewer` | [panel reviewer](agents/panel-reviewer.md) | file editing (`write`, `edit`, `apply_patch`), spawning and session writes, messaging, automation, nodes, UI, media and every plugin or MCP tool | reading, web and memory reads, session history, and the shell for read-only inspection | native interrogate reviewers, how explorers and explainer, reflect lenses and synthesizer |
| `panel-judge` | [panel judge](agents/panel-judge.md) | everything `panel-reviewer` removes, plus the shell (`group:runtime`) | reading | the native arena and architect cross-judge |
| `comment-sicko` | [comment reviewer](agents/comment-sicko.md) | as `panel-reviewer`; owns the `comment-review` schema | as `panel-reviewer` | registered; no native caller yet |
| `poteto-agent` | [delegate](agents/poteto-agent.md) | spawning, session writes, messaging, automation and nodes; owns the `delegate-result` schema | file tools and the shell | registered; no native caller yet |

A native controller pins the profile and its instructions digest for every read-only role when it creates a workflow, and spawns those children with `profile`. The host appends the instructions to the child, removes the denied tools, and records `subagentProfile.instructionsSha256` on the child's run record. A pinned role never spawns without its profile: an instance that lost the registration blocks the phase instead. Writer roles (architect and arena runners, swarm workers, implementation roles) and the why roles, which need connector tools, spawn unprofiled. The model-facing sessions_spawn cannot select a profile, so every agent-driven spawn, including the no-comments reviewer and poteto-mode delegates, stays prompt-enforced, and pstack_brief says so. `panel-reviewer` and `comment-sicko` keep the shell, because reviewers need git and grep to read beyond the diff, so their read-only rule for shell commands remains the child's obligation. The record labels such a role `host-profile-shell`, not `host-profile`, the parent context says "shell kept; read-only shell use prompt-enforced", and the child's brief repeats the read-only shell rule. `panel-judge` has no shell and is labelled `host-profile`. On hosts without the capability, nothing is registered and every role is prompt-enforced; native children of read-only roles are told so in their brief.

## Briefs

| Profile | Template | Routing role | Output contract | Used by |
| --- | --- | --- | --- | --- |
| `comment-sicko` | [comment reviewer](agents/comment-sicko.md) | `judgment and prose` | `comment-review` | [no-comments](workflows.md#no-comments) |
| `poteto-agent` | [delegate](agents/poteto-agent.md) | the assigned implementation role | `delegate-result` | [poteto-mode](workflows.md#poteto-mode) helpers |

1. Resolve the routing role with `pstack_route` as usual. Then call `pstack_brief` with `action: "render"`, the profile and the bounded task; the read-only reviewer also needs the exact parent-chosen `scope`. A scope lists literal repo-relative file paths, because every finding names one and is compared exactly: expand a diff such as `main...HEAD` with `git diff --name-only` first. Every other character is part of a file name, so `app/[id]/page.tsx`, `pages/[...slug].tsx`, `docs/v1..2-notes.md`, `src/a.ts~` and `-n.txt` are accepted as written. Only forms that cannot be such a path are refused: a blank entry, an absolute path, a `..` segment, a control character or newline (including C1 controls such as U+0085 and the Unicode line separators U+2028 and U+2029), a leading `:` (pathspec magic) or a trailing `/` (directory). Render, and check with that scope, return a non-blocking warning for an entry that still reads like a diff label or glob (`main...HEAD`, `src/*.ts`), so even an empty report over such a scope never passes silently, and the reviewer reports a listed file that does not exist as an open question. The task is rendered verbatim inside a fence, so its text cannot add or replace brief sections, and a required read that names a section is listed as the file path plus the section. Use the returned `brief` as the native `sessions_spawn` task with the emitted routing arguments. **Done when:** the child received the labeled brief, its absolute required reads and the closed output schema.
2. Parse the child's final JSON object and call `pstack_brief` with `action: "check"`, the profile as `contract`, the `output` and, for the comment reviewer, the same `scope`. The delegate check also requires every rendered required read in `contractRead` and principle ids from the shipped index. **Done when:** the check returns `PASS`, or the report is rejected and the phase reruns once with the returned errors named. Rerun it as a fresh child: plan the same role again, add the check's exact errors (and, for a `contractRead` error, the exact required paths) to the task, spawn it and check the new report. A collector child is one-shot and refuses `sessions_send`, so that refusal never ends the phase. Only a second rejection leaves the phase BLOCKED, and the parent's own reading never stands in for the report.
3. A passing check proves shape and cross-field consistency only. The parent still inspects the diff, artifacts and every finding, as the route requires.

The comment reviewer deliberately differs from upstream comment-sicko:

- No persona greeting and no delete-on-doubt rule: doubt is an `open` finding.
- It proposes deletions in a report and the parent audits them; upstream deletes comments itself and the parent reviews the diff. This matches the 0.2 native no-comments policy.
- No default scope: without a parent-supplied file list it stops and asks, instead of reviewing the diff against `main`.
- Safety rationale is an added keep clause.
- `// prettier-ignore` is no longer kept unconditionally; like any suppression it needs a justified keep or a proposal.
- Upstream's `/how` and `/why` calls become direct investigation of the named symbol.

A correctness or safety suppression deletion names the suppressed symbol, and a `MUST KILL` finding in the same file must name that symbol. A report that edits application code, widens scope or both keeps and deletes one comment fails its check. The delegate reads only parent-supplied native paths, never Cursor plugin directories, and returns `BLOCKED` naming any missing one. Its `PASS` needs no blockers, only passing checks, and at least one check when it changed files.

## Panel output contracts

Each panel or pool role in [role routing](model-routing.md) has exactly one contract. The module refuses to load if that coverage, or the closed-schema rule (every object closed, every array, string and integer bounded), breaks.

| Role | Contract | Cross-field rules beyond the schema |
| --- | --- | --- |
| `architect runners` | `architect-runner` | Caller usage first with 2–3 distinct call sites; the full rationale headings; at least one losing alternative. The ledger derives each design's shape digest from the reported `shape` (key order does not matter), so two relabelled copies of one shape are not alternatives and no runner computes a digest. |
| `arena runners` | `arena-runner` | Artifact path, rationale and rejected alternatives only; candidates cannot carry rubric scores. |
| `arena cross-judge pool` | `cross-judge` | 3–6 unique criteria; exactly the usable candidates (dropouts excluded) each scored once per criterion, 1–5, under the labels the spawn plan lists (the ledger slot ids); the recommended base is a scored candidate. |
| `interrogate reviewers` | `interrogate-reviewer` | Findings use critical, warning or nit with location, mechanism, evidence and an inference flag; all seven review lenses are covered or marked not applicable with a note; `PASS` carries no critical or warning finding and `ISSUES` carries at least one finding. The lead still assigns the four verdict buckets. |

A [native controller](session-mode.md#native-controllers) passes the same contract to the host as the child's `outputSchema`, inside an envelope of status, evidence and report text, so the host itself rejects a malformed `structured_output` and the controller rejects a contract-invalid one. With the agent-attested [workflow ledger](workflow-ledger.md), `spawn-plan` appends the role's contract to the planned task, and `collect` refuses a panel result whose output is missing or invalid without changing the record. The run stays pending: ask that same accepted child for a corrected object through its native continuation and collect it for the same run. Never rewrite a child's findings or scores yourself. A `BLOCKED` result carries evidence, not output. Without the ledger, check the returned object with `pstack_brief` `check` and the role name. Other roles keep artifact digests and evidence only.
