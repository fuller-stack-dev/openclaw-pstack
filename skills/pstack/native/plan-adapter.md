# Read-only native plan adapter

`pstack_plan_check` accepts complete plan Markdown in `source` and an optional
display-only `label`. Neither field is opened as a path or executed. The source
limit is 131072 characters; a supplied label must contain non-whitespace and fit
256 characters. Unknown fields and coercible non-string values are rejected.

Read the selected execution playbook and the full multi-phase-plan contract in
`playbooks.md` before drafting. This tool exposes the unchanged shipped
`plan-check.mjs` checker through native tool admission; it is not a plan generator
or a replacement for those instructions. Supply the entire plan, not an excerpt
that drops required gates. For an authorized local file, read it with an existing
authorized read tool first, then supply its text. The plugin does not acquire
filesystem authority from a label.

The result has `status` PASS or ISSUES, original-line `problems`, per-PR `reports`
and `verification: plan-structure-only`. Its gates include section ordering,
explicit operator go, hold as zero-writes, native delegation, patch-id
requalification, all unit/live/perf verification blocks, exactly ten live lanes
with regression, screenshot paths and pass predicates, a numeric performance
threshold, and review-gate screenshot/video/operator-approval instructions.
Existing frontmatter, fences and placeholder checks still apply.

**PASS means only that these text gates passed.** It does not establish executed
routes, truthful evidence, checked acceptance boxes, independent review, actual
unit/live/perf outcomes, authorization or approval. A complete-looking plan with
unexecuted boxes can pass. Never use that result to arm a program or merge.
MUST/required/never coverage lives in the reviewed
[upstream rule overlay](semantic-overlay.md); this adapter does not claim it.

The adapter does not activate session mode, open the state store, mutate a plan or
ledger, invoke children, schedule a job, send a message, or grant capability tokens.
It honors a native invocation guard when the host supplies one. Because the check
is pure and uses supplied data only, the absence of a write guard is not a write
capability blocker. Native tool policy and registration compatibility gates apply.

Unattended continuation remains BLOCKED until a reviewed host actually exports
the required scheduling capability. No proposed capability name is fabricated by
this adapter. Plan-check output must not be recorded as host execution evidence.
