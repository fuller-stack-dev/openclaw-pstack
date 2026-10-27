// Valid panel outputs. Tests mutate copies to prove each contract rule rejects.
export const architectOutput = (name) => ({
  packagePath: "/task/designs/" + name.replace(/\W+/g, "-") + "/README.md",
  usage: { readme: "Callers queue an edit and await its receipt.", callSites: ["editor.save(doc)", "sync.flush(queue)"] },
  shape: { summary: name, publicSurface: ["save(doc): Receipt"], modules: [{ name: "queue", responsibility: "Orders pending edits for " + name }] },
  rationale: {
    problem: "Edits race", usage: "save then await", shape: name, synthesisDecision: "Base " + name,
    tradeoffsAccepted: "One more hop", alternativesConsidered: [{ shape: "shared mutable cache", whyLost: "Callers must know lock order" }],
    openQuestionsAndRisks: "Backpressure sizing", nextImplementationStep: "Type the receipt",
  },
});
export const arenaOutput = () => ({
  artifactPath: "/task/candidates/a/patch.diff", rationale: "Smallest boundary that keeps the invariant in one place.",
  alternatives: [{ approach: "Patch every caller", whyRejected: "Duplicates the invariant" }],
});
export const judgeOutput = (labels) => {
  const rubric = ["correctness", "boundary", "extensibility"].map(id => ({ id, criterion: "Grade " + id }));
  return {
    rubric,
    candidates: labels.map((label, i) => ({ label, scores: rubric.map(r => ({ criterion: r.id, score: 5 - i, rationale: label + " on " + r.id })) })),
    recommendedBase: labels[0], rationale: "Read every candidate in full; " + labels[0] + " keeps one owner per invariant.",
  };
};
export const LENSES = ["correctness-and-edge-paths", "idempotency-and-concurrency", "root-cause", "structural-integrity", "behavioral-verification", "complexity", "security"];
export const reviewerOutput = (findings = []) => ({
  findings,
  lenses: LENSES.map((lens, i) => ({ lens, disposition: i < 5 ? "covered" : "not-applicable", note: i < 5 ? "Traced callers" : "No such surface in this diff" })),
  testAssessment: "Tests assert observable outcomes and the failure path.",
});
export const finding = (severity = "warning") => ({
  severity, title: "Lost update", location: "src/store.ts:42", mechanism: "Read-modify-write without CAS",
  evidence: "Two writers interleave in the fixture trace", inference: false,
});
export const commentReview = () => ({
  scope: ["src/a.ts", "src/b.ts"],
  deletions: [
    { file: "src/a.ts", line: 3, comment: "// loop over items", reason: "narration", evidence: "The for-of below says the same" },
    { file: "src/b.ts", line: 9, comment: "// @ts-ignore", reason: "suppression", rule: "TS2532", ruleClass: "correctness", symbol: "lookup", evidence: "Hides a possibly undefined read" },
  ],
  mustKill: [{ file: "src/b.ts", line: 10, symbol: "lookup", reshape: "type", mechanism: "Returns undefined for missing keys", evidence: "Callers dereference without a check" }],
  keeps: [{ file: "src/a.ts", line: 1, clause: "legal-or-license", evidence: "SPDX header" }],
  open: [{ file: "src/a.ts", line: 20, question: "Is the retry limit a vendor constraint?" }],
  deletionCount: 2, applicationCodeEdited: false,
});
export const delegateResult = (contractRead) => ({
  status: "PASS", contractRead, summary: "Added the receipt type and its failure test.",
  changes: [{ path: "src/receipt.ts", kind: "added" }],
  checks: [{ command: "node --test", exitCode: 0, result: "12 pass" }],
  principlesApplied: [{ principle: "principle-model-the-domain", decision: "Receipt is a type, not a boolean" }],
  blockers: [],
});
