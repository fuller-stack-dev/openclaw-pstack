#!/usr/bin/env node
/*! Native statechart port; notices: licenses/statechart-MIT.txt and licenses/pele.txt. */

// src/artifacts/statechart/statechart.ts
import { spawn } from "node:child_process";
import fs2 from "node:fs";
import path2 from "node:path";
import { parseArgs } from "node:util";

// src/artifacts/statechart/toolchain.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
var SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
var ASSET = "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar";
var cacheJar = () => path.join(os.homedir(), ".cache/pstack/tla2tools/1.7.4/tla2tools.jar");
function verifiedJar(file = process.env.TLA2TOOLS || cacheJar()) {
  file = fs.realpathSync(file);
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new Error("TLC jar must be a regular file of at most 16 MiB");
    const hash = createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
    if (hash !== SHA256)
      throw new Error(
        "TLA2TOOLS SHA256 mismatch; refusing to execute unverified jar"
      );
  } finally {
    fs.closeSync(fd);
  }
  return fs.realpathSync(file);
}
async function findTlc() {
  let jar;
  try {
    jar = verifiedJar();
  } catch (error) {
    throw new Error(
      String(error) + "; install nothing implicitly: run statechart toolchain fetch explicitly, or set TLA2TOOLS to the pinned jar"
    );
  }
  const java = process.env.JAVA || "java";
  const version = await new Promise(
    (resolve, reject) => execFile(
      java,
      ["-version"],
      { timeout: 5e3, maxBuffer: 65536 },
      (error, out, err) => error ? reject(error) : resolve(out + err)
    )
  );
  const major = Number(/version "(?:1\.)?(\d+)/.exec(version)?.[1]);
  if (!Number.isInteger(major) || major < 11)
    throw new Error("JAVA must report Java 11 or later");
  return {
    jar,
    java,
    javaVersion: version.trim(),
    release: "1.7.4",
    expectedTlcBanner: "TLC2 Version 2.19",
    sha256: SHA256
  };
}
async function fetchToolchain() {
  const dest = cacheJar();
  if (fs.existsSync(dest)) return verifiedJar(dest);
  const response = await fetch(ASSET, { signal: AbortSignal.timeout(6e4) });
  if (!response.ok || !response.body)
    throw new Error("Official TLC download failed: " + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 16 * 1024 * 1024) throw new Error("TLC download exceeds 16 MiB");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== SHA256)
    throw new Error("Official TLC asset SHA256 mismatch");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = fs.mkdtempSync(path.join(path.dirname(dest), ".fetch-"));
  try {
    const file = path.join(temp, "jar");
    fs.writeFileSync(file, bytes, { flag: "wx" });
    try {
      fs.linkSync(file, dest);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return verifiedJar(dest);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// src/artifacts/statechart/statechart.ts
var usage = "statechart doctor | toolchain fetch | check SPEC.tla [--config FILE --view FILE --out DIR --timeout-ms N --max-edges N] | render CHECK-DIR --out DIR";
var message = (e) => e instanceof Error ? e.message : String(e);
function number(s, fallback, max) {
  const n = s === void 0 ? fallback : Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new Error("Invalid positive bound: " + s);
  return n;
}
function regular(file, limit) {
  const stat = fs2.statSync(file);
  if (!stat.isFile() || stat.size > limit)
    throw new Error(
      "Source/view bound: expected regular file <= " + limit + " bytes: " + file
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
      "max-edges": { type: "string" }
    }
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
  const timeout = number(values["timeout-ms"], 6e4, 36e5), maxEdges = number(values["max-edges"], 1e4, 1e4);
  const spec = path2.resolve(input), config = path2.resolve(values.config ?? input.replace(/\.tla$/, ".cfg"));
  if (command === "check") {
    if (!spec.endsWith(".tla")) throw new Error("Expected SPEC.tla");
    regular(spec, 1e6);
    regular(config, 1e6);
    if (values.view) regular(values.view, 1e6);
  } else regular(path2.join(spec, "chart.json"), 8e6);
  const dest = path2.resolve(
    values.out ?? input.replace(/\.tla$/, "") + (command === "check" ? "-chart" : "-svg")
  );
  const previous = fs2.lstatSync(dest, { throwIfNoEntry: false });
  if (previous && (previous.isSymbolicLink() || !previous.isDirectory() || fs2.readdirSync(dest).length))
    throw new Error("Output must be new or empty, not a link: " + dest);
  let base = path2.dirname(dest);
  while (!fs2.existsSync(base)) base = path2.dirname(base);
  const stage = fs2.mkdtempSync(path2.join(base, ".statechart-")), tmp = path2.join(stage, "tmp");
  fs2.mkdirSync(tmp);
  const lock = path2.join(
    base,
    ".statechart-output-" + (await import("node:crypto")).createHash("sha256").update(dest).digest("hex")
  );
  let lockFd;
  try {
    lockFd = fs2.openSync(lock, "wx");
  } catch (error) {
    fs2.rmSync(stage, { recursive: true, force: true });
    throw new Error("Output already reserved; refuse collision: " + dest, {
      cause: error
    });
  }
  fs2.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, dest, stage }));
  const lockIdentity = fs2.fstatSync(lockFd);
  fs2.closeSync(lockFd);
  let killed = false;
  let worker;
  let stop;
  let timer;
  const kill = () => {
    if (worker?.pid && !killed) {
      killed = true;
      try {
        process.kill(-worker.pid, "SIGKILL");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    }
  };
  const onInt = () => {
    stop ??= "SIGINT";
    kill();
  }, onTerm = () => {
    stop ??= "SIGTERM";
    kill();
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    worker = spawn(
      process.execPath,
      [
        path2.join(import.meta.dirname, "statechart-worker.mjs"),
        command,
        stage,
        spec,
        config,
        values.view ? path2.resolve(values.view) : "",
        String(maxEdges)
      ],
      {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp }
      }
    );
    const result = new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code2) => resolve(code2 ?? 2));
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
        stop + " stopped the check; verdict unknown, rules not checked; no output published."
      );
      return stop === "SIGINT" ? 130 : stop === "SIGTERM" ? 143 : 2;
    }
    const done = path2.join(stage, "done");
    if (![0, 1].includes(code) || !fs2.existsSync(done)) return 2;
    const now = fs2.lstatSync(dest, { throwIfNoEntry: false });
    if (now && (now.isSymbolicLink() || !now.isDirectory() || fs2.readdirSync(dest).length || !previous || now.ino !== previous.ino || now.dev !== previous.dev))
      throw new Error("Output collision while check ran; nothing published");
    fs2.mkdirSync(path2.dirname(dest), { recursive: true });
    fs2.renameSync(done, dest);
    if (command === "check")
      process.stdout.write(fs2.readFileSync(path2.join(dest, "report.md")));
    console.log("\nWrote " + dest);
    return code;
  } finally {
    if (timer) clearTimeout(timer);
    kill();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    fs2.rmSync(stage, { recursive: true, force: true });
    const ownLock = fs2.lstatSync(lock, { throwIfNoEntry: false });
    if (ownLock && ownLock.ino === lockIdentity.ino && ownLock.dev === lockIdentity.dev)
      fs2.unlinkSync(lock);
  }
}
try {
  process.exitCode = await main();
} catch (e) {
  console.error(message(e));
  process.exitCode = 2;
}
