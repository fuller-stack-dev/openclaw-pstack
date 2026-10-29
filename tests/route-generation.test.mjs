import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { syncRoutes } from "../scripts/sync-routes.mjs";

const root = resolve(import.meta.dirname, "..");
async function fixture(t) {
  const dir = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "pstack-routes-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "skills"));
  await cp(join(root, "skills/pstack"), join(dir, "skills/pstack"), { recursive: true });
  return dir;
}
const generated = (root, route = "architect") => join(root, "skills/routes/pstack-" + route + "/SKILL.md");

test("generates and read-only checks all 55 manual routes without rewriting native contracts", async (t) => {
  const dir = await fixture(t);
  const contracts = ["workflows.md", "playbooks.md", "routes.json"];
  const before = await Promise.all(contracts.map(path => readFile(join(dir, "skills/pstack/native", path))));
  assert.deepEqual(await syncRoutes(dir), { routes: 55, check: false, semanticPorting: false });
  assert.deepEqual(await syncRoutes(dir, true), { routes: 55, check: true, semanticPorting: false });
  const manifest = JSON.parse(await readFile(join(dir, "skills/pstack/native/route-skills.json"), "utf8"));
  assert.equal(manifest.files.length, 55);
  assert.equal(manifest.restoredRequirementRoutes, 50);
  assert.equal(manifest.restoredGates, 849);
  assert.equal(manifest.semanticReview, "NOT-PERFORMED-BY-THIS-GENERATOR");
  assert.equal(manifest.files.reduce((count, record) => count + record.requirementIds.length, 0), 849);
  for (const file of manifest.files) {
    const text = await readFile(join(dir, "skills/routes", file.path), "utf8");
    assert.ok(text.includes("the entire " + file.route + " section"));
    assert.ok(text.includes("../../pstack/native/" + file.document + "#" + file.route));
  }
  for (let i = 0; i < contracts.length; i++) assert.deepEqual(await readFile(join(dir, "skills/pstack/native", contracts[i])), before[i]);
});

test("stale/missing output fails --check without repairing it", async (t) => {
  const dir = await fixture(t);
  await syncRoutes(dir);
  await writeFile(generated(dir), "changed guide");
  await assert.rejects(syncRoutes(dir, true), /Stale generated route/);
  assert.equal(await readFile(generated(dir), "utf8"), "changed guide");
  await rm(generated(dir));
  await assert.rejects(syncRoutes(dir, true), /Missing generated route/);
});

test("pinned upstream corruption rejects generation before any output is replaced", async (t) => {
  const dir = await fixture(t);
  await syncRoutes(dir);
  const before = await readFile(generated(dir));
  await writeFile(join(dir, "skills/pstack/upstream/skills/architect/SKILL.md"), "changed required source");
  await assert.rejects(syncRoutes(dir), /Pinned source changed without review/);
  assert.deepEqual(await readFile(generated(dir)), before);
});

test("deleting a required native paragraph fails rather than producing a shortened guide", async (t) => {
  const dir = await fixture(t);
  const path = join(dir, "skills/pstack/native/workflows.md");
  const requirement = JSON.parse(await readFile(join(dir, "skills/pstack/native/requirements/architect.json"), "utf8"));
  const original = await readFile(path, "utf8");
  assert.ok(original.includes(requirement.gates[0].text));
  await writeFile(path, original.replace(requirement.gates[0].text, "removed mandatory gate"));
  await assert.rejects(syncRoutes(dir), /Required native gate missing: architect/);
  await assert.rejects(readFile(generated(dir)), { code: "ENOENT" });
});

test("deleting a requirement route is not excused by regenerating the discovery index", async (t) => {
  const dir = await fixture(t);
  const path = join(dir, "skills/pstack/native/routes.json");
  const routes = JSON.parse(await readFile(path, "utf8"));
  routes.requirementGuards = routes.requirementGuards.filter(route => route !== "architect");
  await writeFile(path, JSON.stringify(routes));
  await assert.rejects(syncRoutes(dir), /Restored requirement coverage shrank/);
});

test("duplicate section, missing route and extra upstream files fail closed", async (t) => {
  const dir = await fixture(t);
  const path = join(dir, "skills/pstack/native/workflows.md");
  const original = await readFile(path, "utf8");
  await writeFile(path, original + "\n## architect\nduplicate\n");
  await assert.rejects(syncRoutes(dir), /Missing\/duplicate native section/);
  await writeFile(path, original.replace("## architect\n", "## not-architect\n"));
  await assert.rejects(syncRoutes(dir), /Missing\/duplicate native section/);
  await writeFile(path, original);
  await writeFile(join(dir, "skills/pstack/upstream/extra.txt"), "unreviewed");
  await assert.rejects(syncRoutes(dir), /Pinned source inventory mismatch/);
});

test("unknown generated files are preserved and prevent regeneration", async (t) => {
  const dir = await fixture(t);
  await syncRoutes(dir);
  const path = join(dir, "skills/routes/owner-file.txt");
  await writeFile(path, "owner data");
  await assert.rejects(syncRoutes(dir), /Unexpected generated route inventory/);
  assert.equal(await readFile(path, "utf8"), "owner data");
});

test("linked generated roots and source inputs are refused without writing through links", async (t) => {
  const dir = await fixture(t);
  const outside = join(dir, "outside");
  await mkdir(outside);
  await symlink(outside, join(dir, "skills/routes"));
  await assert.rejects(syncRoutes(dir), /Linked generated root/);
  await rm(join(dir, "skills/routes"));
  const source = join(dir, "skills/pstack/upstream/skills/architect/SKILL.md");
  const bytes = await readFile(source);
  const linked = join(outside, "SKILL.md");
  await writeFile(linked, bytes);
  await rm(source);
  await symlink(linked, source);
  await assert.rejects(syncRoutes(dir), /Linked input/);
  assert.deepEqual(await readFile(linked), bytes);
});
