import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rmdir,
  rename,
  rm,
  open,
  lstat,
  statfs,
} from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { freemem } from "node:os";
import { loadManifest, sha, boundedFile } from "./manifest.mjs";
import { raster, pixels } from "./raster.mjs";
import { run, ffmpeg, ffprobe, base, doctor } from "./process.mjs";
async function empty(out) {
  try {
    const s = await lstat(out);
    if (!s.isDirectory() || s.isSymbolicLink() || (await readdir(out)).length)
      throw Error("Output collision: target must be new or empty");
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
async function unchanged(plan, file) {
  if (sha(await boundedFile(file, 65536)) !== plan.digest)
    throw Error("Manifest changed during operation");
  for (const s of plan.slides)
    if (sha(await boundedFile(s.path, 8 * 1024 * 1024)) !== s.source.sha256)
      throw Error("Source changed during operation: " + s.id);
}
// Local 8x8 errors avoid averaging a changed digit away across the entire frame.
export function distance(a, b, w = 640, h = 360) {
  let sum = 0,
    caption = 0,
    evidence = 0;
  for (let y = 0; y < h; y += 8)
    for (let x = 0; x < w; x += 8) {
      let block = 0,
        n = 0;
      for (let yy = y; yy < Math.min(y + 8, h); yy++)
        for (let xx = x; xx < Math.min(x + 8, w); xx++) {
          for (let channel = 0; channel < 3; channel++) {
            block += Math.abs(a[(yy * w + xx) * 3 + channel] - b[(yy * w + xx) * 3 + channel]);
            n++;
          }
        }
      sum += block;
      if (y >= 296) caption = Math.max(caption, block / n);
      else evidence = Math.max(evidence, block / n);
    }
  return { mean: sum / (w * h * 3), caption, evidence };
}
function matches(d) {
  return d.mean <= 3 && d.caption <= 8 && d.evidence <= 16;
}
function blend(a, b, alpha) {
  const c = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < c.length; i++) c[i] = Math.round(a[i] * (1 - alpha) + b[i] * alpha);
  return c;
}
async function decodeVerify(plan, movie, signal) {
  const meta = JSON.parse(
    (
      await run(
        ffprobe(),
        [
          "-v",
          "error",
          "-show_streams",
          "-show_entries",
          "stream=codec_type,codec_name,width,height,avg_frame_rate",
          "-of",
          "json",
          "-protocol_whitelist",
          "file,pipe",
          "-f",
          "mov",
          movie,
        ],
        { signal, max: 3 * 1024 * 1024 },
      )
    ).toString(),
  );
  if (
    meta.streams.length !== 1 ||
    meta.streams[0].codec_type !== "video" ||
    meta.streams[0].codec_name !== "h264" ||
    meta.streams[0].width !== 640 ||
    meta.streams[0].height !== 360 ||
    meta.streams[0].avg_frame_rate !== "12/1"
  )
    throw Error("Expected silent 640x360 H264 at 12fps");
  const { frames } = JSON.parse(
    (
      await run(
        ffprobe(),
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-f",
          "mov",
          "-show_frames",
          "-show_entries",
          "frame=best_effort_timestamp_time",
          "-of",
          "json",
          movie,
        ],
        { signal, max: 3 * 1024 * 1024 },
      )
    ).toString(),
  );
  if (frames.length !== plan.totalFrames)
    throw Error(
      "Frame count/hold duration mismatch: " + frames.length + " expected " + plan.totalFrames,
    );
  frames.forEach((f, i) => {
    const timestamp = Number(f.best_effort_timestamp_time);
    if (!Number.isFinite(timestamp) || Math.abs(timestamp - i / 12) > 0.0001)
      throw Error("Nonuniform video frame timestamps");
  });
  const expected = [];
  for (const s of plan.slides) expected.push(await pixels(await raster(s, signal), signal));
  const holds = plan.slides.map((s) => ({
    id: s.id,
    matchedFrames: 0,
    requiredFrames: s.holdFrames,
    worst: { mean: 0, caption: 0, evidence: 0 },
  }));
  const motion = plan.slides.length === 1 ? [0, 0] : plan.slides.slice(1).map(() => 0);
  let tail = Buffer.alloc(0),
    index = 0;
  await run(
    ffmpeg(),
    [
      ...base,
      "-xerror",
      "-protocol_whitelist",
      "file,pipe",
      "-f",
      "mov",
      "-i",
      movie,
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    {
      signal,
      timeout: 120000,
      onData: (chunk) => {
        tail = Buffer.concat([tail, chunk]);
        const size = 640 * 360 * 3;
        while (tail.length >= size) {
          const frame = tail.subarray(0, size);
          tail = tail.subarray(size);
          if (index >= plan.totalFrames) throw Error("Unexpected extra decoded frames");
          const i = plan.slides.findIndex(
            (s) => index >= s.startFrame && index < s.startFrame + s.holdFrames,
          );
          if (i >= 0) {
            const d = distance(frame, expected[i]);
            if (!matches(d))
              throw Error(
                "Slide " +
                  plan.slides[i].id +
                  " mismatched at frame " +
                  index +
                  " " +
                  JSON.stringify(d),
              );
            holds[i].matchedFrames++;
            for (const k in d) holds[i].worst[k] = Math.max(holds[i].worst[k], d[k]);
          } else if (plan.slides.length === 1) {
            const fadeIn = index < plan.transition;
            const alpha = fadeIn
              ? index / plan.transition
              : 1 -
                (index - plan.slides[0].startFrame - plan.slides[0].holdFrames) / plan.transition;
            const black = Buffer.alloc(frame.length);
            const d = distance(frame, blend(black, expected[0], alpha));
            if (!matches(d))
              throw Error("Fade pixels mismatch at frame " + index + " " + JSON.stringify(d));
            if (!matches(distance(frame, expected[0])) && distance(frame, black).mean > 3)
              motion[fadeIn ? 0 : 1]++;
          } else {
            const next = plan.slides.findIndex((s) => s.startFrame > index);
            if (next > 0) {
              const alpha =
                (index - (plan.slides[next].startFrame - plan.transition)) / plan.transition;
              const d = distance(frame, blend(expected[next - 1], expected[next], alpha));
              if (!matches(d))
                throw Error(
                  "Transition pixels mismatch at frame " + index + " " + JSON.stringify(d),
                );
              const a = distance(frame, expected[next - 1]),
                b = distance(frame, expected[next]);
              if (!matches(a) && !matches(b)) motion[next - 1]++;
            }
          }
          index++;
        }
      },
    },
  );
  if (tail.length || index !== plan.totalFrames) throw Error("Incomplete actual video decode");
  for (let i = 0; i < motion.length; i++)
    if (!motion[i]) throw Error("Transition has no decoded intervening motion: " + i);
  return {
    decodedFrames: index,
    holds,
    transitionInterveningFrames: motion,
    thresholds: { mean: 3, captionBlock: 8, evidenceBlock: 16 },
    limitations: [
      "Pixel tolerances are lossy bounds, not semantic OCR or proof that source claims are true.",
      "Agent must inspect story, provenance and every chat-size frame.",
    ],
  };
}
export async function verify(file, out, signal) {
  const plan = await loadManifest(file),
    report = JSON.parse(await boundedFile(join(out, "report.json"), 65536));
  if (report.manifestSha256 !== plan.digest)
    throw Error("Manifest/source association differs from render custody");
  const result = await decodeVerify(plan, join(out, "video.mp4"), signal);
  await unchanged(plan, file);
  return result;
}
export async function render(file, target, signal) {
  await doctor(signal);
  const plan = await loadManifest(file),
    out = resolve(target),
    parent = dirname(out);
  await empty(out);
  const disk = await statfs(parent);
  const workingBudget = 512 * 1024 * 1024;
  const conservativeMovie = (plan.totalFrames / plan.fps) * 8 * 1024 * 1024;
  if (disk.bavail * disk.bsize < workingBudget + conservativeMovie || freemem() < workingBudget)
    throw Error("Insufficient current disk/RAM for bounded video work");
  const lock = out + ".ketchup-lock";
  let handle;
  try {
    handle = await open(lock, "wx");
  } catch (e) {
    if (e.code === "EEXIST")
      throw Error(
        "Output is reserved by an existing operation; inspect " +
          lock +
          " before recovering a crashed owner",
      );
    throw e;
  }
  let stage;
  try {
    await empty(out);
    stage = await mkdtemp(join(parent, ".ketchup-"));
    await handle.writeFile(JSON.stringify({ pid: process.pid, stage, out }) + "\n");
    const frames = [];
    for (let i = 0; i < plan.slides.length; i++) {
      signal?.throwIfAborted();
      const p = join(stage, "slide-" + i + ".png");
      await writeFile(p, await raster(plan.slides[i], signal), { flag: "wx" });
      frames.push(p);
    }
    const args = [...base];
    const filters = [];
    for (let i = 0; i < frames.length; i++) {
      const extra =
        frames.length === 1
          ? 2 * plan.transition
          : (i > 0 ? plan.transition : 0) + (i < frames.length - 1 ? plan.transition : 0);
      args.push(
        "-loop",
        "1",
        "-framerate",
        "12",
        "-t",
        String((plan.slides[i].holdFrames + extra) / 12),
        "-i",
        frames[i],
      );
      filters.push("[" + i + ":v]format=yuv444p,settb=1/12,setpts=PTS-STARTPTS[v" + i + "]");
    }
    let last = "v0";
    for (let i = 1; i < frames.length; i++) {
      const next = "x" + i;
      filters.push(
        "[" +
          last +
          "][v" +
          i +
          "]xfade=transition=fade:duration=0.5:offset=" +
          (plan.slides[i].startFrame - plan.transition) / 12 +
          "[" +
          next +
          "]",
      );
      last = next;
    }
    if (frames.length === 1) {
      filters.push(
        "[v0]fade=t=in:st=0:d=0.5,fade=t=out:st=" +
          (plan.slides[0].startFrame + plan.slides[0].holdFrames) / 12 +
          ":d=0.5[single]",
      );
      last = "single";
    }
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[" + last + "]",
      "-an",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-frames:v",
      String(plan.totalFrames),
      "-r",
      "12",
      "-map_metadata",
      "-1",
      "-fflags",
      "+bitexact",
      "-flags:v",
      "+bitexact",
      "-movflags",
      "+faststart",
      join(stage, "video.mp4"),
    );
    await run(ffmpeg(), args, { signal });
    const proof = await decodeVerify(plan, join(stage, "video.mp4"), signal);
    await mkdir(join(stage, "frames"));
    for (let i = 0; i < frames.length; i++) {
      const frame = plan.slides[i].startFrame + Math.floor(plan.slides[i].holdFrames / 2);
      await run(
        ffmpeg(),
        [
          ...base,
          "-i",
          join(stage, "video.mp4"),
          "-vf",
          "select=eq(n\\," + frame + ")",
          "-frames:v",
          "1",
          join(stage, "frames", plan.slides[i].id + ".png"),
        ],
        { signal },
      );
    }
    await unchanged(plan, file);
    signal?.throwIfAborted();
    const report = {
      version: 1,
      manifestSha256: plan.digest,
      videoSha256: sha(await readFile(join(stage, "video.mp4"))),
      slides: plan.slides.map((s) => ({
        id: s.id,
        source: s.source,
        caption: s.caption,
        newLabels: s.newLabels,
        addedWords: s.addedWords,
        startFrame: s.startFrame,
        holdFrames: s.holdFrames,
      })),
      proof,
    };
    await writeFile(join(stage, "report.json"), JSON.stringify(report, null, 2) + "\n");
    for (const p of frames) await rm(p);
    if (await empty(out)) {
      signal?.throwIfAborted();
      await rmdir(out);
    }
    signal?.throwIfAborted();
    await rename(stage, out);
    stage = undefined;
    return { out, ...report };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await handle.close();
    await rm(lock);
  }
}
