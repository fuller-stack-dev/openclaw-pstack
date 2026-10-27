// Concrete supplied-source plan fixture for native adapter acceptance.
const rule = "Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";
const lanes = Array.from({ length: 10 }, (_, i) => `- [ ] Lane ${i + 1}. ${i === 0 ? "Regression lane against trunk. " : ""}Open a saved relay and confirm delivery. Save \`relay-${i + 1}.png\`. Pass when the delivery receipt is visible.`).join("\n");
const pr = (id, depends = "None.") => [
  `## Deliver a relay receipt (${id})`,
  `**Depends on.** ${depends}`,
  "**Files.**", "- [ ] Edit `src/relay.js`.",
  "**Build.**", "- [ ] Add `receipt` to `send` in `src/relay.js`.",
  "**You see.**", "- [ ] The relay prints `delivered` after acknowledgment.",
  `**Verify, unit.** ${rule}`, "- [ ] Run `node --test relay.test.js` and retain the passing log.",
  `**Verify, live.** ${rule} Ten lanes on \`provider/worker\` at the PR head.`, lanes,
  `**Verify, perf.** ${rule}`,
  "- [ ] Metric. Delivery latency in ms at trunk and head.",
  "- [ ] Probe. Alternate the delivery probe on trunk and head five times.",
  "- [ ] Baseline. Record the trunk median in `latency.json` before head runs.",
  "- [ ] Rule. Fail if head exceeds trunk by 5 percent.",
  `**Review gate.** None. ${id} is not review-gated.`,
  "**Merge.**", "- [ ] Record root exact-head verdict and green CI before the authorized merge.",
].join("\n");
const prefix = [
  "# Relay plan", "", "Deliver receipts for relay users through PR-1.",
  "## How to read this",
  "One box is one unit of work. Every box names the evidence.",
  "Check a box only when its evidence exists.",
  "The program runs playbooks/autopilot-full. The authorized owner merges.", rule,
  "## Program checklist", "### Arm the program",
  "- [ ] Wait for the operator explicit go and read the native leaves from trunk.",
  "- [ ] Record the authorized native audit lifecycle and send a status message only for changes.",
  "- [ ] Propagate hold as zero-writes.", "### Spawn owners",
  "- [ ] Use pstack_route and sessions_spawn for one owner per PR.",
  "### PR mechanics", "- [ ] Run committed-head repo checks through the authorized forge flow.",
  "### Verdict and merge", "- [ ] Audit receipts and apply patch-id requalification.",
  "### Boot recipe", "- [ ] Check out the exact head in an isolated environment and run the relay driver.",
].join("\n");
const tail = [
  "## Close the program", "- [ ] Check every box with its resolving evidence.",
  "## Appendix A. Prototype evidence", "The driver at `proof/relay.log` confirms acknowledgment order.",
  "## Appendix B. Alternatives rejected", "Polling duplicates the event subscription.",
  "## Appendix C. Risks", "PR-1 watches lost acknowledgments.",
  "## Appendix D. Links and reading list", "Read the relay API and native verification routes.",
].join("\n");
const valid = `${prefix}\n${pr("PR-1")}\n${tail}\n`;

export { valid };
