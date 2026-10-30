import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { defaultCache } from "../scripts/build-video.mjs";

const root = resolve(import.meta.dirname, "..");

async function scratch(t) {
  const dir = await mkdtemp(
    join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "pstack-pack-test-"),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("OPENCLAW_") || key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    PSTACK_VIDEO_CACHE: defaultCache(),
    PSTACK_VIDEO_OFFLINE: "1",
    PSTACK_ESBUILD: createRequire(import.meta.url).resolve("esbuild"),
    HOME: join(dir, "home"),
    TMPDIR: join(dir, "tmp"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    COPYFILE_DISABLE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  });
  await mkdir(env.HOME, { mode: 0o700 });
  await mkdir(env.TMPDIR, { mode: 0o700 });
  function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    assert.ifError(result.error);
    return result;
  }
  function ok(command, args, options) {
    const result = run(command, args, options);
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
    );
    return result.stdout;
  }
  return { dir, run, ok };
}

function tarHeaders(gzip) {
  const tar = gunzipSync(gzip),
    entries = [];
  const field = (header, start, size) =>
    header
      .subarray(start, start + size)
      .toString("utf8")
      .replace(/\0.*$/s, "");
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const prefix = field(header, 345, 155),
      name = field(header, 0, 100);
    const size = parseInt(field(header, 124, 12).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0, "valid tar size");
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      type: field(header, 156, 1),
      magic: field(header, 257, 6),
      mode: parseInt(field(header, 100, 8).trim(), 8),
      uid: parseInt(field(header, 108, 8).trim(), 8),
      gid: parseInt(field(header, 116, 8).trim(), 8),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(entries.length > 0, "archive has real entries");
  assert.ok(offset + 1024 <= tar.length, "two complete tar end blocks");
  assert.ok(
    tar.subarray(offset, offset + 1024).every((byte) => byte === 0),
    "tar end markers",
  );
  return entries;
}

// Private vocabulary belongs in a CI secret, never in public source (including
// escaped literals or hashes). Exceptions match values, never whole files.
function privacyTerms(raw, required = false) {
  if (!raw) {
    if (required) throw Error("PSTACK_PRIVACY_TERMS is required for this check");
    return [];
  }
  let terms;
  try { terms = JSON.parse(raw); } catch { throw Error("Invalid PSTACK_PRIVACY_TERMS"); }
  if (!Array.isArray(terms) || terms.length === 0 ||
      terms.some(term => typeof term !== "string" || term.trim() !== term || term.length < 2 || term.length > 200))
    throw Error("Invalid PSTACK_PRIVACY_TERMS");
  return terms;
}
const configuredTerms = privacyTerms(process.env.PSTACK_PRIVACY_TERMS, process.env.PSTACK_REQUIRE_PRIVACY_TERMS === "1");
const privacyRules = [
  ["home path", /\/Users\/[^\s/"'<>\x60]+/gi],
  ["session key", /agent:main:[A-Za-z0-9:_-]+/g],
  ["email", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ["credential", /(?:gh[pousr]_|github_pat_|clh_|sk-)[A-Za-z0-9_-]{16,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bxox[baprs]-[A-Za-z0-9-]{16,}/g],
];
const fixtureSessions = new Map([
  ["scripts/gateway-e2e.mjs", /^agent\u003amain:dashboard:pstack-(?:workspace-divergence|migrate-status|migrate-off|migration-owner|e2e|fresh|task|goal)$/],
  ["scripts/gateway-e2e-native.mjs", /^agent\u003amain:dashboard:pstack-(?:route|brief(?:-delegate|-fragment|-missing)?|old(?:-help|-setup)?|panel|goal|restart|demote|poteto-help|setup|architect|arena|eval-blind|yield-guard|yield-off|yield-handoff-?|collect-in-turn|collector-bound-(?:on)?|agents-run-|swarm|reflect|how(?:-correct)?|why|teach|correction|family(?:-route(?:-2)?)?)$/],
  ["scripts/isolated-load.mjs", /^agent\u003amain:dashboard:isolated-$/],
  ["skills/pstack/scripts/verify_runtime.mjs", /^agent\u003amain:dashboard:fixture$/],
  ["skills/pstack/tests/automation.test.mjs", /^agent\u003amain:(?:main|dashboard:foreign)$/],
  ["skills/pstack/tests/fixtures/automation.mjs", /^agent\u003amain:dashboard:fixture-owner$/],
  ["skills/pstack/tests/test_session_mode.py", /^agent\u003amain:dashboard:case-a$/],
]);
const mediaPins = JSON.parse(await readFile(join(root, "scripts/video-assets.json"), "utf8"));
const originalNotices = new Map(mediaPins.sourceFiles.filter(file => file.path.startsWith("notices/") || file.path === "resvg-js.Cargo.toml")
  .map(file => ["licenses/ketchup-video-renderer/" + file.path, file.sha256]));
function allowedPrivacyMatch(path, kind, value) {
  if (kind === "email") {
    // Reserved example domains are synthetic; the upstream SSH URL is not mail.
    if (/@example\.(?:com|org|net|test|invalid)$/i.test(value)) return true;
    return [
      "skills/pstack/upstream/skills/poteto-mode/scripts/watch-pr/github.ts",
      "tests/fixtures/sessions-spawn.acp.schema.json",
      "tests/fixtures/sessions-spawn.main.acp.schema.json",
      "tests/fixtures/sessions-spawn.main.schema.json",
      "tests/fixtures/sessions-spawn.schema.json",
    ].includes(path) && value === "git" + "@github.com";
  }
  if (kind === "home path") return [
    "skills/pstack/upstream/docs/harness/claude-code.md",
    "skills/pstack/upstream/skills/recall/SKILL.md",
  ].includes(path) && value === "/" + "Users/you";
  return kind === "session key" && (fixtureSessions.get(path)?.test(value) ?? false);
}
function privacyFindings(path, content, terms = configuredTerms) {
  const findings = [];
  // Paths themselves must not leak identities, even if their contents are empty.
  const rules = [...privacyRules, ...terms.map(term => ["private identity",
    new RegExp("\\b" + RegExp.escape(term) + "\\b", "gi")])];
  const original = originalNotices.get(path) === createHash("sha256").update(content).digest("hex");
  for (const [kind, pattern] of rules)
    for (const match of (path + "\n" + content).matchAll(pattern)) {
      // Only original hash-bound attribution emails qualify.
      // Credentials, session keys, private vocabulary and altered files never qualify.
      if (original && kind === "email") continue;
      if (!allowedPrivacyMatch(path, kind, match[0])) findings.push(path + ": " + kind);
    }
  return findings;
}
async function trackedPrivacyFindings(repo, ok, terms = configuredTerms) {
  const paths = ok("git", ["-C", repo, "ls-files", "-z"]).split("\0").filter(Boolean);
  const findings = [];
  for (const path of paths)
    findings.push(...privacyFindings(path, await readFile(join(repo, path), "utf8"), terms));
  return findings;
}

test("privacy identity configuration validates inputs without exposing values", () => {
  assert.deepEqual(privacyTerms(undefined), []);
  assert.throws(() => privacyTerms(undefined, true), { message: "PSTACK_PRIVACY_TERMS is required for this check" });
  for (const value of ["private-bad-json", "{}", "[]", '[1]', '[" "]', '[" trailing "]'])
    assert.throws(() => privacyTerms(value), { message: "Invalid PSTACK_PRIVACY_TERMS" });
  const terms = privacyTerms('["Host.with.dots", "Example Operator"]', true);
  assert.deepEqual(privacyFindings("public.md", "host.with.dots", terms), ["public.md: private identity"]);
  assert.deepEqual(privacyFindings("public.md", "HOST.WITH.DOTS", terms), ["public.md: private identity"]);
  assert.deepEqual(privacyFindings("public.md", "hostXwithXdots and prehost.with.dots", terms), []);
});

test("repository privacy guard rejects private data in tracked files", async (t) => {
  const { dir, ok } = await scratch(t);
  assert.deepEqual(await trackedPrivacyFindings(root, ok), [], "tracked repository privacy");
  if (!configuredTerms.length) t.diagnostic("Private identity list unavailable; generic repository/package checks still run.");
  const terms = ["Example Operator", "test-host-alpha", "host.with.dots"];
  const repo = join(dir, "privacy-fixture");
  await mkdir(repo);
  ok("git", ["init", "-q", repo]);
  const path = join(repo, "public.md");
  await writeFile(path, "Public documentation\n");
  ok("git", ["-C", repo, "add", "public.md"]);
  assert.deepEqual(await trackedPrivacyFindings(repo, ok, terms), []);
  const probes = [
    ["home path", ["/Users", "example-user", "workspace"].join("/")],
    ...terms.map(value => ["private identity", value]),
    ["session key", "agent:" + "main:dashboard:12345678-1234-1234-1234-123456789abc"],
    ["email", "person@" + "private-company.io"],
    ...["ghp_", "github_pat_", "clh_", "sk-", "xoxb-"].map(prefix => ["credential", prefix + "a".repeat(24)]),
    ["credential", "AKIA" + "A".repeat(16)],
    ["credential", "-----BEGIN " + "PRIVATE KEY-----"],
  ];
  for (const [kind, value] of probes) {
    await writeFile(path, value);
    assert.deepEqual(await trackedPrivacyFindings(repo, ok, terms), ["public.md: " + kind]);
  }
  await writeFile(path, "Safe again: reader@example.test\n");
  assert.deepEqual(await trackedPrivacyFindings(repo, ok, terms), [], "removing planted data clears the guard");
  const noticePath = "licenses/ketchup-video-renderer/notices/unicode-bidi-0.3.18/AUTHORS";
  const notice = await readFile(join(root, noticePath), "utf8");
  assert.deepEqual(privacyFindings(noticePath, notice, terms), []);
  assert.ok(privacyFindings("other.txt", notice, terms).some(x => x.endsWith(": email")));
  for (const probe of ["person@" + "private-company.io", "ghp_" + "a".repeat(24), terms[0]])
    assert.ok(privacyFindings(noticePath, notice + probe, terms).length > 0);
  assert.ok(privacyFindings(noticePath, notice.replace("@", "+changed@"), terms).length > 0);
  // An exception is local to the approved fixture/value, not a path-wide bypass.
  const upstream = "skills/pstack/upstream/skills/recall/SKILL.md";
  assert.deepEqual(privacyFindings(upstream, "/" + "Users/you/proj"), []);
  assert.deepEqual(privacyFindings(upstream, probes[0][1]), [upstream + ": home path"]);
  const fixture = "skills/pstack/tests/fixtures/automation.mjs";
  const fakeKey = "agent:" + "main:dashboard:fixture-owner";
  assert.deepEqual(privacyFindings(fixture, fakeKey), []);
  assert.deepEqual(privacyFindings("public.md", fakeKey), ["public.md: session key"]);
  assert.deepEqual(privacyFindings(fixture, "agent:" + "main:dashboard:unapproved"), [fixture + ": session key"]);
  assert.deepEqual(privacyFindings("docs/" + terms[0] + ".md", "", terms), ["docs/" + terms[0] + ".md: private identity"]);
});

test("real commit archive preserves every pinned upstream file as plain ustar", async (t) => {
  const { dir, ok } = await scratch(t);
  const sha = ok("git", ["rev-parse", "HEAD"]).trim();
  const receipt = JSON.parse(
    ok(process.execPath, [
      join(root, "scripts/pack.mjs"),
      "--commit",
      sha,
      "--out-dir",
      join(dir, "artifacts"),
    ]),
  );
  assert.equal(receipt.commit, sha);
  const pinnedMetadata = JSON.parse(ok("git", ["show", `${sha}:package.json`]));
  assert.equal(
    receipt.path,
    join(dir, "artifacts", `openclaw-pstack-${pinnedMetadata.version}-${sha.slice(0, 12)}.tgz`),
  );
  const data = await readFile(receipt.path);
  assert.equal(receipt.sha256, createHash("sha256").update(data).digest("hex"));
  assert.equal(receipt.upstreamFiles, 573);
  const entries = tarHeaders(data);
  for (const entry of entries) {
    assert.equal(entry.magic, "ustar");
    assert.ok(
      ["0", "5", ""].includes(entry.type),
      `no PAX/extension entry: ${entry.path} (${entry.type})`,
    );
    assert.equal(entry.uid, 0);
    assert.equal(entry.gid, 0);
    assert.ok(entry.path.startsWith("package/"), entry.path);
    assert.ok(!entry.path.split("/").some((part) => part.startsWith("._")), "no mac metadata");
  }
  const files = entries.filter((entry) => entry.type !== "5").map((entry) => entry.path);
  assert.equal(new Set(files).size, files.length, "no duplicate files");
  assert.ok(files.includes("package/skills/pstack/upstream/.gitignore"));
  const extracted = join(dir, "extracted");
  await mkdir(extracted);
  ok("tar", ["-xzf", receipt.path, "-C", extracted]);
  const packageRoot = join(extracted, "package"),
    skill = join(packageRoot, "skills/pstack");
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(metadata.name, "@fuller-stack-dev/openclaw-pstack");
  const plugin = JSON.parse(await readFile(join(packageRoot, "openclaw.plugin.json"), "utf8"));
  assert.equal(plugin.id, "pstack");
  assert.equal(plugin.name, "openclaw-pstack");
  assert.equal(plugin.version, metadata.version);
  const build = JSON.parse(await readFile(join(packageRoot, "dist/ketchup-video.build.json"), "utf8"));
  assert.equal(build.sourceCommit, sha);
  assert.equal(build.output.sha256, receipt.media.outputSha256);
  assert.equal(createHash("sha256").update(await readFile(join(packageRoot, build.output.path))).digest("hex"), build.output.sha256);
  for (const [path, hash] of Object.entries(build.inputs)) {
    if (path.startsWith("verified-media:")) continue;
    const source = ok("git", ["show", sha + ":" + path], { encoding: null });
    assert.equal(createHash("sha256").update(source).digest("hex"), hash, path);
  }
  const native = JSON.parse(await readFile(join(skill, "native-manifest.json"), "utf8"));
  assert.equal(native.adapterVersion, "plugin-" + metadata.version);
  assert.deepEqual(native.baselineSkillNames, [], "no private host skill inventory");
  assert.ok(data.length < 120 * 1024 * 1024, "ClawPack compressed bound");
  assert.ok(gunzipSync(data).length < 64 * 1024 * 1024, "ClawPack tar stream bound");
  assert.ok(files.length < 10000, "ClawPack file count bound");
  let unpacked = 0;
  for (const file of files) {
    const relative = file.slice("package/".length);
    const bytes = await readFile(join(packageRoot, relative));
    unpacked += bytes.length;
    assert.ok(bytes.length < 50 * 1024 * 1024, "ClawPack per-file bound");
    assert.deepEqual(privacyFindings(relative, bytes.toString("utf8")), [], "packed privacy: " + relative);
    if (relative.startsWith("skills/pstack/upstream/")) continue;
    assert.doesNotMatch(relative, /(^|\/)(tests|evidence|artifacts|verification|operators)(\/|$)|\.map$/, "no internal dumps or adapter tests");
  }
  assert.ok(unpacked < 50 * 1024 * 1024, "ClawPack combined byte bound");
  assert.ok((await readFile(join(packageRoot, "package.json"))).length < 256 * 1024);
  for (const required of ["NOTICE", "LICENSE", "README.md", "CHANGELOG.md", "dist/index.js"]) assert.ok(files.includes("package/" + required));
  for (const file of files)
    assert.ok(
      ["package.json", ...metadata.files].some(
        (allowed) => file === `package/${allowed}` || file.startsWith(`package/${allowed}/`),
      ),
      file,
    );
  const manifest = JSON.parse(await readFile(join(skill, "source-manifest.json"), "utf8"));
  assert.equal(manifest.fileCount, 573);
  for (const record of manifest.files) {
    const path = "package/skills/pstack/upstream/" + record.path;
    const entry = entries.find((entry) => entry.path === path);
    assert.ok(entry, "pinned source file exists: " + path);
    assert.equal(entry.mode, parseInt(record.gitMode.slice(-3), 8), "canonical Git mode: " + path);
  }
  assert.deepEqual(
    files.filter((path) => path.startsWith("package/skills/pstack/upstream/")).sort(),
    manifest.files.map((file) => `package/skills/pstack/upstream/${file.path}`).sort(),
  );
  const verified = JSON.parse(ok("python3", [join(skill, "scripts/verify_install.py"), skill]));
  assert.equal(verified.ok, true);
  assert.equal(verified.source.files, 573);
  assert.equal(verified.routeSkills.files, 57);
  assert.equal(files.filter(path => path.startsWith("package/skills/routes/")).length, 57);
});

test("clean HEAD default, explicit dirty-worktree pin, and failed verification never publish bad artifacts", async (t) => {
  const { dir, run, ok } = await scratch(t);
  const repo = join(dir, "repo");
  await mkdir(repo);
  const snapshot = ok("git", ["archive", "HEAD"], { encoding: null });
  ok("tar", ["-x", "-C", repo], { input: snapshot });
  // Exercise this candidate script, even before the new file is committed.
  await copyFile(join(root, "scripts/pack.mjs"), join(repo, "scripts/pack.mjs"));
  const git = (args) => ok("git", ["-C", repo, ...args]);
  const commit = () => {
    git(["add", "."]);
    git([
      "-c",
      "user.name=Packaging Test",
      "-c",
      "user.email=pack@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "fixture",
    ]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  git(["init", "-q"]);
  const pinned = commit();
  const script = join(repo, "scripts/pack.mjs");
  const clean = JSON.parse(ok(process.execPath, [script]));
  assert.equal(clean.commit, pinned);
  const accepted = await readFile(clean.path);
  const duplicate = run(process.execPath, [script]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /EEXIST/);
  assert.deepEqual(await readFile(clean.path), accepted, "existing accepted artifact is unchanged");
  const untracked = join(repo, "untracked.txt");
  await writeFile(untracked, "not committed\n");
  const untrackedResult = run(process.execPath, [script]);
  assert.notEqual(untrackedResult.status, 0);
  assert.match(untrackedResult.stderr, /Worktree must be clean/);
  await rm(untracked);
  const ignorePath = join(repo, "skills/pstack/upstream/.gitignore");
  const ignoreBytes = await readFile(ignorePath);
  await writeFile(ignorePath, "uncommitted corruption\n");
  const dirty = run(process.execPath, [script, "--out-dir", join(dir, "dirty")]);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /Worktree must be clean/);
  await assert.rejects(readdir(join(dir, "dirty")), { code: "ENOENT" });
  const explicit = JSON.parse(
    ok(process.execPath, [script, "--commit", pinned, "--out-dir", join(dir, "explicit")]),
  );
  assert.equal(explicit.commit, pinned);
  assert.equal(explicit.upstreamFiles, 573, "uncommitted corruption was not packaged");
  const entry = join(repo, "src/artifacts/ketchup-video/cli.mjs");
  const entryBytes = await readFile(entry);
  await writeFile(entry, "throw Error('dirty source must not enter pinned artifact');");
  const pinnedAgain = JSON.parse(ok(process.execPath, [script, "--commit", pinned, "--out-dir", join(dir, "pinned-again")]));
  assert.equal(pinnedAgain.media.outputSha256, clean.media.outputSha256);
  await writeFile(entry, entryBytes);
  const cache = join(dir, "media-cache");
  await mkdir(cache);
  for (const pin of [...mediaPins.fonts, mediaPins.renderer["index_bg.wasm"]])
    await copyFile(join(defaultCache(), pin.sha256), join(cache, pin.sha256));
  const wasm = join(cache, mediaPins.renderer["index_bg.wasm"].sha256);
  const wasmBytes = await readFile(wasm);
  await writeFile(wasm, "poisoned immutable cache entry");
  const poisoned = run(process.execPath, [script, "--commit", pinned, "--out-dir", join(dir, "poisoned")], {
    env: { ...process.env, PSTACK_VIDEO_CACHE: cache, PSTACK_VIDEO_OFFLINE: "1", PSTACK_ESBUILD: createRequire(import.meta.url).resolve("esbuild") },
  });
  assert.notEqual(poisoned.status, 0);
  assert.match(poisoned.stderr, /Build asset digest mismatch/);
  await assert.rejects(readdir(join(dir, "poisoned")), { code: "ENOENT" });
  await rm(wasm);
  const missing = run(process.execPath, [script, "--commit", pinned, "--out-dir", join(dir, "missing")], {
    env: { ...process.env, PSTACK_VIDEO_CACHE: cache, PSTACK_VIDEO_OFFLINE: "1", PSTACK_ESBUILD: createRequire(import.meta.url).resolve("esbuild") },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing verified media input/);
  await writeFile(wasm, wasmBytes);
  // Restore the earlier dirty-source probe so this commit isolates guide corruption.
  await writeFile(ignorePath, ignoreBytes);
  // External generated guides are verified too, not just native-manifest files.
  const guide = join(repo, "skills/routes/pstack-architect/SKILL.md");
  const guideBytes = await readFile(guide);
  await writeFile(guide, "corrupt manual route");
  commit();
  const badGuideDir = join(dir, "bad-guide");
  const badGuide = run(process.execPath, [script, "--out-dir", badGuideDir]);
  assert.notEqual(badGuide.status, 0);
  assert.match(badGuide.stderr, /content mismatch: pstack-architect/);
  await assert.rejects(readdir(badGuideDir), { code: "ENOENT" });
  await writeFile(guide, guideBytes);
  // A genuinely broken committed source must fail the extracted-archive verifier.
  await rm(join(repo, "skills/pstack/upstream/.gitignore"));
  commit();
  const rejectedDir = join(dir, "rejected");
  const rejected = run(process.execPath, [script, "--out-dir", rejectedDir]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /missing file: .gitignore/);
  await assert.rejects(readdir(rejectedDir), { code: "ENOENT" });
  // Corrupt committed recipe outputs: no missing/mixed binding may reach an archive.
  await writeFile(join(repo, "skills/pstack/upstream/.gitignore"), ignoreBytes);
  const buildScript = join(repo, "scripts/build-video.mjs");
  const buildBytes = await readFile(buildScript, "utf8");
  await writeFile(buildScript, buildBytes.replace('sourceCommit: commit', 'sourceCommit: "0".repeat(40)'));
  commit();
  const mixed = run(process.execPath, [script, "--out-dir", join(dir, "mixed")]);
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /Derived media source\/output binding mismatch/);
  await assert.rejects(readdir(join(dir, "mixed")), { code: "ENOENT" });
  await writeFile(buildScript, buildBytes.replace('await writeFile(join(root, receipt.output.path), bytes, { mode: 0o644 });', '/* deliberately missing output */'));
  commit();
  const missingOutput = run(process.execPath, [script, "--out-dir", join(dir, "missing-output")]);
  assert.notEqual(missingOutput.status, 0);
  assert.match(missingOutput.stderr, /ENOENT/);
  await assert.rejects(readdir(join(dir, "missing-output")), { code: "ENOENT" });
  await writeFile(buildScript, buildBytes);
  const pinsPath = join(repo, "scripts/video-assets.json");
  const pins = JSON.parse(await readFile(pinsPath, "utf8"));
  pins.bundleSha256 = "0".repeat(64);
  await writeFile(pinsPath, JSON.stringify(pins));
  commit();
  const badOutput = run(process.execPath, [script, "--out-dir", join(dir, "bad-output")]);
  assert.notEqual(badOutput.status, 0);
  assert.match(badOutput.stderr, /Derived media digest mismatch/);
  await assert.rejects(readdir(join(dir, "bad-output")), { code: "ENOENT" });
  const unknown = run(process.execPath, [script, "--commit", "not-a-real-commit"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /rev-parse.*failed/);
});
