import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Catalog, Selection } from "./workflow.js";

// Structural copies of the optional host command runtime (S1 spawn/collect with
// selection receipts, S2 requester catalog, S4 owned-child list, S6 scheduled
// turns). Older SDKs do not declare them, so the plugin probes values, never types.
export type NativeSelection = { requested: Selection; resolved?: Selection; observed?: Selection };
export type NativeAccepted = { runId: string; childSessionKey: string; completionMode: "collect"; selection?: NativeSelection };
export type NativeCompletion = {
  runId: string; sessionKey: string; status: "done" | "failed" | "killed" | "timeout"; result: string;
  /** H-1: the text `result` exceeded the host's 100 KB bound or its complete answer was unavailable. */
  resultTruncated?: true;
  structured?: unknown; error?: string; schemaError?: string; label?: string; selection?: NativeSelection;
};
export type NativeCollection = { completed: NativeCompletion[]; pending: string[]; errors?: { runId: string; error: "not_found" | "not_owner" }[]; success?: false };
export type NativeChild = { runId: string; childSessionKey: string; requestId: string; label?: string; status: string };
export type NativeSubagentRuntime = {
  spawn(params: {
    requestId: string; task: string; label?: string; model?: string; thinking?: string;
    fastMode?: boolean | "auto" | "ultrafast"; context?: "fork" | "isolated"; outputSchema?: Record<string, unknown>;
    /** S5: a narrow-only profile this plugin registered; its schema, if any, replaces outputSchema. */
    profile?: string;
  }): Promise<NativeAccepted>;
  collect(params: { ids: string[]; timeoutSeconds?: number }): Promise<NativeCollection>;
  list?(params?: { status?: string }): Promise<NativeChild[]>;
};
export type RequesterCatalog = {
  revision: string; state: "prepared" | "pending";
  /** `family` only on hosts advertising `requester-model-family-v1`; absent means unknown. */
  models: { id: string; provider: string; name: string; family?: string; thinkingLevels?: string[]; fastModes?: (boolean | "auto")[] }[];
  selectionPolicy?: { restricted: true; defaultModel: string | null };
};
export type RequesterModels = { list(): Promise<RequesterCatalog> };
export type ScheduledTurns = {
  schedule(request: {
    requestId: string; command: string; args?: string;
    schedule: { kind: "at"; at: string } | { kind: "every"; everyMs: number };
    deadlineAtMs: number; maxRuns: number;
  }): Promise<{ jobId: string; deadlineAtMs: number; maxRuns: number; survivesRestart?: boolean }>;
};
export type Invocation = { subagents?: NativeSubagentRuntime; models?: RequesterModels; scheduledTurns?: ScheduledTurns };

/** Registration-time host tokens: absent tokens mean the matching opt-in is never requested. */
export function hostCapabilities(api: OpenClawPluginApi) {
  const tokens = (api.runtime as { capabilities?: readonly string[] } | undefined)?.capabilities;
  const has = (token: string) => Array.isArray(tokens) && tokens.includes(token);
  const subagents = has("command-native-subagents-v1"), models = has("requester-model-catalog-v1");
  const scheduled = subagents && has("command-scheduled-turns-v1");
  return {
    subagents, models, scheduled, list: has("native-subagent-list-v1"), restart: has("command-scheduled-turns-restart-v1"),
    profiles: has("native-subagent-profiles-v1"), family: has("requester-model-family-v1"),
    /** Blind native children (`blind: true`): the child's prompt omits its model identity and workspace. */
    blind: has("native-subagent-blind-v1"),
    /** Opt-ins for controller commands; the manifest declares the contracts these require. */
    commandCapabilities: [...(subagents ? ["subagents"] : []), ...(models ? ["models"] : []), ...(scheduled ? ["scheduledTurns"] : [])],
  };
}
export type HostCapabilities = ReturnType<typeof hostCapabilities>;

/** Invocation-bound capabilities; a declared opt-in alone never implies the host granted them. */
export function invocation(ctx: PluginCommandContext): Invocation {
  const runtime = (ctx as { runtimeContext?: Partial<Invocation> }).runtimeContext;
  const subagents = runtime?.subagents;
  return {
    subagents: subagents && typeof subagents.spawn === "function" && typeof subagents.collect === "function" ? subagents : undefined,
    models: runtime?.models && typeof runtime.models.list === "function" ? runtime.models : undefined,
    scheduledTurns: runtime?.scheduledTurns && typeof runtime.scheduledTurns.schedule === "function" ? runtime.scheduledTurns : undefined,
  };
}

/** The host's canonical family token; anything else is dropped, so the family stays unknown. */
const FAMILY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Planner projection of the requester catalog. Host IDs are provider-relative, so the
 * exact native reference is provider/id. A row's canonical `family` is copied only from
 * hosts advertising `requester-model-family-v1`; without it, or without a well-formed
 * value, the row has no family and nothing is inferred from model names.
 */
export function plannerCatalog(catalog: RequesterCatalog, options: { family?: boolean } = {}): Catalog {
  const seen = new Set<string>();
  return catalog.models.flatMap((model) => {
    const id = model.provider + "/" + model.id;
    if (seen.has(id)) return [];
    seen.add(id);
    const family = options.family && typeof model.family === "string" && model.family.length <= 64 && FAMILY.test(model.family) ? model.family : undefined;
    return [{ id, ...(family ? { family } : {}), ...(model.thinkingLevels ? { thinkingLevels: [...model.thinkingLevels] } : {}), ...(model.fastModes ? { fastModes: [...model.fastModes] } : {}) }];
  });
}

/** The host asks callers to retry a rejected read once in the same invocation, then report it. */
export async function readRequesterCatalog(models: RequesterModels, options: { family?: boolean } = {}) {
  let catalog: RequesterCatalog;
  try { catalog = await models.list(); } catch { catalog = await models.list(); }
  return { state: catalog.state, revision: catalog.revision, catalog: plannerCatalog(catalog, options) };
}

/** A host profile this plugin instance registered, with the digest of the bytes it registered. */
export type HostProfile = { id: string; instructionsSha256: string; ownsOutputSchema: boolean };
export type HostProfiles = ReadonlyMap<string, HostProfile>;
type ProfileDefinition = { id: string; description: string; instructionsFile: string; tools: { deny: string[] }; outputSchema?: Record<string, unknown> };

/**
 * S5: registers narrow-only profiles only where the host advertises the capability and
 * offers the method. The digest is computed from the same package bytes the host reads
 * at registration; the host records its own digest on every child run.
 */
export function registerHostProfiles(api: OpenClawPluginApi, supported: boolean, root: string, definitions: ProfileDefinition[]): HostProfiles {
  const registered = new Map<string, HostProfile>();
  const agent = (api as { agent?: { registerSubagentProfile?: (profile: ProfileDefinition) => void } }).agent;
  if (!supported || typeof agent?.registerSubagentProfile !== "function") return registered;
  for (const definition of definitions) {
    try {
      const bytes = readFileSync(join(root, definition.instructionsFile));
      agent.registerSubagentProfile(definition);
      registered.set(definition.id, { id: definition.id, instructionsSha256: createHash("sha256").update(bytes).digest("hex"), ownsOutputSchema: definition.outputSchema !== undefined });
    } catch (error) {
      api.logger.warn("Pstack host profile " + definition.id + " was not registered; its roles stay prompt-enforced: " + String(error));
    }
  }
  return registered;
}
