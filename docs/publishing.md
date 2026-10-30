# ClawHub publishing readiness

Contract checked 2026-10-20 against the official ClawHub overview, how-it-works,
CLI, acceptable-usage, auth and publishing pages; OpenClaw's community,
building-plugins, manifest, manifest/package-json, compatibility and SDK migration
compatibility-policy docs; and **clawhub 0.23.3 (d07aac2e)** help and bundled code.
This is preparation only: no login, upload, public-repo change, tag or release.

## Requirement checklist

| Requirement | Satisfaction / remaining gate |
| --- | --- |
| Owner and namespace | `@fuller-stack-dev/openclaw-pstack` matches publish owner `fuller-stack-dev` and repository name. The future authenticated account must have publish access to that ClawHub owner; not assumed or probed. |
| Valid package name/version | npm-style scoped name; package, plugin manifest and adapter version aligned to 1.2.5 (unreleased). Version records are immutable, so any changed published bytes need a new version. |
| Runtime identity | Plugin id remains `pstack`. It must be unique among this owner's packages; registry uniqueness/availability is a future server-side gate. One host loads one plugin for a given id. |
| Package shape | ESM built `dist/index.js`; public SDK imports external; `openclaw.extensions` declares it. Root manifest has id, strict configSchema with explicit boolean bareRouteAliases and trailInRestrictedSessions opt-ins, one developer-tools category, tool contract, CLI metadata and intentional startup activation. |
| Host compatibility | peer `openclaw >=2026.10.5`; `openclaw.install.minHostVersion >=2026.10.5`; `compat.pluginApi >=2026.10.5`, `compat.minGatewayVersion 2026.10.5`; build host/SDK provenance 2026.10.10-beta.2. Full registration additionally requires api.runtime.state.openKeyedStoreV2 and fails closed before registering full-mode surfaces when absent. Host cli-metadata discovery does not read its intentionally unavailable runtime Proxy; CLI execution re-registers in full mode. Stable v2026.10.5 lacks the method; capable current main builds may still report 2026.10.5. Qualification pins v2026.10.10-beta.2; floors are not blanket runtime qualification. |
| Source provenance | GitHub repository metadata in package.json; publish the packed commit with explicit `--source-repo`, full `--source-commit`, `--source-ref main` and `--source-path .`. Retain tarball SHA-256. |
| Public reviewable source | Repository intentionally remains private. The community-publishing checklist requires public GitHub source. The operator must separately authorize any visibility change before public release; this task does not. |
| File limits | CLI 0.23.3 ClawPack parser: max 10,000 files, 50 MiB combined unpacked bytes (and per file), 64 MiB decompressed tar stream, 256 KiB package.json; max 120 MiB compressed ClawPack transport. Multipart inline limit is 18 MiB (larger artifacts use staged upload). The release is far below all; pack tests enforce the tighter parser bounds. Future server policies may add limits. Skill-publish 10 MiB/file is a separate flow, not used here. |
| Safe archive | Plain ustar, package/ prefix, regular files/directories only, no links/PAX/duplicate paths/macOS metadata; source-mode and extracted-doctor regression checks. Managed npm extraction renames upstream .gitignore to .npmignore; doctor reports that exact relocation and still verifies its pinned bytes and complete inventory, without rewriting the installed tree. |
| Runtime-only shipping | Literal allowlist ships built runtime, two model-visible non-user-invocable guidance skills, 57 manual model-hidden route guides, native guidance/helpers, source integrity records, pinned upstream reference and public docs/licenses. Excludes adapter tests, evidence, artifacts, operator docs, verification dumps and sourcemaps. Upstream's own tests/assets stay only as byte-identical reference, never executed. |
| License/rights | MIT root license retains Lauren Tan attribution and adds adapter owner; original upstream MIT license preserved. NOTICE names v0.15.36, commit/tree and independent adaptation. No official-Cursor/author endorsement claim. |
| Setup/maintenance docs | README covers requirements, registry/local install, hook consent, commands, role file, routes, limitations, security, troubleshooting and upstream refresh. fuller-stack-dev owns maintenance and GitHub issues. |
| Optional icon | Not supplied; ClawHub uses the declared category glyph. Custom artwork is optional; if added later, ship assets/icon.png, valid PNG <=512 KiB. |
| Honest capability/security metadata | No bundled credentials, private endpoints, obfuscated installer, remote unreviewed execution requirement, implicit publishing, telemetry or automated marketplace activity. Host tools/identity/permission gates remain authoritative; dormant automation is explicitly opt-in. |
| Validation | Local doctor and behavioral/archive tests; see each version's acceptance record. Historical 0.2.x ClawHub dry-run evidence does not qualify this partial 0.3 candidate. On those historical artifacts, CLI 0.23.3 inspector passes with zero hard errors and one advisory: its static parser calls `contracts.tools` unknown. Current host manifest docs require that exact tool ownership field, so it is retained; host runtime/Vitest prove registration. The CLI advisory is recorded rather than silenced or treated as proof of a server-side review. |
| Authentication/account standing | Future operator signs in with GitHub-backed ClawHub account and authorizes CLI device flow; upload/account-age/standing and owner access gates are server-owned. No token/log-in used here. Device codes expire after 15 minutes; store secrets only through supported CLI/config. |
| Moderation/publication | Real publishes stage the exact artifact; new releases stay unavailable until automated checks/review finish. A pending upload is not public delivery. Future operator should use --wait and inspect a definitive result. |
| CI | Portable build/generated-route integrity/doctor/routing/Python/automation/plan/workflow/archive tests on push/PR, plus a pinned-host job running strict plugin SDK typecheck and the full Vitest suite against v2026.10.10-beta.2 at 2b85c4c25ea98d72ca1d3e93fb0fd9cac8f0ddab. No release/publish workflow. |

For optional loader-inventory checks, include the installation's own explicit
`baselineSkillNames` alongside `skills` in the JSON passed to
`verify_install.py --inventory`. No unrelated installation's skill list is shipped.
The pure inventory validator still rejects leaks/disappearing baseline skills.

The 0.3 command/discovery, supplied-source plan-tool and optional script-adapter increments do not establish whole-phase readiness. The plan tool is structure-only; it does not verify execution or evidence. The trail and worktree-audit adapters are optional tools that need an operator `tools.allow` opt-in; trail rows are agent-attested and audit buckets never authorize deletion. Native agent briefs and panel output contracts are agent-attested: pstack_brief and workflow collection check report shape and cross-field rules, not correctness, and read-only stays a brief constraint until a host profile capability exists. The reviewed upstream rule overlay maps every pinned MUST/required/never line to native text or a justified exclusion; it is text coverage, not behavioral proof. The watch-pr template is user-installed and read-only; pstack schedules nothing, and its tests use a fake gh, not GitHub. Host capability adapters remain open; no publication is authorized. See `skills/pstack/native/route-commands.md` for the public capability boundaries.

## Downgrading from 1.1 to 1.0

Every native workflow record that 1.1 creates carries `stagesVersion: 2`, and the 1.0 reader rejects that field. In a session whose 1.1 native workflow is still active, waiting, awaiting-user or blocked, a 1.0 plugin answers "Pstack error: Invalid setup" to `/pstack resume`, `/pstack resume cancel`, `/pstack status` and any new native start, and every prompt in that session reports the workflow lookup FAILED CLOSED. This lasts until 1.1 is reinstalled or the record's 14-day idle TTL expires. Nothing is respawned, and completed or cancelled 1.1 records, skill-guided ledgers and mode state are unaffected. The 1.0 reader cannot be changed, so before installing 1.0 over 1.1:

1. In each session with a native workflow in progress (`/pstack status` names it), let it finish or run `/pstack resume cancel`. Cancelling leaves accepted children with their native owner, as always.
2. Then install the 1.0 archive.

If a session is already wedged, reinstall 1.1, cancel that workflow, and downgrade again (follow-up P3-37).

## Derived media and source binding

Git retains reviewable source, immutable input URLs/digests, original notices,
the renderer source patch, exact root/sysroot locks and recipe. The two TTF files
and binary-embedding dist/ketchup-video.mjs are ignored build outputs. The other
three runtime bundles remain tracked. Install/runtime behavior is unchanged:
the published archive is self-contained, with no Rust, build or network step at
install time. FFmpeg remains an existing runtime prerequisite for video use.

Builds need Node, Python 3, esbuild 0.28.2 and a verified media cache, or the pinned
Rust 1.95.0 aarch64-Darwin toolchain with rust-src and wasm32-unknown-unknown.
Set RUST_TOOLCHAIN_DIR for an existing toolchain; the script does not install it.
On a cold build it verifies public source archives, exact locked crates and the
installed WASM sysroot against the official archive, compiles with at most three
jobs, then verifies the pinned wasm-bindgen tool, matching glue/facade and WASM.
No historical npm renderer fallback is allowed. See the renderer BUILD.md for
the current cold-reconstruction limitation; a digest mismatch is a hard refusal.

PSTACK_VIDEO_CACHE chooses a hash-addressed build cache (default
~/.cache/pstack/video-assets); every read is hash-checked. PSTACK_VIDEO_OFFLINE=1
refuses missing inputs rather than fetching. A poisoned entry fails, never
silently refetches or substitutes. Normal frozen dependency installation uses
the repository lock and the canonical package store where supported.

scripts/pack.mjs still archives the exact requested Git commit, then executes
THAT archive's media recipe/pins with the version-checked build tool. It never
copies a dirty local bundle, source file or node_modules tree. The final bundle
must match its committed output pin. dist/ketchup-video.build.json binds the
source commit, source/input digests, tool version and generated output hash;
the printed pack receipt binds that manifest and output to the final tarball
SHA256. The extracted doctor, plain ustar layout, original modes/dotfiles,
573-source inventory, no-links/duplicate checks and no-overwrite rule remain.

## Exact future commands

From a clean reviewed commit in this repository:

```sh
npm run pack
# Use the EXACT path and full commit printed above; do not publish a mutable folder.
clawhub package publish /absolute/path/to/accepted.tgz \
  --family code-plugin --owner fuller-stack-dev \
  --source-repo fuller-stack-dev/openclaw-pstack \
  --source-commit FULL_COMMIT_SHA --source-ref main --source-path . \
  --changelog "REVIEWED_VERSION: accepted changes from the exact reviewed commit" \
  --dry-run --json
```

Only after separate authorization, public-source readiness, successful validation
and `clawhub login`/owner confirmation, the **publish** command is:

```sh
clawhub package publish /absolute/path/to/accepted.tgz \
  --family code-plugin --owner fuller-stack-dev \
  --source-repo fuller-stack-dev/openclaw-pstack \
  --source-commit FULL_COMMIT_SHA --source-ref main --source-path . \
  --changelog "REVIEWED_VERSION: accepted changes from the exact reviewed commit" \
  --wait --json
```

Do not use ordinary folder/GitHub publishing for this version: that path runs
npm pack --ignore-scripts, which discards the upstream .gitignore. Supplying our
verified .tgz preserves all 573 source files and exact artifact identity. The CLI
supports a .tgz source for publish/dry-run even though help labels it as a folder
or GitHub source. Registry ownership, package availability and security review
are not established by a local dry-run. Never claim readiness means published.

## Contract sources

- https://docs.openclaw.ai/clawhub
- https://docs.openclaw.ai/clawhub/how-it-works
- https://docs.openclaw.ai/clawhub/cli
- https://docs.openclaw.ai/clawhub/publishing
- https://docs.openclaw.ai/clawhub/acceptable-usage
- https://docs.openclaw.ai/clawhub/auth
- https://docs.openclaw.ai/plugins/community
- https://docs.openclaw.ai/plugins/building-plugins
- https://docs.openclaw.ai/plugins/manifest
- https://docs.openclaw.ai/plugins/manifest/package-json
- https://docs.openclaw.ai/plugins/compatibility
- https://docs.openclaw.ai/plugins/sdk-migration/compatibility-policy
