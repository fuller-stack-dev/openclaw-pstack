# Ketchup-video bundled sources

The renderer is a new locked source build, not the historical npm WASM.
Its qualified WASM SHA256 is
66da0bed457e785fc75ff1452577ebf4978da904a2029c949fd1e0da892e2c9d.
The exact resvg-js source, immutable resvg/woff2 revisions, dependency-only patch,
158-package lock, original facade Source Code Form, compiler/sysroot inventory
and original component notices are in [ketchup-video-renderer](ketchup-video-renderer/BUILD.md).
Those files ship with the package; their source locators are immutable public URLs.
They do not imply that every locked host/other-target dependency is linked.
MPL-covered source, the plugin MIT, fonts OFL and individual Apache/LLVM/other
component terms stay distinct. The safer-bytes MIT-declaration-only qualification
is retained. These are technical records, not a compliance guarantee.

The unmodified Noto Sans Regular and Noto Sans Math Regular fonts are from
notofonts/noto-fonts revision ffebf8c1ee449e544955a7e813c54f9b73848eac,
Copyright 2018 The Noto Project Authors, SIL OFL 1.1. The full license is
ketchup-video-OFL.txt. Immutable download URLs, bytes and SHA256 pins are in
scripts/video-assets.json in the source repository. Build-time downloads are
verified before embedding; no system fonts or runtime download is used.
FFmpeg is an existing external operator tool, not distributed here.
