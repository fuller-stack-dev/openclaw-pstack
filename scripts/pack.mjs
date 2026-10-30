import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const root = resolve(import.meta.dirname, "..");

async function main() {
  let commit,
    outputDir = join(root, "artifacts");
  const args = process.argv.slice(2);
  while (args.length) {
    const option = args.shift();
    if (!["--commit", "--out-dir"].includes(option) || !args[0] || args[0].startsWith("--"))
      throw Error("Usage: node scripts/pack.mjs [--commit <commit>] [--out-dir <directory>]");
    const value = args.shift();
    if (option === "--commit") commit = value;
    else outputDir = resolve(value);
  }
  const dir = await mkdtemp(
    join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "pstack-pack-"),
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("OPENCLAW_")) delete env[key];
  Object.assign(env, {
    PSTACK_VIDEO_CACHE: resolve(process.env.PSTACK_VIDEO_CACHE || join(homedir(), ".cache/pstack/video-assets")),
    PSTACK_ESBUILD: process.env.PSTACK_ESBUILD || createRequire(import.meta.url).resolve("esbuild"),
    HOME: join(dir, "home"),
    TMPDIR: join(dir, "tmp"),
    COPYFILE_DISABLE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  });
  function run(command, argv, options = {}) {
    const result = spawnSync(command, argv, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    if (result.error || result.status !== 0)
      throw Error(
        `${command} ${argv.join(" ")} failed: ${result.error?.message ?? result.signal ?? result.status}\n` +
          String(result.stdout ?? "") +
          String(result.stderr ?? ""),
      );
    return result.stdout;
  }
  try {
    for (const path of [
      env.HOME,
      env.TMPDIR,
      join(dir, "stage"),
      join(dir, "archive"),
      join(dir, "verify"),
    ])
      await mkdir(path, { mode: 0o700 });
    if (
      commit === undefined &&
      run("git", ["status", "--porcelain", "--untracked-files=all"]).trim()
    )
      throw Error("Worktree must be clean; commit changes or explicitly pin --commit <commit>.");
    const sha = run("git", [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${commit ?? "HEAD"}^{commit}`,
    ]).trim();
    const shortSha = sha.slice(0, 12);
    // Git tar defaults to group-writable modes; pin canonical 0644/0755.
    const archive = run("git", ["-c", "tar.umask=0022", "archive", "--format=tar", "--prefix=package/", sha], {
      encoding: null,
    });
    // Git archive has a global PAX header. Extract it, then emit plain ustar below.
    // Preserve Git modes even when the caller has a restrictive umask.
    run("tar", ["-xp", "-C", join(dir, "stage")], { input: archive });
    const stage = join(dir, "stage/package");
    const metadata = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
    if (
      metadata.name !== "@fuller-stack-dev/openclaw-pstack" ||
      typeof metadata.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(metadata.version)
    )
      throw Error("Invalid package name/version in pinned commit.");
    // This package uses literal file/directory entries, not npm ignore rules. In
    // particular, never let npm pack silently discard upstream/.gitignore.
    if (
      !Array.isArray(metadata.files) ||
      metadata.files.some(
        (file) =>
          typeof file !== "string" ||
          !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file) ||
          file.split("/").some((part) => part === "." || part === ".."),
      )
    )
      throw Error("package.json files must be literal relative files/directories.");
    await regularTree(stage);
    // The only derived package bytes come from this frozen commit's recipe/pins.
    run(process.execPath, [join(stage, "scripts/build-video.mjs")], {
      cwd: stage, env: { ...env, PSTACK_SOURCE_COMMIT: sha },
    });
    const media = JSON.parse(await readFile(join(stage, "dist/ketchup-video.build.json"), "utf8"));
    const pins = JSON.parse(await readFile(join(stage, "scripts/video-assets.json"), "utf8"));
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    if (media.sourceCommit !== sha || media.output.path !== "dist/ketchup-video.mjs" ||
        media.output.sha256 !== pins.bundleSha256 ||
        hash(await readFile(join(stage, media.output.path))) !== media.output.sha256)
      throw Error("Derived media source/output binding mismatch");
    for (const [path, expected] of Object.entries(media.inputs)) {
      if (path.startsWith("verified-media:")) continue;
      if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) || path.split("/").some(p => p === "." || p === "..")) throw Error("Invalid build input path");
      if (hash(await readFile(join(stage, path))) !== expected) throw Error("Mixed source build input: " + path);
    }
    async function regularTree(path) {
      const stat = await lstat(path);
      if (stat.isDirectory()) for (const name of await readdir(path)) await regularTree(join(path, name));
      else if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Non-regular package input: " + path);
    }
    const packaged = join(dir, "archive/package");
    await mkdir(packaged, { mode: 0o755 });
    const packageFiles = ["package.json", ...metadata.files];
    if (new Set(packageFiles).size !== packageFiles.length || packageFiles.some(a => packageFiles.some(b => a !== b && a.startsWith(b + "/")))) throw Error("Duplicate/overlapping package entries");
    for (const file of packageFiles) {
      await regularTree(join(stage, file));
      await mkdir(dirname(join(packaged, file)), { recursive: true });
      await cp(join(stage, file), join(packaged, file), {
        recursive: true,
        preserveTimestamps: true,
      });
    }
    const filename = `openclaw-pstack-${metadata.version}-${shortSha}.tgz`;
    const pending = join(dir, filename);
    run("tar", [
      "--format=ustar",
      ...(process.platform === "darwin"
        ? ["--no-mac-metadata", "--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"]
        : ["--owner=0", "--group=0"]),
      "-czf",
      pending,
      "-C",
      join(dir, "archive"),
      "package",
    ]);
    run("tar", ["-xzf", pending, "-C", join(dir, "verify")]);
    const skill = join(dir, "verify/package/skills/pstack");
    const verification = run("python3", [join(skill, "scripts/verify_install.py"), skill]);
    const verified = JSON.parse(verification);
    if (!verified.ok) throw Error("Archive integrity verification did not report ok.");
    const sha256 = createHash("sha256")
      .update(await readFile(pending))
      .digest("hex");
    await mkdir(outputDir, { recursive: true });
    const path = join(outputDir, filename);
    // Never replace an artifact already associated with an acceptance receipt.
    await copyFile(pending, path, constants.COPYFILE_EXCL);
    console.log(
      JSON.stringify({ path, sha256, commit: sha, upstreamFiles: verified.source.files, media: { manifestSha256: hash(await readFile(join(stage, "dist/ketchup-video.build.json"))), outputSha256: media.output.sha256, sourceCommit: media.sourceCommit } }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
