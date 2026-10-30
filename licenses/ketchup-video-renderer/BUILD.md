# Same-renderer source build and source availability

## Integrated build and current qualification limit

From the repository root, scripts/build-video.mjs validates every source record
in scripts/video-assets.json, fetches the immutable fonts on a cache miss and
builds the self-contained video bundle. PSTACK_VIDEO_CACHE is a hash-addressed
build cache, not a private source locator. Only the exact qualified WASM and
matching facade are accepted. The fonts, WASM and binary-embedding video bundle
are not tracked in Git. No install/runtime download or build is introduced.

scripts/build-video-renderer.py reconstructs the locked renderer in a disposable
build directory with an existing hash-verified Rust 1.95.0 toolchain, verified
official wasm32 sysroot, immutable source archives and locked crate checksums.
It uses at most three Rust jobs, verifies generated glue/facade/WASM, and cleans
its temporary source graph, target and wasm-bindgen tool. Canonical crate archives
are read only after checksum verification; no global toolchain/config is written.
The ordinary build and frozen-commit pack call it only on a missing WASM cache entry.

**The original cold-reconstruction defect is corrected in this recipe.** Six
path packages previously lived outside Cargo's workspace; their absolute
source IDs changed compiler metadata despite identical diagnostic path sets.
The historical qualified 66da0bed artifact (2,642,569 bytes) was not reproduced
by rejected cold outputs including 47d1b43b (2,643,145 bytes), 30d2377d and
63ca7ab2. They were rejected/cleaned, never silently repinned.

The corrected workspace-contained source layout below produced a new qualified
WASM in two genuinely clean different-root/cache-layout builds, identical both
before and after wasm-bindgen. The new pin is derived from this repeatability
proof, not an unexplained drift. Frozen public packaging and CI remain the
integrator's separate gates; the required cold check must not be skipped.

## Qualified artifact and scope

The corrected portable build completed with the **same 158-package lock,
original renderer and facade**, Rust 1.95.0 and wasm-bindgen 0.2.92. The final
unchanged real 20-case consumer passed 20/20. No font, renderer feature, pixel
threshold, encoding or semantic validation policy changed.

- WASM: 2,638,217 bytes; SHA256
  `3b6e67936532d2b023f47574e0b1e88f9f259fe8e2cfba51563f53cac841d47c`.
- Generated web glue: `candidate/index.js`, SHA256
  `8662290f6216dc40aac4e42a426172cc3732fa6f6ef728a0ef70da3a47585df5`.
- Matching bundled facade: `candidate/index.mjs`, SHA256
  `f8c7c51802fa7f792e94dbffd254fc47c6c4fae0b6871992d8e1b6cd50edbb77`.
- Original unmodified facade Source Code Form: `candidate/wasm-binding.ts`.

The integrated source records in `../../scripts/video-assets.json` preserve the
reviewable source and notices; the WASM record identifies a generated output.
Private operational evidence and visual proof are not public package inputs.
Historical source-build proof does not establish cold reconstruction or release readiness.

## Exact source reconstruction

`source-inventory.json` contains every immutable archive URL, SHA256,
source revision, registry archive checksum, original notice path/hash, compiler
artifact and compiler/sysroot binding. The source archives are:

| Directory under source/ | Repository | Immutable revision |
| --- | --- | --- |
| resvg-js | thx/resvg-js | 9ca058462ac529120c8cc84ddcd6fef644cc5406 |
| resvg-js/vendor/resvg | zimond/resvg | 3495d8705b302d6d266748516973606ca9657906 |
| resvg-js/vendor/woff2 | yisibl/woff2-rs | 88cce4cd07da2c3f35839068c6f73672700cfc8b |

In an empty task build directory containing the transfer files:

1. Fetch each `immutableArchives` URL and verify its exact SHA256 before
   extracting. Strip only the archive's one top-level directory into the
   corresponding `source/` directory. No Git history or upstream installer is
   needed. The observed build extracted Rust files, TOML/Markdown files,
   LICENSE/COPYING files and wasm-binding.ts; full archives may contain unused
   fixtures. In particular retain resvg-js/vendor/woff2/readme.md for include_str!.
2. Apply the only source modification:

   ```sh
   patch -d source/resvg-js -p1 < source.patch
   cmp source/resvg-js/Cargo.toml resvg-js.Cargo.toml
   cp Cargo.lock source/resvg-js/Cargo.lock
   cmp source/resvg-js/wasm-binding.ts candidate/wasm-binding.ts
   ```

   The patch pins wasm-bindgen 0.2.92/js-sys 0.3.69 and maps the two immutable
   source dependencies to the verified workspace-contained vendor directories. It changes no Rust
   implementation. Do not resolve a new lock or update dependencies. Root lock
   SHA256 is `874e3f5157154975d8d26ea0c2284bcf01085455020ca2f2c0f48f50bee41329`.
3. Set `RUST_TOOLCHAIN_DIR` to an existing verified Rust 1.95.0 toolchain
   containing wasm32-unknown-unknown, `CANONICAL_CARGO_HOME` to the existing
   immutable crate cache, and `WASM_BINDGEN` to verified wasm-bindgen 0.2.92.
   The exact build used aarch64-apple-darwin Rust commit
   59807616e1fa2540724bfbac14d7976d7e4a3860. Official archive URLs/checksums,
   executable hashes and the corresponding sysroot source commit are in the
   inventory. The wasm-bindgen Darwin-arm64 archive SHA256 is
   `9ac857faddd4368e5ad3f41b74bbc4c2d32c3726d008bd5760fc52c7c6843e48`.
   This recipe does not install or change a global toolchain.
4. Create task-private Cargo index/cache lock state. The observed build copied
   selected sparse-index records to the private Cargo home; for each of all 151
   registry packages it verified the locked archive and all source bytes (6,558
   files). It linked only individual byte-verified canonical archive/source
   entries, extracting missing immutable archives locally. It did not symlink
   an entire mutable Cargo home. The registry identity is
   `index.crates.io-1949cf8c6b5b557f`. Include checksum-bearing index records
   for every locked package. An alternative standard online preparation is
   `cargo fetch --locked --manifest-path source/resvg-js/Cargo.toml` with
   the private Cargo home; it must preserve the exact lock/checksums. No closure
   reselection is allowed. Offline compilation below consumes the frozen inputs.
5. Run the following from the transfer/build root, with physical, not unresolved
   symlink, values for the canonical/toolchain roots. All four mappings are
   present in the actual compiler invocation **before** this build:

   ```sh
   BUILD_ROOT=$(pwd -P)
   export CARGO_HOME="$BUILD_ROOT/cargo-home"
   export CARGO_TARGET_DIR="$BUILD_ROOT/target"
   export RUSTC="$RUST_TOOLCHAIN_DIR/bin/rustc"
   export CARGO_BUILD_JOBS=3
   export GIT_CEILING_DIRECTORIES="$BUILD_ROOT:$CANONICAL_CARGO_HOME"
   unset RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER RUSTC_BOOTSTRAP
   unset CARGO_ENCODED_RUSTFLAGS
   export RUSTFLAGS="--remap-path-prefix=$BUILD_ROOT=/pstack-video-build --remap-path-prefix=$CARGO_HOME=/cargo --remap-path-prefix=$CANONICAL_CARGO_HOME=/cargo --remap-path-prefix=$RUST_TOOLCHAIN_DIR=/rust-toolchain"
   "$RUST_TOOLCHAIN_DIR/bin/cargo" build --locked --offline --release \
     --target wasm32-unknown-unknown --manifest-path source/resvg-js/Cargo.toml
   "$WASM_BINDGEN" target/wasm32-unknown-unknown/release/resvg_js.wasm \
     --target web --out-dir candidate --out-name index
   node bundle-candidate.mjs
   ```

   Use esbuild **0.28.2**. The script accepts `PSTACK_ESBUILD` as an explicit
   module locator, otherwise resolves the normal esbuild package. The script
   bundles the retained original facade against freshly generated glue. It
   changes only the import resolution; original TypeScript imports remain in
   Source Code Form. No wasm-pack, wasm-opt or npm lifecycle script is used.
   Set optional `PSTACK_ARTIFACT_SOURCE` to the unchanged ketchup-video source
   tree only when building the standalone verification consumer. Without it,
   only the facade is bundled. Paths are environment choices, never personal
   constants in the public recipe. Generated declaration files are not needed
   for this runtime transfer.

The graph and compiler are pinned. Two genuinely clean builds at different
absolute roots and different Cargo cache layouts produced byte-identical
pre-bindgen WASM, final WASM, generated glue and facade. This is not a claim of
cross-platform reproducibility. Keep all path packages beneath the wrapper
workspace and remap the actual private Cargo home independently of the build
root. Verify final hygiene/behavior; never edit binary strings.

## Full closure, original notices and source availability

The inventory is the conservative **entire new locked closure**: 158 packages,
151 registry packages and seven immutable source-tree packages, including
host/build/other-target dependencies. It does not assert that every notice or
package is linked at runtime. All 6,558 registry source files were compared to
their original locked archives in both source preparations; 62 selected sources
were reused from the immutable canonical cache.

The compiler and all 54 WASM sysroot files were compared to official Rust
archives and reverified before this compile. `rust-library-Cargo.lock`, the
original `notices/rust-sysroot/COPYRIGHT-library.html`, compiler-builtins
license and referenced standard texts describe that separate sysroot inventory.
The original copyright inventory equals the official compiler distribution;
source lock and builtins license equal the official rust-src distribution.

For modified MPL Source Code Form, make this patch, exact lock/manifest,
portable recipe, original facade and immutable source locators available
alongside the MPL notices. The sole integrator must actually ship these files;
private staging alone is not source availability. No Rust implementation source
was modified. Do not relabel the entire package MPL: preserve the plugin MIT,
existing Noto font OFL and each original component's terms/credit.

Notice qualifications preserved:
- Missing root notices for alloc-stdlib/napi packages were recovered from the
  exact crate-recorded immutable VCS revision.
- Four Pathfinder crates have original Apache-2.0-or-MIT source declarations.
  Their original header/copyright excerpts and the selected full Apache text
  from the named license-steward URL are retained without substituted credit.
- **safer-bytes 0.2.0** has an MIT declaration but no instantiated LICENSE or
  copyright file in its exact archive or recorded complete Git tree. The actual
  declaration and unchanged SPDX standard MIT text are retained and labelled;
  no placeholder author/year is invented. Keep this nuance in review.
- Two upstream notice excerpts contain public web URLs whose route includes
  a home-named URL segment. These are public references, not private filesystem paths;
  preserve them and all legitimate upstream email/author credit.

This is finite technical provenance/notice evidence, **not legal advice or a
compliance guarantee**. Historical published npm WASM provenance remains
unverified; the new frozen closure does not reconstruct that old binary.

## Recorded failures and final verification

Initial attempt 1 exited 101: task extraction omitted readme.md and then-current
bytes 1.12.1 conflicted with woff2's extension methods. The exact readme was
restored; yanked bytes 1.6.0 was rejected before compile and compatible non-yanked
1.6.1 locked after source inspection. Attempt 2 succeeded in 16.64 seconds but
its WASM contained 199 private diagnostic path prefixes. That candidate was
never published and its bytes were replaced, not retained as a backup.

The explicitly authorized additional attempt 3 used the same frozen sources,
lock and verified compiler, adding the path mappings above. It succeeded in
34.89 seconds. Matching glue/facade were regenerated together. The final WASM,
JS, recipe, lock, source patch/inventory, public notice files and proposed public
assets were scanned against actual local roots and generic private path/host/
identity patterns. No binary-string surgery was performed. Original public
attribution is not stripped to manufacture an empty scan.

The unchanged real 20-case consumer passed in 21.90 seconds, including encoding,
decoded hold/transition verification, portrait preservation, Unicode/escaping,
determinism, source drift/collisions, actual caption/pixel/timing mutations,
concurrency and owned-process cancellation. Thresholds remain mean 3, caption 8,
evidence 16. All 20 prior artifact input files are byte-identical.

The final 96-frame fixture MP4 SHA256 is
`3f6414e936608f281a61d91778bfe43eee3eec60bf75dcb1283970749fc4d232`.
It and all three decoded previews are byte-identical to the prior inspected
proof. Minimal previews/MP4 remain private for the parent's final visual check.
No public npm-pack, gateway/import graph or cross-platform PASS is claimed here.
Font coverage, provenance/story truth and agent chat-size visual inspection
responsibilities remain unchanged.

## Source availability

This directory ships the source patch, locks, original facade, public immutable
locators and original notices alongside the generated runtime. The repository
contains the integration build/pack scripts and media pins. Temporary compiler
outputs are consumed and removed; the hash-addressed media cache is only a build
optimization and never substitutes for a qualified cold reconstruction route.

## Portable Cargo identity correction

The original qualified 66da0bed artifact passed behavioral and privacy checks,
but the first portable cold recipe did not reproduce it. The observed rejected
cold outputs included 47d1b43b, 30d2377d and 63ca7ab2 prefixes; they were not
accepted by changing pins. Diagnostic path sets alone were insufficient.

Cargo 1.95 path-source stable_hash removes the workspace prefix only when the
package is under that workspace. Previously six exact-source packages (resvg,
usvg, usvg-parser, usvg-text-layout, usvg-tree, woff2) were sibling directories
outside resvg-js. Their absolute source identities fed compiler metadata even
when rustc diagnostic paths were remapped. The correction is only to extract
those same immutable sources under resvg-js/vendor and update the two relative
patch paths. Cargo.lock, all 158 package versions, source bytes, features,
release profile, compiler and original facade are unchanged. No git-source
substitution, version update, binary surgery or optimizer change is needed.

Two clean sequential producers at different absolute roots, one with linked
verified archive inputs and one with copied archives plus an external Cargo
home, produced the identical result:
- pre-bindgen WASM: 2,961,416 bytes;
  SHA256 30f7ac67ff916dc609bd6509d886d3cbb678e9142c2d8c0578ce63eafbf75513;
- final WASM: 2,638,217 bytes;
  SHA256 3b6e67936532d2b023f47574e0b1e88f9f259fe8e2cfba51563f53cac841d47c;
- all 115 observed compiler metadata/features records and all pre/post-bindgen
  section digests match; glue and facade retain their prior qualified hashes.

The unchanged real consumer passed 20/20 on the corrected artifact. It produced
the same known MP4 and three decoded frame hashes with thresholds 3/8/16. The
new pin is the result of those independent clean producers, not acceptance of
an unexplained one-off drift. The sole integrator must still run the exact
frozen public cold build, package/import-graph and CI gates. Existing MPL
source-availability and safer-bytes declaration qualifications above remain.
