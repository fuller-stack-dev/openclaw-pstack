import { ROLE_SPECS } from "../skills/pstack/scripts/model-routing.mjs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";

// Fixed planner records are closed. Host-owned JSON dictionaries are explicitly
// open: bare type:object is normalized into an empty CLOSED object by native
// OpenAI compatibility preparation, before the planner can inspect the request.
const thinking = { type: "string" };
// Gemini collapses mixed-type unions. Leave these values untyped on the wire;
// the existing planner validates exact controls without native type coercion.
const fastMode = {
  description: "Requested fast mode: boolean, auto or ultrafast; planner validated.",
};
const selection = {
  type: "object",
  properties: { model: { type: "string" }, thinking, fastMode },
  additionalProperties: false,
};
const role = { type: "string", enum: Object.keys(ROLE_SPECS) };
const hostRecord = {
  type: "object",
  additionalProperties: true,
};

export const routeParameters = {
  type: "object",
  properties: {
    role,
    task: { type: "string" },
    catalog: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          family: { type: "string" },
          // Capability contents remain host metadata, not a second capability
          // registry. The planner checks the requested values against these lists.
          thinkingLevels: { type: "array", items: {} },
          fastModes: { type: "array", items: {} },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    spawnSchema: {
      ...hostRecord,
      description:
        "Actual current sessions_spawn JSON Schema, including arbitrary nested schema keywords.",
    },
    baseArgs: {
      ...hostRecord,
      description:
        "Native spawn arguments excluding task/model/thinking/fastMode; keys checked against spawnSchema. Native execution retains validation and requester policy.",
    },
    trialArgs: {
      type: "array",
      items: hostRecord,
      description:
        "Optional native spawn arguments for each selection in order (for example each trial's own cwd); same key rules as baseArgs.",
    },
    blind: {
      type: "boolean",
      description:
        "Blind trial: return the task without the routing snapshot, model IDs, role or workspace, and return custody separately for the parent record. A task or argument that names a selected model or the workspace is refused. On hosts with native blind children the returned arguments also carry blind: true and context \"isolated\"; hostBlind in the result says whether the host blinded the child's own prompt.",
    },
    withheld: {
      type: "array",
      items: { type: "string" },
      description:
        "Blind plans: judge-only text the visible task and arguments must not contain as whole words (the rubric, expected results or oracle, the parent's own results), one criterion or expected value per item. Required for blind arena runners trials, whose task must also not frame the trial as measured (rubric, oracle, expected output, scoring, judging or competitors); the request's own subject words are allowed.",
    },
    snapshot: {
      type: "object",
      properties: {
        version: { type: "integer" },
        role,
        source: { type: "string", enum: ["inherit", "config", "override"] },
        selections: { type: "array", items: selection },
        poolIndex: {
          description: "Saved pool index 0/1 for pool roles; null otherwise; planner validated.",
        },
        diversity: {
          type: "string",
          enum: ["not-applicable", "different-family", "not-established", "unverified"],
        },
      },
      required: ["version", "role", "source", "selections", "poolIndex", "diversity"],
      additionalProperties: false,
    },
    overrides: {
      description:
        "Preset name, inherit, selection object, or two-entry panel/pool array; strictly planner validated.",
    },
    parentModel: { type: "string" },
    parentFamily: { type: "string" },
    action: { type: "string", enum: ["plan", "confirm"] },
    requested: selection,
    // Receipts are host-owned and extensible; confirmSelection interprets only
    // native rejection status and resolved model/provider, never authority.
    receipt: {
      ...hostRecord,
      description: "Unmodified native spawn receipt; not a grant of authority.",
    },
    evidence: {
      type: "object",
      properties: {
        source: { type: "string" },
        model: { type: "string" },
        provider: { type: "string" },
        thinking: { type: "string" },
        fastMode: {
          description:
            "Raw native observed fastMode, compared without coercion to the requested value.",
        },
        serviceTier: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

// Agent-loop validation supports coercion. The planner deliberately does not:
// e.g. fastMode:"true", family:42 and snapshot.version:"1" are malformed, not
// requests to repair. Use the SAME owned schema with the public non-coercing
// validator before native coercion, not a second hand-written schema/validator.
export function prepareRouteArguments(args: unknown) {
  const checked = validateJsonSchemaValue({ schema: routeParameters, value: args });
  if (!checked.ok) {
    // The host does not classify prepareArguments throws as argument validation.
    // Return a deliberately schema-invalid envelope for native classification.
    // The root is closed, but Gemini drops additionalProperties: the catalog
    // entry also deliberately lacks its required id, which no type conversion
    // can invent. Thus even that descriptor rejects before policy/execution.
    // Diagnostics are bounded; original arguments remain error-receipt data.
    return {
      catalog: [{}],
      __pstack_invalid_arguments__: {
        diagnostics: checked.errors.slice(0, 8).map((error) => error.text.slice(0, 256)),
        originalArguments: args,
      },
    };
  }
  return args as Record<string, unknown>;
}
