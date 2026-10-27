import { readFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// PSTACK_HOST_PIN selects another committed pin, such as the main-branch pin for
// native-controller host capabilities that are not in a release yet.
export const hostPin = JSON.parse(
  readFileSync(new URL("../tests/fixtures/" + (process.env.PSTACK_HOST_PIN ?? "openclaw-host.json"), import.meta.url), "utf8"),
);

export function qualifiedHost() {
  const source = process.env.OPENCLAW_SOURCE;
  // Retain only the explicitly supplied source selector, never Gateway state.
  for (const key of Object.keys(process.env))
    if (key.startsWith("OPENCLAW_")) delete process.env[key];
  if (!source) throw Error("Set OPENCLAW_SOURCE to the pinned, dependency-ready host checkout");
  const host = realpathSync(source);
  const git = (...args) => execFileSync("git", ["-C", host, ...args], { encoding: "utf8" }).trim();
  // A tagged pin must match its tag; a branch pin names one exact commit.
  if (git("rev-parse", "HEAD") !== hostPin.commit ||
      (hostPin.tag !== undefined && git("rev-parse", hostPin.tag + "^{commit}") !== hostPin.commit))
    throw Error("Host must be " + (hostPin.tag ?? hostPin.ref) + " at " + hostPin.commit);
  if (git("status", "--porcelain", "--untracked-files=no"))
    throw Error("Pinned host tracked source must be immutable/clean");
  return host;
}

export function isolateHostEnvironment(label) {
  const scratch = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : "/tmp", label));
  for (const key of Object.keys(process.env))
    if (key.startsWith("OPENCLAW_")) delete process.env[key];
  process.env.TMPDIR = scratch;
  process.env.TMP = scratch;
  process.env.TEMP = scratch;
  process.env.HOME = join(scratch, "home");
  process.env.USERPROFILE = process.env.HOME;
  process.env.XDG_CONFIG_HOME = join(scratch, "xdg-config");
  process.env.XDG_CACHE_HOME = join(scratch, "xdg-cache");
  process.env.OPENCLAW_STATE_DIR = join(scratch, "state");
  process.env.OPENCLAW_CONFIG_PATH = join(scratch, "config.json");
  for (const path of [process.env.HOME, process.env.OPENCLAW_STATE_DIR,
    process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME]) mkdirSync(path, { mode: 0o700 });
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  process.once("exit", cleanup);
  return { scratch, cleanup };
}
