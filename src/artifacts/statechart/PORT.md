# Native statechart port custody

Source: cursor/plugins commit c742dd61706fbacc1b95f1a20b7b988cf096ce6c, pstack/skills/statechart/scripts/. MIT copyright 2026 Lauren Tan; full license ../../../licenses/statechart-MIT.txt. Every original below read in full before native execution. Exact scope: 29 original files reviewed (26 TypeScript runtime, shell launcher, package.json, tsconfig.json); the native graph has 28 TypeScript files (26 counterparts plus toolchain/render). Immutable Git blob identity verified on fetch. No upstream script/harness executed. No gateway authority added; view code runs in owned agent-exec worker (process separation, not filesystem sandbox).

| Original | SHA256 | Native counterpart | Reviewed disposition |
| --- | --- | --- | --- |
| backends/cfg.ts | aea4d8766d214e7fa08f4881f1037319655e75eb56652e1b6d5d4f13a162e3e1 | src/artifacts/statechart/backends/cfg.ts | Reviewed in full; unchanged semantics, attribution header only. |
| backends/mermaid.ts | 75704b2704a9399a39479ff704a580d5b9a1d0fede01fe771df28bf799b434b6 | src/artifacts/statechart/backends/mermaid.ts | Reviewed in full; unchanged semantics, attribution header only. |
| backends/plain-text.ts | e2bedb855eb3806ec3fe7a7bfa49baa309fb4cf0da425b5fe1e0686268ce255a | src/artifacts/statechart/backends/plain-text.ts | Reviewed in full; unchanged semantics, attribution header only. |
| backends/report.ts | 730b4048578ab0468e1581f16fec60b246e321161effb68e481efb373f0f2501 | src/artifacts/statechart/backends/report.ts | Preserve reports; add explicit drawing-failure explanation without falsely claiming chart-budget overflow. |
| frontends/config.ts | 5eeab1e755f20a2c83b408c6503fdc9c6b10c971d8dedad3f912bd15f9763daf | src/artifacts/statechart/frontends/config.ts | Reviewed in full; unchanged semantics, attribution header only. |
| frontends/dot.ts | 4eef9ec848557dcd01ca8dbbec75b71c0653c1b73583108bafbb6f559f6d677b | src/artifacts/statechart/frontends/dot.ts | Reviewed in full; unchanged semantics, attribution header only. |
| frontends/marks.ts | eb0120e61a4004a435c7b7c46916da9dc8b2fa8696ed0d3eb64dc953fed3ab11 | src/artifacts/statechart/frontends/marks.ts | Reviewed in full; unchanged semantics, attribution header only. |
| frontends/messages.ts | 36bfc6fb3ffa86897661efb2aa67bd95b55a4da9a3e952831f6e0668826b4b92 | src/artifacts/statechart/frontends/messages.ts | Preserve nested TLC parsing; reject mismatched end IDs and truncated completion/statistics markers. |
| frontends/spec.ts | 450cdfc8d0577a96818ca3697efebbbf70b530a4ba7e3eee03cf1ba8d3f1a0fd | src/artifacts/statechart/frontends/spec.ts | Reject missing SANY root module. |
| frontends/trace.ts | 7d083cf89b81c41556fc3fd5f07019886e0f6783c632475e7181ac4b81887367 | src/artifacts/statechart/frontends/trace.ts | Reviewed in full; unchanged semantics, attribution header only. |
| frontends/value.ts | 7c54be394b7a10f60591858a0f08fb1e8dc0941df1f38ede07fbe7719ff56da0 | src/artifacts/statechart/frontends/value.ts | Reviewed in full; unchanged semantics, attribution header only. |
| frontends/verdict.ts | 0d0a9d6b6d6da5a7c48851b86d9d041f22982404dda6288795a1715138d7008b | src/artifacts/statechart/frontends/verdict.ts | Completed marker/statistics validation. |
| frontends/view.ts | 2c0af8939321c5aaed4b6ecac8ce6a98d0e6774d8bd15d4b02fe4f406b8c9620 | src/artifacts/statechart/frontends/view.ts | Reviewed in full; unchanged semantics, attribution header only. |
| ir.ts | 5602beca4e4ac08421cfa07e4da989f0e75439f1d136cc923226909e771dc7ff | src/artifacts/statechart/ir.ts | Preserve typed Value/Graph/Chart/Outcome domain; add optional chartError distinct from verification. |
| package.json | 2c36842f391275b0f343a38947560adee155fab4a744eacef1e595e9f07c4e3d | Not ported | Reviewed, not executed or ported; native ESM build replaces upstream launcher/config/harness. |
| passes/annotate.ts | dc8eeee09c3a9a0c060f32fb1d554e01bd80e5265751cdeb041ef3e19561b92a | src/artifacts/statechart/passes/annotate.ts | Reviewed in full; unchanged semantics, attribution header only. |
| passes/label.ts | b5ef402369c5e7846be1fd39165e95cbfe715fc36eb9331a0401b26523c539c9 | src/artifacts/statechart/passes/label.ts | Reviewed in full; unchanged semantics, attribution header only. |
| passes/lift.ts | 8977dddc6c93bb2e3914d5b50760eb66876107ba51e2b8cf9e18611b4c40c89c | src/artifacts/statechart/passes/lift.ts | Reviewed in full; unchanged semantics, attribution header only. |
| passes/loop-check.ts | 07d459385849aa35834040bf34e279c39baba68244ec9da17c57703a6ee8e2d4 | src/artifacts/statechart/passes/loop-check.ts | Reviewed in full; unchanged semantics, attribution header only. |
| passes/paths.ts | 9af1066b007ef86cb05c5e278eef09f090f1e46eb91d356e5146edbd4fee4ec7 | src/artifacts/statechart/passes/paths.ts | Reviewed in full; unchanged semantics, attribution header only. |
| passes/reach.ts | b52b38f926814937b733221b40bd31075a69a2fb91ecbce2164752a8684bc5d6 | src/artifacts/statechart/passes/reach.ts | Reviewed in full; unchanged semantics, attribution header only. |
| passes/region-check.ts | 8a6e0618740a14bb7048f6563b4324958177f4685d4d6d90364cc6245b1498b4 | src/artifacts/statechart/passes/region-check.ts | Reviewed in full; unchanged semantics, attribution header only. |
| passes/regions.ts | d740ebfdbb5ec7b4984412a635a596b43af7a77b8bcb49a1463c8afa75299f72 | src/artifacts/statechart/passes/regions.ts | Reviewed in full; unchanged semantics, attribution header only. |
| pipeline.ts | 8aa8d9295ab6762f7f2ffae91a0aee98b1a1314747c875edba4598fdab8ed543 | src/artifacts/statechart/pipeline.ts | Expose typed Chart for separate render; actual compiled edges including starts capped before Mermaid construction; source/JSON cap elides optional chart without altering completed TLC verdict. |
| run.ts | f330e0a3b0a9f8181c2e52252c4a47db3f0a64f79a7cca5490263e33a5f13c72 | src/artifacts/statechart/run.ts | Remove mise and shell janitor paths; fixed verified jar checked before every Java spawn, Java >=11; upstream JVM defaults/options retained (128 MiB only in tiny fixtures); validate completion/statistics, keep rules not checked; optional drawing failure retains completed original TLC verdict. |
| statechart | aeffb7077850fd4c225e3d18049ca6ed7b988cf48e88cd8463526a7feaa74d13 | Not ported | Reviewed, not executed or ported; native ESM build replaces upstream launcher/config/harness. |
| statechart.ts | 1c653f05d0cd0f3298455701f36e3d7d1f837f93e6e642f7c20afb5d613c2d12 | src/artifacts/statechart/statechart.ts | Separate Node ESM agent-exec CLI (check/render/doctor/toolchain fetch), owned worker group, native timeout/signals, new/empty output + exclusive destination reservation and atomic rename; no detached janitor. |
| tsconfig.json | 6bb2af53f7b251328e6117cd4fb761468dc4d4b96085d31a19304ccb73c32cc1 | Not ported | Reviewed, not executed or ported; native ESM build replaces upstream launcher/config/harness. |
| worker.ts | 1f18ed5ef806982e05e8a40fc217e88257700b28b63cb4acbd647872f85f782b | src/artifacts/statechart/worker.ts | Bundled worker executes selected view, real TLC, and staged files; emits chart.json; render reads bounded validated compiled chart, never arbitrary Mermaid. |

## Additional owned files

- toolchain.ts: native fixed-asset/hash acquisition (explicit command only), canonical cache and Java diagnostics.
- render.ts: public pele@1.9.0, bounded validated compiled Chart input, actual edge cap (not Pele maxEdges), source/output checks.
- tests/artifact-statechart.test.mjs: authored small real TLC fixtures and labeled Java-boundary corrupt-output/drawing-failure fixtures; no upstream JS harness/corpus.
- tests/artifact-statechart-pele.test.mjs: real public Pele known invalid input, limits, and demonstrated stateDiagram maxEdges gap.
- tests/artifact-statechart-packed.mjs: actual public npm pack, source-free extracted CLI behavioral suite, removes its artifact after use.
- Public scripts/build.mjs and scripts/typecheck.mjs own build and strict checks; no standalone stage recipes were copied.

## Public integration

The public build emits independent dist/statechart.mjs and dist/statechart-worker.mjs entries.
It inspects the complete gateway metafile and refuses artifact/Pele/raster inputs there.
Pele is exactly 1.9.0 in package.json and package-lock.json, resolved normally through installed dependencies.
No canonical-path overrides or standalone staging recipes are product defaults.
The native port retains its strict compiler settings in tsconfig.json beside these sources;
the gateway retains its stronger indexed-access setting unchanged. Both are checked by scripts/typecheck.mjs.

Run node scripts/build.mjs, then set TLA2TOOLS to the verified jar and JAVA to Java >=11:
node tests/artifact-statechart-packed.mjs
node --test tests/artifact-statechart-pele.test.mjs
The packed test uses npm pack on the actual public package, extracts outside the source checkout,
and runs its CLI and worker without source, node_modules or private loader paths.

### JVM heap compatibility

The approved upstream run.ts at c742dd61706fbacc1b95f1a20b7b988cf096ce6c passes no -Xmx flag.
The standalone reviewed port had added -Xmx128m. Integration removes that production cap,
retaining the selected JVM's default and ordinary JAVA_TOOL_OPTIONS for operator configuration.
The tiny behavioral fixtures explicitly set JAVA_TOOL_OPTIONS=-Xmx128m; that is not a large-model policy.
No budget was raised to make a fixture pass. Actual packed CLI execution requalifies this change.

## CLI contract and safety boundary

node dist/statechart.mjs doctor
node dist/statechart.mjs toolchain fetch
node dist/statechart.mjs check SPEC.tla --out NEW-DIR [--config FILE --view FILE --timeout-ms N --max-edges N]
node dist/statechart.mjs render CHECK-DIR --out NEW-SVG-DIR

Exit 0: original complete TLC config holds; 1: valid original counterexample (later rules may honestly be not checked); 2: infrastructure/model/timeout/invalid-input; 130/143: SIGINT/SIGTERM. Only 0/1 publish check output. Render success does not assert a model holds. 500-state chart coverage and optional graph/render limits never change completed TLC verdicts. Optional rendering is a separate command and cannot retract an existing check proof. A whole-check timeout/cancel reports unknown and publishes nothing even if intermediate work exists. --timeout-ms defaults to 60s, maximum 1h; --max-edges defaults to and cannot exceed 10,000 (includes start arrows). Source/config/view input <=1MB; chart JSON <=8MB; rendered Mermaid <=1MB and SVG <=8MB. Rendering accepts compiled chart JSON, not free-form Mermaid/SVG.

The user view is arbitrary code in the ordinary native exec worker, not a permission sandbox. No gateway tool/controller/role added: seven controller kinds and seventeen roles are unchanged. Process-group cancellation is POSIX/macOS/Linux only; Windows is not qualified. Trusted input/toolchain paths must not be maliciously replaced concurrently. Cooperating CLIs reserve a destination using one exclusive lock with pid/dest/stage; SIGINT/SIGTERM/timeout release it by inode identity. After an uncatchable SIGKILL/crash, do not auto-replay or remove unknown resources: inspect recorded pid/current consumer and exact owned stage before manual cleanup. No janitor/registry/cache framework. The command does not promise descendant containment against view code that deliberately detaches itself.

SVG is a noninteractive file/image. Do not embed as raw HTML or serve it with script authority; errors/snippets are text. This is not arbitrary-SVG sanitization qualification. Model counterexamples are model evidence only, not production bug proof without real-code replay.

## Test-quality audit

All three touched test files were read in full. Assertions use native built CLI, exit statuses, reader reports, chart files, SVG pixels-as-markup styles, no-output publication, retained sentinels, and actual process disappearance. Two Java wrappers inject only the failing adapter boundary while invoking real Java for SANY/version; ordinary holds/breaks/liveness/deadlock/rechecks use the real verified TLC jar. No source-text mirrored implementation tests or generic snapshots. One parsed-marker fault fixture is a distinct truncated-output boundary. Packed execution reuses the same suite intentionally; it is a distribution boundary check, not duplicate semantic coverage. Formatter touched adapted files only; whitespace layout deviations in those files are nonsemantic and in addition to this table. Formatter and strict typecheck were run. Full upstream 376-file corpus was not ported.

## Remaining limits

The network branch of explicit toolchain fetch has not been newly exercised: the approved
canonical jar and existing-cache branch are reused. No claim of full upstream corpus parity,
Windows behavior, malicious user-code containment, publication or live plugin activation.
The source-only mirror remains the prior 172 files and 55 route inputs; this native port is separate.

New/empty output reservations are a narrow concurrent-publication guard, not a replay/job system.
A crash lock is not automatically stolen by PID alone; inspect its exact stage and current consumers.
Models are task-private fixtures, not production bug evidence.
