# Legacy interrogate references

These four upstream references preserve the exact bytes shipped by adapter
commit `ed3e203a58aed4a377b431736b508286fb6b615f`: Cursor plugins upstream
v0.15.29, commit `29fa9382c9c250d134f6a2f1aa86c01c5f63119d`, under
`pstack/skills/interrogate/references/`.
They are retained outside the source mirror so later upstream removals cannot
change an admitted legacy review. Original upstream authorship and MIT license
remain; see the package NOTICE and LICENSE. These are source-only references,
not executable instructions for the Cursor runtime.

- `reviewer-prompt.md`
- `rubric.md`
- `code-quality-review.md`
- `lead-judgment.md`

`workflow.md` preserves the native interrogate section from that same adapter
commit, changing only relative links to resolve from this directory. It retains
the read-only review, rubric, four-bucket verdict and legacy output contract.
The frozen compatibility fixture in `tests/fixtures/interrogate-legacy.json`
pins the four original SHA-256 digests, schema and host-profile definition.

These files serve existing records; do not update their semantics when changing
the current interrogate route. A new executed-proof variant must be selected
from the immutable workflow record, not from the installed package version.
