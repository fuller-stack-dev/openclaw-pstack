import { join } from "node:path";
import routes from "../skills/pstack/native/routes.json";

/** Only the reviewed workflow/playbook routes; principles/extensions are not command aliases. */
export const ROUTES: readonly string[] = Object.freeze([...routes.workflows, ...routes.playbooks]);
export type RouteName = string;

export function routeCommands(bareAliases = false): { name: string; route: RouteName }[] {
  return ROUTES.flatMap((route) => [
    { name: "pstack-" + route, route },
    ...(bareAliases ? [{ name: route, route }] : []),
  ]);
}

/** Routes that answer the user's question read-only: they continue the agent but never activate mode. */
export const READ_ONLY_ROUTES: readonly string[] = Object.freeze(["poteto-help", "setup-pstack"]);

/** Static fallback when the agent cannot be continued for this invocation (no exact session or sender authority). */
export function readOnlyRouteHelp(route: RouteName): string | undefined {
  if (route === "poteto-help")
    return "Pstack help: /pstack on | off | status | help | <route> <task>, or /pstack-<route> <task>. Read the native contract and complete selected workflow/playbook section. Route commands continue through the ordinary host agent; evidence is agent-attested. Help does not activate mode or execute a task.";
  if (route === "setup-pstack")
    return "Pstack setup is read-only: inspect the native contract, native/workflows.md section setup-pstack and native/model-routing.md. Report an example workspace-root pstack-models.json from actual available metadata; do not write config, install providers, change credentials, activate mode or create a job. Missing capabilities are BLOCKED, not permission to install.";
  return undefined;
}

export type HostFacts = { controllers: boolean; scheduled: boolean; profiles: string[] };

/** Prompt context for the one agent turn a read-only route command continues. */
export function readOnlyRouteContext(route: RouteName, root: string, workspace: string, host: HostFacts): string {
  const native = (file: string) => join(root, "skills/pstack/native", file);
  const facts = "Host facts from the pstack plugin's registration probe: native controllers (/pstack-architect, -arena, -interrogate, -swarm, -how, -why, -reflect) are " +
    (host.controllers ? "available" : "unavailable, so those routes run skill-guided") + "; unattended continuation through requester-admitted scheduled command turns (S6) is " +
    (host.scheduled ? "available to native controller workflows only" : "unavailable, so any unattended or overnight continuation is BLOCKED on this host") + "; narrow-only host tool profiles (S5) are " +
    (host.profiles.length ? "registered: " + host.profiles.join(", ") : "unavailable, so read-only child roles are prompt-enforced") + ".";
  const common = [
    "Pstack read-only route /pstack-" + route + " for this turn: answer the user's question in their message. This command did not activate pstack mode, start a task, spawn children or create a job, and neither may you.",
    "Read-only: do not edit files or configuration, run billed model probes, read secrets, spawn children, create schedules or automations, or toggle pstack mode.",
    facts,
  ];
  if (route === "poteto-help")
    return [...common,
      "Follow the complete `poteto-help` section of " + native("workflows.md") + ". Before answering, read the native README " + join(root, "skills/pstack/README.md") + ", the route index " + native("routes.json") +
        " and the best matching route section in " + native("workflows.md") + " or " + native("playbooks.md") + ". Lead with the answer, give at most one example prompt, and cite the file and section you read.",
    ].join("\n\n");
  return [...common,
    "Follow the complete `setup-pstack` section of " + native("workflows.md") + " and " + native("model-routing.md") + " (Setup and first use). The workspace role configuration is " + join(workspace, "pstack-models.json") +
      "; read it (absent means every role inherits), use pstack_route to resolve any role's current selection, and report the current selections and role counts. Plain setup stays read-only: only an explicit request to configure role selections, after the confirmation that section requires, authorizes editing that file.",
  ].join("\n\n");
}
