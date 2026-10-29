import { executedContracts, frozenSchema, executedContextSchema } from "../skills/pstack/scripts/interrogate-semantics.mjs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { PANEL_ROLES, PROFILES, profile, checkOutput, renderBrief, requiredRead, scopeAdvisories, scopeErrors, assertProofContext } from "../skills/pstack/scripts/output-contracts.mjs";
import type { HostProfiles } from "./native-runtime.js";

const paths = { type: "array", minItems: 1, maxItems: 256, items: { type: "string", minLength: 1, maxLength: 1024, pattern: "^[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f][^\\u0000-\\u001f\\u007f]*$" } };
export const briefParameters = {
  type: "object", additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["render", "check"] },
    profile: { type: "string", enum: [...PROFILES], description: "render: native brief template to fill." },
    task: { type: "string", minLength: 1, maxLength: 16000, pattern: "\\S", description: "render: the bounded task, treated as data." },
    scope: { ...paths, description: "Parent-supplied review scope: literal repo-relative file paths, one per entry, exactly as findings will name them (app/[id]/page.tsx is one file). Expand a diff or pattern to its files first (for example git diff --name-only main...HEAD). Refused: blank, absolute, a .. segment, a control character or Unicode line break (U+0085, U+2028, U+2029), a leading : (pathspec magic) or a trailing / (directory). Required to render the read-only reviewer; check rejects a report that widens it." },
    contract: { type: "string", enum: [...PROFILES, ...PANEL_ROLES, ...Object.keys(executedContracts)], description: "check: profile id or panel/pool role whose output contract applies." },
    output: { type: "object", additionalProperties: true, description: "check: the child's returned JSON object, validated without coercion." },
    status: { type: "string", enum: ["PASS", "ISSUES", "BLOCKED"], description: "check: the child's reported result status, when its contract depends on it." },
    frozen: frozenSchema,
    reviewers: executedContextSchema.properties.reviewers,
    candidates: { ...paths, maxItems: 8, description: "check cross-judge: exact usable candidate labels." },
  }, required: ["action"],
};
const allowed: Record<string, string[]> = { render: ["profile", "task", "scope"], check: ["contract", "output", "scope", "status", "candidates", "frozen", "reviewers"] };
function assertArguments(value: unknown) {
  const checked = validateJsonSchemaValue({ schema: briefParameters, value });
  if (!checked.ok) throw Error("Invalid pstack_brief arguments: " + checked.errors.slice(0, 4).map(e => e.text).join("; "));
  const p = value as Record<string, unknown>;
  const fields = allowed[p.action as string]!;
  if (Object.keys(p).some(k => k !== "action" && !fields.includes(k))) throw Error("Unexpected fields for pstack_brief " + p.action);
  if (p.action === "render" && (!p.profile || !p.task)) throw Error("render requires profile and task");
  if (p.action === "check" && (!p.contract || p.output === undefined)) throw Error("check requires contract and output");
  const scope = p.scope === undefined ? [] : scopeErrors(p.scope as string[]);
  if (scope.length) throw Error("Invalid pstack_brief scope: " + scope.slice(0, 4).join("; "));
}
const reply = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });

/** GitHub-style anchor of a markdown heading: lowercase, punctuation dropped, spaces as hyphens. */
const anchor = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
const anchors = (markdown: string) => new Set([...markdown.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map(m => anchor(m[1]!)));

/**
 * A delegate's `contractRead` may name a required read as `path#fragment`, with the path
 * absolute as rendered or literal repo-relative (for example
 * `skills/pstack/native/workflows.md#poteto-mode`). Such an entry counts as that read only when
 * the fragment names an existing heading of the file, and the read's own section when it has
 * one. Every other entry is left as written, so the existing exact-path refusal still applies.
 */
export async function contractReadsAsRequired(entries: unknown, reads: { path: string; section?: string }[], root: string) {
  if (!Array.isArray(entries)) return { entries, errors: [] as string[] };
  const files = new Map<string, Promise<Set<string>>>(), errors: string[] = [];
  const headings = (file: string) => files.get(file) ?? files.set(file, readFile(file, "utf8").then(anchors)).get(file)!;
  const mapped = await Promise.all(entries.map(async (entry) => {
    if (typeof entry !== "string" || reads.some(r => r.path === entry)) return entry;
    const at = entry.indexOf("#");
    const [base, fragment] = at < 0 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)];
    if (!fragment || fragment.includes("#") || /\s/.test(base) || base.includes("\\")) return entry;
    // Literal paths only: absolute as rendered, or repo-relative without `.`/`..` segments.
    const literal = isAbsolute(base) ? base : base.split("/").some(part => part === "" || part === "." || part === "..") ? undefined : join(root, base);
    const read = literal && normalize(literal) === literal ? reads.find(r => r.path === literal) : undefined;
    if (!read) return entry;
    const wanted = fragment.toLowerCase();
    if (!(await headings(read.path)).has(wanted)) { errors.push("contractRead " + JSON.stringify(entry) + ": #" + fragment + " names no heading in " + read.path.slice(root.length + 1).split(sep).join("/")); return entry; }
    if (read.section && anchor(read.section) !== wanted) { errors.push("contractRead " + JSON.stringify(entry) + ": the required read is section #" + anchor(read.section) + ", not #" + fragment); return entry; }
    return read.path;
  }));
  return { entries: mapped, errors };
}

export function registerBriefTool(api: OpenClawPluginApi, root: string, hostProfiles: HostProfiles = new Map()) {
  const skill = join(root, "skills/pstack");
  // Sections are named beside the literal file path, so every listed path exists as written.
  const reads = (id: string) => profile(id)!.requiredReads.map((r: string) => { const read = requiredRead(r); return { ...read, path: join(skill, read.path) }; });
  const readPaths = (id: string) => [...new Set(reads(id).map((r: { path: string }) => r.path))];
  api.registerTool(ctx => ({
    name: "pstack_brief", label: "Pstack native briefs and output contracts",
    description: "Render a labeled native delegate/comment-reviewer brief, or check a child's returned JSON against its profile or panel-role output contract. Read-only: does not spawn, collect, edit or approve. A valid shape is agent-attested, never proof the work is correct.",
    parameters: briefParameters,
    prepareArguments: args => { assertArguments(args); return args as Record<string, unknown>; },
    execute: async (_id, params) => {
      ctx.assertInvocationCurrent?.();
      assertArguments(params);
      const p = params as Record<string, any>;
      if (p.action === "render") {
        const found = profile(p.profile)!;
        const instructions = await readFile(join(skill, found.instructionsFile), "utf8");
        ctx.assertInvocationCurrent?.();
        const brief = renderBrief(p.profile, { instructions, task: p.task, requiredReads: reads(p.profile), scope: p.scope });
        const host = hostProfiles.get(found.id);
        // A model-facing sessions_spawn cannot select a host profile, so this brief is prompt-enforced.
        return reply({ assurance: "agent-attested", enforcement: "prompt-enforced", profile: found.id, label: found.label, routingRole: found.routingRole, readOnly: found.readOnly,
          outputContract: found.outputSchema, requiredReads: readPaths(p.profile), brief, warnings: scopeAdvisories(p.scope ?? []),
          hostProfile: host ? { id: host.id, registered: true, instructionsSha256: host.instructionsSha256, appliesTo: "native controller spawns only" } : { id: found.id, registered: false },
          notice: "Resolve the routing role with pstack_route and pass this brief as the native sessions_spawn task. Rendering is not admission, execution or tool enforcement; sessions_spawn cannot select a host profile." });
      }
      const context: Record<string, unknown> = { status: p.status, candidates: p.candidates, scope: p.scope };
      if (Object.hasOwn(executedContracts, p.contract)) {
        if (!["PASS", "ISSUES", ...(p.contract === "interrogate-executed-lead" ? ["BLOCKED"] : [])].includes(p.status)) throw Error("Executed check needs explicit status; only a lead may carry BLOCKED accounting");
        assertProofContext(p.frozen);
        if (p.contract === "interrogate-executed-lead") assertProofContext({ frozen: p.frozen, reviewers: p.reviewers }, true);
        Object.assign(context, { frozen: p.frozen, reviewers: p.reviewers });
      }
      let output = p.output, readErrors: string[] = [];
      if (p.contract === "poteto-agent") {
        const routes = JSON.parse(await readFile(join(skill, "native/routes.json"), "utf8"));
        ctx.assertInvocationCurrent?.();
        Object.assign(context, { requiredReads: readPaths("poteto-agent"), principles: routes.principles });
        if (p.output && typeof p.output === "object" && !Array.isArray(p.output) && Array.isArray(p.output.contractRead)) {
          const read = await contractReadsAsRequired(p.output.contractRead, reads("poteto-agent"), root);
          ctx.assertInvocationCurrent?.();
          output = { ...p.output, contractRead: read.entries }; readErrors = read.errors;
        }
      }
      if (p.contract === "comment-sicko" && !p.scope) throw Error("check comment-sicko requires the parent-supplied scope");
      const errors = [...readErrors, ...checkOutput(p.contract, output, context)];
      // The render-time scope advisory is repeated here, so a pass over a scope that may name a diff label is never silent.
      const warnings = scopeAdvisories(p.scope ?? []);
      return reply({ assurance: "agent-attested", contract: p.contract, status: errors.length ? "ISSUES" : "PASS", errors, warnings,
        notice: errors.length ? "Reject this report; rerun the child once with these failures named."
          : warnings.length ? "Shape and cross-field rules hold, but the scope may not name the intended files (see warnings); a pass over the wrong files proves nothing. Inspect the artifacts yourself; this is not correctness evidence."
          : "Shape and cross-field rules hold. Inspect the artifacts yourself; this is not correctness evidence." });
    },
  }), { names: ["pstack_brief"] });
}
