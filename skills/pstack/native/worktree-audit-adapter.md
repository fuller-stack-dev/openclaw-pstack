# Optional read-only worktree audit adapter

`pstack_worktree_audit` is the native replacement for the source-only upstream
`poteto-mode/scripts/worktree-audit.sh`. The script is never executed. The tool
is **optional**: OpenClaw exposes it only after the operator allowlists
`pstack_worktree_audit` (or the `pstack` plugin) in `tools.allow`.

Arguments are both optional. `repo` is a repository directory relative to the
requester workspace (default: the workspace). After symlink resolution it must
stay inside the workspace. `base` names an existing local ref for the merged
check; it is never fetched. Without it the adapter tries local `origin/HEAD`,
`origin/main`, then `origin/master`, and warns that the ref may be stale. When
none exists, merged is `unknown`. An explicit `base` that does not exist is an
error.

Each linked worktree (the main worktree is skipped) reports:

- `sizeKiB` from a bounded `du -sk` (30 s each, 120 s total), or `null` when it
  times out, fails or the total budget is spent. A timed-out or failed `du` adds
  a warning naming the worktree; a spent total budget adds one result warning.
- `ageDays` since the HEAD commit (`null` if that read fails or times out, without
  a warning), `branch` (HEAD's full `refs/heads/` ref, so a tag of the same name
  cannot change it) and `locked`.
- `merged`: `YES` when HEAD is an ancestor of the base, `no` when git says it is
  not, `unknown` otherwise, including a timeout (without a warning). A squash
  merge shows `no`.
- `dirty`: `clean`, `scratch:<n>` (untracked files only), `wip:<n>` (tracked
  changes), `missing` (prunable or absent directory) or `unknown` (the index or
  a file could not be read, a listing exceeded its cap or timed out, a populated
  submodule is nested too deep, the time budget ran out, or the worktree's HEAD
  lookup failed). Only exit 1 from that lookup means an unborn HEAD, and only
  when `git show-ref --exists` then reports HEAD's branch ref missing (exit 2):
  git also exits 1 for a corrupt branch ref. Any other failure (a crash, a kill,
  exit 128, a corrupt or unreadable ref, a detached HEAD, or a git older than
  2.43 without `--exists`) is `unknown` with a "HEAD lookup failed" warning,
  never a reason to skip the staged comparison; a timed-out confirmation warns
  as the "unborn HEAD check". A listing that
  exceeds its cap, a too-deep submodule, or a time budget that runs out at any
  step (the worktree's HEAD lookup, a listing, the index-path lookup, the
  `core.fileMode` read, the file comparison, hashing or a submodule HEAD
  lookup) also adds a warning naming
  the step and the worktree; `unknown` is never silent there, and a spent
  budget never reads as `clean`. A populated submodule
  at its recorded commit is compared recursively, so modified, staged or
  untracked content inside it counts as one tracked change, as ` M sub` does in
  `git status`. See "Differences from git status" below.
- `remote`: `pushed`, `ahead<n>/behind<m>`, `no-remote` or `detached`, against
  the local `origin/<branch>` ref without fetching, or `unknown` with a warning
  naming the step when the branch, upstream or ahead/behind lookup timed out.
  A timeout is never reported as `detached` or `no-remote`.
- `pr` and `lastActivity`: always `not-checked`.
- `bucket`: `hold-wip` (tracked changes or unknown dirty state), `verify-activity`
  (merged into the local base), or `review`.

Rows are sorted by size, largest first. At most 200 worktrees are audited; when
more exist the result says `complete: false` with a warning rather than failing.

**Differences from upstream, on purpose.** The upstream script fetches the base,
asks `origin`/`gh` for PR state and scans Cursor transcripts. This adapter does
none of that, so it never emits upstream's `safe` or `hold-open-pr` buckets.
`verify-activity` means only "merged into a possibly stale local base". PR state,
recent native session activity, live processes and unique unpublished source
must still be checked through supported tools. **No bucket authorizes deletion.**
Removal stays a human-gated step in [worktree-cleanup](playbooks.md#worktree-cleanup)
through supported cleanup.

No-write and no-program enforcement: git runs without a shell, with inherited
`GIT_*` variables removed, optional locks off, trace2 output off,
`core.fsmonitor=false`, `core.untrackedCache=false`, `core.pager=cat`,
`log.showSignature=false`, `protocol.allow=never` (also set per protocol, so
repository config cannot re-allow one), `GIT_NO_LAZY_FETCH=1`, a non-interactive
terminal and per-call timeouts. Command-line settings outrank every config file
whenever that file is written, so repository or global config cannot start an
fsmonitor hook, pager or signature verifier (`gpg.program`), and no transport
can run, so a partial clone never lazily fetches.

The audit never runs `git status`, `diff-files` or any other command that reads
file content through git. Those commands re-read a stat-changed or racily clean
file through the clean filter that config and attributes name, and git has no
switch that disables it, so checking the config first would leave a race. Instead
git only lists the index (`ls-files --stage --debug`), the staged paths
(`diff-index --cached --name-only`) and the untracked paths. The adapter compares
each entry's stat data with the file itself and hashes candidate files' raw
bytes. No filter, `textconv`, `diff.external` or diff command is ever
consulted, so a config write at any moment during the audit cannot start a
program. A deterministic test injects that config before each git call in turn.
None of the commands the audit runs invokes a hook.

**Differences from `git status`.** The comparison never reports `clean` where
git would report a modified, staged or deleted path, with one byte-identical
exception. The known differences:

- A file under a content filter or line-ending conversion whose timestamps
  changed counts as a tracked change even when its content did not, because
  content is compared raw (safe direction).
- A file whose raw bytes equal its committed blob but which git would now
  normalise (for example committed CRLF under a later `text` attribute) reads
  `clean` here and modified in git. Its bytes are exactly the committed ones, so
  no work is lost.
- With `core.symlinks=false` a link is checked out as a plain file, which reads
  as a change here and clean in git (safe direction).
- A populated submodule is compared recursively up to 3 nested levels; a deeper
  populated submodule makes the worktree `unknown` with a warning. An
  unpopulated submodule is not compared, as in git. `submodule.<name>.ignore`
  and `diff.ignoreSubmodules` are not honoured, so content they would hide
  still counts (safe direction).
- An index written without sub-second timestamps is compared on seconds, and an
  entry modified in the same second as the index write is hashed (racily clean,
  as in git), so a same-size edit in that second is still found.
- The index, staged and untracked listings are each capped at 256 MiB of git
  output (about a million tracked paths); beyond that the worktree is `unknown`
  with a warning naming the cap.

The whole audit has a 300 s budget. Each git call is limited to 15 s or the
remaining budget. A call whose limit fires, or has already passed when its
result is handled (for example after the event loop was blocked while git
exited), counts as timed out and its output is discarded, even if git finished
in time. When the limit fires, the output pipes are closed before git is killed,
so a process that git started and that keeps them open (only possible with a
forking `git` wrapper on `PATH`) cannot hold the audit past the limit; that
process itself is not killed. A direct child that ignores the SIGTERM is sent
SIGKILL after 500 ms. Worktrees not reached are listed in `unaudited`, `complete` is
false and a warning says so; the audit does not fail.

The adapter refuses when the session is sandboxed, when
`tools.fs.workspaceOnly` is set (linked worktrees may sit outside the
workspace), or when the workspace is unavailable. It checks the host invocation
guard before work, between worktrees and before returning.

The adapter does not mutate any repository, ref, index or worktree, open the
state store, spawn children, schedule work or grant capability tokens.
