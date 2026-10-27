import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { checkPlan } from "../skills/pstack/scripts/plan-check.mjs";

export const planCheckParameters = {
  type: "object", additionalProperties: false,
  properties: {
    source: { type: "string", maxLength: 131072, description: "Complete plan Markdown supplied as data, never a filesystem path or script." },
    label: { type: "string", minLength: 1, maxLength: 256, pattern: "\\S", description: "Display-only diagnostic label. Never opened as a path." },
  }, required: ["source"],
};
function assertArguments(value: unknown) {
  const checked = validateJsonSchemaValue({ schema: planCheckParameters, value });
  if (!checked.ok) throw Error("Invalid pstack_plan_check arguments: " + checked.errors.slice(0, 4).map(e => e.text).join("; "));
}
export function registerPlanCheckTool(api: OpenClawPluginApi) {
  api.registerTool(ctx => ({
    name: "pstack_plan_check", label: "Pstack read-only plan check",
    description: "Check supplied Markdown with all shipped native plan gates. Does not read a file, execute, mutate checkboxes, verify evidence or approve a plan. A text-gate pass is not route execution proof.",
    parameters: planCheckParameters,
    prepareArguments: args => { assertArguments(args); return args as Record<string, unknown>; },
    execute: async (_id, params) => {
      ctx.assertInvocationCurrent?.();
      assertArguments(params);
      const p = params as { source: string; label?: string };
      const checked = checkPlan(p.source, p.label ?? "supplied-plan.md");
      ctx.assertInvocationCurrent?.();
      const details = { ...checked, status: checked.problems.length ? "ISSUES" : "PASS", verification: "plan-structure-only",
        notice: "Text gates do not prove route execution, checked evidence, independent review, live/perf acceptance or approval. No input is opened as a path or executed." };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  }), { names: ["pstack_plan_check"] });
}
