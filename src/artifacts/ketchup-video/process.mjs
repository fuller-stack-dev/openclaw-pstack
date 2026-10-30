import { spawn } from "node:child_process";
export async function run(
  bin,
  args,
  { signal, input, onData, max = 2 * 1024 * 1024, timeout = 120000 } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let err = "",
      chunks = [],
      size = 0,
      failure;
    let escalation;
    const kill = (sig) => {
      try {
        if (process.platform === "win32") child.kill(sig);
        else if (child.pid) process.kill(-child.pid, sig);
      } catch (e) {
        if (e.code !== "ESRCH") failure ??= e;
      }
    };
    const stop = (e) => {
      failure ??= e;
      kill("SIGTERM");
      escalation ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () => stop(Error("Cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(Error("Process timed out: " + bin)), timeout);
    child.on("error", (e) => {
      failure = e;
    });
    child.stdout.on("data", (b) => {
      try {
        if (onData) onData(b);
        else {
          size += b.length;
          if (size > max) throw Error("Process output bound exceeded");
          chunks.push(b);
        }
      } catch (e) {
        stop(e);
      }
    });
    child.stderr.on("data", (b) => {
      err = (err + b.toString()).slice(-8192);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(Error(bin + " failed (" + (code ?? sig) + "): " + err.trim()));
      else resolve(Buffer.concat(chunks));
    });
  });
}
export const ffmpeg = () => process.env.PSTACK_FFMPEG || "ffmpeg";
export const ffprobe = () => process.env.PSTACK_FFPROBE || "ffprobe";
export const base = [
  "-hide_banner",
  "-loglevel",
  "error",
  "-nostdin",
  "-threads",
  "1",
  "-filter_threads",
  "1",
  "-filter_complex_threads",
  "1",
];
export async function doctor(signal) {
  const capabilities = [];
  for (const x of ["-version", "-filters", "-decoders", "-encoders"])
    capabilities.push(await run(ffmpeg(), ["-hide_banner", x], { signal }));
  const [version, filters, decoders, encoders] = capabilities;
  for (const f of ["xfade", "scale", "format", "fade"])
    if (!new RegExp("\\b" + f + "\\b").test(filters)) throw Error("Missing FFmpeg filter: " + f);
  if (!/\bpng\b/.test(decoders)) throw Error("Missing FFmpeg PNG decoder");
  if (!/\blibx264\b/.test(encoders)) throw Error("Missing FFmpeg libx264 encoder");
  await run(ffprobe(), ["-version"], { signal });
  return {
    ffmpeg: version.toString().split("\n")[0],
    platform: process.platform,
    fonts: "Noto Sans + Noto Sans Math; unsupported glyphs rejected",
    geometry: "640x360 @ 12fps, 64px caption strip",
    authority: "ordinary agent exec; no gateway execution",
  };
}
