/** Record-local interrogate semantics. Pure validation; never executes reported commands. */
const str = (maxLength = 2048) => ({ type: 'string', minLength: 1, maxLength });
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const revision = { type: 'string', pattern: '^[a-f0-9]{40,64}$' };
const arr = (items, maxItems, minItems = 0) => ({ type: 'array', minItems, maxItems, items });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const choice = (...values) => ({ type: 'string', enum: values });
const file = obj({ path: str(1024), sha256: hash });
export const frozenSchema = obj({ revision, tree: revision, patchDigest: hash, files: arr(file, 128, 1) });
const environment = arr(obj({ name: str(128), value: str(1024) }), 16);
const proof = obj({
  command: str(), cwd: str(1024), environment, scratch: str(1024),
  frozen: frozenSchema, frozenAfter: frozenSchema, outcome: choice('observed', 'harness-failed', 'unsafe', 'unavailable'), repro: arr(file, 16, 1), safety: str(),
  exitCode: { type: 'integer', minimum: 0, maximum: 255 },
  expectedExitCode: { type: 'integer', minimum: 0, maximum: 255 }, actual: str(4096), expected: str(4096),
});
const finding = obj({ id: str(64), severity: choice('critical', 'warning', 'nit'), location: str(1024), claim: str(), proof });
const review = obj({ intent: str(), frozen: frozenSchema, coverage: str(4096), findings: arr(finding, 12) });
const reviewer = obj({ slot: choice('reviewers:0', 'reviewers:1'), artifactDigest: hash, output: review });
const accounting = obj({ origin: str(128), disposition: choice('keep', 'drop', 'blocked', 'duplicate'), reason: str(), rerun: proof, duplicateOf: str(128) }, ['origin', 'disposition', 'reason']);
const lead = obj({ intent: str(), frozen: frozenSchema, reviewers: arr(obj({ slot: choice('reviewers:0', 'reviewers:1'), artifactDigest: hash }), 2, 2), accounting: arr(accounting, 24) });
export const executedContracts = Object.freeze({ 'interrogate-executed-reviewer': review, 'interrogate-executed-lead': lead });
export const executedContextSchema = obj({ frozen: frozenSchema, reviewers: arr(reviewer, 2, 2) });
const legacy = Object.freeze({ executed: false, reviewer: 'interrogate-reviewer', lead: undefined, profile: undefined,
  sections: ['Intent', 'Reviewers', 'Act on', 'Consider', 'Noted', 'Dismissed', 'Agreement Map'],
  frame: ['intent', 'frozen-head', 'rubric'], verdict: ['all-findings-four-buckets', 'model-attributed-agreement-map', 'source-validation'],
  recipe: 'skills/pstack/native/legacy/interrogate/workflow.md', references: 'skills/pstack/native/legacy/interrogate' });
const executed = Object.freeze({ executed: true, reviewer: 'interrogate-executed-reviewer', lead: 'interrogate-executed-lead', profile: 'interrogate-adversary',
  sections: ['Intent', 'Findings', 'Dropped'], frame: ['intent', 'frozen-head', 'reproduction-policy'], verdict: ['independent-lead'],
  recipe: 'skills/pstack/native/interrogate-executed.md', references: 'skills/pstack/native' });
/** Only frozen setup selects semantics. Missing selector means legacy forever. */
export function interrogateSemantics(setup) { return setup?.kind === 'interrogate' ? setup.executedProof === true ? executed : legacy : undefined; }
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value);
const same = (a, b) => canonical(a) === canonical(b);
const unique = values => new Set(values).size === values.length;
const relative = path => !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(x => !x || x === '.' || x === '..') && ![...path].some(c => c.charCodeAt(0) < 32);
const absolute = path => path.startsWith('/') && relative(path.slice(1));
function files(list, fail) {
  if (!unique(list.map(f => f.path))) fail('duplicate file path');
  if (list.some(f => !relative(f.path))) fail('files must be literal relative paths without traversal');
}
export function frozenErrors(frozen, fail) { files(frozen.files, fail); }
function checkProof(p, frozen, fail) {
  if (p.outcome !== 'observed') fail('unsafe, unavailable or failed harness is not execution proof');
  if (!same(p.frozen, frozen) || !same(p.frozenAfter, frozen)) fail('source drift: proof does not match frozen scope/revision/tree/patch');
  if (!absolute(p.scratch) || !(p.cwd === p.scratch || p.cwd.startsWith(p.scratch + '/')) || p.cwd.split('/').includes('..')) fail('proof cwd must be inside its absolute scratch');
  if (!unique(p.environment.map(e => e.name))) fail('duplicate environment variable');
  files(p.repro, fail);
}
const broken = p => p.exitCode !== p.expectedExitCode || p.actual !== p.expected;
/** Cross-field checks attest reports, not host execution or command safety. */
export function checkExecuted(name, output, context, fail) {
  const frozen = context.frozen;
  if (!frozen) { fail('frozen review context required'); return; }
  if (!same(output.frozen, frozen)) fail('source drift: output differs from frozen review context');
  frozenErrors(output.frozen, fail);
  if (name === 'interrogate-executed-reviewer') {
    if (!unique(output.findings.map(f => f.id))) fail('duplicate finding id');
    for (const f of output.findings) {
      if (!frozen.files.some(file => f.location === file.path || f.location.startsWith(file.path + ':') || f.location.startsWith(file.path + '#'))) fail('finding location outside frozen scope');
      checkProof(f.proof, frozen, fail); if (!broken(f.proof)) fail('finding must demonstrate actual versus expected failure'); }
    if (context.status === 'PASS' && output.findings.length) fail('PASS cannot carry executed findings');
    if (context.status === 'ISSUES' && !output.findings.length) fail('ISSUES requires executed findings');
    return;
  }
  const reviewers = context.reviewers;
  if (!Array.isArray(reviewers) || reviewers.length !== 2 || !same(reviewers.map(r => r.slot).sort(), ['reviewers:0', 'reviewers:1'])) { fail('both collected reviewers required'); return; }
  const identities = reviewers.map(({slot, artifactDigest}) => ({slot, artifactDigest})).sort((a,b) => a.slot.localeCompare(b.slot));
  if (!same([...output.reviewers].sort((a,b) => a.slot.localeCompare(b.slot)), identities)) fail('lead must bind both exact collected reviewer artifacts');
  const findings = new Map(reviewers.flatMap(r => r.output.findings.map(f => [r.slot + '/' + f.id, f])));
  if (!unique(output.accounting.map(a => a.origin)) || !same(output.accounting.map(a => a.origin).sort(), [...findings.keys()].sort())) fail('account for every finding exactly once');
  const scratch = reviewers.flatMap(r => r.output.findings.map(f => f.proof.scratch));
  const rerunRoots = [];
  for (const row of output.accounting) {
    const f = findings.get(row.origin); if (!f) continue;
    if (row.disposition === 'blocked') { if (row.rerun || row.duplicateOf) fail('blocked finding carries a reason, not a successful rerun'); continue; }
    if (row.disposition === 'duplicate') {
      const target = output.accounting.find(a => a.origin === row.duplicateOf);
      const original = findings.get(row.duplicateOf);
      if (!target || !['keep', 'drop'].includes(target.disposition) || !original || row.rerun) fail('duplicate must point directly to an independently rerun keep/drop');
      else if (!same(f.proof.repro, original.proof.repro) || f.proof.command !== original.proof.command || f.proof.cwd.slice(f.proof.scratch.length) !== original.proof.cwd.slice(original.proof.scratch.length) || !same(f.proof.environment, original.proof.environment) || f.proof.expected !== original.proof.expected || f.proof.expectedExitCode !== original.proof.expectedExitCode || f.location !== original.location) fail('duplicate does not share the same repro, command, relative cwd, environment, expectation and location');
      continue;
    }
    if (!row.rerun || row.duplicateOf) { fail('keep/drop requires its own independent rerun'); continue; }
    const p = row.rerun; checkProof(p, frozen, fail);
    if (scratch.some(s => p.scratch === s || p.scratch.startsWith(s + '/') || s.startsWith(p.scratch + '/'))) fail('independent rerun must use fresh scratch, not reviewer scratch');
    if (rerunRoots.some(s => p.scratch === s || p.scratch.startsWith(s + '/') || s.startsWith(p.scratch + '/'))) fail('each independent finding rerun needs a fresh scratch root');
    rerunRoots.push(p.scratch);
    if (!same(p.repro, f.proof.repro)) fail('repro hash changed before independent rerun');
    if (p.command !== f.proof.command || !same(p.environment, f.proof.environment) || p.cwd.slice(p.scratch.length) !== f.proof.cwd.slice(f.proof.scratch.length) || p.expected !== f.proof.expected || p.expectedExitCode !== f.proof.expectedExitCode) fail('rerun changed command, relative cwd, environment or expectation');
    if ((row.disposition === 'keep') !== broken(p)) fail('keep/drop contradicts independent actual versus expected');
  }
  if (context.status !== 'BLOCKED' && output.accounting.some(a => a.disposition === 'blocked')) fail('unsafe, failed or unavailable reruns require BLOCKED, never a completed verdict');
  const kept = output.accounting.some(a => a.disposition === 'keep');
  if (context.status === 'PASS' && kept) fail('PASS cannot retain a finding');
  if (context.status === 'ISSUES' && !kept) fail('ISSUES requires a retained finding');
}
