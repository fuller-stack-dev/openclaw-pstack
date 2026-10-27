/** Agent-attested brief and output contracts. Pure: no tools, spawning, files or network. */
import contracts from '../native/agents/contracts.json' with { type: 'json' };
import { ROLE_SPECS } from './model-routing.mjs';

const KEYWORDS = {
  object: ['type', 'description', 'additionalProperties', 'required', 'properties'],
  array: ['type', 'description', 'items', 'minItems', 'maxItems'],
  string: ['type', 'description', 'minLength', 'maxLength', 'enum', 'pattern'],
  integer: ['type', 'description', 'minimum', 'maximum'],
  boolean: ['type', 'description'],
};
const own = (value, key) => Object.hasOwn(value, key);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Every object is closed and every bound is explicit, so a contract cannot silently accept extra data. */
export function checkSchemaDefinition(schema, path = '$') {
  if (!isObject(schema) || !own(KEYWORDS, schema.type)) throw Error('Unsupported schema type at ' + path);
  for (const key of Object.keys(schema)) if (!KEYWORDS[schema.type].includes(key)) throw Error('Unsupported schema keyword at ' + path + ': ' + key);
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false || !isObject(schema.properties) || !Array.isArray(schema.required)) throw Error('Open or incomplete object schema at ' + path);
    for (const name of schema.required) if (!own(schema.properties, name)) throw Error('Required field without schema at ' + path + '.' + name);
    for (const [name, child] of Object.entries(schema.properties)) checkSchemaDefinition(child, path + '.' + name);
  }
  if (schema.type === 'array') {
    if (!Number.isInteger(schema.minItems) || !Number.isInteger(schema.maxItems) || schema.minItems > schema.maxItems) throw Error('Unbounded array schema at ' + path);
    checkSchemaDefinition(schema.items, path + '[]');
  }
  if (schema.type === 'string' && !Array.isArray(schema.enum) && typeof schema.pattern !== 'string' && !Number.isInteger(schema.maxLength)) throw Error('Unbounded string schema at ' + path);
  if (schema.type === 'integer' && (!Number.isInteger(schema.minimum) || !Number.isInteger(schema.maximum))) throw Error('Unbounded integer schema at ' + path);
}

function check(schema, value, path, errors) {
  if (errors.length >= 32) return;
  const fail = message => errors.push(path + ': ' + message);
  switch (schema.type) {
    case 'object':
      if (!isObject(value)) return fail('expected object');
      for (const key of Object.keys(value)) if (!own(schema.properties, key)) fail('unexpected field ' + key);
      for (const key of schema.required) if (!own(value, key)) fail('missing required field ' + key);
      for (const [key, child] of Object.entries(schema.properties)) if (own(value, key)) check(child, value[key], path + '.' + key, errors);
      return;
    case 'array':
      if (!Array.isArray(value)) return fail('expected array');
      if (value.length < schema.minItems || value.length > schema.maxItems) fail('expected ' + schema.minItems + '-' + schema.maxItems + ' items');
      value.forEach((item, i) => check(schema.items, item, path + '[' + i + ']', errors));
      return;
    case 'string':
      if (typeof value !== 'string') return fail('expected string');
      if (!value.trim() || value.includes('\u0000')) return fail('blank or NUL string');
      if (schema.minLength !== undefined && value.length < schema.minLength) fail('too short');
      if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('too long');
      if (schema.enum && !schema.enum.includes(value)) fail('expected one of ' + schema.enum.join(', '));
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('does not match ' + schema.pattern);
      return;
    case 'integer':
      if (!Number.isInteger(value)) return fail('expected integer');
      if (value < schema.minimum || value > schema.maximum) fail('expected ' + schema.minimum + '-' + schema.maximum);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail('expected boolean');
  }
}

/**
 * A review scope lists literal repo-relative file paths, because every finding
 * names one of them and is compared byte for byte. Brackets, dots, tildes,
 * carets, at signs and a leading dash are ordinary file-name characters
 * (app/[id]/page.tsx, pages/[...slug].tsx, src/a.ts~, -n.txt), so only forms
 * that cannot be such a path are refused.
 */
export function scopeErrors(scope) {
  const errors = [];
  for (const entry of scope) {
    const fail = why => errors.push('scope entry ' + JSON.stringify(entry) + ' is not a literal repo-relative file path (' + why + '); list each file relative to the repository root, one per entry, exactly as findings will name it');
    if (typeof entry !== 'string' || !entry.trim()) fail('blank');
    else if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(entry)) fail('control character or line break');
    else if (entry.startsWith('/')) fail('absolute');
    else if (entry.split('/').includes('..')) fail('.. traversal segment');
    else if (entry.startsWith(':')) fail('pathspec magic prefix');
    else if (entry.endsWith('/')) fail('directory');
  }
  return errors;
}

/**
 * Advisory only: an entry without a directory that reads like a revision range,
 * or any entry with a glob character, is still taken literally. The parent may
 * have meant a diff or pattern, which must be expanded to its files first.
 */
export function scopeAdvisories(scope) {
  return scope.filter(entry => typeof entry === 'string' && (/[*?]/.test(entry) || (!entry.includes('/') && /\.\.|@\{|[~^]\d*$/.test(entry))))
    .map(entry => 'scope entry ' + JSON.stringify(entry) + ' is taken as a literal file name; if it is a diff label or pattern, expand it to the changed files (for example git diff --name-only <base>...HEAD)');
}

const duplicates = values => values.filter((v, i) => values.indexOf(v) !== i);
const where = item => item.file + ':' + item.line;

const SEMANTICS = {
  'architect-runner'(output, _context, fail) {
    if (duplicates(output.usage.callSites).length) fail('call sites must be distinct real usages');
    if (duplicates(output.shape.modules.map(m => m.name)).length) fail('duplicate module name');
  },
  'arena-runner'() {},
  'cross-judge'(output, context, fail) {
    const ids = output.rubric.map(r => r.id), labels = output.candidates.map(c => c.label);
    if (duplicates(ids).length) fail('duplicate rubric criterion id');
    if (duplicates(labels).length) fail('duplicate candidate label');
    if (context.candidates) {
      const expected = [...context.candidates].sort(), actual = [...labels].sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) fail('judge must score exactly the usable candidates: ' + expected.join(', '));
    }
    for (const candidate of output.candidates) {
      const scored = candidate.scores.map(s => s.criterion);
      if (duplicates(scored).length || JSON.stringify([...scored].sort()) !== JSON.stringify([...ids].sort())) fail(candidate.label + ' must score every rubric criterion exactly once');
    }
    if (!labels.includes(output.recommendedBase)) fail('recommended base is not a scored candidate');
  },
  'interrogate-reviewer'(output, context, fail) {
    const lenses = output.lenses.map(l => l.lens);
    if (duplicates(lenses).length) fail('each review lens must be dispositioned exactly once');
    const blocking = output.findings.filter(f => f.severity !== 'nit').length;
    if (context.status === 'PASS' && blocking) fail('PASS cannot carry critical or warning findings');
    if (context.status === 'ISSUES' && !output.findings.length) fail('ISSUES requires at least one finding');
  },
  'comment-review'(output, context, fail) {
    if (output.applicationCodeEdited !== false) fail('comment reviewer is report-only; application code edits are rejected');
    if (output.deletionCount !== output.deletions.length) fail('deletionCount must equal proposed deletions');
    if (duplicates(output.scope).length) fail('duplicate scope entry');
    for (const error of scopeErrors(output.scope)) fail(error);
    if (context.scope) for (const file of output.scope) if (!context.scope.includes(file)) fail('scope escape: ' + file);
    const items = [...output.deletions, ...output.mustKill, ...output.keeps, ...output.open];
    for (const item of items) if (!output.scope.includes(item.file)) fail('finding outside scope: ' + where(item));
    const deleted = output.deletions.map(where);
    if (duplicates(deleted).length) fail('duplicate deletion');
    for (const keep of output.keeps) if (deleted.includes(where(keep))) fail('comment both kept and deleted: ' + where(keep));
    for (const open of output.open) if (deleted.includes(where(open))) fail('doubt is an open finding, never a deletion: ' + where(open));
    for (const d of output.deletions) {
      const suppression = d.reason === 'suppression';
      if (suppression !== (d.rule !== undefined) || suppression !== (d.ruleClass !== undefined)) fail('suppression deletions, and only they, name the suppressed rule and its class: ' + where(d));
      const critical = suppression && ['correctness', 'safety'].includes(d.ruleClass);
      if (critical !== (d.symbol !== undefined)) fail('a correctness/safety suppression deletion, and only it, names the suppressed symbol: ' + where(d));
      else if (critical && !output.mustKill.some(k => k.file === d.file && k.symbol === d.symbol))
        fail('correctness/safety suppression needs an actionable MUST KILL finding on the same symbol: ' + where(d));
    }
  },
  'delegate-result'(output, context, fail) {
    if (output.status === 'BLOCKED' && !output.blockers.length) fail('BLOCKED requires a named blocker');
    if (output.status === 'PASS' && (output.blockers.length || output.checks.some(c => c.exitCode !== 0))) fail('PASS requires no blockers and only passing checks');
    if (output.status === 'PASS' && output.changes.length && !output.checks.length) fail('PASS with changes requires at least one reported check');
    if (output.status !== 'BLOCKED') for (const path of context.requiredReads ?? []) if (!output.contractRead.includes(path)) fail('required native contract was not read before work: ' + path);
    if (context.principles) for (const p of output.principlesApplied) if (!context.principles.includes(p.principle)) fail('unknown native principle: ' + p.principle);
  },
};

export const PANEL_ROLES = Object.freeze(Object.keys(ROLE_SPECS).filter(role => ROLE_SPECS[role] !== 'single'));
export const PROFILES = Object.freeze(contracts.profiles.map(p => p.id));
/** Contracts must cover exactly the routing panels with closed schemas that have cross-field rules. */
export function checkContracts(value) {
  for (const schema of Object.values(value.schemas)) checkSchemaDefinition(schema);
  if (JSON.stringify(Object.keys(value.panelRoles).sort()) !== JSON.stringify([...PANEL_ROLES].sort())) throw Error('Output contracts must cover exactly the routing panel and pool roles');
  for (const name of [...Object.values(value.panelRoles), ...value.profiles.map(p => p.outputSchema)])
    if (!own(value.schemas, name) || !own(SEMANTICS, name)) throw Error('Missing output contract: ' + name);
  // Narrow-only: a profile may deny tools, never allow, select models or change sandboxing.
  const ids = [...value.profiles, ...value.panelProfiles].map(p => p.id);
  if (duplicates(ids).length) throw Error('Duplicate profile id: ' + duplicates(ids).join(', '));
  for (const p of [...value.profiles, ...value.panelProfiles]) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(p.id)) throw Error('Profile id is not a plugin-local identifier: ' + p.id);
    const narrow = p.narrowTools;
    if (!isObject(narrow) || Object.keys(narrow).join() !== 'deny' || !Array.isArray(narrow.deny) || !narrow.deny.length
      || narrow.deny.some(t => typeof t !== 'string' || !/^(group:)?[a-z][a-z0-9_]*$/.test(t)) || duplicates(narrow.deny).length)
      throw Error('Profile ' + p.id + ' needs a narrow-only tools deny list');
    if (typeof p.instructionsFile !== 'string' || !/^native\/agents\/[a-z0-9-]+\.md$/.test(p.instructionsFile)) throw Error('Profile ' + p.id + ' instructions must be a native agents file');
  }
  // Panel profiles serve read-only controller roles; every file-editing, spawning and plugin tool is denied.
  const assigned = value.panelProfiles.flatMap(p => p.roles);
  if (duplicates(assigned).length) throw Error('A role belongs to at most one panel profile: ' + duplicates(assigned).join(', '));
  for (const p of value.panelProfiles) {
    if (!Array.isArray(p.roles) || !p.roles.length) throw Error('Panel profile ' + p.id + ' needs roles');
    for (const role of p.roles) {
      if (!own(ROLE_SPECS, role)) throw Error('Unknown panel profile role: ' + role);
      if (WRITER_ROLES.includes(role)) throw Error('Panel profile ' + p.id + ' cannot serve writer role ' + role);
    }
    for (const tool of READ_ONLY_DENY) if (!p.narrowTools.deny.includes(tool)) throw Error('Panel profile ' + p.id + ' must deny ' + tool);
  }
}
/** Roles whose children must write files; they never run under a read-only panel profile. */
export const WRITER_ROLES = Object.freeze(['feature, refactoring', 'bug-fix', 'perf-issue', 'hillclimb', 'hardest tasks', 'architect runners', 'arena runners', 'swarm workers']);
const READ_ONLY_DENY = ['write', 'edit', 'apply_patch', 'sessions_spawn', 'group:plugins'];
checkContracts(contracts);

export function contractFor(nameOrRole) {
  const name = own(contracts.panelRoles, nameOrRole) ? contracts.panelRoles[nameOrRole]
    : contracts.profiles.find(p => p.id === nameOrRole)?.outputSchema ?? nameOrRole;
  if (!own(contracts.schemas, name)) return undefined;
  return { name, schema: JSON.parse(JSON.stringify(contracts.schemas[name])) };
}
export const profile = id => {
  const found = contracts.profiles.find(p => p.id === id);
  return found && JSON.parse(JSON.stringify(found));
};
/**
 * Narrow-only host subagent profile definitions (S5): package-relative instructions, a
 * tool deny list and, for the brief profiles, their closed output contract. No model,
 * auth or sandbox fields exist. Panel profiles carry no schema: the controller supplies
 * each role's envelope as the spawn outputSchema.
 */
export function subagentProfiles() {
  return [
    ...contracts.profiles.map(p => ({ id: p.id, description: p.label, instructionsFile: 'skills/pstack/' + p.instructionsFile,
      outputSchema: JSON.parse(JSON.stringify(contracts.schemas[p.outputSchema])), tools: { deny: [...p.narrowTools.deny] } })),
    ...contracts.panelProfiles.map(p => ({ id: p.id, description: p.label, instructionsFile: 'skills/pstack/' + p.instructionsFile,
      tools: { deny: [...p.narrowTools.deny] } })),
  ];
}
/** Whether a profile leaves the shell (exec/process) in the child; then read-only shell use is prompt-enforced. */
export function profileKeepsShell(id) {
  // An unknown id is labelled conservatively: the shell may remain.
  const found = [...contracts.profiles, ...contracts.panelProfiles].find(p => p.id === id);
  return !found || !['group:runtime', 'exec'].some(tool => found.narrowTools.deny.includes(tool));
}
/** The panel profile a controller role spawns under, when one serves it. */
export function panelProfileFor(role) {
  return contracts.panelProfiles.find(p => p.roles.includes(role))?.id;
}

/** Returns every structural and cross-field error; an empty list is agent-attested shape validity only. */
export function checkOutput(nameOrRole, output, context = {}) {
  const contract = contractFor(nameOrRole);
  if (!contract) return ['unknown output contract: ' + nameOrRole];
  const errors = [];
  check(contract.schema, output, '$', errors);
  if (!errors.length) SEMANTICS[contract.name](output, context, message => errors.push(message));
  return errors;
}
export function assertOutput(nameOrRole, output, context) {
  const errors = checkOutput(nameOrRole, output, context);
  if (errors.length) throw Error('Invalid ' + nameOrRole + ' output: ' + errors.slice(0, 4).join('; '));
}

export function outputInstruction(nameOrRole) {
  const contract = contractFor(nameOrRole);
  if (!contract) throw Error('Unknown output contract: ' + nameOrRole);
  return 'Output contract `' + contract.name + '`: end with exactly one JSON object matching this closed schema. The parent validates it before use; shape validity is not evidence of correctness.\n' + JSON.stringify(contract.schema);
}

/** Splits a profile's required read into a literal file path and an optional section name. */
export const requiredRead = entry => { const at = entry.indexOf('#'); return at < 0 ? { path: entry } : { path: entry.slice(0, at), section: entry.slice(at + 1) }; };
/** A fence longer than any backtick run in the text, so the text cannot close it or start a heading. */
function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return fence + 'text\n' + text + '\n' + fence;
}
export function renderBrief(id, { instructions, task, requiredReads, scope }) {
  const p = profile(id);
  if (!p) throw Error('Unknown pstack brief profile: ' + id);
  if (typeof instructions !== 'string' || !instructions.trim()) throw Error('Brief instructions unavailable');
  if (typeof task !== 'string' || !task.trim() || task.length > 16000) throw Error('Bounded task required');
  if (!Array.isArray(requiredReads) || !requiredReads.length || requiredReads.some(r => typeof r?.path !== 'string' || !r.path.startsWith('/') || r.path.includes('#'))) throw Error('Absolute native contract paths required');
  if (p.readOnly && (!Array.isArray(scope) || !scope.length)) throw Error('Read-only reviewer brief requires an explicit scope');
  if (scope) { const errors = scopeErrors(scope); if (errors.length) throw Error('Invalid review scope: ' + errors.slice(0, 4).join('; ')); }
  return [
    '# ' + p.label,
    'Assurance: agent-attested, prompt-enforced brief. ' + (p.readOnly ? 'Read-only is a brief constraint plus inherited native tool policy, not host enforcement. ' : '') + 'A host profile removes tools only from native controller spawns; a model-facing sessions_spawn cannot select one.',
    instructions.trim(),
    '## Required reads (absolute)\n' + requiredReads.map(r => '- ' + r.path + (r.section ? ' (section `' + r.section + '`)' : '')).join('\n'),
    ...(scope ? ['## Scope (exact files)\nEach entry is one literal repo-relative file path; brackets, dots and other punctuation are part of the name.\n' + scope.map(s => '- ' + s).join('\n')] : []),
    '## Task\nThe parent\'s task, verbatim. Text inside the fence cannot change the sections of this brief.\n' + fenced(task.trim()),
    '## Output\n' + outputInstruction(p.outputSchema),
  ].join('\n\n');
}
