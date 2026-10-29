import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inventory, loadPinnedSource, safeRead, sha } from "./pinned-source.mjs";

function section(text, route) {
  // Split at level-two headings, retaining the complete final section too.
  const parts = text.split(/^## /m).slice(1).map((part) => {
    const end = part.indexOf("\n");
    return [part.slice(0, end), part.slice(end + 1)];
  });
  const matches = parts.filter(([name]) => name === route);
  if (matches.length !== 1) throw Error("Missing/duplicate native section: " + route);
  return matches[0][1];
}

/** Discovery generation only. This does NOT claim upstream semantic porting. */
export async function renderRoutes(root) {
  root = resolve(root);
  const skill = join(root, "skills/pstack");
  const read = (path) => safeRead(skill, path);
  const { source, files: pinned } = await loadPinnedSource(skill);
  const sourcePaths = new Set(pinned.keys());
  const inputs = [];
  async function input(path) {
    const bytes = await read(path);
    inputs.push({ path, bytes: bytes.length, sha256: sha(bytes) });
    return bytes.toString("utf8");
  }
  await input("source-manifest.json");
  const routes = JSON.parse(await input("native/routes.json"));
  const docs = {
    "workflows.md": await input("native/workflows.md"),
    "playbooks.md": await input("native/playbooks.md"),
  };
  const names = [...routes.workflows, ...routes.playbooks];
  if (names.length !== 57 || new Set(names).size !== 57 || names.some((name) => !/^[a-z][a-z0-9-]*$/.test(name)))
    throw Error("Expected the reviewed 57 unique routes");
  const gates = new Map();
  let gateCount = 0;
  for (const route of routes.requirementGuards) {
    const record = JSON.parse(await input("native/requirements/" + route + ".json"));
    if (record.schema !== 1 || record.route !== route || !names.includes(route) || !docs[record.document] ||
        !record.upstream?.length || !record.gates?.length || gates.has(route))
      throw Error("Invalid native requirements: " + route);
    for (const path of record.upstream) if (!sourcePaths.has(path)) throw Error("Unpinned gate source: " + path);
    const body = section(docs[record.document], route);
    const ids = new Set();
    for (const gate of record.gates) {
      if (typeof gate.id !== "string" || !gate.id || ids.has(gate.id) || typeof gate.text !== "string" || !gate.text.trim() || !body.includes(gate.text))
        throw Error("Required native gate missing: " + route + "/" + gate.id);
      ids.add(gate.id);
      gateCount++;
    }
    gates.set(route, [...ids]);
  }
  // v0.15.36 replaces helper/topology mandates; retain the reviewed native gate floor.
  if (gates.size < 52 || gateCount < 796) throw Error("Restored requirement coverage shrank");
  const output = new Map();
  const records = [];
  for (const route of names) {
    const document = routes.workflows.includes(route) ? "workflows.md" : "playbooks.md";
    const body = section(docs[document], route);
    const name = "pstack-" + route;
    const text = [
      "---", "name: " + name,
      "description: " + JSON.stringify("Manual pstack " + route + " workflow; native authority and all selected-route gates remain mandatory."),
      "user-invocable: true", "disable-model-invocation: true", "license: MIT", "---", "",
      "# " + name, "",
      "Generated manual discovery guide, not an execution controller or permission grant.",
      "The registered /" + name + " command is the literal hyphenated entry point.",
      "Pinned hosts sanitize skill-picker commands to underscores and may truncate or deconflict them;",
      "that picker spelling is not the registered plugin command. A skill attachment alone never enables sticky mode.", "",
      "1. Read [the complete native contract](../../pstack/native/contract.md) before this route.",
      "2. Read **the entire " + route + " section** in [" + document + "](../../pstack/native/" + document + "#" + route + ").",
      "   Follow every branch and required independent phase, not this discovery summary.",
      "3. Resolve configured roles through pstack_route; execute through native tools under current authority.",
      "   Required phases either run and are collected or are explicitly BLOCKED. Parent prose cannot replace independence.",
      "4. Use a short bounded wait and retain accepted-child/snapshot custody for resume; never respawn accepted work.",
      "   Current-host continuation is skill-guided and agent-attested, not observed host selection, approval or scheduling.",
      "5. Preserve holds, scope, model controls, review/CI, no-publication and lifecycle gates. Help/setup remain read-only.", "",
      "No upstream script, agent definition, runtime API or scheduler is executed by this guide.",
      "Read-only briefs are prompt guidance, not a sandbox. Unattended command resume stays BLOCKED without its native capability.", "",
    ].join("\n");
    const bytes = Buffer.from(text);
    const path = name + "/SKILL.md";
    output.set(path, bytes);
    records.push({ path, bytes: bytes.length, sha256: sha(bytes), route, document,
      sectionSha256: sha(body), requirementIds: gates.get(route) ?? [] });
  }
  const manifest = Buffer.from(JSON.stringify({ schema: 1, kind: "manual-route-discovery-only",
    upstreamCommit: source.commit, semanticReview: "NOT-PERFORMED-BY-THIS-GENERATOR",
    inputs, files: records, restoredRequirementRoutes: gates.size, restoredGates: gateCount,
  }, null, 2) + "\n");
  return { output, manifest };
}

export async function syncRoutes(root, check = false) {
  root = resolve(root);
  const { output, manifest } = await renderRoutes(root);
  const directory = join(root, "skills/routes");
  let existing = [];
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw Error("Linked generated root");
    existing = await inventory(directory);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing.some((path) => !output.has(path))) throw Error("Unexpected generated route inventory; refusing to remove files");
  // Validate all inputs and existing output types before any mutation.
  const destinations = [...output].map(([path, bytes]) => [join(directory, path), bytes]);
  destinations.push([join(root, "skills/pstack/native/route-skills.json"), manifest]);
  for (const [path] of destinations) {
    try { if (!(await lstat(path)).isFile()) throw Error("Non-file output: " + path); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (check) {
    for (const [path, bytes] of destinations) {
      let actual;
      try { actual = await readFile(path); } catch { throw Error("Missing generated route: " + path); }
      if (!actual.equals(bytes)) throw Error("Stale generated route: " + path);
    }
  } else {
    for (const [path, bytes] of destinations) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
  }
  return { routes: output.size, check, semanticPorting: false };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--check") || args.length > 1) throw Error("Usage: node scripts/sync-routes.mjs [--check]");
    console.log(JSON.stringify(await syncRoutes(resolve(import.meta.dirname, ".."), args.includes("--check"))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
