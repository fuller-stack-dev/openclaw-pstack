import { registerPlanCheckTool } from "./plan-tool.js";
import { registerBriefTool } from "./brief-tool.js";
import { registerTrailTool, trailOptions } from "./trail-tool.js";
import { registerWorktreeAuditTool } from "./worktree-audit-tool.js";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type PluginCommandContext,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  transition,
  readMode,
  importLegacy,
  importCurrentLegacy,
  cleanupStale,
  MAX_RECORDS,
  type Identity,
} from "./state.js";
import { planFromWorkspace } from "../skills/pstack/scripts/model-routing-cli.mjs";
import { routeParameters, prepareRouteArguments } from "./route-schema.js";
import { routeCommands, readOnlyRouteContext, readOnlyRouteHelp, READ_ONLY_ROUTES, type RouteName } from "./route-commands.js";
import { registerWorkflowTool, registerSpawnGuard, type OwnerResolver } from "./workflow-tool.js";
import { yieldDecision } from "./yield-guard.js";
import { collectorDecision } from "./collector-bound.js";
import { hostCapabilities, invocation, readRequesterCatalog, registerHostProfiles, type Invocation } from "./native-runtime.js";
import { subagentProfiles } from "../skills/pstack/scripts/output-contracts.mjs";
import { CONTROLLER_KINDS, activeNative, downgradeRefusal, nativePromptContext, parseResume, resumeNative, startNative } from "./native-commands.js";
import type { Kind } from "./workflow.js";
import { randomUUID } from "node:crypto";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const help =
  "Pstack: /pstack on | off | status | help | <task>. Owner-only /pstack migrate imports current active legacy records online without toggling mode. /poteto_mode shares mode. Use pstack_route and native sessions_spawn for skill-guided panels; deterministic panel/resume subcommands are unavailable in v1. Children never inherit sticky mode, but do inherit native requester tool policy.";
const nativeHelp =
  "Pstack: /pstack on | off | status | help | <task>. Native controllers: /pstack-architect, -arena, -interrogate, -swarm, -how, -why, -reflect <task> run their panels as code; /pstack resume [approve [notes] | revise <notes> | correct <errors> | cancel] continues the session's native workflow (correct asks for one corrected deliverable); /pstack architect|arena|interrogate shows its state. Owner-only /pstack migrate imports legacy records. /poteto_mode shares mode. Children never inherit sticky mode, but do inherit native requester tool policy.";
const SINGLE_WORD = ["architect", "arena", "interrogate", "resume"];
/** A read-only route command's continued agent turn must start within this window to receive its context. */
const READ_ONLY_TURN_TTL_MS = 5 * 60_000;
const squash = (value: string) => value.replace(/\s+/g, " ").trim();
export function register(api: OpenClawPluginApi) {
  // CLI metadata has no runtime by host design; CLI execution registers in full mode.
  if (api.registrationMode !== "cli-metadata" && typeof api.runtime?.state?.openKeyedStoreV2 !== "function") {
    throw Error(
      "Pstack requires keyed-store V2 (api.runtime.state.openKeyedStoreV2): use OpenClaw >=2026.10.10-beta.2 or a current main build that exports this contract.",
    );
  }
  const store = (assertCurrent?: () => void) =>
    api.runtime.state.openKeyedStoreV2(
      { namespace: "session-mode-v2", maxEntries: MAX_RECORDS, overflowPolicy: "reject-new" },
      assertCurrent ? { assertCurrent } : undefined,
    );
  let cleanupCursor = "";
  // CLI metadata registration has no runtime; it registers nothing that needs these tokens.
  const caps = api.registrationMode === "cli-metadata" ? hostCapabilities({} as OpenClawPluginApi) : hostCapabilities(api);
  // Identifies this plugin instance so a schedule that cannot survive a restart or reload is re-armed.
  // S5: narrow-only host profiles where offered; otherwise every brief stays prompt-enforced.
  const profiles = registerHostProfiles(api, api.registrationMode !== "cli-metadata" && caps.profiles, root, subagentProfiles());
  const wait = api.pluginConfig?.nativeWaitSeconds;
  const nativeHost = { api, root, instance: { pid: process.pid, load: randomUUID() }, profiles, family: caps.family,
    ...(Number.isInteger(wait) && (wait as number) >= 0 && (wait as number) <= 30 ? { waitSeconds: wait as number } : {}) };
  // One pending read-only route turn per exact session incarnation, set only by an authorized
  // command and consumed by the prompt build of the agent turn that command continues.
  const readOnlyTurns = new Map<string, { route: RouteName; question: string; workspace: string; expires: number }>();
  const turnKey = (sessionKey: string, sessionId: string) => sessionKey + "\u0000" + sessionId;
  const hostFacts = { controllers: caps.subagents && caps.models, scheduled: caps.scheduled, profiles: [...profiles.keys()] };
  const ownerFor: OwnerResolver = async (ctx) => {
    if (!ctx.sessionKey || !ctx.sessionId) throw Error("Exact requester session incarnation required");
    const { agentId, entry } = await entryFor(ctx.sessionKey);
    if (!entry || entry.sessionId !== ctx.sessionId || (ctx.agentId && ctx.agentId !== agentId))
      throw Error("Requester session incarnation changed");
    const workspace = await workspaceFor(agentId, entry);
    if ((await entryFor(ctx.sessionKey)).entry?.sessionId !== ctx.sessionId)
      throw Error("Requester session incarnation changed during workspace resolution");
    return { sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, workspace };
  };
  async function entryFor(sessionKey: string) {
    const agentId = parseAgentSessionKey(sessionKey)?.agentId;
    if (!agentId) throw Error("Pstack requires a native agent session key");
    const entry = await api.runtime.agent.session.getSessionEntryAsync({
      sessionKey,
      agentId,
      readConsistency: "latest",
    });
    return { agentId, entry };
  }
  // Commands, hooks and migration share a key even when the host reply path
  // supplies a different prepared/run workspace to the hook.
  async function workspaceFor(agentId: string, entry: { spawnedWorkspaceDir?: string }) {
    return realpath(
      entry.spawnedWorkspaceDir ??
        api.runtime.agent.resolveAgentWorkspaceDir(
          api.runtime.config.current({ clone: true }),
          agentId,
        ),
    );
  }
  async function migrationEntryFor(sessionKey: string) {
    const { agentId, entry } = await entryFor(sessionKey);
    return entry ? { ...entry, workspace: await workspaceFor(agentId, entry) } : undefined;
  }
  async function command(ctx: PluginCommandContext, route?: RouteName) {
    // Route arguments are task data, never mode/migration controls. Preserve the
    // host commandBody and all authority fields for ordinary agent continuation.
    const readOnly = route !== undefined && READ_ONLY_ROUTES.includes(route);
    const suffix = ctx.args?.trim() || "";
    const arg = route ? route + (suffix ? " " + suffix : "") : suffix || "on";
    const control = route ? "" : arg.split(/\s+/, 1)[0]!.toLowerCase();
    const trailing = arg.slice(control.length).trim();
    const ignored = trailing ? " Trailing text was ignored; use /pstack <task> to run a task." : "";
    const native = invocation(ctx);
    const capable = Boolean(native.subagents && native.models);
    if (control === "help") return { text: (capable ? nativeHelp : help) + ignored };
    if (control === "migrate" && trailing)
      return { text: "Pstack migrate takes no arguments; mode was not changed." };
    const resume = route ? undefined : parseResume(arg);
    const singleWord = !route && SINGLE_WORD.includes(arg.toLowerCase());
    // A scheduled continuation carries no sender; only its exact resume form is admitted.
    const unattended = !ctx.senderId && resume?.workflowId !== undefined && !resume.action && arg.trim().split(/\s+/).length === 2;
    if (arg.length > 16000)
      return { text: "Pstack rejected: task exceeds 16000 characters; mode was not changed." };
    if (
      !ctx.isAuthorizedSender ||
      (!ctx.senderId && !(unattended && native.subagents)) ||
      !ctx.sessionKey ||
      !ctx.sessionId ||
      !["webchat", "internal"].includes(ctx.channel) ||
      !ctx.gatewayClientScopes?.some((s) => s === "operator.write" || s === "operator.admin")
    )
      return {
        text: readOnly
          ? readOnlyRouteHelp(route!) + " (Static help: this invocation lacks an authorized internal/webchat sender with operator.write and an exact session, so the agent did not answer your question.)"
          : "Pstack rejected: an authorized internal/webchat command sender with operator.write and an exact session is required.",
      };
    const assertCurrent = ctx.assertOwnerCurrent;
    try {
      assertCurrent?.();
      const { agentId, entry } = await entryFor(ctx.sessionKey);
      if (ctx.agentId && ctx.agentId !== agentId) throw Error("Host agent/session mismatch");
      if (!entry || entry.sessionId !== ctx.sessionId) throw Error("Session incarnation changed");
      const workspace = await workspaceFor(agentId, entry);
      if (control === "migrate") {
        // Native command owner authority is invocation-bound; the native store
        // revalidates it for mutations after awaited preparation.
        if (ctx.senderIsOwner !== true || !assertCurrent)
          return {
            text: "Pstack migration rejected: current native command-owner authority is required; mode was not changed.",
          };
        assertCurrent();
        const result = await importCurrentLegacy(
          store(assertCurrent),
          workspace,
          migrationEntryFor,
        );
        return { text: JSON.stringify(result, null, 2) };
      }
      const owner = { sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, workspace };
      const kind = route && CONTROLLER_KINDS.includes(route) ? (route as Kind) : undefined;
      if (resume || singleWord || (kind && capable)) {
        const active = await activeNative(api, owner, assertCurrent);
        if (resume && (native.subagents || active)) {
          // An in-progress native record is never continued as v1 skill-guided work.
          if (!native.subagents) return { text: downgradeRefusal(active!.record, active!.view) };
          return await resumeNative(nativeHost, ctx, resume, owner, native, unattended);
        }
        if (singleWord && !capable)
          return {
            text: active
              ? downgradeRefusal(active.record, active.view)
              : "Pstack deterministic panel/resume subcommands are unavailable in v1; mode was not changed. Use /pstack <task> with pstack_route and native sessions_spawn instead.",
          };
        if (singleWord && control !== "resume") {
          return {
            text: active && active.record.setup.kind === arg.toLowerCase()
              ? "Native " + active.record.setup.kind + " `" + active.record.id + "`: phase " + active.view.phase + ", status " + active.view.status + ". " + active.view.next
              : "No native " + arg.toLowerCase() + " workflow is in progress in this session" + (active ? " (`" + active.record.id + "` is a " + active.record.setup.kind + ")" : "") + ". Start one with /pstack-" + arg.toLowerCase() + " <task>.",
          };
        }
      }
      if (!ctx.senderId) throw Error("A command sender is required");
      const identity: Identity = {
        userId: ctx.senderId,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        workspace,
      };
      const state = store(assertCurrent);
      if (control === "status") {
        const mode = await readMode(state, identity);
        const active = await activeNative(api, owner, assertCurrent);
        const policy = ctx.config.plugins?.entries?.pstack?.hooks;
        const blocked =
          policy?.allowConversationAccess !== true || policy.allowPromptInjection === false;
        return {
          text:
            "Pstack " +
            (mode?.active ? "on" : "off") +
            "; exact incarnation " +
            ctx.sessionId +
            "; revision " +
            (mode?.revision ?? 0) +
            (blocked
              ? "; stored mode only: prompt injection is blocked by hook policy. Set plugins.entries.pstack.hooks.allowConversationAccess=true and do not disable allowPromptInjection; inspect the runtime hook before use."
              : "") +
            (active ? "; native " + active.record.setup.kind + " `" + active.record.id + "` at " + active.view.phase + " (" + active.view.status + ")" : "") +
            ignored,
        };
      }
      if (readOnly) {
        // The agent answers the question read-only; mode, tasks and jobs stay untouched.
        const now = Date.now();
        for (const [key, turn] of readOnlyTurns) if (turn.expires <= now) readOnlyTurns.delete(key);
        readOnlyTurns.set(turnKey(ctx.sessionKey, ctx.sessionId), { route: route!, question: squash(suffix), workspace, expires: now + READ_ONLY_TURN_TTL_MS });
        return { continueAgent: true, suppressReply: true };
      }
      assertCurrent?.();
      const mode = await transition(state, identity, control !== "off");
      // A committed toggle must never be blocked by unrelated retention work.
      try {
        const swept = await cleanupStale(
          state,
          async (key) => (await entryFor(key)).entry?.sessionId,
          cleanupCursor,
        );
        cleanupCursor = swept.cursor;
        if (swept.lookupFailed)
          api.logger.warn(
            "Pstack cleanup retained rows after native lookup failures: " + swept.lookupFailed,
          );
      } catch (error) {
        api.logger.warn("Pstack best-effort cleanup unavailable: " + String(error));
      }
      if (kind && capable) return await startNative(nativeHost, ctx, kind, suffix, owner, native);
      if (control === "on" || control === "off")
        return {
          text:
            "Pstack " +
            (mode?.active ? "on" : "off") +
            " (revision " +
            (mode?.revision ?? 0) +
            ")." +
            ignored,
        };
      return { continueAgent: true, suppressReply: true };
    } catch (error) {
      return { text: "Pstack error: " + String(error instanceof Error ? error.message : error) };
    }
  }
  // Controller commands request the native runtime only on hosts that advertise it;
  // older hosts register the same commands without the opt-in and keep v1 behavior.
  const withCapabilities = (definition: Parameters<OpenClawPluginApi["registerCommand"]>[0], requested = caps.commandCapabilities) =>
    api.registerCommand((requested.length ? { ...definition, runtimeCapabilities: requested } : definition) as Parameters<OpenClawPluginApi["registerCommand"]>[0]);
  for (const name of ["pstack", "poteto_mode"])
    withCapabilities({
      name,
      description: caps.subagents ? "Exact-session pstack mode and native workflow resume" : "Exact-session pstack workflow mode",
      acceptsArgs: true,
      requireAuth: true,
      requiredScopes: ["operator.write"],
      handler: command,
    });
  for (const { name, route } of routeCommands(api.pluginConfig?.bareRouteAliases === true)) {
    const controller = CONTROLLER_KINDS.includes(route) && caps.subagents && caps.models;
    withCapabilities({
      name,
      description: controller
        ? "Native pstack " + route + " controller where the host grants subagents; skill-guided otherwise"
        : "Skill-guided pstack " + route + "; agent-attested, not a native controller",
      acceptsArgs: true,
      requireAuth: true,
      requiredScopes: ["operator.write"],
      handler: (ctx) => command(ctx, route),
    }, controller ? caps.commandCapabilities : []);
  }
  api.on("before_prompt_build", async (event, ctx) => {
    ctx.hookInvocation?.assertActive();
    if (!ctx.sessionKey || !ctx.sessionId) return undefined;
    // The read-only route turn is the one carrying that command's question; consume it once.
    let routeNotice: string | undefined;
    const pendingRoute = readOnlyTurns.get(turnKey(ctx.sessionKey, ctx.sessionId));
    const request = squash(String((event as { currentUserMessage?: string }).currentUserMessage ?? event.prompt ?? ""));
    if (pendingRoute && pendingRoute.expires > Date.now() && (!pendingRoute.question || request.includes(pendingRoute.question.slice(0, 400)))) {
      readOnlyTurns.delete(turnKey(ctx.sessionKey, ctx.sessionId));
      routeNotice = readOnlyRouteContext(pendingRoute.route, root, pendingRoute.workspace, hostFacts);
    }
    // No current-profile bridge or reply_dispatch hook. Session access is native.
    // Preparation errors are not state corruption and never inject inactive noise.
    let scope: Omit<Identity, "userId">;
    try {
      const { agentId, entry } = await entryFor(ctx.sessionKey);
      if (!entry || entry.sessionId !== ctx.sessionId || (ctx.agentId && ctx.agentId !== agentId))
        return undefined;
      const workspace = await workspaceFor(agentId, entry);
      scope = { sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, workspace };
    } catch (error) {
      api.logger.warn("Pstack prompt preparation unavailable: " + String(error));
      return routeNotice ? { prependContext: routeNotice } : undefined;
    }
    // A native workflow in progress tells the agent its checkpoint even when mode is off.
    let nativeNotice: string | undefined;
    try {
      nativeNotice = await nativePromptContext(api, scope, root, () => ctx.hookInvocation?.assertActive());
    } catch (error) {
      nativeNotice = "Pstack native workflow lookup FAILED CLOSED: " + String(error) + ". Do not continue or respawn its children; report this error.";
    }
    const notices = [nativeNotice, routeNotice].filter(Boolean).join("\n\n");
    try {
      const mode = await readMode(
        store(() => ctx.hookInvocation?.assertActive()),
        scope,
      );
      if (!mode?.active) return notices ? { prependContext: notices } : undefined;
      return {
        prependContext:
          (notices ? notices + "\n\n" : "") +
          "Pstack mode is active for this exact session incarnation (revision " +
          mode.revision +
          "). Read " +
          join(root, "skills/pstack/SKILL.md") +
          " and " +
          join(root, "skills/pstack/native/contract.md") +
          ". Pstack owns workflow; OpenClaw owns secure execution. Use pstack_route for the 17 roles and exact snapshots, then native sessions_spawn. Children do not inherit sticky mode; native requester tool policy still applies. A slash-command task means execute its task suffix, not toggle mode again. For /pstack-<route> (or an explicitly enabled bare route alias), read that complete selected section in native/workflows.md or native/playbooks.md before executing. All required independent phases and gates remain mandatory; this is skill-guided, agent-attested continuation, not a deterministic controller. When a route's deliverable is a routed child's result (for example teach's judgment-and-prose explanation, a how explainer or a why synthesis), deliver that collected result verbatim as a quoted block attributed to its role, actual model and run id, with at most a short lead-in; never replace it with a parent rewrite or paraphrase. In skill-guided routes, spawn a routed child you may hand off as an announcing child (omit collect); after one bounded wait leaves it pending, write the six-line handoff from contract.md \"Visible handoff\" and end the turn with sessions_yield, whose completion events resume this session. Collect every collector (collect: true) in the turn that spawned it, with agents_wait and awaitResults: true: nothing wakes this session when a collector finishes, so never end a turn with one pending. A collector's runTimeoutSeconds bounds that wait, counted from the child's own start: spawn a collector with the arguments pstack_route returns, which give it 600 seconds when it has none, and give any other collector you spawn the same bound. This plugin refuses a collector that asks for more than 900 seconds; a phase that may take longer is an announcing child. Call sessions_yield with acknowledgment and message only, never waitFor: the host's waitFor sentence only matters when the caller is itself a subagent paused for its requester's message, not a parent waiting for its own children. If the host's plan-completion check (\"This run’s latest successfully saved plan still has unfinished steps\") follows a handoff, answer it with exactly NO_REPLY and no tool call. The six handoff lines end the reply: never follow them with a status sentence or send them with a message tool. A block a route requires in every reply, such as show-me-your-work's Attention or opening-a-pr's readiness line, goes immediately before the six lines. This plugin checks every sessions_yield of this session, route or not: it removes waitFor and lets the yield through with a note, and it refuses an acknowledgment without the six handoff lines, such as sessions_yield({ acknowledgment: \"UNUSED\" }); after a refusal, retry the same sessions_yield at once with the six lines.",
      };
    } catch (error) {
      return {
        prependContext:
          "Pstack state lookup FAILED CLOSED: " +
          String(error) +
          ". Stop pstack-specific dispatch and report this error.",
      };
    }
  });
  // Version 2 receives the host requester catalog when the run has admitted requester authority.
  api.registerTool(
    {
      contextVersion: 2,
      create: (toolContext: OpenClawPluginToolContext) => ({
        name: "pstack_route",
        label: "Pstack role routing",
        description:
          "Read workspace-root pstack-models.json; return immutable snapshot and native sessions_spawn args, checked against the host requester catalog when available. Does not spawn or edit.",
        parameters: routeParameters,
        prepareArguments: prepareRouteArguments,
        execute: async (_id: string, params: unknown) => {
          const p = params as Record<string, unknown>;
          if (!toolContext.workspaceDir) throw Error("Requester workspace is unavailable");
          const models = (toolContext as { runtimeContext?: Invocation }).runtimeContext?.models;
          const requester = models && typeof models.list === "function" ? await readRequesterCatalog(models, { family: caps.family }) : undefined;
          const result = await planFromWorkspace({ ...p, workspace: toolContext.workspaceDir }, { requester, hostBlind: caps.blind });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        },
      }),
    } as unknown as Parameters<OpenClawPluginApi["registerTool"]>[0],
    { names: ["pstack_route"] },
  );
  registerPlanCheckTool(api);
  registerBriefTool(api, root, profiles);
  registerTrailTool(api, trailOptions(api.pluginConfig));
  registerWorktreeAuditTool(api);
  registerWorkflowTool(api, ownerFor, async (sessionKey) => (await entryFor(sessionKey)).entry?.sessionId);
  // Every sessions_yield of a top-level session in pstack mode: waitFor is removed, and an
  // acknowledgment must carry the six handoff lines. Subagents may still pause for their requester.
  // A sessions_spawn collector of a session in pstack mode that asks for more than 900 seconds is refused (collector-bound.ts).
  registerSpawnGuard(api, ownerFor, async (params, ctx) => {
    if (!ctx.sessionKey || /:subagent:/.test(ctx.sessionKey)) return undefined;
    // Visible spawned children use dashboard keys too; execution lineage, not sidebar placement,
    // decides whether they may pause for a requester's message. Keep the legacy hidden-key fallback.
    const { entry } = await entryFor(ctx.sessionKey);
    if (!entry || entry.sessionId !== ctx.sessionId || entry.spawnedBy) return undefined;
    const scope = await ownerFor(ctx);
    const mode = await readMode(store(), scope);
    return mode?.active ? yieldDecision(params) : undefined;
  }, async (params, ctx) => {
    // Every collector of a session in pstack mode, top-level or not; the decision only ever refuses.
    if (params?.collect !== true || !ctx.sessionKey) return undefined;
    const mode = await readMode(store(), await ownerFor(ctx));
    return mode?.active ? collectorDecision(params) : undefined;
  });
  api.registerCli(
    ({ program }) => {
      const cli = program.command("pstack").description("Pstack integrity and legacy import");
      cli.command("doctor").action(() => {
        const r = spawnSync(
          "python3",
          [join(root, "skills/pstack/scripts/verify_install.py"), join(root, "skills/pstack")],
          { encoding: "utf8" },
        );
        process.stdout.write(r.stdout ?? "");
        process.stderr.write(r.stderr ?? "");
        if (r.status !== 0) throw Error("Pstack integrity check failed");
      });
      cli
        .command("migrate")
        .requiredOption("--workspace <path>")
        .requiredOption(
          "--offline",
          "Offline-only import; the Gateway using this state must be stopped",
        )
        .option("--all-current-active", "Import every current, non-archived active legacy record")
        .option("--user <id>")
        .option("--session-key <key>")
        .option("--session-id <id>")
        .action(
          async (opts: {
            workspace: string;
            allCurrentActive?: boolean;
            user?: string;
            sessionKey?: string;
            sessionId?: string;
          }) => {
            if (opts.allCurrentActive) {
              if (opts.user || opts.sessionKey || opts.sessionId)
                throw Error("Choose bulk migration or one exact identity, not both");
              const result = await importCurrentLegacy(store(), opts.workspace, migrationEntryFor);
              console.log(JSON.stringify(result, null, 2));
              if (result.errors) process.exitCode = 1;
              return;
            }
            if (!opts.user || !opts.sessionKey || !opts.sessionId)
              throw Error(
                "Use --all-current-active or supply --user, --session-key and --session-id",
              );
            const entry = await migrationEntryFor(opts.sessionKey);
            if (
              !entry ||
              entry.sessionId !== opts.sessionId ||
              entry.archivedAt !== undefined ||
              entry.workspace !== (await realpath(opts.workspace))
            )
              throw Error(
                "Selected migration requires a current non-archived incarnation with matching native workspace",
              );
            const result = await importLegacy(store(), {
              workspace: opts.workspace,
              userId: opts.user,
              sessionKey: opts.sessionKey,
              sessionId: opts.sessionId,
            });
            console.log(JSON.stringify(result, null, 2));
          },
        );
    },
    { commands: ["pstack"] },
  );
}
export default definePluginEntry({
  id: "pstack",
  name: "openclaw-pstack",
  description: "Exact-session workflow mode and native role planning",
  register,
});
