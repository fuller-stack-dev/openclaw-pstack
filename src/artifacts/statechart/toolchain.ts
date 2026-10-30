// Native agent-exec adapter. Never loaded by the gateway.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
export const SHA256 =
  "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
export const ASSET =
  "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar";
export const cacheJar = () =>
  path.join(os.homedir(), ".cache/pstack/tla2tools/1.7.4/tla2tools.jar");
export function verifiedJar(file = process.env.TLA2TOOLS || cacheJar()) {
  file = fs.realpathSync(file);
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new Error("TLC jar must be a regular file of at most 16 MiB");
    const hash = createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
    if (hash !== SHA256)
      throw new Error(
        "TLA2TOOLS SHA256 mismatch; refusing to execute unverified jar",
      );
  } finally {
    fs.closeSync(fd);
  }
  return fs.realpathSync(file);
}
export async function findTlc() {
  let jar: string;
  try {
    jar = verifiedJar();
  } catch (error) {
    throw new Error(
      String(error) +
        "; install nothing implicitly: run statechart toolchain fetch explicitly, or set TLA2TOOLS to the pinned jar",
    );
  }
  const java = process.env.JAVA || "java";
  const version = await new Promise<string>((resolve, reject) =>
    execFile(
      java,
      ["-version"],
      { timeout: 5000, maxBuffer: 65536 },
      (error, out, err) => (error ? reject(error) : resolve(out + err)),
    ),
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
    sha256: SHA256,
  };
}
export async function fetchToolchain() {
  const dest = cacheJar();
  if (fs.existsSync(dest)) return verifiedJar(dest);
  const response = await fetch(ASSET, { signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body)
    throw new Error("Official TLC download failed: " + response.status);
  const chunks: Uint8Array[] = [];
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return verifiedJar(dest);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
