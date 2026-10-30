# Native artifact CLIs

These are ordinary agent-exec programs, not Gateway tools or new controller kinds.
Resolve the package root from this installed skill (three parents above native/).
Use absolute paths to its dist entries. The package keeps Node >=24.16.0.
The video build target node22 is not an executed Node22 qualification.
The source-only upstream scripts remain non-executable reference.

## Statechart

Work in a task-private directory outside the repository. Inspect the model,
configuration and any executable view before running them. View code runs with
ordinary exec authority, not a sandbox. Preserve inherited fork/untrusted-code
isolation. Use these native commands from the package root:

    node dist/statechart.mjs doctor
    node dist/statechart.mjs toolchain fetch
    node dist/statechart.mjs check SPEC.tla --out NEW-DIR --config SPEC.cfg --view view.mjs
    node dist/statechart.mjs render CHECK-DIR --out NEW-SVG-DIR

Doctor installs nothing. Explicit toolchain fetch acquires the pinned TLA2Tools
1.7.4 jar into the supported cache and verifies its SHA256. Set TLA2TOOLS to an
existing verified jar and JAVA to Java >=11 to reuse trusted tools. JVM defaults
and operator JAVA_TOOL_OPTIONS remain effective; production has no forced heap
cap. Necessary trusted setup follows assigned-task scope and native exec policy,
not an invented blanket installation prohibition. No live service/config changes.

Model the reader's agreed rules as invariants. Never weaken them to obtain a pass.
Use named actions in Next. Model intentional terminal states with a stuttering
action rather than concealing a real deadlock. Keep constants/constraints bounded.
A view's state(vars) returns a label, hierarchy array, or parallel-region object.
step(action,from,to) names the reader-visible event; group/colors/title are optional.
Functions depend only on arguments. TLA sequences have 1-based object keys; sets
are arrays. Explain relevant conditions without duplicating region conditions.
Preserve each bug-path state and mark when coarsening. Never merge states that
break different rules. Hidden transitions retain reachability and a needed exit,
and hide all model steps of an arrow or none. Disclose hidden steps.

The original complete TLC configuration decides the verdict, not the chart or
renderer. Exit 0 holds; 1 is a counterexample; 2 is invalid input/infrastructure,
unknown/timeout; 130/143 are cancellation. Subsequent bounded checks can leave
rules not checked. Never treat those as holds. Explain VIEW/SYMMETRY equivalence,
constraints, omitted behavior and any model bounds. The 500-state drawing budget,
optional drawing failure and rendering limits do not change completed TLC results.

Give the chart.mmd as Mermaid plus the report's numbered paths, each broken rule
in the reader's words, exclusions, and a rerun command with a new output directory.
Use the separate pinned public Pele renderer for an image. Render success is not
model proof. Treat SVG as a noninteractive image/file, not raw active HTML.
Replay code-model counterexamples against real code before calling them bugs.
A failed replay first challenges the model. Keep that gate explicit.

Check timeout defaults to 60 seconds, maximum 1 hour. The graph edge bound is
10,000 including starts, checked independently of Pele's ineffective state-diagram
maxEdges option. Input files <=1MB, chart JSON <=8MB, Mermaid <=1MB, SVG <=8MB.
A whole-check timeout publishes no result. Output must be new/empty. A reservation
and sibling stage protect cooperating writers; signals wait for owned processes
and remove owned staging. Inspect crash locks and their actual consumers manually;
never steal by PID alone. Deliberately detached hostile descendants are not contained.
POSIX cancellation is qualified on macOS; Windows execution remains unqualified.

## Ketchup video

Read the complete native ketchup workflow first. The source window starts at the
last real user message before this invocation, not before a prior ketchup report.
Resolve both message and invocation IDs from actual agent context; never invent
IDs or promote worker receipts to user messages. Gather current factual changes
and all still-waiting user-only calls, even those raised before the window.
Rendering outside the repository is the narrow exception to ketchup's read-only
behavior; it grants no production writes, publishing or provider uploads.

Privately write the takeaway and slide plan. Use <=10 evolving factual PNG slides
from actual screenshots, diffs or data, with stable visual meanings and no repeated
facts. Reject invented screens, generated evidence, unrelated pictures, status
bullet decks and decorative tables. Distinguish done/running/failed/not checked;
work awaiting a decision is not done. A missing screenshot is disclosed, not faked.

Create a closed v1 manifest:

    {
      "version": 1,
      "window": { "lastUserMessageId": "ACTUAL_ID", "invocationId": "ACTUAL_ID" },
      "slides": [{
        "id": "before",
        "source": { "type": "screenshot", "path": "before.png", "sha256": "EXACT_SHA256", "ref": "ACTUAL_CAPTURE_REFERENCE" },
        "caption": "The point demonstrated by this evidence",
        "newLabels": []
      }]
    }

The uppercase values above are documentation placeholders, not executable evidence.
source.type is screenshot, diff or data; paths are local PNGs relative to the
manifest. newLabels declares every newly visible or changed label already present
in the PNG. Include all added labels on the first slide; screenshot text itself is
excluded. It is not an overlay API. The agent must verify this complete declaration.

    node dist/ketchup-video.mjs doctor
    node dist/ketchup-video.mjs render manifest.json NEW-OR-EMPTY-OUTPUT
    node dist/ketchup-video.mjs verify manifest.json OUTPUT

Use existing local FFmpeg/ffprobe with PNG decode, libx264 and xfade/scale/format/fade.
Doctor never installs. PSTACK_FFMPEG/PSTACK_FFPROBE are trusted operator executable
paths, not manifest-controlled commands. No browser, NAPI, system fonts, network
fetch or generated-media provider is used. MPL/OFL/source notices ship with the
bundle; the compiled-WASM closure audit remains a publication gate in licenses/.

Output is silent 640x360 H264 at 12fps, with a fixed 64px subtitle strip. Whole PNGs
fit proportionally without cropping; letterboxing deliberately preserves edges.
Captions state the point rather than repeat labels and must fit 608px at 20px.
The pinned Noto Sans/Math pair rejects unsupported glyphs including default CJK
and emoji; use truthful text fallback or an explicitly qualified font build, not
misleading substitutions. Input PNG <=8MiB, <=4096 per side and <=8M pixels;
manifest <=64KiB, caption <=300 code units. Limits precede renderer construction.
There is no arbitrary SVG input or reliance on ignored renderer limit options.

Hold frames round up to at least one second per three added words (caption plus
declared labels), minimum one second. Six-frame fades are additional time. Each
slide is capped at 120 seconds; each process has a 120-second deadline. Actual
current memory/disk is checked. The CLI independently decodes frames to verify
ordered evidence, captions, holds and transitions against newly generated rasters.
Lossy pixel tolerances are not OCR or proof that source facts are true.

Inspect each actually decoded frames/*.png at chat size for readability, overlap,
completeness and story before delivery. Verify every hold and added-word declaration;
repair, rerender and recheck failures. Deliver ketchup's opening sentence, attach
OUTPUT/video.mp4 through the supported media mechanism, name remaining agent work
in one line, then every waiting call. Option names match the video. If render or
attachment cannot be completed, give one truthful failure line and the calls only;
never manufacture an animation or claim a missing attachment succeeded.

Targets must be new/empty and non-symlink. Exclusive reservation/staging prevents
cooperating writers from overwriting output. SIGINT/SIGTERM terminate only owned
process groups, await close and clean owned files. Uncatchable crashes can leave a
lock naming PID/stage/output; inspect actual ownership before cleanup. Windows
process-group behavior is unqualified. Keep only outputs needed by an immediate
consumer and remove consumed fixtures; never delete another owner's stage.

## Qualification boundaries

Public npm-packed consumers execute both independent CLIs without source,
node_modules or private loader paths. These tests prove artifact behavior and
packaging, not agent story quality, real-provider inference or route completion.
The registered catalog has 57 routes, including skill-guided statechart and
ketchup-video. Discovery and reviewed text coverage do not prove agent story
quality, final package qualification or release readiness.
