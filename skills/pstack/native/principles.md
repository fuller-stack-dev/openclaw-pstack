# Native principles

Read the native contract first. Apply principles as scoped engineering judgments, never permission to delete safeguards, widen work or bypass review. Each named section is available through `/pstack principle-<name> <task>`. Cite a principle only if it materially changed a decision.

## principle-attack-the-premise
After two failed fixes share an assumption, write that assumption and test a prediction that would differ if false. Do not attempt a third fix on an untested premise. **Check:** record the observation and resulting hypothesis.

## principle-boundary-discipline
Validate untrusted input where it crosses a real boundary, then carry typed domain data inward. Keep policy/business logic separate from adapters. Do not remove checks for legitimately fallible runtime data or security boundaries. **Check:** invalid input fails safely and valid input reaches the domain unchanged.

## principle-build-the-lever
When a small reusable script or check improves reliability, build and verify it instead of repeating manual work. Avoid a new framework for a one-off task. **Check:** rerunning it produces the expected result without unintended writes.

## principle-encode-lessons-in-structure
Prefer a type, invariant, lint or behavioral regression that prevents a repeated mistake. Keep judgment in concise instructions when it cannot be encoded. **Check:** the historical bad case fails and the good case passes.

## principle-exhaust-the-design-space
For material uncertainty, compare two or three genuinely different designs against observable criteria. Do not multiply candidates for settled mechanical work. **Check:** explain the selected design and rejected tradeoff with evidence.

## principle-experience-first
Optimize the actual user's task and the next maintainer's understanding, not implementation convenience. Every feature, control and option must be justified by the central workflow it serves; ship fewer polished features over more rough ones. **Check:** demonstrate the central user flow and its error/feedback states.

## principle-explain-the-number
Before measuring, write the result that would change a decision and the noise floor. Stop when run-to-run spread exceeds the effect. A result named only after the run does not satisfy this pre-measurement gate. Before relying on a metric, identify the limiter, real completed work, errors, noise, repeated-run spread and end-to-end relevance. **Check:** apply the benchmark-checklist route or report inconclusive.

## principle-fix-root-causes
Reproduce, trace the first wrong decision and fix it there. A guard is valid when it handles a legitimate state, not when it conceals corruption. Do not expand to unrelated fixes. **Check:** the original repro passes and relevant bad states remain detectable.

## principle-foundational-thinking
Choose data types, ownership, access patterns and isolation before logic. Add only foundations that the authorized work actually needs. **Check:** later units use the foundation without repeated special-case coordination.

## principle-guard-the-context-window
Use bounded reads, concise evidence and independently scoped workers when useful. Do not omit required full-file audits or delegate private material unnecessarily. **Check:** important decisions retain resolvable source/evidence pointers.

## principle-laziness-protocol
Prefer the smallest change and one authoritative decision point. Deletion requires evidence that behavior and consumers do not need the removed code. **Check:** required behavior passes with fewer unnecessary layers.

## principle-make-operations-idempotent
Inspect current state, derive required changes and reconcile partial runs. Use atomic transitions where appropriate. Anything a run leaves behind, such as a lock, temporary file, half-written record or claimed job, must be recognizable as stale by the next run through evidence that holds wherever the previous run stopped. **Check:** repeated invocation and interruption recovery converge without duplicate effects or data loss in isolated tests.

## principle-migrate-callers-then-delete-legacy-apis
For coordinated internal migrations, move every scoped consumer before deleting the old contract. External compatibility and ownership are explicit gates. **Check:** consumer inventory is complete and old API removal breaks no supported caller.

## principle-minimize-reader-load
Reduce unjustified indirection and hidden mutable state, not merely line count. Retain useful boundaries. **Check:** a reader can find where a value originates and who changes it from the relevant files.

## principle-model-the-domain
Use structures matching real states and access patterns instead of scattered synchronized flags. Avoid abstractions without a real need. **Check:** invalid combinations are rejected and valid transitions are exercised.

## principle-never-block-on-the-human
Proceed with authorized reversible decisions and state reasonable assumptions. Still ask for genuinely missing product/safety decisions or required approval. **Check:** no invented permission, silently crossed gate or unnecessary waiting.

## principle-outcome-oriented-execution
Converge on the agreed end state with explicit verification boundaries. Temporary breakage is allowed only in task-owned isolated work and when already authorized, never the live system. **Check:** each deliverable is coherent at its release boundary.

## principle-prove-it-works
Inspect and exercise the actual artifact. Builds, file times, queued actions and self-reports are insufficient for behavioral claims. **Check:** the claimed outcome has a directly observed result or is marked unverified.

## principle-redesign-from-first-principles
Consider what design naturally accommodates the new requirement, then deliver the smallest scoped change with coherent types, docs and consumers. **Check:** the new requirement is not a hidden exception in every caller.

## principle-separate-before-serializing-shared-state
Eliminate unnecessary shared writes; otherwise enforce a genuine single-writer/transactional boundary. Instructions are not locks. **Check:** concurrent cases do not overwrite independent results or corrupt state.

## principle-sequence-verifiable-units
Order bounded work so each unit has a meaningful check. Preserve exact tested heads; do not rebase or mutate others' work just to improve the story. **Check:** each accepted unit and final composition have evidence.

## principle-subtract-before-you-add
Remove proven dead/redundant structure when it simplifies the requested change. Preserve safety guards, valid edge cases and source custody. **Check:** tests and consumer inspection support each removal.

## principle-test-behavior-not-implementation
Assert observable return values, errors, persisted state or external effects through real interfaces. Do not mirror implementation or mock away the bug. Audit the whole touched test file. **Check:** breaking the requirement fails the test; harmless internal restructuring does not.

## principle-type-system-discipline
Parse untrusted values, derive types from authoritative schemas, distinguish meaningful identifiers and exhaust variants. **Check:** invalid states fail type/boundary checks and runtime behavior still passes.
