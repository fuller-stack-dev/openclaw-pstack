import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  copyFile,
  chmod,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
const cli = resolve(process.env.PSTACK_VIDEO_CLI || "dist/ketchup-video.mjs");
const hash = (b) => createHash("sha256").update(b).digest("hex");
function crc(b) {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type),
    n = Buffer.alloc(4),
    c = Buffer.alloc(4);
  n.writeUInt32BE(data.length);
  c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([n, t, data, c]);
}
function png(which, w = 320, h = 148) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * (w * 3 + 1) + 1 + x * 3;
      const box = x > 30 + which * 70 && x < 90 + which * 70 && y > 30 && y < 110;
      raw[p] = box ? 240 : 30;
      raw[p + 1] = box ? 180 : 50;
      raw[p + 2] = box ? 50 : 70;
    }
  const pixel = (x, y, rgb) => {
    const p = y * (w * 3 + 1) + 1 + x * 3;
    for (let c = 0; c < 3; c++) raw[p + c] = rgb[c];
  };
  if (which === 0 && w === 320) {
    const glyph = {
      s: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
      t: ["00100", "00100", "11111", "00100", "00100", "00100", "00011"],
      a: ["00000", "01110", "00001", "01111", "10001", "10001", "01111"],
      r: ["00000", "10110", "11001", "10000", "10000", "10000", "10000"],
      p: ["00000", "11110", "10001", "11110", "10000", "10000", "10000"],
      o: ["00000", "01110", "10001", "10001", "10001", "10001", "01110"],
      i: ["00100", "00000", "01100", "00100", "00100", "00100", "01110"],
      n: ["00000", "11110", "10001", "10001", "10001", "10001", "10001"],
    };
    Array.from("start position").forEach((c, i) => {
      for (let y = 0; y < 7; y++)
        for (let x = 0; x < 5; x++)
          if (glyph[c]?.[y][x] === "1")
            for (let yy = 0; yy < 2; yy++)
              for (let xx = 0; xx < 2; xx++)
                pixel(30 + i * 12 + x * 2 + xx, 120 + y * 2 + yy, [240, 240, 240]);
    });
  }
  if (which === 9)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if ((x < 12 || x >= w - 12) && (y < 12 || y >= h - 12))
          pixel(
            x,
            y,
            y < 12
              ? x < 12
                ? [240, 20, 20]
                : [20, 240, 20]
              : x < 12
                ? [20, 20, 240]
                : [240, 240, 20],
          );
  const hdr = Buffer.alloc(13);
  hdr.writeUInt32BE(w);
  hdr.writeUInt32BE(h, 4);
  hdr[8] = 8;
  hdr[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", hdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function command(bin, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    p.stdout.on("data", (b) => (stdout += b));
    p.stderr.on("data", (b) => (stderr += b));
    p.once("error", reject);
    p.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const call = (args, env) => command(process.execPath, [cli, ...args], env);
const ok = (r) => {
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const bad = (r, re) => {
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, re);
  assert.equal(r.stderr.trim().split("\n").length, 1);
};
test("standalone CLI: real raster, encoding, decoded hold/caption and failure boundaries", async (t) => {
  const dir = await mkdtemp(resolve(".video-test-"));
  const manifest = join(dir, "manifest.json"),
    out = join(dir, "good");
  const slides = [];
  for (let i = 0; i < 3; i++) {
    const b = png(i),
      p = join(dir, i + ".png");
    await writeFile(p, b);
    slides.push({
      id: "s" + i,
      source: { type: "data", path: p, sha256: hash(b), ref: "synthetic-test-data:position=" + i },
      caption:
        i === 0
          ? "Café → Δ & <safe> PR17"
          : i === 1
            ? "The same evidence moves to the next position"
            : "Every original edge remains visible",
      newLabels: i === 0 ? ["start position"] : [],
    });
  }
  const m = {
    version: 1,
    window: {
      lastUserMessageId: "fixture-user-before-invocation",
      invocationId: "fixture-ketchup",
    },
    slides,
  };
  const save = async (value) => writeFile(manifest, JSON.stringify(value));
  await save(m);
  let report;
  try {
    await t.test("capacity admission uses process-available RAM and keeps resource bounds", async (t) => {
      const budget = 512 * 1024 * 1024;
      // Independent one-word slide: 12 hold frames plus two 6-frame fades.
      const capacityManifest = join(dir, "capacity.json");
      await writeFile(capacityManifest, JSON.stringify({
        ...m, slides: [{ ...slides[0], caption: "Capacity", newLabels: [] }],
      }));
      const requiredDiskBytes = budget + 2 * 8 * 1024 * 1024;
      const measured = (target, disk, freeRam, availableRam) => {
        // Only OS/process measurements are replaced; real guard, raster and encoder run.
        // Throw on resampling to bind refusal telemetry to the admission sample.
        const preload = `import fs from "node:fs/promises"; import os from "node:os";
          import {syncBuiltinESMExports} from "node:module";
          let disks = 0, frees = 0, available = 0;
          fs.statfs = async () => { if (++disks > 1) throw Error("disk resampled");
            return {bavail: ${disk}, bsize: 1}; };
          os.freemem = () => { if (++frees > 1) throw Error("free RAM resampled");
            return ${freeRam}; };
          process.availableMemory = () => { if (++available > 1) throw Error("available RAM resampled");
            return ${availableRam}; };
          syncBuiltinESMExports();`;
        return command(process.execPath, [
          "--import", "data:text/javascript," + encodeURIComponent(preload),
          cli, "render", capacityManifest, target,
        ]);
      };
      for (const [name, disk, availableRam] of [
        ["low disk", requiredDiskBytes - 1, budget * 6],
        ["low process RAM despite high system free", requiredDiskBytes, budget - 1],
        ["zero process RAM", requiredDiskBytes, 0],
        ["negative process RAM", requiredDiskBytes, -1],
        ["NaN process RAM", requiredDiskBytes, NaN],
        ["infinite process RAM", requiredDiskBytes, Infinity],
      ]) await t.test(name, async () => {
        const target = join(dir, "capacity-refused");
        try {
          const r = await measured(target, disk, budget * 8, availableRam);
          bad(r, /Insufficient current disk\/RAM for bounded video work: /);
          const metrics = JSON.parse(r.stderr.slice(r.stderr.indexOf("{")));
          assert.equal(metrics.availableDiskBytes, disk);
          assert.equal(metrics.requiredDiskBytes, requiredDiskBytes);
          assert.equal(metrics.freeRamBytes, budget * 8);
          assert.equal(metrics.processAvailableMemoryBytes, Number.isFinite(availableRam) ? availableRam : null);
          assert.equal(metrics.requiredRamBytes, budget);
          assert.equal(metrics.platform, process.platform);
          assert.ok(Number.isFinite(metrics.totalRamBytes) && metrics.totalRamBytes > 0);
          assert.ok(!(await readdir(dir)).some((name) =>
            name === "capacity-refused" || name.startsWith(".ketchup-") || name.endsWith(".ketchup-lock")));
        } finally { await rm(target, { recursive: true, force: true }); }
      });
      for (const availableRam of [budget * 6, budget])
        await t.test("low system free renders with process RAM " + availableRam, async () => {
          const target = join(dir, "capacity-ready");
          try {
            const result = ok(await measured(target, requiredDiskBytes, 256 * 1024 * 1024, availableRam));
            const proof = ok(await call(["verify", capacityManifest, target]));
            assert.equal(proof.decodedFrames, 24);
            assert.equal(proof.holds[0].requiredFrames, 12);
            assert.equal(proof.holds[0].matchedFrames, 12);
            assert.ok(proof.transitionInterveningFrames.every((n) => n > 0));
            assert.deepEqual(proof.thresholds, { mean: 3, captionBlock: 8, evidenceBlock: 16 });
            assert.deepEqual(proof, result.proof);
          } finally { await rm(target, { recursive: true, force: true }); }
        });
    });
    await t.test("doctor reports actual qualified processes", async () => {
      assert.match(ok(await call(["doctor"])).ffmpeg, /ffmpeg version/);
    });
    await t.test("three evolving sources render and independently decode", async () => {
      report = ok(await call(["render", manifest, out]));
      const proof = ok(await call(["verify", manifest, out]));
      assert.equal(proof.holds.length, 3);
      assert.equal(proof.holds[0].requiredFrames, 32);
      for (const h of proof.holds) assert.equal(h.matchedFrames, h.requiredFrames);
      assert.ok(proof.transitionInterveningFrames.every((n) => n >= 1));
      assert.equal((await readdir(join(out, "frames"))).length, 3);
      console.log("CALIBRATION " + JSON.stringify({ videoSha256: report.videoSha256, ...proof }));
    });
    await t.test("one factual slide keeps its full hold between actual fades", async () => {
      const single = structuredClone(m);
      single.slides = single.slides.slice(0, 1);
      await save(single);
      const target = join(dir, "single");
      const r = ok(await call(["render", manifest, target]));
      assert.equal(r.proof.holds[0].matchedFrames, 32);
      assert.equal(r.proof.decodedFrames, 44);
      assert.ok(r.proof.transitionInterveningFrames.every((n) => n > 0));
      await save(m);
      await rm(target, { recursive: true });
    });
    await t.test("two factual slides preserve rounded holds", async () => {
      const two = structuredClone(m);
      two.slides = two.slides.slice(0, 2);
      await save(two);
      const target = join(dir, "two");
      const r = ok(await call(["render", manifest, target]));
      assert.equal(r.proof.holds.length, 2);
      assert.equal(r.proof.decodedFrames, 70);
      await save(m);
      await rm(target, { recursive: true });
    });
    await t.test("portrait data retains all four source corners with letterboxing", async () => {
      const b = png(9, 100, 200),
        source = join(dir, "portrait.png");
      await writeFile(source, b);
      const m2 = structuredClone(m);
      m2.slides = [
        {
          id: "portrait",
          source: {
            type: "data",
            path: source,
            sha256: hash(b),
            ref: "synthetic-four-corner-boundary",
          },
          caption: "All four corners remain in frame",
          newLabels: [],
        },
      ];
      await save(m2);
      const target = join(dir, "portrait");
      ok(await call(["render", manifest, target]));
      const decoded = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          join(target, "frames", "portrait.png"),
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { maxBuffer: 1000000 },
      );
      assert.equal(decoded.status, 0, decoded.stderr.toString());
      for (const [x, y, rgb] of [
        [253, 7, [240, 20, 20]],
        [386, 7, [20, 240, 20]],
        [253, 288, [20, 20, 240]],
        [386, 288, [240, 240, 20]],
        [20, 140, [21, 26, 34]],
      ])
        for (let c = 0; c < 3; c++)
          assert.ok(
            Math.abs(decoded.stdout[(y * 640 + x) * 3 + c] - rgb[c]) < 12,
            "corner/letterbox pixel " + x + "," + y,
          );
      await save(m);
      await rm(target, { recursive: true });
    });
    await t.test("byte deterministic repeated render", async () => {
      const other = join(dir, "repeat");
      const r = ok(await call(["render", manifest, other]));
      assert.equal(r.videoSha256, report.videoSha256);
      await rm(other, { recursive: true });
    });
    await t.test("existing sentinel and ready output are preserved", async () => {
      const target = join(dir, "sentinel");
      await mkdir(target);
      await writeFile(join(target, "keep"), "untouched");
      bad(await call(["render", manifest, target]), /collision/);
      assert.equal(await readFile(join(target, "keep"), "utf8"), "untouched");
      bad(await call(["render", manifest, out]), /collision/);
    });
    await t.test("concurrent producers cannot replace the winning output", async () => {
      const target = join(dir, "race");
      const results = await Promise.all([
        call(["render", manifest, target]),
        call(["render", manifest, target]),
      ]);
      assert.deepEqual(results.map((r) => r.code).sort(), [0, 2]);
      bad(
        results.find((r) => r.code === 2),
        /reserved|collision/,
      );
      ok(await call(["verify", manifest, target]));
      await rm(target, { recursive: true });
    });
    await t.test("source changed after snapshot cannot publish ready output", async () => {
      const source = slides[0].source.path,
        original = await readFile(source),
        target = join(dir, "drift");
      const pending = call(["render", manifest, target]);
      let observed = false;
      for (let i = 0; i < 300; i++) {
        if ((await readdir(dir)).some((n) => n.startsWith(".ketchup-"))) {
          observed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      try {
        assert.ok(observed, "operation reached owned staging");
        await writeFile(source, Buffer.concat([original, Buffer.from("raced")]));
        bad(await pending, /changed during operation/);
        assert.ok(!(await readdir(dir)).includes("drift"));
      } finally {
        await writeFile(source, original);
        await pending;
      }
    });
    await t.test("manifest bounds, source enum, glyphs and actual caption geometry", async () => {
      for (const [change, re] of [
        [(x) => (x.slides = Array.from({ length: 11 }, () => slides[0])), /1 through 10/],
        [(x) => (x.slides[0].source.type = "generated"), /screenshot\/diff\/data/],
        [(x) => (x.slides[0].caption = "日本語 😀"), /Unsupported glyphs/],
        [(x) => (x.slides[0].caption = "wide ".repeat(50)), /overflow/],
        [(x) => (x.font = "system"), /manifest fields/],
      ]) {
        const x = structuredClone(m);
        change(x);
        await save(x);
        bad(await call(["render", manifest, join(dir, "bad")]), re);
      }
      await save(m);
    });
    await t.test("changed input and source association refuse", async () => {
      const source = slides[0].source.path,
        b = await readFile(source);
      await writeFile(source, Buffer.concat([b, Buffer.from("changed")]));
      bad(await call(["verify", manifest, out]), /digest changed/);
      await writeFile(source, b);
      const x = structuredClone(m);
      [x.slides[0].source, x.slides[1].source] = [x.slides[1].source, x.slides[0].source];
      await save(x);
      bad(await call(["verify", manifest, out]), /association/);
      await save(m);
    });
    await t.test("invalid, oversized and corrupt actual PNG reject", async () => {
      for (const mode of ["invalid", "dimension", "corrupt"]) {
        let b = png(0);
        if (mode === "invalid") b = Buffer.from("not PNG");
        if (mode === "dimension") b.writeUInt32BE(999999, 16);
        if (mode === "corrupt") b = b.subarray(0, 40);
        const p = join(dir, "broken.png");
        await writeFile(p, b);
        const x = structuredClone(m);
        x.slides[0].source = { ...x.slides[0].source, path: p, sha256: hash(b) };
        await save(x);
        bad(
          await call(["render", manifest, join(dir, "bad")]),
          mode === "dimension" ? /dimension/ : mode === "invalid" ? /PNG/ : /failed/,
        );
      }
      await save(m);
    });
    await t.test("byte limits and nonlocal source paths refuse before rendering", async () => {
      const huge = join(dir, "huge.png");
      await writeFile(huge, Buffer.alloc(8 * 1024 * 1024 + 1));
      const x = structuredClone(m);
      x.slides[0].source.path = huge;
      await save(x);
      bad(await call(["render", manifest, join(dir, "bad")]), /byte bound/);
      await rm(huge);
      await writeFile(manifest, " ".repeat(65537));
      bad(await call(["render", manifest, join(dir, "bad")]), /byte bound/);
      x.slides[0].source.path = "https://invalid.example/evidence.png";
      await save(x);
      bad(await call(["render", manifest, join(dir, "bad")]), /local PNG/);
      await save(m);
    });
    await t.test("missing ffmpeg reports truthful one-line failure", async () => {
      bad(
        await call(["render", manifest, join(dir, "bad")], {
          PSTACK_FFMPEG: join(dir, "does-not-exist"),
        }),
        /ENOENT/,
      );
    });
    await t.test(
      "missing filter and encoder fault clean owned staging after real tool execution",
      async () => {
        const actual = (await command("which", ["ffmpeg"])).stdout.trim();
        for (const mode of ["filter", "fault"]) {
          const wrapper = join(dir, "ffmpeg-" + mode + ".mjs");
          const code =
            "#!" +
            process.execPath +
            '\nimport {spawnSync} from "node:child_process";import {readFileSync} from "node:fs";const a=process.argv.slice(2);const r=spawnSync(' +
            JSON.stringify(actual) +
            ",a,{input:readFileSync(0),maxBuffer:16000000});if(" +
            JSON.stringify(mode) +
            '==="filter"&&a.includes("-filters")){process.stdout.write(r.stdout.toString().split("\\n").filter(x=>!x.includes("xfade")).join("\\n"));process.exit(r.status);}if(' +
            JSON.stringify(mode) +
            '==="fault"&&a.includes("-filter_complex")){process.stderr.write("injected encoder failure after real ffmpeg execution");process.exit(7);}process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");process.exit(r.status??2);';
          await writeFile(wrapper, code);
          await chmod(wrapper, 0o700);
          bad(
            await call(["render", manifest, join(dir, "fault-out")], { PSTACK_FFMPEG: wrapper }),
            mode === "filter" ? /Missing FFmpeg filter: xfade/ : /injected encoder failure/,
          );
          assert.ok(
            !(await readdir(dir)).some(
              (n) => n.startsWith(".ketchup-") || n.endsWith(".ketchup-lock") || n === "fault-out",
            ),
          );
        }
      },
    );
    await t.test("actual MP4 shortened hold, missing caption and wrong still reject", async () => {
      for (const kind of ["short", "short-preserved", "caption", "still", "color"]) {
        const target = join(dir, kind);
        await mkdir(target);
        await copyFile(join(out, "report.json"), join(target, "report.json"));
        const args = ["-hide_banner", "-loglevel", "error"];
        if (kind === "still")
          args.push(
            "-loop",
            "1",
            "-framerate",
            "12",
            "-i",
            join(out, "frames", "s0.png"),
            "-frames:v",
            String(report.proof.decodedFrames),
          );
        else {
          args.push("-i", join(out, "video.mp4"));
          if (kind === "short") args.push("-frames:v", String(report.proof.decodedFrames - 4));
          else if (kind === "short-preserved")
            args.push(
              "-vf",
              "select=not(between(n\\,28\\,31)),setpts=N/(12*TB),tpad=stop_mode=clone:stop_duration=0.333333333",
              "-frames:v",
              String(report.proof.decodedFrames),
            );
          else if (kind === "color") args.push("-vf", "hue=h=90");
          else args.push("-vf", "drawbox=x=0:y=296:w=640:h=64:color=0x111827:t=fill");
        }
        args.push(
          "-an",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          join(target, "video.mp4"),
        );
        const r = await command("ffmpeg", args);
        assert.equal(r.code, 0, r.stderr);
        bad(
          await call(["verify", manifest, target]),
          kind === "short" ? /duration mismatch/ : /mismatched|pixels mismatch/,
        );
        await rm(target, { recursive: true });
      }
    });
    await t.test("subtle PR17 to PR18 mutation is rejected by actual pixels", async () => {
      const changed = structuredClone(m);
      changed.slides[0].caption = changed.slides[0].caption.replace("PR17", "PR18");
      await save(changed);
      const mutant = join(dir, "mutant");
      ok(await call(["render", manifest, mutant]));
      await save(m);
      await copyFile(join(out, "report.json"), join(mutant, "report.json"));
      const r = await call(["verify", manifest, mutant]);
      bad(r, /mismatched/);
      console.log("CAPTION_MUTATION " + r.stderr.trim());
      await rm(mutant, { recursive: true });
    });
    await t.test(
      "swapped ordered slides fail pixel verification even with expected custody",
      async () => {
        const swapped = structuredClone(m);
        [swapped.slides[0], swapped.slides[1]] = [swapped.slides[1], swapped.slides[0]];
        await save(swapped);
        const mutant = join(dir, "swap");
        ok(await call(["render", manifest, mutant]));
        await save(m);
        await copyFile(join(out, "report.json"), join(mutant, "report.json"));
        bad(await call(["verify", manifest, mutant]), /mismatched/);
        await rm(mutant, { recursive: true });
      },
    );
    await t.test(
      "cancel waits for owned FFmpeg group and preserves unrelated process",
      async () => {
        const actual = (await command("which", ["ffmpeg"])).stdout.trim(),
          pidFile = join(dir, "owned-pid");
        const wrapper = join(dir, "slow-ffmpeg.mjs");
        const code =
          "#!" +
          process.execPath +
          '\nimport {spawn} from "node:child_process";import {writeFileSync} from "node:fs";const a=process.argv.slice(2);const encoding=a.includes("-filter_complex");if(encoding)a.unshift("-re");const p=spawn(' +
          JSON.stringify(actual) +
          ',a,{stdio:["inherit","inherit","inherit"]});if(encoding)writeFileSync(' +
          JSON.stringify(pidFile) +
          ',String(p.pid));p.on("close",c=>process.exit(c??2));';
        await writeFile(wrapper, code);
        await chmod(wrapper, 0o700);
        const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
          stdio: "ignore",
        });
        const unrelatedDone = new Promise((r) => unrelated.on("close", r));
        const target = join(dir, "cancelled");
        const p = spawn(process.execPath, [cli, "render", manifest, target], {
          env: { ...process.env, PSTACK_FFMPEG: wrapper },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let err = "";
        p.stderr.on("data", (b) => (err += b));
        const done = new Promise((r) => p.on("close", (code, signal) => r({ code, signal })));
        let owned;
        try {
          for (let i = 0; i < 500; i++) {
            try {
              owned = Number(await readFile(pidFile, "utf8"));
              break;
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.ok(owned, "real encoder PID recorded");
          process.kill(owned, 0);
          p.kill("SIGTERM");
          const r = await done;
          assert.equal(r.code, 143, err);
          let alive = true;
          for (let i = 0; i < 100; i++) {
            try {
              process.kill(owned, 0);
            } catch (e) {
              assert.equal(e.code, "ESRCH");
              alive = false;
              break;
            }
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.equal(alive, false, "owned encoder terminated");
          process.kill(unrelated.pid, 0);
          assert.ok(
            !(await readdir(dir)).some(
              (n) => n.startsWith(".ketchup-") || n === "cancelled" || n.endsWith(".ketchup-lock"),
            ),
          );
        } finally {
          if (p.exitCode === null) p.kill("SIGTERM");
          await done;
          unrelated.kill("SIGTERM");
          await unrelatedDone;
        }
      },
    );
    if (process.env.PSTACK_KEEP_PROOF) {
      const target = resolve(process.env.PSTACK_KEEP_PROOF);
      await mkdir(target);
      for (const name of ["video.mp4", "report.json"])
        await copyFile(join(out, name), join(target, name));
      await mkdir(join(target, "frames"));
      for (const name of await readdir(join(out, "frames")))
        await copyFile(join(out, "frames", name), join(target, "frames", name));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
