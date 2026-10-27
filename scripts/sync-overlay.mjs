import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPinnedSource, safeRead, sha } from "./pinned-source.mjs";

// The doctor (skills/pstack/scripts/verify_install.py) repeats this extraction
// byte for byte; tests/semantic-overlay.test.mjs proves both agree.
export const RULE_PATTERN = /\b(?:must(?:n['’]t)?|required|never)\b/i;
export const EXCLUSIONS = {
  "non-normative": "The keyword is a name, heading, placeholder or quoted example, not an instruction.",
  "source-only-code": "Code or tests of a source-only upstream script that native never runs; its behavior is replaced by the cited native guard.",
  "cursor-harness": "Cursor or Claude Code harness mechanics with no OpenClaw counterpart.",
  "guide-example": "User-facing guide prose or a sample user prompt that binds no agent behavior.",
};
const OVERLAY = "native/semantic-overlay.json";
const OUTPUT = "native/semantic-overlay.md";
const MIN_QUOTE = 12;
const MIN_REASON = 40;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Extract every rule line from verified pinned files, in manifest and line order. */
export function extractRules(records, files) {
  const result = [];
  for (const record of records) {
    const bytes = files.get(record.path);
    if (bytes.includes(0)) continue;
    let text;
    try { text = decoder.decode(bytes); } catch { continue; }
    const seen = new Map();
    const rules = [];
    text.split("\n").forEach((raw, index) => {
      const line = raw.replace(/[ \t\r]+$/, "");
      if (!RULE_PATTERN.test(line)) return;
      const occurrence = seen.get(line) ?? 0;
      seen.set(line, occurrence + 1);
      rules.push({ id: "r-" + sha(record.path + "\n" + occurrence + "\n" + line).slice(0, 16), line: index + 1, text: line });
    });
    if (rules.length) result.push({ path: record.path, sha256: record.sha256, rules });
  }
  return result;
}

const nativeDoc = (doc) => typeof doc === "string" && /^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.md$/.test(doc) && doc !== "semantic-overlay.md";
const keys = (entry, expected) => entry && typeof entry === "object" && !Array.isArray(entry) &&
  JSON.stringify(Object.keys(entry).sort()) === JSON.stringify([...expected].sort());

/** Check the reviewed overlay against fresh extraction and the native targets it names. */
export async function validateOverlay(skill, overlay, extracted, source) {
  const errors = [];
  if (!keys(overlay, ["schema", "kind", "upstreamCommit", "extraction", "files"]) || overlay.schema !== 1 ||
      overlay.kind !== "upstream-rule-overlay" || !Array.isArray(overlay.files) ||
      !overlay.files.every((file) => keys(file, ["path", "sha256", "rules"]) && Array.isArray(file.rules) &&
        file.rules.every((rule) => keys(rule, ["id", "line", "map"]))))
    throw Error("Invalid semantic overlay");
  if (overlay.upstreamCommit !== source.commit) errors.push("Overlay pins upstream commit " + overlay.upstreamCommit + ", source is " + source.commit);
  const reviewed = new Map(overlay.files.map((file) => [file.path, file]));
  if (reviewed.size !== overlay.files.length) errors.push("Duplicate overlay file");
  const expected = new Set(extracted.map((file) => file.path));
  for (const path of reviewed.keys()) if (!expected.has(path)) errors.push("Overlay file has no upstream rules: " + path);
  const routes = JSON.parse(await safeRead(skill, "native/routes.json"));
  const requirements = new Map();
  for (const route of routes.requirementGuards) {
    const record = JSON.parse(await safeRead(skill, "native/requirements/" + route + ".json"));
    requirements.set(route, { document: record.document, ids: new Set(record.gates.map((gate) => gate.id)) });
  }
  const docs = new Map();
  const ruleIds = new Map();
  const entries = [];
  for (const file of extracted) {
    const entry = reviewed.get(file.path);
    if (!entry) {
      for (const rule of file.rules) errors.push("Unmapped upstream rule: " + file.path + ":" + rule.line + " " + rule.id + " " + JSON.stringify(rule.text.slice(0, 160)));
      continue;
    }
    if (entry.sha256 !== file.sha256) errors.push("Upstream drift: " + file.path + " overlay pins " + entry.sha256 + ", pinned source is " + file.sha256);
    const mapped = new Map((entry.rules ?? []).map((rule) => [rule.id, rule]));
    if (mapped.size !== (entry.rules ?? []).length) errors.push("Duplicate overlay rule in " + file.path);
    for (const rule of file.rules) {
      const review = mapped.get(rule.id);
      if (!review) { errors.push("Unmapped upstream rule: " + file.path + ":" + rule.line + " " + rule.id + " " + JSON.stringify(rule.text.slice(0, 160))); continue; }
      if (review.line !== rule.line) errors.push("Overlay line drift: " + rule.id + " is at " + file.path + ":" + rule.line);
      ruleIds.set(rule.id, { file, rule, review });
      entries.push(rule.id);
    }
    const current = new Set(file.rules.map((rule) => rule.id));
    for (const id of mapped.keys()) if (!current.has(id)) errors.push("Stale overlay rule (no longer upstream): " + file.path + " " + id);
    const order = (entry.rules ?? []).map((rule) => rule.id).filter((id) => current.has(id));
    if (JSON.stringify(order) !== JSON.stringify(file.rules.map((rule) => rule.id).filter((id) => mapped.has(id))))
      errors.push("Overlay rules out of upstream order: " + file.path);
  }
  if (JSON.stringify(overlay.files.map((file) => file.path).filter((path) => expected.has(path))) !==
      JSON.stringify(extracted.map((file) => file.path).filter((path) => reviewed.has(path))))
    errors.push("Overlay files out of pinned manifest order");
  for (const id of entries) {
    const { file, rule, review } = ruleIds.get(id);
    const where = file.path + ":" + rule.line + " " + id;
    if (!Array.isArray(review.map) || review.map.length === 0) { errors.push("Unmapped upstream rule: " + where + " has no disposition"); continue; }
    const seen = new Set();
    for (const target of review.map) {
      const fingerprint = JSON.stringify(target);
      if (seen.has(fingerprint)) errors.push("Duplicate disposition at " + where);
      seen.add(fingerprint);
      if (keys(target, ["gate"])) {
        const [route, gate, extra] = String(target.gate).split("/");
        if (extra !== undefined || !requirements.get(route)?.ids.has(gate)) errors.push("Unknown native requirement gate " + target.gate + " at " + where);
      } else if (keys(target, ["native", "quote"])) {
        if (!nativeDoc(target.native)) { errors.push("Invalid native document " + target.native + " at " + where); continue; }
        if (typeof target.quote !== "string" || target.quote.length < MIN_QUOTE || target.quote.includes("\n")) { errors.push("Native quote too short at " + where); continue; }
        if (!docs.has(target.native)) {
          try { docs.set(target.native, (await safeRead(skill, "native/" + target.native)).toString("utf8")); }
          catch { docs.set(target.native, null); }
        }
        const doc = docs.get(target.native);
        if (doc === null) errors.push("Missing native document " + target.native + " at " + where);
        else if (!doc.includes(target.quote)) errors.push("Native text missing from " + target.native + " at " + where + ": " + JSON.stringify(target.quote));
        else if (doc.indexOf(target.quote) !== doc.lastIndexOf(target.quote)) errors.push("Ambiguous native quote in " + target.native + " at " + where + ": " + JSON.stringify(target.quote));
      } else if (keys(target, ["exclude", "reason"])) {
        if (!Object.hasOwn(EXCLUSIONS, target.exclude)) errors.push("Unknown exclusion category " + target.exclude + " at " + where);
        if (typeof target.reason !== "string" || target.reason.trim().length < MIN_REASON || target.reason.includes("\n"))
          errors.push("Exclusion needs a justification of at least " + MIN_REASON + " characters at " + where);
      } else if (keys(target, ["same"])) {
        const other = ruleIds.get(target.same);
        if (!other || target.same === id) errors.push("Unknown same-rule reference " + target.same + " at " + where);
        else if (!Array.isArray(other.review.map) || other.review.map.some((next) => next && typeof next === "object" && Object.hasOwn(next, "same"))) errors.push("Chained same-rule reference " + target.same + " at " + where);
      } else errors.push("Invalid disposition at " + where + ": " + JSON.stringify(target));
    }
  }
  if (errors.length) throw Error(errors.length + " semantic overlay error(s):\n" + errors.join("\n"));
  return { requirements };
}

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\]\(/g, "]\\(").replace(/\t/g, " ");
function excerpt(text) {
  const points = [...text.trim()];
  return escape(points.length > 200 ? points.slice(0, 200).join("").trimEnd() + "…" : points.join(""));
}

export function renderOverlay(overlayBytes, overlay, extracted, requirements) {
  const rules = new Map();
  for (const file of extracted) for (const rule of file.rules) rules.set(rule.id, { path: file.path, line: rule.line });
  const reviewed = new Map(overlay.files.map((file) => [file.path, new Map(file.rules.map((rule) => [rule.id, rule.map]))]));
  const reviewedById = new Map([...reviewed.values()].flatMap((rules) => [...rules]));
  const counts = { gate: 0, native: 0, same: 0, exclude: 0 };
  const categories = Object.fromEntries(Object.keys(EXCLUSIONS).map((name) => [name, 0]));
  const byGate = new Map();
  const body = [];
  let total = 0;
  for (const file of extracted) {
    body.push("### `" + file.path + "`", "", "Pinned sha256 `" + file.sha256 + "`.", "");
    for (const rule of file.rules) {
      total++;
      const map = reviewed.get(file.path).get(rule.id);
      body.push("- [L" + rule.line + "](../upstream/" + file.path + ") `" + rule.id + "`: " + excerpt(rule.text));
      for (const target of map) {
        if (target.gate) {
          counts.gate++;
          const [route, gate] = target.gate.split("/");
          if (!byGate.has(target.gate)) byGate.set(target.gate, []);
          byGate.get(target.gate).push(rule.id);
          body.push("  - Gate [" + target.gate + "](" + requirements.get(route).document + "#" + route + ")");
        } else if (target.native) {
          counts.native++;
          body.push("  - Native [" + target.native + "](" + target.native + "): “" + escape(target.quote) + "”");
        } else if (target.same) {
          counts.same++;
          const other = rules.get(target.same);
          body.push("  - Same rule as `" + target.same + "` (`" + other.path + "` L" + other.line + ")");
        } else {
          counts.exclude++;
          categories[target.exclude]++;
          body.push("  - Excluded, " + target.exclude + ": " + escape(target.reason));
        }
      }
    }
    body.push("");
  }
  const resolved = (map) => map.flatMap((target) => target.same ? reviewedById.get(target.same) : [target]);
  const carried = [...reviewedById.values()].filter((map) => resolved(map).some((target) => target.gate || target.native)).length;
  const index = [...byGate.keys()].sort().map((gate) => "- `" + gate + "`: " + byGate.get(gate).map((id) => "`" + id + "`").join(", "));
  const text = [
    "# Upstream rule overlay", "",
    "Generated by `node scripts/sync-overlay.mjs` from [semantic-overlay.json](semantic-overlay.json). Do not edit it by hand; `node scripts/sync-overlay.mjs --check` fails when it is stale.", "",
    "Overlay: `semantic-overlay.json` sha256 `" + sha(overlayBytes) + "`", "",
    "Upstream: commit `" + overlay.upstreamCommit + "`", "",
    "Every line of the pinned upstream source that states a MUST, required or never rule is listed below with the native requirement gate or native guidance text that carries it, a pointer to the same rule elsewhere upstream, or a justified exclusion. A line matches when it contains the word `must`, `mustn't`, `required` or `never` in any letter case. The mapping is reviewed text coverage. It is not evidence that a model followed the rule.", "",
    "| Disposition | Targets |", "| --- | ---: |",
    "| Native requirement gate | " + counts.gate + " |",
    "| Native guidance text | " + counts.native + " |",
    "| Same rule as another upstream line | " + counts.same + " |",
    "| Excluded | " + counts.exclude + " |", "",
    total + " upstream rules in " + extracted.length + " files; " + byGate.size + " distinct gates. Following same-rule pointers, " +
      carried + " rules are carried by native text and " + (total - carried) + " are excluded.", "",
    "## Exclusion categories", "",
    ...Object.entries(EXCLUSIONS).map(([name, meaning]) => "- `" + name + "` (" + categories[name] + "): " + meaning), "",
    "## Rules by upstream file", "",
    ...body,
    "## Upstream rules by native gate", "",
    ...index, "",
  ].join("\n");
  return { bytes: Buffer.from(text), total, files: extracted.length, counts, gates: byGate.size, carried };
}

export async function syncOverlay(root, check = false) {
  root = resolve(root);
  const skill = join(root, "skills/pstack");
  const { source, files } = await loadPinnedSource(skill);
  const extracted = extractRules(source.files, files);
  const overlayBytes = await safeRead(skill, OVERLAY);
  const overlay = JSON.parse(overlayBytes);
  const { requirements } = await validateOverlay(skill, overlay, extracted, source);
  const rendered = renderOverlay(overlayBytes, overlay, extracted, requirements);
  const path = join(skill, OUTPUT);
  try { if (!(await lstat(path)).isFile()) throw Error("Non-file output: " + path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (check) {
    let actual;
    try { actual = await readFile(path); } catch { throw Error("Missing generated overlay: " + OUTPUT); }
    if (!actual.equals(rendered.bytes)) throw Error("Stale generated overlay: " + OUTPUT);
  } else await writeFile(path, rendered.bytes);
  return { files: rendered.files, rules: rendered.total, carried: rendered.carried, gates: rendered.gates, targets: rendered.counts, check };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some((arg) => arg !== "--check")) throw Error("Usage: node scripts/sync-overlay.mjs [--check]");
    console.log(JSON.stringify(await syncOverlay(resolve(import.meta.dirname, ".."), args.includes("--check"))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
