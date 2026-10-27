import { collectorRefusal, COLLECTOR_MAX_RUN_TIMEOUT_SECONDS, readRunTimeoutSeconds } from "../skills/pstack/scripts/model-routing.mjs";

/**
 * The host's launch replay key on a Code Mode `agents.run` spawn. agents.run attaches it with
 * Object.defineProperty (non-enumerable), and it never sets runTimeoutSeconds.
 */
export const SWARM_LAUNCH_REPLAY_KEY = Symbol.for("openclaw.swarmCodeModeIdempotencyKey");

export type SpawnDecision = { action: "refuse"; reason: string };

/**
 * Plugin-side check for a pstack-mode session's skill-guided sessions_spawn collector (contract.md
 * "Bounded-wait handoff"). It never rewrites the spawn: `pstack_route` gives a planned collector its default
 * bound, and a rewrite would replace the host's parameter object. It only refuses a collector that explicitly
 * asks for more than the maximum, read the way the host reads it. A Code Mode agents.run spawn (which never
 * carries a bound) and a malformed bound (which the host refuses itself) pass unchanged; undefined leaves the call alone.
 */
export function collectorDecision(params: Record<PropertyKey, unknown> | undefined): SpawnDecision | undefined {
  if (params?.collect !== true || Object.prototype.hasOwnProperty.call(params, SWARM_LAUNCH_REPLAY_KEY)) return undefined;
  let seconds: number | undefined;
  try {
    seconds = readRunTimeoutSeconds(params).seconds;
  } catch {
    return undefined;
  }
  if (seconds === undefined || seconds <= COLLECTOR_MAX_RUN_TIMEOUT_SECONDS) return undefined;
  return { action: "refuse", reason: "Pstack refused this sessions_spawn: " + collectorRefusal(seconds) + "." };
}
