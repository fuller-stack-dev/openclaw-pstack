# Optional append-only trail adapter

`pstack_trail` is the native replacement for the source-only upstream
`show-me-your-work/scripts/log.sh`. The script is never executed. The tool is
**optional**: OpenClaw exposes it only after the operator allowlists
`pstack_trail` (or the `pstack` plugin) in `tools.allow`. Without that opt-in,
keep the trail with native file tools under the same
[show-me-your-work](workflows.md#show-me-your-work) rules.

Arguments are `log`, `phase`, `decision`, `why`, `evidence` and `result`, all
required. `log` is a slug (`^[a-z0-9][a-z0-9-]{0,63}$`), never a path; the row
goes to `<requester workspace>/.audit/<log>.tsv`. Each other cell must contain
non-whitespace and fit 2000 characters. Unknown fields and coercible
non-string values are rejected before execution and again at execution.

Row contract, matching upstream `log.sh`:

- The header `ts phase decision why evidence result` (tab-separated) is written
  once, atomically, when the log is first created (a temporary file is
  hard-linked into place, then removed). Concurrent first writers never
  duplicate it or write a row before it. A writer that opens the log while
  another creator's temporary link still exists waits up to 500 ms for that link
  to go, and only when the one extra link is this log's own `.<log>.*.tmp`
  sibling with the same inode. Any other extra link is refused at once.
- `ts` is the host UTC time to the second.
- Tabs, newlines, carriage returns and other control characters become spaces,
  so every row stays one line. A cell whose first character is `=`, `+`, `-` or
  `@` gets a leading single quote, so a spreadsheet treats it as text.
- Rows are only appended. The adapter never truncates, rewrites, reorders or
  deletes a row. A torn earlier write keeps its bytes; the next row starts on a
  new line.

**Restricted sessions fail closed.** The host's read-only permission mode
removes core write tools but reaches plugin tools only as
`fsPolicy.workspaceOnly`; plugins are not told that a session is read-only. So
the adapter refuses whenever the session's filesystem policy is `workspaceOnly`
or absent (unknown). An operator may set the plugin config boolean
`plugins.entries.pstack.config.trailInRestrictedSessions` to `true` only when no
read-only session can call `pstack_trail` (for example, when it is not
allowlisted for agents that run in read-only mode). Models cannot set it. A host
read-only signal for plugin tools would let this become exact; until then it
stays a documented capability gap.

The adapter refuses rather than writing when the session is sandboxed (a
host-side writer would bypass the sandbox), the workspace is unavailable or
outside the effective filesystem root, `.audit` is not a real directory inside
the workspace, the log is a symlink, directory or hard-linked file, or an
existing file does not begin with the exact trail header. A refused call leaves
the file unchanged. The host invocation guard is checked before work and again
immediately before the append. If header publication fails, its temporary file
is removed.

**Swap check and residual race.** Node has no `openat`, so the log is opened by
path. After opening, the adapter checks `.audit` (before and after the name
lookup) is still the validated real directory and the log name still refers to
the opened file, and refuses otherwise. A process that can swap `.audit` for a
symlink and back inside that microsecond window, or during first creation,
could still leave a header-only file in another directory it can write. Swapping
it out and back again across all three post-open checks could, in theory, also
append one row to an existing exactly-headed trail in such a directory. Both
need a local process that can already write there.

**A row is agent-attested.** The adapter does not check that evidence resolves,
that a row matches the transcript, or that phase `start` boundaries are correct.
The end-of-run transcript audit, the different-family trail review and the
Attention section remain required, or are reported BLOCKED.

The adapter does not activate mode, open the state store, spawn children,
schedule work, send messages, commit the log or grant capability tokens.
