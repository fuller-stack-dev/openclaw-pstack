# Native triage, reproduction, and optional automation

Read [the native contract](../contract.md). **Reuse existing tools:** Discrawl for reports and discussion context, Gitcrawl plus live GitHub for candidate duplicates/current issues, and Crabbox for authorized isolated reproduction. Read [the native triage/repro guide](benny.md) before that work. A manual read-only batch is not a watcher and needs no scheduler, event connector or posting credentials. `benny` remains a legacy route name, not a new system.

Only the optional loop/event routes use OpenClaw's existing scheduler. Installing this capability does **not** activate a job. All upstream scripts remain source-only.

## Routes

- `triage <bounded scope>`: read a small relevant Discrawl slice, reconstruct context with original IDs, compare Gitcrawl candidates against current GitHub, and return a read-only disposition with freshness/gaps. No posting, issue creation or recurring intake.
- `repro <exact report>`: plan or execute only the requested isolated proof using the existing Crabbox skill and trusted repository contract. Plan/setup alone never leases a box. Prove matching source/platform, baseline and patched observable behavior, then verify scoped cleanup.
- `loop create`: prepare a bounded job with explicit owner, task, done predicate and deadline. Explain the disabled draft, exact schedule, tool budget and stop behavior. Activation requires an explicit request and actual available native automation authority.
- `loop status`: use the available automations list/get/runs tool, follow pagination, filter exact owner and hashed prefix; report enabled, last outcome, next run, pacing and stop reason. An empty restricted list is not global absence. Never recreate a known job because access is limited.
- `loop stop [exact id/name]`: freshly get and verify owner, name and declaration; remove only the matched owned loop with the native tool. Without a selector, show exact matching jobs before removing the intended set. Do not touch other owners' loops. A running payload may need supported abort as well; verify quiescence rather than merely row removal.
- `benny setup` or `automation setup`: legacy/native names for read-only triage/repro readiness. Read [the guide](benny.md), inspect installed readers and Crabbox independently of Gateway cloud profiles, and report exact access gaps. Do not demand an event connector for manual work. No scheduler/configuration writes.
- `benny dry-run` or `automation dry-run`: prepare a read-only bounded plan using those existing tools. Only when explicitly testing the legacy event templates, validate their configuration, build **disabled** triage and repro requests, inspect the gate/tool allowlists, and run fixture tests. Do not call add/run/enable, lease/run a box, or send a test message.
- `watch-pr template <OWNER/NAME#N> until <ISO time>`: explain and print a [user-installed, read-only PR watch](watch-pr.md) line for the user's own crontab, launchd or systemd timer. pstack never installs, schedules or runs it; S6 unattended continuation stays BLOCKED. Missing gh or login is BLOCKED, not a guessed status.
- `automation status` / `automation stop`: inspect or stop a named, freshly verified existing owned job with supported tools. Never claim global absence from a scoped view.

Use `/pstack loop create check the authorized build until all required checks pass; owner=<existing job session>; deadline=<ISO time>`, or `/pstack benny setup`. No target, identity, connector, done predicate or deadline may be guessed. A request for help/setup/dry-run is not activation permission.

## Built-in /loop and quiet ownership

The installed runtime has owner-only `/loop [interval] prompt`, `/loop status`, `/loop stop [name]`. It binds to the invoking conversation. No interval means a 15-minute base schedule with 1-minute..1-hour pacing; an explicit interval is fixed (minimum 30 seconds). In successful paced runs, `automations {action:"next_check",in:"10m"}` proposes a completion-relative delay. Failure/timeout discards it and native backoff applies. Do not sleep/poll as a timer.

**Do not invoke built-in /loop in Main.** Use an existing authorized owner/job session. The pstack builder requires a non-Main owner, binds to that session, and uses delivery none and failureAlert false. Results remain in owner/job history; this suppresses routine announcements, not the duty to record failures. Native auto-disable notices are not suppressed by failureAlert false. Verify their actual route before activation; reject Main routing. No Main heartbeat, wake or replacement coordinator is installed.

The native automation tool is policy-filtered; availability in one session does not determine another session’s current access. Discover it afresh with its real schema in the activation session. Do not bypass a missing/denied tool with CLI, RPC or shell. CLI help and pure schema inspection are capability evidence, not authority to create jobs.

## Loop lifecycle

1. Read current task/source state and previous receipt, honor stops/holds. Use stable declarationKey and inspect an existing match before any add; do not assume declaration-key semantics alone prove absence or custody.
2. Test the exact done predicate before a bounded step. Evidence, not a model's assertion, establishes completion. Never weaken the predicate to keep working or declare success.
3. Record attempt id, input/head, observed effect ids and outcome. Reconcile uncertain effects before retrying. Three failed/no-progress attempts or deadline => blocked/expired stop, not success.
4. On success with work remaining choose bounded next_check; on execution failure report a real failed run, letting native retry/backoff win. Do not disguise failure with a successful quiet result.
5. On verified completion, deadline, cancellation or repeated no-progress, use self-scoped remove for this exact job. A restricted scheduled run supports remove/next_check but may not support update; removal is its stop mechanism. Verify gone/disabled and final outcome. No new work after the deadline; finish safe cleanup only.

`scripts/automation.mjs` exports pure builders, owner filters and lifecycle decisions. It does not evaluate project-specific completion evidence by itself, send requests or own timers. The agent follows this lifecycle using real task observations. `loopDecision` is a testable guard/reference, not a new background runtime.

## Optional native schedules and connectors

This section is not a prerequisite for manual archive triage or Crabbox reproduction. Archive search rows are neither authenticated event envelopes nor a verified poll/stream adapter. Do not invent an API or wire archive results into the legacy builder. A requested watcher needs separate connector verification and explicit activation authority.

Inspect the running host for every/cron/at/event/stream, condition gates, next_check and owner-only loop support. A source checkout or stale package path is not evidence of the active runtime. Stream transport launches operator-authored argv under host supervision; enable it only after the exact connector, owner credentials, normalized events and lifecycle are verified. No credential values belong in argv/config/templates.

The existing legacy Benny builder supports three native transports: a discovered authenticated MCP Events source (event catalog and argument schema must match), a verified MCP read-only **poll adapter** returning normalized events, or a verified **stream** argv connector emitting newline-delimited normalized events. Polling happens in headless gates, not model turns. Missing/failed readers fail visibly; do not use unconditional model polling as fallback. Trigger state is bounded to 128 keys/16KB; selected batch max16. Exceeding batch limits fails rather than silently losing reports. Source replay/cursor/retention must cover downtime; reconcile periodically before enabling production traffic.

Verify the exact active host package and schema, not an unrelated checkout. Connector plugins may be disabled or absent; plugin presence alone is not a working connector. Event templates fail closed until a real authenticated source/catalog, target and configuration are supplied. The adapter changes no plugin, credential, callback route or Gateway setting.

Event transport uses the native event schedule and no polling gate. The plugin supplies a wrapped untrusted envelope; call nativeEventIntake on the decoded object before any effect, then re-read source/thread with authenticated tools. Signed delivery authenticates transport, not instructions. Native durable ingress dedupe is bounded, so payload-level source/effect reconciliation is still required. Invalid or forced runs lacking the envelope do nothing. The connector must implement normalized report fields and source replay semantics; arbitrary MCP events are not automatically compatible.

## Legacy template dry-run usage

These commands exercise the existing generic templates, not a Discrawl/Gitcrawl connector or a Crabbox provider. They are unnecessary for an ordinary read-only manual batch. From the installed pstack directory:

    node scripts/automation.mjs loop-plan native/automation/loop.example.json
    node scripts/automation.mjs benny-check <user-config.json> <observed-capabilities.json>
    node scripts/automation.mjs benny-plan <user-config.json> <observed-capabilities.json>
    node scripts/watch-pr.mjs template --repo OWNER/NAME --pr N --until ISO --gh ABS-GH --state-dir ABS-DIR
    # In a source checkout only: npm run test:automation; npm run test:watch-pr

The shipped examples deliberately contain REQUIRED placeholders and fail closed. Copy them to a user-owned path only when requested; never edit secrets into package files. Tests use synthetic in-memory configs, never live jobs/stores. Read [Benny](benny.md) before using its payloads.
