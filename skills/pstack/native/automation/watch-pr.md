# User-installed PR watch template

`watch-pr template` prepares a recurring, read-only status watch for one pull request. The user installs it in a scheduler they own, such as their crontab, a launchd agent or a systemd user timer. **pstack schedules nothing.** It registers no tool, timer, hook or automation job for this. It never edits a crontab and never runs the watch for you. The scheduled-command capability (S6) stays BLOCKED, so [babysit](../playbooks.md#babysit) still cannot continue unattended; this template only reports status. It does not fix, push, comment, merge or wake any session.

Read [the native contract](../contract.md) and [automation guide](README.md) first. The upstream `scripts/watch-pr` CLI stays source-only. `scripts/watch-pr.mjs` is a native reimplementation of the read side only and does not execute any upstream code.

## What one run does

`node scripts/watch-pr.mjs run --repo OWNER/NAME --pr N --until ISO-TIME [options]` performs one bounded observation:

1. **Bounds first.** It stops before any read once `--until` has passed. With `--state-dir` it also stops once the run cap is reached, or once a merge or close has already been recorded.
2. **Tools.** It uses only the user's own `gh` (`--gh ABS-PATH`, or `gh` found on `PATH`) and that account's existing login. It runs exactly `gh auth status --hostname HOST`, then fixed GraphQL `query` documents (`gh api graphql`) for the pull request's state, mergeability, review decision, head check rollup and review threads.
   - A guard refuses every other gh subcommand, any mutation document, `-X/--method`, `--input` and any unexpected variable.
   - The gh environment disables prompts, update checks and color. It drops `GH_DEBUG`, `DEBUG`, `GH_HOST` and `GH_REPO`.
   - Credentials are never read, copied or printed. Stderr details are redacted before they are reported: GitHub token patterns (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), the exact values of `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` in the run's environment, any `Authorization` value to the end of its line, whatever its scheme (a `Bearer`, `token` or `Basic` scheme name is kept), and `Bearer` values. Another secret that gh itself prints is not recognised.
   - Each GraphQL variable has one accepted form: `-f owner=`, `-f name=` and `-f after=` as raw strings, and `-F number=` as digits only, so no variable can name an `@file`.
3. **Limits.** Each gh call has a time limit (`--timeout-ms`, default 20 s, at most 120 s) and a 2 MiB output cap. At the limit gh's output pipes are closed and gh is killed, so a process gh started that keeps them open cannot hold the run. Review threads are read in at most 10 pages. If threads remain unread, or the head moves between pages, the verdict is `incomplete`, never `ready`.
4. **Report.** It prints one JSON line containing the status, a forge-first verdict, the exact head, check totals, the names of failing checks, the unresolved-thread count, and whether anything changed since the last run. Check names and other GitHub text are untrusted data. Control characters are removed and the text is never interpreted.

The verdicts are checked in babysit order. The first match wins:

| Verdict | Meaning |
| --- | --- |
| `merged`, `closed` | The PR has merged or closed. This is terminal: remove the schedule. |
| `draft` | The PR is a draft. |
| `conflict` | The forge reports conflicts or a dirty merge state. |
| `incomplete` | Thread pages were left unread or the head moved during the read. |
| `review-threads` | There are unresolved review threads. |
| `ready` | The forge reports MERGEABLE and CLEAN or HAS_HOOKS at this head, with no failing or pending check and no blocking review decision in the same read. If those facts contradict CLEAN, the matching later verdict applies instead. |
| `unstable` | The PR is mergeable, but a check that isn't required is failing. |
| `checks-failing`, `checks-pending` | The head's check rollup is failing, or still pending. |
| `changes-requested`, `review-required` | The review decision is blocking the merge. |
| `behind`, `blocked`, `computing` | The forge reports BEHIND or BLOCKED, or is still computing mergeability. |
| `unknown` | Any other combination. |

A green check list alone is never `ready`. Mergeability always comes from GitHub's own merge state.

## Exit codes

| Code | Status | Meaning |
| --- | --- | --- |
| 0 | `observed` or `skipped` | A verdict was read. `skipped` means another run for the same PR still holds the lock. |
| 2 | usage | An argument is invalid. Nothing was read. |
| 3 | `blocked` | `gh-missing` (no executable gh) or `gh-auth` (not logged in, or the token was rejected). No verdict is given. |
| 4 | `read-failed` | Not found or not visible, a timeout, the output limit, a malformed response or a gh error. No verdict is given. |
| 5 | `finished` | The deadline passed, the run cap was reached, or a merge/close was already recorded. Remove the schedule. |
| 6 | `state-error` | The state directory is unsafe, the state file is unreadable or belongs to another watch, or the lock is not a regular file (for example a directory or a link). It is never reset automatically. |

## Read-only by default, idempotent with state

Without `--state-dir`, a run writes nothing anywhere. It prints only the report.

`--state-dir ABS-DIR` is an existing directory owned by the same user that is not group- or world-writable and is not a link. It enables:

- a per-PR state file (mode 0600, replaced atomically) recording the run count, the last head and verdict, and whether the watch has reached a terminal state;
- a lock, so an overlapping run is `skipped`. A lock is recovered if its process has died, or if it is older than the longest possible run. Runs that find the same stale lock remove it one at a time under a short-lived `.steal` guard and re-check it first, so only one of them takes it over and no run is counted twice or lost. A guard file left by a run that died mid-steal is removed after 30 s. A guard that is not a regular file (a directory or a link) is a `state-error` (exit 6), like such a lock, so it never blocks recovery silently.

Re-running against an unchanged PR reports `changed:false`. With `--quiet-unchanged` it prints nothing, so cron mail arrives only for a change, a failure or the end of the watch. The end is printed once: the run that first reports `finished` records that, and later firings with `--quiet-unchanged` still exit 5 but print nothing (without it they print the report with `repeated: true`). A watch that never recorded a run has nothing to record, so it reports a passed deadline every time. A failed read still counts toward the run cap and never replaces the last observation. Every newly counted run, including a failed one after a raised `--max-runs`, starts a new end, which is then printed once.

## Install it yourself

From the installed pstack skill directory, print a line and review it:

    node scripts/watch-pr.mjs template --repo OWNER/NAME --pr N \
      --until 2026-11-01T00:00:00Z --gh /opt/homebrew/bin/gh \
      --state-dir "$HOME/.local/state/pstack-watch-pr" --every 15

`template` refuses an `--until` that is already past or more than 30 days away. It also refuses a missing or non-executable `--gh`, a missing or unsafe `--state-dir`, a cadence outside 5 minutes to 1 day, and any path containing `%` or control characters, which cron would mangle. Unless you pass `--max-runs` (at most 5000), the run cap is the number of runs the cadence needs before `--until`, at most 5000. When the cadence needs more, for example every 5 minutes for more than about 17 days, the template adds a note with the earlier time at which the cap ends the watch.

The template prints a commented crontab line built from absolute paths. It writes nothing and runs nothing. Add the line with `crontab -e` only if you want the watch. The cadence lives in the scheduler; `run` refuses `--every`.

To stop early, remove the line. On exit 5, remove it as well. Plugin updates can move the script, so re-run `template` after an update. A launchd agent or systemd timer can run the same command; keep the same bounds.

The guide entry is the native extension `watch-pr template`. For example, `/pstack watch-pr template OWNER/NAME#N until <ISO time>` asks the agent to explain the bounds and produce this line.

**Agent rules.** The agent may run `template` to show the line. It must not install the line, edit a crontab or launchd/systemd configuration, or create a native automation job, unless the user separately asks it to and the session's own tools permit that change. If the session lacks gh or a gh login, the agent reports that gap as BLOCKED rather than guessing a verdict.

These docs and `npm run test:watch-pr` cover the template's behavior with a private fake `gh`. The tests prove neither GitHub's merge rules nor a particular scheduler.
