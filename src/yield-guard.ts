/**
 * Plugin-side guard for every sessions_yield of a top-level session in pstack mode (contract.md
 * "Visible handoff"). Such a session yields to wait for its own children, whose completion events
 * resume it, so `waitFor` is never needed: the guard removes it and lets the yield through with a
 * note. An acknowledgment, when given, is the visible waiting reply, so it carries the six handoff
 * lines; one that does not is refused, with the exact call to retry at once.
 */
export const HANDOFF_LABELS = ["Handoff:", "Owner:", "Pending:", "Done so far:", "Snapshot:", "Next:"] as const;
export const YIELD_EXAMPLE = 'sessions_yield({ acknowledgment: "Handoff: <route>, <phase> pending\\nOwner: <this session key>\\nPending: <role> run <run ID>, session <child session key>\\nDone so far: …\\nSnapshot: …\\nNext: …", message: "<private resume notes>" })';
/** The note added to a yield's persisted result after the guard removed its waitFor. */
export const WAIT_FOR_REMOVED_NOTE = "Pstack removed waitFor from this sessions_yield and let it through: a session waiting for its own children is resumed by their completion events without waitFor. Omit waitFor when you yield.";
const WAIT_FOR_KEYS = ["waitFor", "wait_for"] as const;

/** Read a handoff field, allowing ordinary Markdown/list presentation around its label. */
function handoffField(line: string): { label: string; value: string } | undefined {
  const plain = line.trim()
    .replace(/^(?:(?:[-*•>+]|\d\uFE0F?\u20E3|\d+[.)]|[A-Za-z]+[.)]|#{1,6}|\[[ xX]\]|[\p{Extended_Pictographic}\uFE0F\u200D]+)\s+)+/u, "")
    .replace(/^\|\s*/, "")
    .replace(/^(?:[*_]{1,3}|\x60)/, "");
  const match = /^([A-Za-z][A-Za-z ]*?)\s*(?:[*_]{1,3}|\x60)?(?:\s*[:：—–|]|\s+-\s+)(.*)$/.exec(plain);
  if (!match?.[1] || match[2] === undefined) return undefined;
  const normalizedLabel = match[1].trim().toLowerCase() + ":";
  const label = HANDOFF_LABELS.find(known => known.toLowerCase() === normalizedLabel);
  if (!label) return undefined;
  // Formatting alone is not a value (including an empty Markdown table cell).
  const value = match[2].replace(/^[\s*_\x60|]+|[\s*_\x60|]+$/g, "");
  return { label, value };
}

/** The handoff labels without a non-empty value; empty when all six fields are present. */
export function missingHandoffLabels(ack: string): string[] {
  const present = new Set(ack.split(/\r?\n/).map(handoffField).filter(field => field?.value).map(field => field!.label));
  return HANDOFF_LABELS.filter(label => !present.has(label));
}

export type YieldDecision =
  | { action: "allow" }
  | { action: "rewrite"; params: Record<string, unknown>; note: string }
  | { action: "refuse"; reason: string };

/** What the guard does with a pstack-mode top-level session's sessions_yield. */
export function yieldDecision(params: Record<string, unknown> | undefined): YieldDecision {
  const hasWaitFor = WAIT_FOR_KEYS.some(key => params?.[key] !== undefined);
  const ack = params?.acknowledgment;
  if (typeof ack === "string" && ack.trim()) {
    const missing = missingHandoffLabels(ack);
    if (missing.length) {
      const what = missing.length === HANDOFF_LABELS.length && !ack.split(/\r?\n/).some(handoffField)
        ? "its acknowledgment is a placeholder or status sentence (" + JSON.stringify(ack.slice(0, 60)) + "), not a handoff"
        : "its acknowledgment lacks the handoff line(s) " + missing.join(", ") + "; each of the six lines starts with its label and has a non-empty value";
      return { action: "refuse", reason:
        "Pstack refused this sessions_yield because " + what + ". Retry the same sessions_yield now, with the six handoff lines in acknowledgment and your private notes in message" +
        (hasWaitFor ? ", and without waitFor" : "") + ": " + YIELD_EXAMPLE +
        ". If the handoff is already in this turn's reply text, retry it without acknowledgment instead. Never end the turn on a status sentence." };
    }
  }
  if (!hasWaitFor) return { action: "allow" };
  // Explicit undefined rather than deletion: the host merges hook params over the original call.
  const rewritten: Record<string, unknown> = { ...params };
  for (const key of WAIT_FOR_KEYS) rewritten[key] = undefined;
  return { action: "rewrite", params: rewritten, note: WAIT_FOR_REMOVED_NOTE };
}
