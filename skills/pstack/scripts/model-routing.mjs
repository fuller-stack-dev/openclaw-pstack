/** Native pstack role planning only. No spawning, model discovery, auth or writes. */
export const ROLE_SPECS = Object.freeze({
  'feature, refactoring': 'single',
  'bug-fix': 'single',
  'perf-issue': 'single',
  hillclimb: 'single',
  'judgment and prose': 'single',
  'hardest tasks': 'single',
  'how explorer': 'single',
  'how explainer': 'single',
  'why investigators': 'single',
  'why synthesizer': 'single',
  'reflect tooling': 'single',
  'reflect judgment, divergent, synthesizer': 'single',
  'arena runners': 'panel',
  'arena cross-judge pool': 'pool',
  'swarm workers': 'single',
  'architect runners': 'panel',
  'interrogate reviewers': 'panel',
});
const controls = ['model', 'thinking', 'fastMode'];
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra', 'on'];
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => JSON.parse(JSON.stringify(value));
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(label + ' must be an object');
}
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error('Unknown ' + label + ' field: ' + key);
}
function roleKind(role) {
  if (!own(ROLE_SPECS, role)) throw Error('Unknown pstack role: ' + role);
  return ROLE_SPECS[role];
}
function modelRef(value) {
  if (typeof value !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(value)) throw Error('Expected exact native provider/model ID');
}
function selection(value) {
  keys(value, controls, 'selection');
  if (own(value, 'model')) modelRef(value.model);
  if (own(value, 'thinking') && !thinkingLevels.includes(value.thinking)) throw Error('Unknown thinking control');
  if (own(value, 'fastMode') && ![true, false, 'auto', 'ultrafast'].includes(value.fastMode)) throw Error('Unknown fastMode control');
  return clone(value);
}
function entry(value, presets) {
  if (value === 'inherit') return {};
  if (typeof value === 'string') {
    if (!own(presets, value)) throw Error('Unknown preset: ' + value);
    return selection(presets[value]);
  }
  return selection(value);
}
function roleEntries(role, value, presets) {
  if (roleKind(role) === 'single') {
    if (Array.isArray(value)) throw Error(role + ' requires one selection');
    return [entry(value, presets)];
  }
  if (!Array.isArray(value) || value.length !== 2) throw Error(role + ' requires exactly two entries');
  return value.map(item => entry(item, presets));
}
/** Missing roles inherit; an existing malformed config never silently becomes absent. */
export function validateConfig(config) {
  if (config === null || config === undefined) return null;
  keys(config, ['version', 'presets', 'roles'], 'config');
  if (config.version !== 1) throw Error('Unsupported config version');
  object(config.presets, 'presets'); object(config.roles, 'roles');
  for (const [name, value] of Object.entries(config.presets)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || name === 'inherit') throw Error('Invalid preset name: ' + name);
    selection(value);
  }
  for (const [role, value] of Object.entries(config.roles)) roleEntries(role, value, config.presets);
  return clone(config);
}
/** null means no native catalog was available: availability is unverified, never assumed absent. */
function catalogMap(catalog) {
  if (catalog === null) return null;
  if (!Array.isArray(catalog)) throw Error('catalog must be an array of native available model records');
  const map = new Map();
  for (const record of catalog) {
    keys(record, ['id', 'family', 'thinkingLevels', 'fastModes'], 'catalog record');
    modelRef(record.id);
    if (map.has(record.id)) throw Error('Duplicate catalog model: ' + record.id);
    if (record.family !== undefined && (typeof record.family !== 'string' || !record.family.trim())) throw Error('Invalid model family');
    for (const field of ['thinkingLevels', 'fastModes']) {
      if (own(record, field) && !Array.isArray(record[field])) throw Error(field + ' must be an array');
    }
    map.set(record.id, record);
  }
  return map;
}
function validateAvailable(requested, catalog) {
  if (!requested.model || catalog === null) return;
  const record = catalog.get(requested.model);
  if (!record) throw Error('Unavailable native model: ' + requested.model);
  for (const [field, capability] of [['thinking', 'thinkingLevels'], ['fastMode', 'fastModes']]) {
    if (own(requested, field) && record[capability] && !record[capability].includes(requested[field])) {
      throw Error('Unsupported ' + field + ' for ' + requested.model);
    }
  }
}
function validateConfiguration(config, models) {
  const parsed = validateConfig(config);
  if (parsed) {
    for (const preset of Object.values(parsed.presets)) validateAvailable(preset, models);
    for (const [configuredRole, value] of Object.entries(parsed.roles)) {
      roleEntries(configuredRole, value, parsed.presets).forEach(item => validateAvailable(item, models));
    }
  }
  return parsed;
}
/** Complete structural and native-catalog validation, including unused selections. A null catalog checks structure only. */
export function validateConfigAgainstCatalog(config, catalog = []) {
  return validateConfiguration(config, catalogMap(catalog));
}
/** Resolve once per new delegation; store this JSON snapshot in the existing task record. */
export function resolveRole({role, config = null, overrides, catalog = [], parentModel, parentFamily}) {
  const kind = roleKind(role), models = catalogMap(catalog);
  const parsed = validateConfiguration(config, models);
  let source = 'inherit';
  let candidates = kind === 'single' ? [{}] : [{}, {}];
  if (parsed && own(parsed.roles, role)) {
    candidates = roleEntries(role, parsed.roles[role], parsed.presets); source = 'config';
  }
  if (overrides !== undefined) {
    candidates = roleEntries(role, overrides, parsed?.presets ?? {}); source = 'override';
  }
  for (const requested of candidates) validateAvailable(requested, models);
  let selections = candidates, poolIndex = null, diversity = 'not-applicable';
  if (kind !== 'single') {
    const catalogFamily = models?.get(parentModel)?.family;
    if (parentFamily !== undefined && (typeof parentFamily !== 'string' || !parentFamily.trim())) throw Error('Invalid parent family');
    if (catalogFamily !== undefined && parentFamily !== undefined && catalogFamily !== parentFamily) {
      throw Error('Parent family contradicts native catalog');
    }
    // Families are compared only for equality; an absent family is unknown, never different.
    // An inherited entry runs the parent's model, so it has the parent's family.
    const family = catalogFamily ?? parentFamily;
    const familyOf = item => item.model ? models?.get(item.model)?.family : family;
    const differs = (a, b) => a !== undefined && b !== undefined && a !== b;
    if (kind === 'pool') {
      const different = candidates.findIndex(item => differs(familyOf(item), family));
      poolIndex = different < 0 ? 0 : different;
      diversity = different >= 0 ? 'different-family'
        : family !== undefined && candidates.every(item => familyOf(item) === family) ? 'not-established' : 'unverified';
      selections = [candidates[poolIndex]];
    } else {
      // A panel's two entries: different only when both families are known and differ.
      const [a, b] = candidates.map(familyOf);
      diversity = differs(a, b) ? 'different-family'
        : (a !== undefined && a === b) || (candidates[0].model ?? null) === (candidates[1].model ?? null) ? 'not-established' : 'unverified';
    }
  }
  return {version: 1, role, source, selections: clone(selections), poolIndex, diversity};
}
/** Revalidation does not consult new config or reselect an already chosen pool member. */
export function validateSnapshot(snapshot, catalog = []) {
  keys(snapshot, ['version', 'role', 'source', 'selections', 'poolIndex', 'diversity'], 'snapshot');
  const kind = roleKind(snapshot.role);
  if (snapshot.version !== 1 || !['inherit', 'config', 'override'].includes(snapshot.source)) throw Error('Invalid snapshot metadata');
  if (!Array.isArray(snapshot.selections) || snapshot.selections.length !== (kind === 'panel' ? 2 : 1)) throw Error('Invalid snapshot cardinality');
  if (kind === 'pool' ? ![0, 1].includes(snapshot.poolIndex) : snapshot.poolIndex !== null) throw Error('Invalid snapshot pool index');
  // Panels resolved before families were compared keep their recorded 'not-applicable'.
  const allowedDiversity = kind === 'pool' ? ['different-family', 'not-established', 'unverified']
    : kind === 'panel' ? ['not-applicable', 'different-family', 'not-established', 'unverified'] : ['not-applicable'];
  if (!allowedDiversity.includes(snapshot.diversity)) throw Error('Invalid snapshot diversity');
  const models = catalogMap(catalog);
  snapshot.selections.forEach(item => validateAvailable(selection(item), models));
  return clone(snapshot);
}
function schemaAccepts(schema, value) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.anyOf) return schema.anyOf.some(item => schemaAccepts(item, value));
  if (schema.oneOf) return schema.oneOf.filter(item => schemaAccepts(item, value)).length === 1;
  if (own(schema, 'const') && schema.const !== value) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && typeof value !== schema.type) return false;
  return true;
}
function spawnFields(args, properties, label) {
  object(args, label);
  for (const field of Object.keys(args)) {
    if (!own(properties, field)) throw Error('Unknown native spawn argument: ' + field);
    if (['task', ...controls].includes(field)) throw Error('Routing controls belong in selection, not ' + label);
  }
  if (args.runtime && args.runtime !== 'subagent') throw Error('This adapter uses native subagents, not ACP');
}
/** Strings a blind trial must not see: every selected model ID, its provider-less names, and the invoking workspace path. */
function blindLeaks(saved, workspace) {
  const leaks = [];
  for (const item of saved.selections) {
    if (!item.model) continue;
    // The full ID and every shorter provider-less tail, e.g. openai/gpt-6-astra and gpt-6-astra.
    const parts = item.model.split('/');
    parts.forEach((_, index) => leaks.push(parts.slice(index).join('/')));
  }
  if (workspace) leaks.push(workspace);
  return [...new Set(leaks.filter(value => value.length >= 3))];
}
/**
 * Measurement framing a candidate-visible eval trial never carries: the rubric or oracle, scoring
 * the trial's own cases, telling it that it is judged or compared, or naming its competitors.
 * Ordinary subject words (a requested regression test, an expression evaluator, a bowling score,
 * a memory arena, a Judge class) are not framing and pass.
 */
// A clause ends at punctuation or the end of the text: "This is a benchmark." frames the trial, "This is a benchmark regression" does not.
const CLAUSE_END = String.raw`(?=\s*(?:[.;:!?,)\u2013\u2014]|$))`;
const MEASUREMENT_FRAMING = [
  /\b(?:grading (?:criteria|scheme|policy)|scoring (?:criteria|scheme|policy|rubric)|hidden tests?)\b/i,
  // Resources frame a trial when instructions tell it to use/match them, not when they name its subject.
  /(?<=\b(?:use|follow|apply|consult|match|meet|satisfy)\s+(?:(?:an?|the|our)\s+)?)(?:rubrics?|oracles?|expected (?:outputs?|answers?|results?))\b(?=\s*(?:[.;:!?,]|$)|\s+(?:in|to|for|exactly|below)\b)/i,
  /\b(?:grader|judge)\s+(?:will\s+)?(?:assess|evaluate|grade|review|score)\s+(?:you|your\s+(?:work|diff|answer|code|attempt))\b/i,
  /\b(?:run|execute)\s+(?:the\s+)?eval(?:uation)?\s+harness\s+(?:after|on\s+your)\b/i,
  /\b(?:we|they)\s+(?:will\s+)?(?:grade|score|judge|evaluate)\s+(?:this|your)\s+(?:attempt|answer|work|solution|diff)\b/i,
  /\b(?:score|grade)\s+(?:each|every|all|your)\s+(?:cases?|answers?|outputs?|results?|attempts?|solutions?|trials?)\b/i,
  /\b(?:you|your\s+(?:\w+\s+)?(?:answers?|outputs?|work|solutions?|responses?|attempts?|code|results?|changes?))\s+(?:are|is|will\s+be|get|gets)\s+(?:being\s+)?(?:evaluated|judged|scored|graded|compared|benchmarked|ranked|measured)\b/i,
  // Competitors: a competing or rival model, any other candidate or runner, or other models or assistants doing this task.
  /\b(?:competing|rival)\s+(?:models?|candidates?|runners?|agents?|contestants?|entrants?|assistants|AIs|LLMs)\b/i,
  /\bother\s+(?:candidates?|runners?|contestants?|entrants?)\b/i,
  /\bother\s+(?:AI\s+)?(?:models?|agents?|assistants|AIs|LLMs|instances)\b(?=\s+(?:(?:are|were|will\s+be|have\s+been|also|already)\s+)*(?:solving|attempting|working\s+on|doing|competing|trying|tackling|answering|racing|tried|attempted|solved|answered|given|getting|receiving|solve|attempt|try|compete|tackle|answer|get|receive|race)\b)/i,
  /\b(?:another|several)\s+(?:AI\s+)?(?:models?|agents?|assistants?)\b(?=\s+(?:(?:is|are|were|will\s+be|have\s+been|also|already)\s+)*(?:solving|attempting|doing|trying|tackling|answering|tried|attempted|solved|answered)\s+(?:(?:this|the\s+same)\s+(?:task|problem)\b|(?:this|it)\s*(?:[.;!?,]|$)))/i,
  /\bother\s+(?:AI\s+)?(?:models?|assistants|agents?)\s*(?::\s*|(?:are\s+)?)(?:your\s+)?(?:competitors|opponents|rivals|competition)\b/i,
  /\bother\s+\w+\s+instances\s+(?:are\s+)?(?:also\s+)?(?:attempting|solving)\s+(?:this|the\s+same)\s+task\b/i,
  /\byou(?:\s+are|'re)\s+competing\s+(?:against|with)\b/i,
  /\bwe\s+are\s+comparing\s+(?:assistants|models|agents)\s+on\s+this\s+task\b/i,
  /\byou(?:\s+are|'re)\s+one\s+of\s+many\s+in\s+(?:a|the)\s+benchmark\b/i,
  /\b(?:we\s+are\s+testing\s+you|testing\s+your\s+ability)\b/i,
  /\byou(?:\s+are|'re)\s+one\s+of\s+(?:\w+\s+)?(?:candidates?|models?|agents?|assistants|attempts?|runners?|contestants?|entrants?|solvers?)\b/i,
  // 1.2.5 (P3-70, P3-76): the trial named as an eval, benchmark or experiment at the end of its clause; told it is tested.
  new RegExp(String.raw`\b(?:this|the)\s+(?:(?:task|trial|exercise|run|attempt|request|prompt)\s+)?is\s+(?:(?:also\s+)?part\s+of\s+)?(?:an?\s+|the\s+)?(?:eval(?:uation)?s?|benchmark|experiment)(?:[\s-]+(?:task|run|suite|trial|set|style\s+task))?` + CLAUSE_END, 'i'),
  new RegExp(String.raw`\byou(?:\s+are|'re)\s+being\s+(?:tested|evaluated|judged|scored|graded|benchmarked|compared)(?:` + CLAUSE_END + String.raw`|(?=\s+(?:on|for)\s+(?:your|how|whether)\b|\s+(?:against|alongside)\b))`, 'i'),
  // A reference or criteria the trial is checked against, or that a clause states as the answer; never the subject of an edit.
  /(?<=\b(?:checked|compared|graded|scored|judged|evaluated|measured|verified|tested|matched|diffed)\s+(?:against|to|with)\s+(?:(?:an?|the|our)\s+)?(?:hidden\s+)?)(?:reference(?:\s+(?:solutions?|answers?|implementation))?|answer\s+key|ground\s+truth|gold(?:en)?\s+answers?)\b/i,
  /\breference\s+implementation\s+(?:that\s+)?we\s+compare\s+against\b/i,
  /(?<=(?:^|[.;!?\n]\s*|\b(?:the|our|your|my)\s+))(?:reference\s+(?:solutions?|answers?)|answer\s+key|success\s+criteri(?:a|on)|pass\s+criteria|ground\s+truth|gold(?:en)?\s+answers?)(?=\s*:|\s+(?:says|say|reads|expects|requires|lists|gives)\b|\s+(?:is|are)\s+(?:that\b|to\b|whether\b))/i,
  // Answer declarations may contain lists, units or case qualifiers. Only known layout/UI predicates
  // are subject descriptions; requiring a bare value at clause end would leak short answer keys.
  /\b(?:gold(?:en)?\s+answers?|success\s+criteri(?:a|on)|ground\s+truth|answer\s+key|reference\s+(?:solutions?|answers?)|pass\s+criteria|expected\s+(?:answers?|outputs?|results?))(?=(?:\s*:\s*|\s+(?:is|are)\s+)(?!\d+(?:\.\d+)?\s+(?:columns?|rows?|characters?|chars?|pixels?|px)\b)(?!(?:"[^"]*"|'[^']*'|\x60[^\x60]*\x60|\([^)]*\)|\[[^\]]*\])\s+in\s+(?:the\s+)?(?:menu|dropdown)\b)(?:\d|["'\x60(\[]))/i,
  /\bexpected\s+answers?(?=\s*:)/i,
  // Scoring the trial's own cases: an instruction to record a score or verdict per case, not a feature that stores or prints one.
  /(?<=\b(?:record|report|give|assign|mark|write\s+\S+\s+with)\s+(?:(?:an?|the|your)\s+)?)(?:score|grade|verdict|pass\/fail|pass\s+or\s+fail)\s+(?:for|of|on)\s+(?:each|every)\s+(?:test\s+)?(?:cases?|answers?|attempts?|solutions?)\b(?!\s+in\s+(?:the\s+)?(?!(?:results|summary)\b)[\w-]+\s+table\b)/i,
  /\bgive\s+(?:each|every)\s+(?:test\s+)?case\s+(?:a\s+)?score\b(?=\s*(?:[.;!?]|$)|\s+in\s+results\b)/i,
  new RegExp(String.raw`\b(?:each|every)\s+(?:answer|case|attempt)\s+is\s+(?:scored|graded)` + CLAUSE_END, 'i'),
  /\bmark\s+(?:each|every)\s+(?:test\s+)?case\s+pass\s+or\s+fail\b(?=\s*(?:[.;!?]|$)|\s+in\s+results\b)/i,
];
const squash = value => value.toLowerCase().replace(/\s+/g, ' ').trim();
/** Whether squashed text contains a squashed withheld item as whole words, so "fast" never matches "breakfast". */
const containsWhole = (text, item) => new RegExp('(?<![\\p{L}\\p{N}_])' + item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_])', 'u').test(text);
/**
 * A collector (`collect: true`) is collected with `agents_wait` and `awaitResults: true`, which waits until the
 * child settles; only the child's own `runTimeoutSeconds` bounds that wait, and the host default (0) means no
 * limit. So every collector a plan returns gets a bound: 600 seconds when it has none, which covered every collector
 * in the 1.2.3 rerun (84 runs, longest 595 s), and at most 900 seconds on request. The bound counts from the child's
 * own start, so time queued behind other children is extra. A longer phase is an announcing child, which hands off
 * visibly after a 60-second wait instead of holding the reply.
 */
export const COLLECTOR_RUN_TIMEOUT_SECONDS = 600;
export const COLLECTOR_MAX_RUN_TIMEOUT_SECONDS = 900;
/** The refusal for a collector that asks for more than the maximum. */
export const collectorRefusal = seconds => 'A collector holds the reply until it settles, so its runTimeoutSeconds is at most ' + COLLECTOR_MAX_RUN_TIMEOUT_SECONDS + ' (got ' + seconds + '); spawn a longer phase as an announcing child (omit collect) and hand off';
/**
 * A spawn's runTimeoutSeconds read the way the host's sessions_spawn reads it (`readNonNegativeIntegerParam`):
 * the camelCase key or its `run_timeout_seconds` alias; absent, null or a blank string is unset; a number or a
 * numeric string must be a non-negative integer.
 * @param {Record<PropertyKey, unknown>} args
 * @returns {{key: string | undefined, seconds: number | undefined}}
 */
export function readRunTimeoutSeconds(args) {
  const key = own(args, 'runTimeoutSeconds') ? 'runTimeoutSeconds' : own(args, 'run_timeout_seconds') ? 'run_timeout_seconds' : undefined;
  const raw = key === undefined ? undefined : args[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return {key, seconds: undefined};
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw Error('runTimeoutSeconds must be a non-negative integer (got ' + JSON.stringify(raw) + ')');
  return {key, seconds: value};
}
/**
 * A collector's spawn arguments with its run bound: the default when unset or 0 (no limit); refused above the maximum.
 * The result always carries a numeric `runTimeoutSeconds`, never the snake_case alias.
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown> | undefined} properties the host sessions_spawn schema properties, when known
 * @returns {Record<string, unknown>}
 */
export function boundCollector(args, properties) {
  if (args.collect !== true) return args;
  if (properties && !own(properties, 'runTimeoutSeconds')) throw Error('This host cannot bound a collector (no runTimeoutSeconds in sessions_spawn); spawn the phase as an announcing child (omit collect)');
  const {key, seconds} = readRunTimeoutSeconds(args);
  if (seconds !== undefined && seconds > COLLECTOR_MAX_RUN_TIMEOUT_SECONDS) throw Error(collectorRefusal(seconds));
  const bound = seconds || COLLECTOR_RUN_TIMEOUT_SECONDS;
  if (key === 'runTimeoutSeconds' && args.runTimeoutSeconds === bound && !own(args, 'run_timeout_seconds')) return args;
  const {run_timeout_seconds: _alias, ...rest} = args;
  return {...rest, runTimeoutSeconds: bound};
}
/** The host capability whose `blind` spawn argument omits the child's model identity and workspace from its own prompt. */
export const HOST_BLIND_CAPABILITY = 'native-subagent-blind-v1';
/**
 * Return only first-class sessions_spawn arguments; the caller executes the tool.
 * By default each task carries the routing snapshot for continuation. With `blind`,
 * the task is returned exactly as given, without the snapshot, model IDs, role or
 * workspace; keep custody from `custodyRecords` in the parent record instead. A blind
 * task, or a spawn argument value, that already names a selected model or the
 * workspace is refused. `trialArgs` adds one argument object per selection, such as
 * each trial's own cwd.
 *
 * `withheld` lists judge-only text (the rubric, expected results or oracle, the parent's own
 * measurements) that a blind task or argument must not contain as whole words; blind `arena runners`
 * trials need it, and their visible text must not frame the trial as measured either. With `hostBlind` (the host
 * advertises native-subagent-blind-v1 and its spawn schema has `blind`), every blind spawn also
 * carries `blind: true` and `context: "isolated"`, so the host omits the child's model identity and
 * workspace from its own prompt.
 */
export function buildSpawnArgs({snapshot, task, catalog = /** @type {Array<{id: string, family?: string, thinkingLevels?: unknown[], fastModes?: unknown[]}>} */ ([]), spawnSchema, baseArgs = {}, trialArgs = /** @type {Array<Record<string, unknown>> | undefined} */ (undefined), blind = false, workspace, withheld = /** @type {string[] | undefined} */ (undefined), hostBlind = false}) {
  const saved = validateSnapshot(snapshot, catalog);
  if (typeof task !== 'string' || !task.trim()) throw Error('A bounded task is required');
  if (typeof blind !== 'boolean') throw Error('blind must be a boolean');
  if (withheld !== undefined && (!blind || !Array.isArray(withheld) || !withheld.length || withheld.length > 32 || withheld.some(item => typeof item !== 'string' || squash(item).length < 4 || item.length > 4000))) {
    throw Error(blind ? 'withheld needs 1-32 strings of 4-4000 characters' : 'withheld belongs only to a blind plan');
  }
  const properties = spawnSchema?.properties;
  if (!properties || !own(properties, 'task')) throw Error('Current sessions_spawn schema required');
  spawnFields(baseArgs, properties, 'baseArgs');
  if (trialArgs !== undefined) {
    if (!Array.isArray(trialArgs) || trialArgs.length !== saved.selections.length) throw Error('trialArgs needs exactly one object per selection (' + saved.selections.length + ')');
    trialArgs.forEach(args => spawnFields(args, properties, 'trialArgs'));
  }
  if (workspace !== undefined && (typeof workspace !== 'string' || !workspace.trim())) throw Error('Invalid invoking workspace');
  if (blind) {
    const visible = [task, ...[baseArgs, ...(trialArgs ?? [])].flatMap(args => Object.values(args).filter(value => typeof value === 'string'))];
    const leaked = blindLeaks(saved, workspace).filter(value => visible.some(text => text.includes(value)));
    if (leaked.length) throw Error('A blind task or spawn argument names ' + leaked.length + ' selected model ID(s) or the workspace path; remove them before planning');
    // Judge-only text never reaches a candidate-visible task: the trial states the goal, not the measurement.
    const shown = visible.map(squash), kept = (withheld ?? []).map(squash).filter(item => shown.some(text => containsWhole(text, item)));
    if (kept.length) throw Error('A blind task or spawn argument contains ' + kept.length + ' withheld judge-only item(s) (rubric, expected results, oracle or the parent\'s own results); state the organic goal only');
    if (saved.role === 'arena runners') {
      if (withheld === undefined) throw Error('A blind arena runners trial needs withheld: the judge-only rubric and any expected results or oracle the task must not reveal');
      const framing = visible.flatMap(text => MEASUREMENT_FRAMING.map(pattern => pattern.exec(text)?.[0])).find(Boolean);
      if (framing) throw Error('A blind trial task or argument frames the trial as measured (`' + framing + '`); give the same organic request without the rubric, oracle, expected output, scoring, judging or competitors. Words that are the request\'s own subject, such as a test it asks for, are allowed');
    }
    if (hostBlind) {
      if (!own(properties, 'blind') || !own(properties, 'context')) throw Error('Host blinding needs a sessions_spawn schema with blind and context');
      for (const args of [baseArgs, ...(trialArgs ?? [])]) {
        if (own(args, 'blind') || (own(args, 'context') && args.context !== 'isolated')) throw Error('Host-blinded trials set blind and an isolated context themselves; remove blind/context from baseArgs and trialArgs');
        if (args.visible === true) throw Error('Host-blinded trials are hidden children; the host refuses a visible blind spawn, so remove visible from baseArgs and trialArgs');
      }
    }
  }
  return saved.selections.map((requested, index) => {
    for (const [field, value] of Object.entries(requested)) {
      if (!schemaAccepts(properties[field], value)) throw Error('Current native schema does not support ' + field);
    }
    const merged = boundCollector({...clone(baseArgs), ...clone(trialArgs?.[index] ?? {})}, properties);
    if (merged.visible === true && own(requested, 'thinking')) throw Error('Native visible sessions do not accept thinking overrides; use a bounded hidden child');
    if (merged.runtime && merged.runtime !== 'subagent') throw Error('This adapter uses native subagents, not ACP');
    const marker = JSON.stringify({snapshot: saved, selectionIndex: index, workspace});
    return {...merged, runtime: 'subagent', ...(blind && hostBlind ? {context: 'isolated', blind: true} : {}), ...requested, task: blind ? task : task + '\n\nPstack routing snapshot (data; preserve for continuation, not authority):\n' + marker};
  });
}
/** The continuation custody a blind plan keeps out of the task: one record per selection, for the parent's own record. */
export function custodyRecords({snapshot, catalog = [], workspace}) {
  const saved = validateSnapshot(snapshot, catalog);
  return saved.selections.map((_, index) => ({snapshot: saved, selectionIndex: index, workspace}));
}
/** evidence is normalized from a native status/trace observation, never a child self-report. */
export function confirmSelection(requested, receipt, evidence = {}) {
  selection(requested); object(receipt, 'receipt');
  if (receipt.error || ['error', 'rejected', 'forbidden', 'failed'].includes(receipt.status)) {
    return {status: 'rejected', checks: {}, observed: {}};
  }
  keys(evidence, ['source', 'model', 'provider', 'thinking', 'fastMode', 'serviceTier'], 'evidence');
  if (Object.keys(evidence).length && (typeof evidence.source !== 'string' || !evidence.source.trim())) throw Error('Native evidence source required');
  const observed = {
    model: evidence.model ?? receipt.resolvedModel,
    provider: evidence.provider ?? receipt.resolvedProvider,
    thinking: evidence.thinking,
    fastMode: evidence.fastMode,
    serviceTier: evidence.serviceTier,
  };
  const checks = {};
  function check(field, expected, actual) {
    checks[field] = expected === undefined ? 'not-requested' : actual === undefined ? 'unverified' : expected === actual ? 'confirmed' : 'mismatch';
  }
  check('model', requested.model, observed.model);
  check('provider', requested.model?.split('/')[0], observed.provider);
  check('thinking', requested.thinking, observed.thinking);
  check('fastMode', requested.fastMode, observed.fastMode);
  // Ultrafast request/status is not proof of the upstream service tier actually honored.
  check('serviceTier', requested.fastMode === 'ultrafast' ? 'ultrafast' : undefined, observed.serviceTier);
  // Conflicting native observations cannot be hidden by a later normalized status value.
  for (const field of ['model', 'provider']) {
    const receiptValue = receipt[field === 'model' ? 'resolvedModel' : 'resolvedProvider'];
    if (receiptValue !== undefined && observed[field] !== undefined && receiptValue !== observed[field]) checks[field] = 'mismatch';
  }
  const values = Object.values(checks);
  if (!observed.model || !observed.provider) values.push('unverified');
  return {status: values.includes('mismatch') ? 'mismatch' : values.includes('unverified') ? 'unverified' : 'confirmed', checks, observed};
}
