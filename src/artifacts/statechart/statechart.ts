#!/usr/bin/env node
// Native adapter of cursor/plugins c742dd61 statechart.ts; MIT (c) 2026 Lauren Tan.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findTlc, fetchToolchain } from "./toolchain.ts";
const usage =
  "statechart doctor | toolchain fetch | check SPEC.tla [--config FILE --view FILE --out DIR --timeout-ms N --max-edges N] | render CHECK-DIR --out DIR";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
function number(s: string | undefined, fallback: number, max: number) {
  const n = s === undefined ? fallback : Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new Error("Invalid positive bound: " + s);
  return n;
}
function regular(file: string, limit: number) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > limit)
    throw new Error(
      "Source/view bound: expected regular file <= " +
        limit +
        " bytes: " +
        file,
    );
}
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      view: { type: "string" },
      out: { type: "string" },
      "timeout-ms": { type: "string" },
      "max-edges": { type: "string" },
    },
  });
  const [command, input, ...extra] = positionals;
  if (command === "doctor" && positionals.length === 1) {
    console.log(JSON.stringify(await findTlc(), null, 2));
    return 0;
  }
  if (command === "toolchain" && input === "fetch" && !extra.length) {
    console.log(await fetchToolchain());
    return 0;
  }
  if (!["check", "render"].includes(command) || !input || extra.length)
    throw new Error(usage);
  const timeout = number(values["timeout-ms"], 60000, 3600000),
    maxEdges = number(values["max-edges"], 10000, 10000);
  const spec = path.resolve(input),
    config = path.resolve(values.config ?? input.replace(/\.tla$/, ".cfg"));
  if (command === "check") {
    if (!spec.endsWith(".tla")) throw new Error("Expected SPEC.tla");
    regular(spec, 1_000_000);
    regular(config, 1_000_000);
    if (values.view) regular(values.view, 1_000_000);
  } else regular(path.join(spec, "chart.json"), 8_000_000);
  const dest = path.resolve(
    values.out ??
      input.replace(/\.tla$/, "") + (command === "check" ? "-chart" : "-svg"),
  );
  const previous = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (
    previous &&
    (previous.isSymbolicLink() ||
      !previous.isDirectory() ||
      fs.readdirSync(dest).length)
  )
    throw new Error("Output must be new or empty, not a link: " + dest);
  let base = path.dirname(dest);
  while (!fs.existsSync(base)) base = path.dirname(base);
  const stage = fs.mkdtempSync(path.join(base, ".statechart-")),
    tmp = path.join(stage, "tmp");
  fs.mkdirSync(tmp);
  // Cooperative CLI contenders reserve one destination; arbitrary user view code is not sandboxed.
  const lock = path.join(
    base,
    ".statechart-output-" +
      (await import("node:crypto"))
        .createHash("sha256")
        .update(dest)
        .digest("hex"),
  );
  let lockFd: number;
  try {
    lockFd = fs.openSync(lock, "wx");
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error("Output already reserved; refuse collision: " + dest, {
      cause: error,
    });
  }
  fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, dest, stage }));
  const lockIdentity = fs.fstatSync(lockFd);
  fs.closeSync(lockFd);
  let killed = false;
  let worker: ReturnType<typeof spawn> | undefined;
  let stop: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  const kill = () => {
    if (worker?.pid && !killed) {
      killed = true;
      try {
        process.kill(-worker.pid, "SIGKILL");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    }
  };
  const onInt = () => {
      stop ??= "SIGINT";
      kill();
    },
    onTerm = () => {
      stop ??= "SIGTERM";
      kill();
    };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    worker = spawn(
      process.execPath,
      [
        path.join(import.meta.dirname, "statechart-worker.mjs"),
        command,
        stage,
        spec,
        config,
        values.view ? path.resolve(values.view) : "",
        String(maxEdges),
      ],
      {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      },
    );
    const result = new Promise<number>((resolve, reject) => {
      worker!.once("error", reject);
      worker!.once("exit", (code) => resolve(code ?? 2));
    });
    timer = setTimeout(() => {
      stop ??= "timeout";
      kill();
    }, timeout);
    const code = await result;
    clearTimeout(timer);
    kill();
    if (stop) {
      console.error(
        stop +
          " stopped the check; verdict unknown, rules not checked; no output published.",
      );
      return stop === "SIGINT" ? 130 : stop === "SIGTERM" ? 143 : 2;
    }
    const done = path.join(stage, "done");
    if (![0, 1].includes(code) || !fs.existsSync(done)) return 2;
    const now = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (
      now &&
      (now.isSymbolicLink() ||
        !now.isDirectory() ||
        fs.readdirSync(dest).length ||
        !previous ||
        now.ino !== previous.ino ||
        now.dev !== previous.dev)
    )
      throw new Error("Output collision while check ran; nothing published");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(done, dest);
    if (command === "check")
      process.stdout.write(fs.readFileSync(path.join(dest, "report.md")));
    console.log("\nWrote " + dest);
    return code;
  } finally {
    if (timer) clearTimeout(timer);
    kill();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    fs.rmSync(stage, { recursive: true, force: true });
    const ownLock = fs.lstatSync(lock, { throwIfNoEntry: false });
    if (
      ownLock &&
      ownLock.ino === lockIdentity.ino &&
      ownLock.dev === lockIdentity.dev
    )
      fs.unlinkSync(lock);
  }
}
try {
  process.exitCode = await main();
} catch (e) {
  console.error(message(e));
  process.exitCode = 2;
}
