# Ketchup-video bundled sources

Unmodified @resvg/resvg-wasm 2.6.2 (MPL-2.0): corresponding Source Code Form at https://github.com/yisibl/resvg-js/tree/v2.6.2; published JS/WASM at https://registry.npmjs.org/@resvg/resvg-wasm/-/resvg-wasm-2.6.2.tgz. WASM SHA256 22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70. Full MPL is ketchup-video-MPL-2.0.txt.

Unmodified Noto Sans Regular and Noto Sans Math Regular, Copyright 2018 The Noto Project Authors, SIL OFL 1.1: https://github.com/notofonts/noto-fonts/tree/ffebf8c1ee449e544955a7e813c54f9b73848eac. Full OFL is ketchup-video-OFL.txt. Font hashes are pinned in scripts/build-video.mjs. No proprietary system fonts. FFmpeg is an external operator-provided tool, not distributed.

## Compiled-WASM audit, 2026-10-29

Inspected the actual published package and its pinned WASM, plus the complete Git tree and Cargo.toml at tag v2.6.2 (commit 9ca058462ac529120c8cc84ddcd6fef644cc5406). The npm package contains JS/WASM/types but no transitive license inventory. That source tree has no Cargo.lock. Cargo.toml includes registry version ranges, a resvg git patch at 3495d870 and a woff2 git patch using a mutable branch. The actual WASM contains paths identifying woff2 revision 88cce4c and some registry crate versions; strings are incomplete evidence, not a complete dependency bill of materials.

The complete compiled dependency closure and corresponding notices therefore remain UNVERIFIED. Do not infer the closure by resolving those ranges today, treat MPL as covering all dependencies, or claim legal compliance from this partial audit. Publication requires the producer build lock/SBOM and corresponding license texts, or independently qualified source-build provenance for the distributed WASM. This records a source-provenance gap, not a legal opinion.
