# Native deterministic ketchup-video artifact

This is a new native implementation of the factual ketchup-video behavior in
cursor/plugins, pstack/skills/ketchup-video/SKILL.md, revision
c742dd61706fbacc1b95f1a20b7b988cf096ce6c (0.15.36). No upstream executable
was copied or run. The public source writer owns package/build/route integration.
This directory is the native implementation source; it is not loaded into the Gateway.

## Build and execution

Package runtime requires Node >=24.16.0; node22 is only the build target. Uses public @resvg/resvg-wasm **2.6.2**, esbuild **0.28.2** at
build time, and a qualified local ffmpeg/ffprobe at runtime. No browser, NAPI,
private host SDK, system fonts, provider call, network fetch or upload is used.

The package pins public build dependencies and embeds the two font buffers and WASM.
Run `node scripts/build.mjs` from the repository root. Runtime commands:

    node dist/ketchup-video.mjs doctor
    node dist/ketchup-video.mjs render manifest.json new-or-empty-output
    node dist/ketchup-video.mjs verify manifest.json output
    node --test tests/artifact-video-pack.test.mjs

The packed test runs the actual public npm package outside the source checkout with no node_modules or private loaders. The independent artifact entry is never imported by dist/index.js. Normal native agent exec policy owns execution. PSTACK_FFMPEG and PSTACK_FFPROBE are trusted operator executable paths, never manifest options.

## Closed manifest v1

    {
      "version": 1,
      "window": {
        "lastUserMessageId": "the-user-message-immediately-before-invocation",
        "invocationId": "this-ketchup-video-invocation"
      },
      "slides": [{
        "id": "before",
        "source": {
          "type": "screenshot",
          "path": "before.png",
          "sha256": "64 lowercase hex digits of exact PNG bytes",
          "ref": "actual capture/diff/data reference"
        },
        "caption": "The point this real picture makes",
        "newLabels": ["text added to the source picture"]
      }]
    }

Sources are local PNG files only; type is screenshot, diff or data. A diff/data
source is the agent's factual visual composition, not arbitrary SVG passed to
this CLI. Paths resolve relative to the manifest. The exact manifest bytes and
source digests bind caption/order/source associations. Caption text is XML
escaped. newLabels declares newly added labels ALREADY visible in the input
PNG; it is not an overlay API. Count all labels on the first slide, then all
new/changed labels. Never count words inside a screenshot. Declared labels are
counted conservatively in full, even if they repeat a prior label. CLI cannot
infer undeclared text from pixels; the agent must verify that declaration.

Agent owns the last-message window, actual provenance, visual story and calls.
Use <=10 evolving factual slides, no invented screen/status, bullet deck,
generated evidence or unrelated images. Make each slide change what the user
knows. Write the takeaway and slide plan privately first. Captions should be
about ten words, but are limited by actual 608px text geometry at 20px, not an
arbitrary word ceiling. Unsupported default-font glyphs fail explicitly. Do not
replace factual labels with misleading text to work around missing glyphs;
request an explicitly qualified font build or use a truthful text fallback.

## Pipeline and bounds

Manifest -> immutable in-memory source bytes -> locally rasterized PNGs ->
FFmpeg -> independent RGB decode/matching -> atomic ready output. 640x360 at
12fps; image fits proportionally without crop above a fixed 64px subtitle strip.
Letterboxing is deliberate: all source edges remain visible. Source dimensions
are <=4096 per side and <=8M pixels, source bytes <=8MiB, manifest <=64KiB,
caption <=300 code units; all checked before constructing Resvg. Its ignored
maxPixels/limit options are not relied on. Only escaped generated text and the
bounded local PNG data URI reach Resvg; no arbitrary SVG or resource URL input.
The exact default fonts are embedded, loadSystemFonts=false. No custom runtime
font API is exposed; Japanese/emoji examples fail rather than produce tofu.

Added words count caption plus declared labels, with punctuation tokens counted
and compound tokens split conservatively. Hold = max(12, ceil(words*12/3))
frames. Each slide is limited to 120 seconds to bound this small catch-up tool.
Six-frame fades are additional time, never subtracted from reading holds. A
single slide has separate six-frame fade-in/out. The silent H264 MP4 has no
watermark. Current free disk/RAM are checked against estimated work; execution
is limited to one encoder thread and a 120-second deadline per process. These
are honest artifact limits, not a new maintainer execution admission framework.

Each independently decoded MP4 frame is compared against the expected RGB
raster generated afresh from the pinned input/caption. Metadata/PTS must be
12fps and exact count. Every planned hold frame must match that ordered slide;
transition frames match the predicted blend and are never counted as holds.
Distinct synthetic inputs must have actual intermediate frames. Comparison uses
full-image mean absolute channel error <=3, maximum 8x8 caption-block error <=8,
and maximum evidence-block error <=16. This prevents a one-digit mutation being
averaged away. Calibration across real fixture encodes: correct caption max3.277,
evidence max7.542; final labeled PR17->PR18 wrong-caption block73.917. Thresholds were not
loosened after failures. These lossy tolerances are not exact byte equality or
OCR: small within-tolerance changes remain possible. High-detail legitimate
images may need a future qualified encoding change; never silently relax proof.

Output contains video.mp4, report.json, and one ACTUALLY DECODED 640px PNG per
slide in frames/. Temporary rasters are deleted. Repeated encode on the tested
FFmpeg build is byte-identical; cross-version/cross-CPU byte identity is not
claimed. The report is custody plus measured evidence, not proof of source truth.

Before delivery, the agent must inspect each decoded frame at chat size for
legibility, non-overlap, factual completeness and story. The machine cannot
verify those semantic judgments. Reply according to ketchup: opening sentence,
video, work-left line, calls. On any render failure give a truthful one-line
failure plus the calls; never substitute a fake video. CLI errors are one line,
exit2; SIGINT130/SIGTERM143. doctor never installs dependencies.

## Ownership and cancellation

Target must be new/empty, not a symlink. A sibling exclusive reservation lock and
same-parent staging directory prevent two cooperating writers overwriting one
another. Commit rechecks emptiness; a sentinel or existing output is preserved.
SIGINT/SIGTERM kill only the spawned process's own POSIX group, await close,
then remove owned staging/lock. No pkill, registry or janitor. The lock records
owner PID/stage/output to diagnose an uncatchable SIGKILL/host crash; it is not
authority to delete a live owner's work. Recovery of such leftovers is an
explicit owner inspection, not automatic PID-based guessing. Windows process-
group cancellation and Linux execution are unqualified; no full Windows claim.
Executed runtime was Node26.12.1/macOS arm64. Node22 is the build target, not an
executed platform qualification in this artifact.

## Custody and licenses

Native code is original implementation for Pstack;
the source-only upstream behavior is MIT-licensed. Preserve the public package's
MIT license and upstream attribution when integrating. No publication is implied by source integration.

Bundled renderer: @resvg/resvg-wasm 2.6.2, repository yisibl/resvg-js,
source tag v2.6.2, MPL-2.0. Unmodified public WASM SHA256:
22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70.
Corresponding Source Code Form is available at
https://github.com/yisibl/resvg-js/tree/v2.6.2 and the exact published JS/WASM
package at https://registry.npmjs.org/@resvg/resvg-wasm/-/resvg-wasm-2.6.2.tgz.
The MPL text is assets/MPL-2.0.txt; keep it and this source notice alongside the
bundle. Renderer source has not been modified. The bundle's original module
notices are retained. Review transitive compiled-WASM notices in the public
package's release-license audit before publication; this is not a legal opinion.

Fonts: Copyright 2018 The Noto Project Authors, SIL Open Font License 1.1.
Two unmodified font files from notofonts/noto-fonts revision
ffebf8c1ee449e544955a7e813c54f9b73848eac only; retain assets/OFL.txt:

- NotoSans-Regular.ttf: b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5
- NotoSansMath-Regular.ttf: 80b61fd613d3519197e64fff6f7e71fdc7f3e6526440ea4115b554ef7fd59af7
- OFL.txt: 0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb

No Apple font is included. FFmpeg is invoked as an existing external tool and
is not distributed in this artifact.

## Remaining release gates

Parent inspection/independent review; sole-writer integration and full touched-
test audit; public package build/import-graph and npm-pack execution; actual
route invocation/window/calls/media attachment; license release audit; supported
platform qualification. This artifact alone does not complete production parity.
The detailed partial compiled-WASM audit is in licenses/ketchup-video-sources.md. Its missing build lock/SBOM remains a publication gate.
