# Native role routing

This is the pstack plugin’s read-only role argument adapter for the existing OpenClaw runtime—not a model manager, credential store or scheduler. Prefer the bundled pstack_route tool; the legacy standalone planner remains compatibility source with the same strict semantics. Read it on **every pstack/poteto-mode invocation and active-session substantive work turn**, including help, setup, prose and review. [Session lifecycle](session-mode.md) preserves opt-in, not a fixed model override. Mode/status responses and simple conversational acknowledgments stay inline without creating a new role phase; substantive judgment/prose still uses its configured role. Use the invoking **workspace root**, not this installed skill directory or a worker's temporary checkout, for `pstack-models.json`. Read/resolve again before each new role delegation. Existing task phases keep their recorded snapshot and owner unless a later explicit user correction authorizes the append-only supersession described below; original evidence stays immutable.

## Ordered execution

1. Read the existing workspace config through the planner below. Only a genuinely absent entry (checked with lstat) or omitted role means native inheritance: omit model, thinking and fastMode. Invalid JSON/schema, unknown fields/roles/models/controls, unsupported controls or wrong panel counts are errors for new work, never silent defaults. A dangling config symlink is an invalid existing entry, never an absent file. Do not create a file just to express inheritance.
2. Choose the exact role from the table. Where the host provides a requester catalog, pstack_route uses it; otherwise normalize native available-model metadata into a small in-memory catalog of `{id, family?, thinkingLevels?, fastModes?}`. Include only exact available provider/model IDs. Preserve native family identity across different providers; provider names alone do not establish diversity. Do not infer availability from a familiar model name or stale inventory. Missing capability metadata is unknown, not proof; the actual native schema and runtime remain authoritative. This temporary projection is not a saved second registry. A supplied parent family that contradicts the known native catalog family is rejected rather than used to claim diversity.
3. Apply precedence: explicit task role selection **replaces** that role's configured selection; config overrides native inheritance. Replacement is intentional: choosing another model must not accidentally carry the old model's fast-tier controls. An explicit `"inherit"` drops all role overrides. Explicit panel/pool overrides must still contain exactly two entries. Do not turn unknown IDs into aliases or substitute another provider.
4. For a new task, resolve the role and record the resulting JSON snapshot with the existing task's record. A panel expands into two bounded children. A cross-judge pool chooses **one** entry whose verified model family differs from the current parent when possible; otherwise it chooses the first and reports unavailable/unverified diversity. `swarm workers` is one selection applied to each otherwise-authorized worker, not permission to create an unbounded swarm. A race/comparison's explicit arm selection overrides that worker's default.
5. Keep ordinary small work inline only when there are no requested overrides or the current model, thinking and fastMode are independently known to match, and no independent pass is required. If any requested setting differs or cannot be verified, use a bounded native child with the returned arguments. This includes all five judgment/prose choices: do not write the answer on the parent and label it “Opus”. Do not patch the parent's model/preferences. An assigned child already executing its recorded selection does not recursively delegate the same phase.
6. Inspect the **current effective** first-class `sessions_spawn` schema. Pass its `parameters` to the builder; then call the actual tool with the returned arguments. The builder never calls tools/RPC/CLI itself. Hidden native children accept separate `model`, `thinking` and `fastMode` fields; supported host schemas may include `"ultrafast"`. Visible native children do **not** accept thinking overrides: do not quietly drop that request. Prefer a bounded hidden child for these roles, or report the real capability conflict if a visible session is required. Preserve existing completion mode, work limits, test isolation and review requirements.
7. Record run/session IDs with the snapshot and inspect confirmation below. Collect through native completion events/collector results. A receipt is admission/resolution evidence, not finished work. Continue the same owned task on resume; do not respawn or change its selection merely because defaults changed. A later explicit user correction follows the append-only continuation procedure below instead of replaying a superseded control. An unavailable saved model is an explicit blocker, not a substitute. A malformed, unavailable-model or unsupported-control updated config is reported in configWarning but cannot replace a valid existing snapshot.

## Exact role map

These are the **17 labels** and list sizes from the pinned upstream setup reference. `sol` and `opus` below are user preset names, not provider aliases or hard-coded defaults.

| Role (exact JSON key) | Example preset (not a default) | Delegation size |
| --- | --- | --- |
| feature, refactoring | sol | one per assigned task |
| bug-fix | sol | one |
| perf-issue | sol | one |
| hillclimb | sol | one |
| judgment and prose | opus | one |
| hardest tasks | opus | one |
| how explorer | sol | one per bounded explorer |
| how explainer | opus | one |
| why investigators | sol | one per bounded investigator |
| why synthesizer | opus | one |
| reflect tooling | sol | one |
| reflect judgment, divergent, synthesizer | opus | one per assigned phase |
| arena runners | [opus, sol] | two |
| arena cross-judge pool | [opus, sol] | **one selected from two** |
| swarm workers | sol | one selection per authorized worker |
| architect runners | [opus, sol] | two |
| interrogate reviewers | [opus, sol] | two |

For complex `how`, 2–4 explorer slices precede the explainer; simple questions use one explainer with no explorers, as required by [the route](workflows.md#how). For `why`, investigators precede the synthesizer. For `reflect`, tooling and judgment/synthesis use their respective roles. Ordinary writing, design judgment, teaching summaries and review synthesis use `judgment and prose`; difficult implementation can select `hardest tasks` explicitly. Other implementation work uses the matching feature/refactoring/bug/performance role. Selecting a principle does not create another role. Only select a panel when that comparison/review is authorized and useful; once selected, do not silently reduce its two entries. Required but unavailable independent review stays blocked.

## Config schema

Workspace-owned `pstack-models.json` accepts only:

- `version: 1`;
- `presets`: names matching `[a-z][a-z0-9_-]*` (except reserved `inherit`), mapped to selection objects;
- `roles`: any subset of the exact keys above, mapped to a preset name, `"inherit"`, a selection object, or—only for the three panels and one pool—an array of exactly two such entries.

A selection object contains only optional `model` (exact available provider/model ID), `thinking` (native level) and `fastMode` (`true`, `false`, `"auto"` or `"ultrafast"`). Omitted fields inherit natively, not from another preset. Empty `{}` is inheritance. No authProfile, credentials, provider config, synthetic effort suffixes, arbitrary native arguments or recursive presets. All configured model selections, including unused presets, are validated before new work.

Minimal **shape example**, not a command to overwrite existing config:

```json
{
  "version": 1,
  "presets": {
    "sol": {"model": "openai/gpt-6.1-sol", "thinking": "high", "fastMode": true}
  },
  "roles": {"bug-fix": "sol"}
}
```

The presets above are illustrative user choices, not bundled model defaults or an availability guarantee. Configure only models and controls admitted by the current host. An ordinary default change affects new delegations; an explicit correction can also apply to an authorized continuation as described below.

## Setup and first use

- `/pstack setup` reads available capabilities and config and shows all roles; it does not edit or spawn by implication.
- “Configure pstack models …” explicitly permits only the requested workspace role file edits. Follow [setup-pstack](workflows.md#setup-pstack): inspect and preserve unrelated selections, preview the supported reasoning budget and full 17-role candidate table, obtain confirmation before writing unless the full table is already confirmed, validate against fresh native availability, write only that file and read it back. Plain setup remains read-only. Do not write Cursor rules or Gateway/profile settings.
- State that a listed model is inventory evidence, not a successful inference. If a billed live probe is authorized, use first-class native spawning and inspect the result; never install a provider or switch auth as fallback.
- Try `/pstack how <small scoped question>`: use the simple path and record only `how explainer`, with native delegation/collection or its named BLOCKED gate. A complex subsystem question instead records 2–4 `how explorer` slices followed by `how explainer`. Use a bounded read-only artifact so model routing is separated from implementation risk.
- An ordinary config/default change applies only to **future new delegations**; it does not rewrite saved selections. A later explicit user correction can supersede a continuation selection through the append-only procedure below, retaining its task owner. Old tasks without snapshots cannot retroactively claim a route: preserve their actual native state/owner, mark prior routing evidence unknown, and record the explicitly corrected selection before the next authorized continuation.

## Explicit user corrections on continuation

Snapshot immutability protects historical evidence; it does not override a newer explicit user instruction. Apply an explicit correction only to its stated scope. It does not resume a held task or authorize a new owner, provider, credential route or live-state edit.

1. The existing task owner reads the latest recorded selection and applicable correction. Keep the original snapshot, receipt and references unchanged. If already corrected, reuse it rather than appending duplicates.
2. Deep-copy the snapshot. Change only fields explicitly covered by the instruction, preserving role, other controls, source, order, poolIndex/diversity and unaffected selections. For example, an instruction to use ordinary Fast for an exact model changes only that model's `fastMode` to `true`. Preserve task ownership, credential binding and continuation/completion identity outside the snapshot. Do not re-resolve defaults or reselect a pool member.
3. Append an entry to the existing task record with the instruction/date, reference or digest of the unchanged original, and superseding snapshot. Keep relationship/owner metadata outside the strict snapshot schema; never overwrite prior evidence or edit the native database.
4. Validate the copy with `validateSnapshot(correctedSnapshot, catalog)`, then pass it as `snapshot` to `planFromWorkspace` or the stdin CLI. Do not combine resume with `overrides` or change the role. Apply controls through the existing authorized continuation/delegation interface; a plan alone changes no running session.
5. Record subsequent requested/resolved evidence against the superseding entry without relabeling prior proof. If the existing record/interface cannot preserve the link or apply a control, report that exact blocker instead of silently replaying a superseded control or inventing a raw-store edit.

Without an explicit correction, generic saved-snapshot behavior is unchanged. Capability tests can resume legacy control values; that proves support, not a user's present preference.

## Planner API and CLI

Pure module: `scripts/model-routing.mjs`. `validateConfigAgainstCatalog(config, catalog)` performs complete structural and availability/control validation, including unused selections; both new resolution and resume-time config inspection share it. `resolveRole({role, config, overrides?, catalog, parentModel?, parentFamily?})` returns a JSON snapshot. `validateSnapshot(snapshot, catalog)` revalidates a saved selection without consulting config or reselecting the pool. `buildSpawnArgs({snapshot, task, catalog, spawnSchema, baseArgs?})` returns native argument objects with the snapshot embedded in each brief. Keep taskName/label/working-directory and accepted completion parameters in `baseArgs`; model/thinking/fastMode belong only in the selection. Call the **first-class tool**, not a CLI or direct RPC, with those objects.

Blind trials. `buildSpawnArgs({..., blind: true, trialArgs?})`, or `blind: true` on pstack_route, returns each task exactly as given, without the routing snapshot, model IDs, role or workspace, so an eval candidate cannot see them. The plan then returns `custody`, one `{snapshot, selectionIndex, workspace}` record per selection, which the parent keeps in its own run record for continuation. A blind task, or a string spawn argument, that names a selected model ID (or any provider-less tail of it) or the invoking workspace path is refused rather than sanitized. `trialArgs` gives one argument object per selection, such as each trial's own `cwd`, under the same key rules as `baseArgs`. Outside blind mode nothing changes. See the [planner call](delegation.md#planner-call) for how routes use it.

Read-only wrapper: `scripts/model-routing-cli.mjs` consumes one JSON request on stdin and outputs one JSON plan. Use the available execution tool, with input assembled as data rather than shell interpolation. It reads only the workspace role file and writes no file:

```json
{"workspace":"/absolute/invoking/workspace","role":"bug-fix"}
```

Without a file that returns a single inherited snapshot. Availability is checked against, in order: the host requester catalog (pstack_route reads it automatically on hosts advertising `requester-model-catalog-v1`, and the result names `catalogSource: "requester"` and returns the selected records as `catalog`), a caller-supplied normalized native `catalog` (strict, even when empty), or none. With none, configured models resolve with `availability: "unverified"` and a `catalogNotice` instead of failing as unavailable; native spawn admission stays authoritative. A pending requester catalog proves neither availability nor absence. On hosts advertising `requester-model-family-v1`, requester catalog rows carry the host's canonical `family` where the host knows it, and the returned `catalog` records include it; families are compared only for equality and never inferred from names. A pool reports `different-family` only when the selected entry's family and the parent's are both known and differ, and a panel only when both entries' families are known and differ; known and equal is `not-established`, and any unknown family is `unverified`. Without that capability the requester catalog carries no family, so diversity stays unverified with it. Add a bounded `task`, actual `spawnSchema` and optional `baseArgs` to return spawn arguments. Add `overrides` only for an explicit task selection. On ordinary resumption pass the recorded `snapshot` instead; after a documented explicit user correction, pass its append-only superseding snapshot as described above. A different role or new `overrides` value is still rejected. `configWarning` is explicit when an invalid updated file is ignored in favor of an existing snapshot. Module/CLI output is planning, **not** execution evidence.

## Confirmation

`confirmSelection(requested, receipt, evidence?)` (or CLI `action:"confirm"`) compares exact requested model/provider to native `resolvedModel`/`resolvedProvider`. Normalize only **observed native status/trace** data as `{source, model?, provider?, thinking?, fastMode?, serviceTier?}`. The source identifies the observation; do not feed requested arguments or a child self-report back as effective evidence.

- Keep canonical model/provider identity separate from executor labels: native status can show `anthropic/claude-opus-5-5` while the transcript transport is `claude-cli`. Do not feed that executor label into `resolvedProvider`, invent an alias, or overwrite a conflicting actual receipt. If an actual receipt reports a different resolved provider, preserve the strict mismatch and investigate it.
- An error/rejected spawn is `rejected`. Actual model/provider or observed control differences are `mismatch`. Preserve the receipt, do not silently run a substitute or call it successful routing.
- Missing reasoning/fast-tier metadata is `unverified`, **not** a reason to fail every accepted child or spawn repeated probes. Keep separate requested, observed and unknown fields. Native status can confirm the selected thinking/fastMode; a status preference alone does not prove an upstream service tier was honored.
- For `fastMode:"ultrafast"` the service-tier check remains unverified until a native response/trace reports the effective tier. A confirmed lower tier is a mismatch, not “ultrafast passed”. Native clamping must likewise be reported rather than hidden.
- Return results through the existing parent/owner, never change parent model settings, never route notifications to Main by default. Required model diversity/controls remain an explicit gate when unproved; independent authorized work may continue.

## Verification boundary

`node --test skills/pstack/tests/model-routing.test.mjs` exercises all 17 mappings, five alternate-model roles, three panels plus one pool, inheritance, explicit overrides, strict rejection, resume snapshots and honest receipt handling. Tests use private temporary workspaces and fixture-only Opus routing. They do not call models or touch live config/stores. Run the existing integrity and automation suites too; preserve distinct behavioral coverage and the source-only loader boundary. Only fingerprint this adapter's changed/new package files in native-manifest.json; never fingerprint user config or rewrite the upstream/source manifest.
