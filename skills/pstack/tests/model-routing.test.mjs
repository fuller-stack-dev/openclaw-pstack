import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, mkdir, symlink, lstat, readlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveRole, validateConfig, validateSnapshot, buildSpawnArgs, confirmSelection, boundCollector} from '../scripts/model-routing.mjs';
import {planFromWorkspace} from '../scripts/model-routing-cli.mjs';

// The alternate provider is deliberately fictitious: this test does not select a live Opus route.
const sol = {model: 'openai/gpt-6.1-sol', thinking: 'high', fastMode: 'ultrafast'};
const opus = {model: 'fixture-opus/opus-five-five', thinking: 'xhigh'};
const catalog = [
  {id: sol.model, family: 'gpt', thinkingLevels: ['high', 'xhigh'], fastModes: [false, true, 'auto', 'ultrafast']},
  {id: opus.model, family: 'claude', thinkingLevels: ['high', 'xhigh'], fastModes: [false, true, 'auto']},
];
const solRoles = ['feature, refactoring', 'bug-fix', 'perf-issue', 'hillclimb', 'how explorer', 'why investigators', 'reflect tooling', 'swarm workers'];
const opusRoles = ['judgment and prose', 'hardest tasks', 'how explainer', 'why synthesizer', 'reflect judgment, divergent, synthesizer'];
const panels = ['arena runners', 'architect runners', 'interrogate reviewers'];
const pool = 'arena cross-judge pool';
const config = {version: 1, presets: {sol, opus}, roles: {
  ...Object.fromEntries(solRoles.map(role => [role, 'sol'])),
  ...Object.fromEntries(opusRoles.map(role => [role, 'opus'])),
  ...Object.fromEntries([...panels, pool].map(role => [role, ['opus', 'sol']])),
}};
const schema = {properties: {
  task: {type: 'string'}, runtime: {enum: ['subagent', 'acp'], type: 'string'},
  model: {type: 'string'}, thinking: {type: 'string'},
  fastMode: {anyOf: [{type: 'boolean'}, {type: 'string', const: 'auto'}, {type: 'string', const: 'ultrafast'}]},
  visible: {type: 'boolean'}, taskName: {type: 'string'}, label: {type: 'string'},
}};
const resolve = (role, extra = {}) => resolveRole({role, config, catalog, parentModel: sol.model, ...extra});
const build = (snapshot, extra = {}) => buildSpawnArgs({snapshot, catalog, task: 'Read the scoped artifact and report defects; no writes.', spawnSchema: schema, ...extra});
const routing = arg => Object.fromEntries(['model', 'thinking', 'fastMode'].filter(key => Object.hasOwn(arg, key)).map(key => [key, arg[key]]));
async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pstack-routing-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

for (const role of solRoles) test(role + ': Sol high and ultrafast are separate native arguments', () => {
  const args = build(resolve(role));
  assert.equal(args.length, 1);
  assert.deepEqual(routing(args[0]), sol);
});
for (const role of opusRoles) test(role + ': alternate-model judgment is a bounded Opus xhigh delegation', () => {
  const args = build(resolve(role));
  assert.equal(args.length, 1);
  assert.deepEqual(routing(args[0]), opus);
  assert.equal(args[0].runtime, 'subagent');
  assert.match(args[0].task, /^Read the scoped artifact/);
});
for (const role of panels) test(role + ': exactly two ordered native delegations', () => {
  const args = build(resolve(role));
  assert.deepEqual(args.map(routing), [opus, sol]);
  const records = args.map(arg => JSON.parse(arg.task.split('\n').at(-1)));
  assert.deepEqual(records.map(record => record.selectionIndex), [0, 1]);
  assert.deepEqual(records[0].snapshot, resolve(role));
});
test(pool + ': choose one differing family, not both pool entries', () => {
  const fromSol = resolve(pool);
  assert.deepEqual(build(fromSol).map(routing), [opus]);
  assert.equal(fromSol.diversity, 'different-family');
  const fromOpus = resolve(pool, {parentModel: opus.model});
  assert.deepEqual(build(fromOpus).map(routing), [sol]);
  assert.equal(fromOpus.poolIndex, 1);
});
test('same-family providers do not masquerade as model diversity', () => {
  const other = {id: 'fixture-other/opus-five-five', family: 'claude'};
  const result = resolve(pool, {catalog: [...catalog, other], parentModel: other.id});
  assert.equal(result.poolIndex, 1);
  const same = resolve(pool, {overrides: ['opus', 'opus'], parentModel: opus.model});
  assert.equal(same.poolIndex, 0);
  assert.equal(same.diversity, 'not-established');
});
test('unknown parent family keeps one deterministic selection and discloses uncertainty', () => {
  const result = resolve(pool, {parentModel: undefined});
  assert.equal(result.poolIndex, 0);
  assert.equal(result.diversity, 'unverified');
});
test('missing config inherits native defaults for all 17 roles', () => {
  for (const role of [...solRoles, ...opusRoles, ...panels, pool]) {
    const snapshot = resolve(role, {config: null});
    const args = build(snapshot);
    assert.equal(args.length, panels.includes(role) ? 2 : 1);
    assert.ok(args.every(arg => Object.keys(routing(arg)).length === 0));
  }
});
test('explicit overrides replace config selections without leaking old controls', () => {
  assert.deepEqual(build(resolve('bug-fix', {overrides: opus})).map(routing), [opus]);
  assert.deepEqual(build(resolve('judgment and prose', {overrides: 'inherit'})).map(routing), [{}]);
  assert.deepEqual(build(resolve('arena runners', {overrides: ['sol', 'opus']})).map(routing), [sol, opus]);
  assert.deepEqual(build(resolve('how explorer', {overrides: {thinking: 'high'}})).map(routing), [{thinking: 'high'}]);
});
test('unknown roles, preset typos and invalid cardinality are errors, never substitutions', () => {
  for (const role of ['retired role', 'how critics', '__proto__']) assert.throws(() => resolve(role), /Unknown pstack role/);
  assert.throws(() => resolve('bug-fix', {overrides: 'typo'}), /Unknown preset/);
  for (const overrides of [[], ['opus'], ['opus', 'sol', 'sol'], 'opus']) assert.throws(() => resolve('arena runners', {overrides}), /exactly two/);
  assert.throws(() => resolve('bug-fix', {overrides: ['opus']}), /requires one/);
});
test('unknown model and unsupported native controls fail before creating arguments', () => {
  assert.throws(() => resolve('bug-fix', {overrides: {model: 'missing/model'}}), /Unavailable native model/);
  for (const overrides of [{model: 'auto'}, {thinking: 'gigantic'}, {fastMode: 'fast'}, {authProfile: 'x'}, {provider: 'x'}]) {
    assert.throws(() => resolve('bug-fix', {overrides}));
  }
  assert.throws(() => resolve('bug-fix', {overrides: {...opus, fastMode: 'ultrafast'}}), /Unsupported fastMode/);
  assert.throws(() => resolve('bug-fix', {overrides: {...sol, thinking: 'max'}}), /Unsupported thinking/);
});
test('strict config version and field validation rejects malformed structures', () => {
  for (const value of [[], {}, {...config, version: 2}, {...config, extra: true}, {...config, presets: []}, {...config, roles: {'how critics': 'sol'}}, {...config, presets: {sol: {...sol, apiKey: 'not-a-secret'}}}]) assert.throws(() => validateConfig(value));
});
test('native schema is required and ultrafast is not silently downgraded', () => {
  const snapshot = resolve('bug-fix');
  assert.throws(() => build(snapshot, {spawnSchema: undefined}), /schema required/);
  const oldSchema = structuredClone(schema);
  oldSchema.properties.fastMode = {type: 'boolean'};
  assert.throws(() => build(snapshot, {spawnSchema: oldSchema}), /does not support fastMode/);
  delete oldSchema.properties.thinking;
  assert.throws(() => build(resolve('how explainer'), {spawnSchema: oldSchema}), /does not support thinking/);
});
test('native hidden-only thinking and credential boundaries are preserved', () => {
  assert.throws(() => build(resolve('how explainer'), {baseArgs: {visible: true}}), /visible sessions/);
  for (const baseArgs of [{authProfile: 'x'}, {model: sol.model}, {thinking: 'low'}, {fastMode: false}, {runtime: 'acp'}]) assert.throws(() => build(resolve('bug-fix'), {baseArgs}));
  assert.equal(build(resolve('bug-fix'), {baseArgs: {label: 'Bounded fix'}})[0].label, 'Bounded fix');
});
test('workspace config is reread for new work; resume retains original exact selection', async t => {
  const dir = await workspace(t), path = join(dir, 'pstack-models.json');
  const beforeMissing = await planFromWorkspace({workspace: dir, role: 'bug-fix'});
  assert.equal(beforeMissing.configPresent, false);
  assert.deepEqual(beforeMissing.snapshot.selections, [{}]);
  await writeFile(path, JSON.stringify(config));
  const request = {workspace: dir, role: pool, catalog, parentModel: opus.model, task: 'Bounded judge.', spawnSchema: schema};
  const first = await planFromWorkspace(request);
  assert.deepEqual(first.spawnArgs.map(routing), [sol]);
  assert.equal(JSON.parse(first.spawnArgs[0].task.split('\n').at(-1)).workspace, dir, 'children retain the invoking workspace rather than guessing from a worktree');
  const updated = structuredClone(config);
  updated.roles[pool] = ['opus', 'opus'];
  await writeFile(path, JSON.stringify(updated));
  assert.deepEqual((await planFromWorkspace(request)).spawnArgs.map(routing), [opus]);
  const resumed = await planFromWorkspace({...request, parentModel: sol.model, snapshot: first.snapshot});
  assert.deepEqual(resumed.snapshot, first.snapshot);
  assert.deepEqual(resumed.spawnArgs.map(routing), [sol]);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(updated), 'planner does not write user config');
  await assert.rejects(planFromWorkspace({...request, snapshot: first.snapshot, overrides: 'opus'}), /cannot be replaced/);
  assert.throws(() => validateSnapshot(first.snapshot, [catalog[1]]), /Unavailable native model/);
});
test('blind mode keeps model IDs, role and workspace out of trial tasks and returns custody separately', async t => {
  // An eval trial's candidate-visible task must not name the competing models, the arena role or the workspace.
  const dir = await workspace(t);
  await writeFile(join(dir, 'pstack-models.json'), JSON.stringify(config));
  const task = 'Make the retry policy in src/retry.ts handle a 429 with Retry-After. Add design notes if useful.';
  const trialSchema = {properties: {...schema.properties, cwd: {type: 'string'}}};
  const request = {workspace: dir, role: 'arena runners', catalog, parentModel: sol.model, task, spawnSchema: trialSchema};
  const leaky = await planFromWorkspace(request);
  assert.ok(leaky.spawnArgs.every(arg => arg.task.includes(opus.model) && arg.task.includes(dir) && arg.task.includes('arena runners')), 'the default plan carries custody in the task');
  const trials = ['/private/tmp/relay-north', '/private/tmp/relay-south'];
  const withheld = ['a 429 is retried once after Retry-After seconds'];
  const plan = await planFromWorkspace({...request, blind: true, withheld, trialArgs: trials.map(cwd => ({cwd})), baseArgs: {label: 'Relay'}});
  assert.equal(plan.blind, true);
  assert.equal(plan.hostBlind.status, 'unavailable');
  assert.deepEqual(plan.spawnArgs.map(routing), [opus, sol], 'routing controls stay native arguments');
  assert.deepEqual(plan.spawnArgs.map(arg => arg.cwd), trials, 'each trial gets its own environment');
  for (const arg of plan.spawnArgs) {
    assert.equal(arg.task, task, 'the trial task is exactly the organic request');
    assert.equal(arg.label, 'Relay');
    for (const hidden of [opus.model, 'opus-five-five', sol.model, 'gpt-6.1-sol', 'arena', dir, 'Pstack routing snapshot']) assert.ok(!JSON.stringify({task: arg.task, label: arg.label, cwd: arg.cwd}).includes(hidden), hidden);
  }
  assert.deepEqual(plan.custody, [0, 1].map(selectionIndex => ({snapshot: plan.snapshot, selectionIndex, workspace: dir})), 'custody stays for the parent record');
  // The custody snapshot resumes the same selections.
  const resumed = await planFromWorkspace({workspace: dir, snapshot: plan.custody[1].snapshot, catalog, task, spawnSchema: trialSchema, blind: true, withheld});
  assert.deepEqual(resumed.spawnArgs.map(routing), [opus, sol]);
  // A blind cross-judge seat sees only the sanitized labels and rubric.
  const judge = await planFromWorkspace({workspace: dir, role: pool, catalog, parentModel: opus.model, task: 'Score outputs A and B against the four criteria.', spawnSchema: schema, blind: true});
  assert.deepEqual(judge.spawnArgs.map(routing), [sol]);
  assert.equal(judge.spawnArgs[0].task, 'Score outputs A and B against the four criteria.');
  assert.equal(judge.custody[0].snapshot.diversity, 'different-family');
});
test('blind mode refuses a task or argument that already names a selected model or the workspace', async t => {
  const dir = await workspace(t);
  await writeFile(join(dir, 'pstack-models.json'), JSON.stringify(config));
  const request = {workspace: dir, role: 'arena runners', catalog, parentModel: sol.model, spawnSchema: schema, blind: true};
  for (const task of ['Compare with ' + opus.model + '.', 'You are opus-five-five.', 'Run as gpt-6.1-sol.', 'Work in ' + dir + '/src.']) {
    await assert.rejects(planFromWorkspace({...request, task}), /blind task or spawn argument names/, task);
  }
  await assert.rejects(planFromWorkspace({...request, task: 'Fix it.', baseArgs: {label: 'openai/gpt-6.1-sol trial'}}), /blind task or spawn argument names/);
  await assert.rejects(planFromWorkspace({...request, task: 'Fix it.', trialArgs: [{label: 'a'}]}), /one object per selection \(2\)/);
  await assert.rejects(planFromWorkspace({...request, task: 'Fix it.', trialArgs: [{model: sol.model}, {}]}), /Routing controls belong in selection/);
  await assert.rejects(planFromWorkspace({...request, task: 'Fix it.', blind: 'yes'}), /blind must be a boolean/);
  await assert.rejects(planFromWorkspace({workspace: dir, role: 'bug-fix', catalog, blind: true}), /need a task/);
  // Outside blind mode the same task is planned as before, with custody in the task.
  const open = await planFromWorkspace({...request, blind: false, task: 'Compare with ' + opus.model + '.'});
  assert.equal(open.custody, undefined);
  assert.match(open.spawnArgs[0].task, /Pstack routing snapshot/);
});
test('1.2.3: blind trials keep judge-only text and measurement words out, and use host blind children only when offered', async t => {
  const dir = await workspace(t);
  await writeFile(join(dir, 'pstack-models.json'), JSON.stringify(config));
  const task = 'Make the retry policy in src/retry.ts handle a 429 with Retry-After.';
  const withheld = ['429 and 503 are retried; 400 is not', 'policy fidelity'];
  const request = {workspace: dir, role: 'arena runners', catalog, parentModel: sol.model, task, spawnSchema: schema, blind: true, withheld};
  // The 1.2.2 eval rerun's leaks: the oracle in the trial prompt, and a harness that scores the trial's own cases.
  await assert.rejects(planFromWorkspace({...request, task: task + ' Expected: 429 and 503 are retried;   400 is NOT.'}), /contains 1 withheld judge-only item/);
  await assert.rejects(planFromWorkspace({...request, task: task + ' Write assess.mjs and score each case in results.json.'}), /frames the trial as measured \(`score each case`\)/);
  await assert.rejects(planFromWorkspace({...request, withheld: undefined}), /needs withheld/);
  await assert.rejects(planFromWorkspace({...request, blind: false}), /withheld belongs only to a blind plan/);
  await assert.rejects(planFromWorkspace({...request, withheld: ['ab']}), /1-32 strings/);
  // Without the host capability the plan says blinding is unavailable and adds no host argument.
  const plain = await planFromWorkspace(request);
  assert.equal(plain.hostBlind.status, 'unavailable');
  assert.match(plain.hostBlind.notice, /does not advertise native-subagent-blind-v1, so host blinding is unavailable.*never call it a blind trial/);
  assert.ok(plain.spawnArgs.every(arg => !('blind' in arg) && !('context' in arg)));
  // With it, and a spawn schema that accepts blind, every trial is a blind isolated child with the organic task only.
  const blindSchema = {properties: {...schema.properties, blind: {type: 'boolean'}, context: {type: 'string', enum: ['isolated', 'fork']}}};
  const hosted = await planFromWorkspace({...request, spawnSchema: blindSchema}, {hostBlind: true});
  assert.equal(hosted.hostBlind.status, 'native');
  assert.deepEqual(hosted.spawnArgs.map(arg => [arg.blind, arg.context, arg.task]), [[true, 'isolated', task], [true, 'isolated', task]]);
  assert.deepEqual(hosted.spawnArgs.map(routing), [opus, sol]);
  await assert.rejects(planFromWorkspace({...request, spawnSchema: blindSchema, baseArgs: {context: 'fork'}}, {hostBlind: true}), /isolated context themselves/);
  // The capability without a schema field stays unavailable rather than sending an argument the tool would refuse.
  const old = await planFromWorkspace(request, {hostBlind: true});
  assert.equal(old.hostBlind.status, 'unavailable');
  assert.match(old.hostBlind.notice, /This sessions_spawn schema has no blind field/);
  assert.ok(old.spawnArgs.every(arg => !('blind' in arg)));
  // The judge seat may read the rubric, never the parent's own results.
  const judge = {workspace: dir, role: pool, catalog, parentModel: opus.model, spawnSchema: blindSchema, blind: true};
  await assert.rejects(planFromWorkspace({...judge, task: 'Score outputs A and B on the rubric. The parent measured 402 matches and 98 mismatches.', withheld: ['402 matches and 98 mismatches']}, {hostBlind: true}), /withheld judge-only item/);
  const seat = await planFromWorkspace({...judge, task: 'Score outputs A and B on the rubric: policy fidelity, scope.'}, {hostBlind: true});
  assert.deepEqual([seat.spawnArgs[0].blind, seat.spawnArgs[0].context, seat.hostBlind.status], [true, 'isolated', 'native']);
});
test('1.2.4: blind trials refuse measurement framing, not the subject words of an organic request (P3-62, P3-63, P3-65)', async t => {
  const dir = await workspace(t);
  await writeFile(join(dir, 'pstack-models.json'), JSON.stringify(config));
  const task = 'Make the retry policy in src/retry.ts handle a 429 with Retry-After.';
  const schemaCwd = {properties: {...schema.properties, cwd: {type: 'string'}}};
  const request = {workspace: dir, role: 'arena runners', catalog, parentModel: sol.model, task, spawnSchema: schemaCwd, blind: true, withheld: ['429 and 503 are retried; 400 is not']};
  // P3-62: the reviewer's probes are organic requests whose subject uses a measurement word; each is planned unchanged.
  for (const organic of ['Write an expression evaluator for src/calc.ts.', 'Add a regression test for the 429 path.', 'Build a bowling score calculator.',
    'Implement a memory arena allocator.', 'Write a string comparator.', 'List candidates for the next release.', 'Rename the Judge class to Referee.']) {
    const plan = await planFromWorkspace({...request, task: organic});
    assert.deepEqual(plan.spawnArgs.map(arg => arg.task), [organic, organic], organic);
  }
  const testsDir = await planFromWorkspace({...request, trialArgs: [{cwd: '/private/tmp/relay-a/tests'}, {cwd: '/private/tmp/relay-b'}]});
  assert.deepEqual(testsDir.spawnArgs.map(arg => arg.cwd), ['/private/tmp/relay-a/tests', '/private/tmp/relay-b']);
  // Measurement framing is still refused: the rubric or oracle, scoring the trial's own cases, judging, competitors.
  for (const [extra, shown] of [[' Use the rubric in notes.md.', 'rubric'], [' Match the expected output exactly.', 'expected output'], [' Score every answer in results.json.', 'Score every answer'],
    [' Your solution will be judged on clarity.', 'Your solution will be judged'], [' You are being compared with other models.', 'You are being compared'], [' Beat the competing agents.', 'competing agents']]) {
    await assert.rejects(planFromWorkspace({...request, task: task + extra}), new RegExp('frames the trial as measured \\(`' + shown + '`\\).*own subject'), extra);
  }
  // P3-65 W4: framing in a trial argument, not only in the task, is refused.
  await assert.rejects(planFromWorkspace({...request, trialArgs: [{cwd: '/private/tmp/relay-a'}, {cwd: '/private/tmp/hidden tests/relay-b'}]}), /frames the trial as measured \(`hidden tests`\)/);
  await assert.rejects(planFromWorkspace({...request, baseArgs: {label: 'We will grade this attempt'}}), /frames the trial as measured \(`We will grade this attempt`\)/);
  // P3-63: withheld items match whole words, so a short item is not found inside another word.
  const fast = await planFromWorkspace({...request, task: 'Serve breakfast orders from src/menu.ts.', withheld: ['fast']});
  assert.equal(fast.spawnArgs[0].task, 'Serve breakfast orders from src/menu.ts.');
  await assert.rejects(planFromWorkspace({...request, task: 'Keep the menu fast.', withheld: ['fast']}), /contains 1 withheld judge-only item/);
  // P3-63: the host refuses a visible blind spawn, so the plan refuses it first.
  const blindSchema = {properties: {...schemaCwd.properties, blind: {type: 'boolean'}, context: {type: 'string', enum: ['isolated', 'fork']}, visible: {type: 'boolean'}}};
  await assert.rejects(planFromWorkspace({...request, spawnSchema: blindSchema, baseArgs: {visible: true}}, {hostBlind: true}), /hidden children.*remove visible/);
  const hidden = await planFromWorkspace({...request, spawnSchema: blindSchema, baseArgs: {visible: false}}, {hostBlind: true});
  assert.deepEqual(hidden.spawnArgs.map(arg => [arg.visible, arg.blind]), [[false, true], [false, true]]);
});
test('snapshots are detached from config and reject corrupt stored selections', () => {
  const local = structuredClone(config), snap = resolve('bug-fix', {config: local});
  local.presets.sol.thinking = 'xhigh';
  assert.deepEqual(snap.selections, [sol]);
  for (const bad of [{...snap, version: 2}, {...snap, extra: 1}, {...snap, selections: []}, {...snap, selections: [{...sol, fake: true}]}, {...snap, poolIndex: 0}]) assert.throws(() => validateSnapshot(bad, catalog));
});
test('malformed file, null and directories never become absent config', async t => {
  const dir = await workspace(t), path = join(dir, 'pstack-models.json');
  for (const contents of ['{', 'null', '[]', '{"version":9}']) {
    await writeFile(path, contents);
    await assert.rejects(planFromWorkspace({workspace: dir, role: 'bug-fix'}));
  }
  await rm(path);
  await mkdir(path);
  await assert.rejects(planFromWorkspace({workspace: dir, role: 'bug-fix'}), /Cannot use/);
});
test('receipt model/provider mismatches are explicit; missing controls stay unverified', () => {
  const receipt = {resolvedModel: sol.model, resolvedProvider: 'openai'};
  const result = confirmSelection(sol, receipt);
  assert.equal(result.status, 'unverified');
  assert.equal(result.checks.model, 'confirmed');
  assert.equal(result.checks.thinking, 'unverified');
  assert.equal(result.checks.fastMode, 'unverified');
  assert.equal(confirmSelection(sol, {...receipt, resolvedModel: opus.model}).status, 'mismatch');
  assert.equal(confirmSelection(sol, {...receipt, resolvedProvider: 'wrong'}).checks.provider, 'mismatch');
  assert.equal(confirmSelection(sol, {}).checks.model, 'unverified');
  assert.equal(confirmSelection({}, {}).status, 'unverified', 'no requested override is not proof of successful native resolution');
});
test('native effective evidence proves controls; status preference alone does not prove service tier', () => {
  const receipt = {resolvedModel: sol.model, resolvedProvider: 'openai'};
  const evidence = {source: 'native status observation', thinking: 'high', fastMode: 'ultrafast'};
  assert.equal(confirmSelection(sol, receipt, evidence).checks.serviceTier, 'unverified');
  assert.equal(confirmSelection(sol, receipt, {...evidence, serviceTier: 'ultrafast'}).status, 'confirmed');
  assert.equal(confirmSelection(sol, receipt, {...evidence, thinking: 'medium'}).checks.thinking, 'mismatch');
  assert.equal(confirmSelection(sol, receipt, {...evidence, serviceTier: 'priority'}).checks.serviceTier, 'mismatch');
  assert.equal(confirmSelection(sol, receipt, {...evidence, model: opus.model}).checks.model, 'mismatch');
  assert.throws(() => confirmSelection(sol, receipt, {thinking: 'high'}), /evidence source/);
  assert.throws(() => confirmSelection({...sol, fake: true}, receipt));
});
test('invalid unused config selections are not hidden by a valid selected role', () => {
  const invalid = structuredClone(config);
  invalid.presets.unused = {model: 'missing/unused'};
  assert.throws(() => resolve('bug-fix', {config: invalid}), /Unavailable native model/);
});
test('broken new config cannot alter or cancel an already recorded delegation', async t => {
  const dir = await workspace(t), path = join(dir, 'pstack-models.json');
  const snapshot = resolve('bug-fix');
  await writeFile(path, '{broken');
  const resumed = await planFromWorkspace({workspace: dir, snapshot, catalog, task: 'Continue existing work.', spawnSchema: schema});
  assert.deepEqual(resumed.snapshot, snapshot);
  assert.match(resumed.configWarning, /Cannot use/);
  assert.deepEqual(resumed.spawnArgs.map(routing), [sol]);
  await assert.rejects(planFromWorkspace({workspace: dir, role: 'bug-fix', catalog}), /Cannot use/);
});
test('dangling config symlink rejects new work instead of inheriting', async t => {
  const dir = await workspace(t), path = join(dir, 'pstack-models.json');
  const target = join(dir, 'missing-target.json');
  await symlink(target, path);
  await assert.rejects(planFromWorkspace({workspace: dir, role: 'bug-fix', catalog}), /Cannot use pstack-models.json/);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal(await readlink(path), target);
  await writeFile(target, JSON.stringify(config));
  const repairedTarget = await planFromWorkspace({workspace: dir, role: 'bug-fix', catalog});
  assert.deepEqual(repairedTarget.snapshot.selections, [sol], 'an ordinary valid symlink remains supported');
  assert.equal(await readlink(path), target, 'the planner does not replace the user symlink');
});
test('dangling config symlink warns on resume and preserves the valid snapshot', async t => {
  const dir = await workspace(t), path = join(dir, 'pstack-models.json');
  await symlink(join(dir, 'missing-target.json'), path);
  const snapshot = resolve('bug-fix');
  const result = await planFromWorkspace({workspace: dir, snapshot, catalog, task: 'Continue the same task.', spawnSchema: schema});
  assert.match(result.configWarning, /Cannot use updated pstack-models.json/);
  assert.equal(result.configPresent, true, 'the dangling entry still exists');
  assert.deepEqual(result.snapshot, snapshot);
  assert.deepEqual(result.spawnArgs.map(routing), [sol]);
});
for (const [name, selection, reason] of [
  ['unavailable model', {model: 'missing/updated'}, /Unavailable native model/],
  ['unsupported thinking', {...opus, thinking: 'max'}, /Unsupported thinking/],
  ['unsupported fast mode', {...opus, fastMode: 'ultrafast'}, /Unsupported fastMode/],
]) test('updated config with ' + name + ' warns on resume and rejects new work', async t => {
  const dir = await workspace(t), path = join(dir, 'pstack-models.json');
  const changed = structuredClone(config);
  changed.presets.opus = selection;
  await writeFile(path, JSON.stringify(changed));
  const snapshot = resolve('bug-fix');
  const result = await planFromWorkspace({workspace: dir, snapshot, catalog, task: 'Continue the same task.', spawnSchema: schema});
  assert.match(result.configWarning, reason);
  assert.deepEqual(result.snapshot, snapshot);
  assert.deepEqual(result.spawnArgs.map(routing), [sol]);
  await assert.rejects(planFromWorkspace({workspace: dir, role: 'bug-fix', catalog}), reason);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(changed));
});
test('contradictory parent family cannot manufacture different-family judging', () => {
  assert.throws(() => resolve(pool, {overrides: ['sol', 'sol'], parentFamily: 'claude'}), /Parent family contradicts/);
  const matching = resolve(pool, {overrides: ['sol', 'sol'], parentFamily: 'gpt'});
  assert.equal(matching.diversity, 'not-established');
  assert.equal(matching.selections.length, 1);
  const supplied = resolve(pool, {parentModel: 'unknown/native-model', parentFamily: 'gpt'});
  assert.deepEqual(supplied.selections, [opus]);
});
test('a rejected native spawn is not a partially verified success', () => {
  assert.equal(confirmSelection(sol, {status: 'error', error: 'model unavailable'}).status, 'rejected');
});
test('CLI reads stdin, produces native arguments, and exits nonzero on malformed JSON', async t => {
  const dir = await workspace(t);
  const cli = fileURLToPath(new URL('../scripts/model-routing-cli.mjs', import.meta.url));
  const input = {workspace: dir, role: 'bug-fix', overrides: sol, catalog, task: 'Bounded fix.', spawnSchema: schema};
  const success = spawnSync(process.execPath, [cli], {input: JSON.stringify(input), encoding: 'utf8'});
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout).spawnArgs.map(routing), [sol]);
  const bad = spawnSync(process.execPath, [cli], {input: '{', encoding: 'utf8'});
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.equal(JSON.parse(bad.stderr).ok, false);
  await assert.rejects(planFromWorkspace({...input, extra: true}), /Unknown request/);
});
test('without any native catalog a configured router model resolves as unverified instead of unavailable', async t => {
  const dir = await workspace(t);
  // The provider-relative model id contains a slash: the shape that 0.3 reported as unavailable.
  const router = {model: 'fixture-router/openai/gpt-6-astra', thinking: 'high', fastMode: true};
  await writeFile(join(dir, 'pstack-models.json'), JSON.stringify({version: 1, presets: {router}, roles: {'bug-fix': 'router', [pool]: ['router', 'router']}}));
  const plan = await planFromWorkspace({workspace: dir, role: 'bug-fix', task: 'Fix it.', spawnSchema: schema});
  assert.deepEqual(plan.snapshot.selections, [router]);
  assert.equal(plan.catalogSource, 'none');
  assert.equal(plan.availability, 'unverified');
  assert.match(plan.catalogNotice, /unverified/);
  assert.deepEqual(routing(plan.spawnArgs[0]), router);
  // A supplied catalog stays authoritative, including an explicitly empty one.
  await assert.rejects(planFromWorkspace({workspace: dir, role: 'bug-fix', catalog: []}), /Unavailable native model: fixture-router\/openai\/gpt-6-astra/);
  const judged = await planFromWorkspace({workspace: dir, role: pool, parentFamily: 'gpt'});
  assert.equal(judged.snapshot.diversity, 'unverified', 'no catalog means no family evidence');
});
test('a prepared requester catalog is authoritative; a pending one proves neither availability nor absence', async t => {
  const dir = await workspace(t);
  await writeFile(join(dir, 'pstack-models.json'), JSON.stringify(config));
  const requester = {state: 'prepared', catalog};
  const plan = await planFromWorkspace({workspace: dir, role: 'bug-fix', catalog: [catalog[1]]}, {requester});
  assert.deepEqual(plan.snapshot.selections, [sol]);
  assert.equal(plan.catalogSource, 'requester');
  assert.match(plan.catalogNotice, /caller-supplied catalog was ignored/);
  assert.deepEqual(plan.catalog, [catalog[0]], 'only the selected models are projected back for a workflow setup');
  await assert.rejects(planFromWorkspace({workspace: dir, role: 'bug-fix'}, {requester: {state: 'prepared', catalog: [catalog[1]]}}), /Unavailable native model: openai\/gpt-6.1-sol/);
  const pending = await planFromWorkspace({workspace: dir, role: 'bug-fix'}, {requester: {state: 'pending', catalog: []}});
  assert.equal(pending.availability, 'unverified');
  assert.match(pending.catalogNotice, /still pending/);
  assert.equal(pending.catalog, undefined);
});

test('1.2.5 (P3-68): every collector a plan returns carries a run bound', () => {
  const snapshot = resolve('bug-fix');
  const bounded = {properties: {...schema.properties, collect: {type: 'boolean'}, runTimeoutSeconds: {type: 'number', minimum: 0}}};
  const plan = baseArgs => build(snapshot, {spawnSchema: bounded, baseArgs});
  // No bound, or 0 (the host's "no limit"), gets the default; a collector waited with awaitResults has no other bound.
  assert.equal(plan({collect: true})[0].runTimeoutSeconds, 600);
  assert.equal(plan({collect: true, runTimeoutSeconds: 0})[0].runTimeoutSeconds, 600);
  assert.equal(plan({collect: true, runTimeoutSeconds: 300})[0].runTimeoutSeconds, 300);
  assert.equal(plan({collect: true, runTimeoutSeconds: 900})[0].runTimeoutSeconds, 900);
  assert.throws(() => plan({collect: true, runTimeoutSeconds: 901}), /runTimeoutSeconds is at most 900 \(got 901\); spawn a longer phase as an announcing child/);
  // An announcing child is handed off after a bounded wait, so the plan leaves its arguments alone.
  assert.equal(Object.hasOwn(plan({})[0], 'runTimeoutSeconds'), false);
  assert.equal(Object.hasOwn(plan({collect: false})[0], 'runTimeoutSeconds'), false);
  // A host without runTimeoutSeconds cannot bound a collector, so the plan says to spawn an announcing child.
  assert.throws(() => build(snapshot, {spawnSchema: {properties: {...schema.properties, collect: {type: 'boolean'}}}, baseArgs: {collect: true}}), /cannot bound a collector.*announcing child/);
  // A per-trial collector is bounded too.
  const panel = build(resolve('arena runners'), {spawnSchema: bounded, trialArgs: [{collect: true}, {}]});
  assert.deepEqual(panel.map(arg => arg.runTimeoutSeconds), [600, undefined]);
  // P3-74 (M2): null and a blank string are unset, as the host reads them, so they get the default.
  assert.equal(plan({collect: true, runTimeoutSeconds: null})[0].runTimeoutSeconds, 600);
  assert.equal(plan({collect: true, runTimeoutSeconds: ''})[0].runTimeoutSeconds, 600);
  // The host reads numeric strings as numbers: "0" is no limit, "3600" is past the cap, "300" is 300.
  assert.equal(plan({collect: true, runTimeoutSeconds: '0'})[0].runTimeoutSeconds, 600);
  assert.strictEqual(plan({collect: true, runTimeoutSeconds: '300'})[0].runTimeoutSeconds, 300);
  assert.throws(() => plan({collect: true, runTimeoutSeconds: '3600'}), /at most 900 \(got 3600\)/);
  assert.throws(() => plan({collect: true, runTimeoutSeconds: '1e4'}), /at most 900 \(got 10000\)/);
  // A value the host would refuse is refused here too, rather than passed on as a bound.
  for (const bad of [-1, true, 1.5, 'soon']) assert.throws(() => plan({collect: true, runTimeoutSeconds: bad}), /runTimeoutSeconds must be a non-negative integer/, String(bad));
  // The host's snake_case alias is read too, and the bound the plan returns uses the camelCase key only.
  assert.deepEqual(boundCollector({collect: true, run_timeout_seconds: '300'}, undefined), {collect: true, runTimeoutSeconds: 300});
  assert.deepEqual(boundCollector({collect: true, run_timeout_seconds: 0}, undefined), {collect: true, runTimeoutSeconds: 600});
  assert.throws(() => boundCollector({collect: true, run_timeout_seconds: 1800}, undefined), /at most 900 \(got 1800\)/);
});
test('1.2.5 (P3-70, P3-72 F8): blind trials refuse framing that names the trial as measured, and withheld matches whole words on both sides', async t => {
  const dir = await workspace(t);
  await writeFile(join(dir, 'pstack-models.json'), JSON.stringify(config));
  const task = 'Make the retry policy in src/retry.ts handle a 429 with Retry-After.';
  const request = {workspace: dir, role: 'arena runners', catalog, parentModel: sol.model, task, spawnSchema: schema, blind: true, withheld: ['429 and 503 are retried; 400 is not']};
  for (const [extra, shown] of [[' This is an eval.', 'This is an eval'], [' This task is part of a benchmark.', 'This task is part of a benchmark'], [' This is an experiment; do your best.', 'This is an experiment'],
    [' You are being tested.', 'You are being tested'], [' Two other assistants are solving the same task.', 'other assistants'], [' Other LLMs are attempting this too.', 'Other LLMs'],
    [' Your output is checked against a reference solution.', 'reference solution'], [' The success criteria: retries stop at 3.', 'success criteria'], [' The answer key says 3.', 'answer key'],
    [' Record a score for each case in results.json.', 'score for each case'], [' Write results.json with a pass/fail for each case.', 'pass/fail for each case']]) {
    await assert.rejects(planFromWorkspace({...request, task: task + extra}), new RegExp('frames the trial as measured \\(`' + shown.replace(/[/]/g, '\\/') + '`\\)'), extra);
  }
  // P3-76: framing the reviewer found missing, refused without the false positives below.
  for (const [extra, shown] of [[' You are one of three candidates.', 'You are one of three candidates'], [' Ground truth: 3 retries.', 'Ground truth'], [' Record pass or fail for each case.', 'pass or fail for each case'],
    [' The gold answer is 3.', 'gold answer'], [' The success criterion is 3 retries.', 'success criterion'], [' This is the evaluation run.', 'This is the evaluation run'], [' Several other models are attempting this task.', 'other models']]) {
    await assert.rejects(planFromWorkspace({...request, task: task + extra}), new RegExp('frames the trial as measured \\(`' + shown + '`\\)'), extra);
  }
  // Organic requests that use these words as their own subject still plan unchanged, including the 1.2.5 review's
  // false positives (P3-76): an eval/benchmark/experiment named mid-clause, and reference, key, criteria, other-model
  // and per-case nouns that are the subject of the edit rather than how the trial is measured.
  for (const organic of ['Add a benchmark for parse() in bench/parse.bench.ts.', 'Fix the flaky eval harness in scripts/eval.ts.', 'Print the coverage score for each test file.',
    'Compare the CLI against the reference output in fixtures/cli.txt.', 'Show the assistant message in the chat view.', 'This is a regression in the parser; fix it.',
    'This is an evaluation order bug in the interpreter; fix it.', 'This is a benchmark regression; fix parse()', 'This is an experiment flag rollout for the checkout page.',
    'The task is an eval of the expression in calc.ts', 'Explain why this is a benchmark of parse().', 'Fix the answer key lookup in quiz.ts', 'Add an answer key field to the Quiz model',
    'Update the reference solution in docs/solutions/retry.md', 'Add a success criteria section to the README', 'Render the success criteria table',
    'Show other assistants in the agent picker', 'List other LLMs supported by the provider registry', 'Print the pass/fail for each case in the test runner summary',
    'Store a verdict for each case in moderation.ts', 'Store the grade for each answer in the gradebook table', 'You are being tested by the CI matrix on Node 22',
    'Load the ground truth labels from data/labels.csv.', 'Compare predictions to the ground truth in data/gt.csv.', 'The ground truth is stored in data/gt.csv; load it.',
    'Other models are missing from the picker.', 'Add an acceptance criteria checklist in the PR template.']) {
    const plan = await planFromWorkspace({...request, task: organic});
    assert.deepEqual(plan.spawnArgs.map(arg => arg.task), [organic, organic], organic);
  }
  // F8: the right-hand word boundary: "fast" is not found in "faster".
  const faster = await planFromWorkspace({...request, task: 'Make the menu faster.', withheld: ['fast']});
  assert.equal(faster.spawnArgs[0].task, 'Make the menu faster.');
});

test('1.2.6 (P3-70, P3-76): measured-attempt framing is refused without banning the same subjects', async t => {
  const dir = await workspace(t);
  await writeFile(join(dir, 'pstack-models.json'), JSON.stringify(config));
  const request = {workspace: dir, role: 'arena runners', catalog, parentModel: sol.model, spawnSchema: schema, blind: true, withheld: ['judge-private-policy']};
  const pairs = [
    ["Use the oracle to check your answer.", "Use Oracle 19c for the database.", "oracle"],
    ["The grader will assess your work.", "A grader will assess student submissions; fix its API serializer.", "grader will assess your work"],
    ["Use the rubric in notes.md.", "Use the rubric renderer to format feedback.", "rubric"],
    ["Match the expected output exactly.", "Match the expected output field styling to the editor.", "expected output"],
    ["Run the eval harness after fixing this.", "Fix the eval harness argument parser.", "Run the eval harness after"],
    ["We will grade this attempt.", "We will grade student submissions with the new service.", "We will grade this attempt"],
    ["A judge will review your diff.", "The Judge class reviews document diffs; fix its parser.", "judge will review your diff"],
    ["Your attempt will be graded against acceptance criteria in CRITERIA.md.", "Acceptance criteria are in CRITERIA.md; implement the ticket.", "Your attempt will be graded"],
    ["Another model already tried this; do better.", "Another agent tried to acquire the lock before the session row existed; fix the race.", "Another model"],
    ["Other AI models are your competitors.", "Other AI models are available in the picker.", "Other AI models are your competitors"],
    ["Other AI models: your competition.", "Other AI models: list the supported providers.", "Other AI models: your competition"],
    ["Several models are attempting this task.", "Several agents are getting stuck on the scheduler lock; fix the deadlock.", "Several models"],
    ["Other Claude instances are solving the same task.", "Other Claude instances are missing from the picker.", "Other Claude instances are solving the same task"],
    ["You are competing against GPT.", "Add a page comparing GPT with other providers.", "You are competing against"],
    ["We are comparing assistants on this task.", "We are comparing assistants on the settings page.", "We are comparing assistants on this task"],
    ["Your output is checked against a hidden reference.", "Update the hidden reference field in the form.", "reference"],
    ["There is a reference implementation we compare against.", "Update the reference implementation in docs/solutions.md.", "reference implementation we compare against"],
    ["Give each case a score.", "Give each case a score field in the schema.", "Give each case a score"],
    ["Each answer is scored.", "Each answer is scored by the quiz service; fix its gradebook storage.", "Each answer is scored"],
    ["Mark each test case PASS or FAIL in results.json.", "Mark each test case pass or fail based on its exit code in the JUnit reporter.", "Mark each test case PASS or FAIL"],
    ["You are one of many in a benchmark.", "This is one of many benchmark fixtures; update its README.", "You are one of many in a benchmark"],
    ["We are testing you.", "We are testing your retry helper on malformed input.", "We are testing you"],
    ["Testing your ability to fix bugs.", "Add a test for the ability field in the user model.", "Testing your ability"],
    ["The answer key is 3.", "The answer key is 3 columns wide; fix its layout.", "answer key"],
    ["The reference answer is 42.", "The reference answer is 42 characters long; widen its input.", "reference answer"],
    ["The reference solution is \"retry\".", "The reference solution is \"retry\" in the dropdown; rename that option.", "reference solution"],
    ["Pass criteria are 3 retries.", "Pass criteria are 3 columns wide; fix the table.", "Pass criteria"],
    ["The answer key says 3.", "The answer key is 3 columns wide; fix its layout.", "answer key"],
    ["The answer key says \"retry\".", "The answer key is \"Answer\" in the menu; rename the label.", "answer key"],
    ["Record the grade for each answer in results.json.", "Record the grade for each answer in the gradebook table.", "grade for each answer"],
    ["The answer key is 3, 7 and 9.", "The answer key is 3 columns wide; fix its layout.", "answer key"],
    ["The answer key is 3 and 7.", "The answer key is 3 rows tall; fix its layout.", "answer key"],
    ["The answer key is (b).", "The answer key is (b) in the menu; rename that label.", "answer key"],
    ["The answer key is 42 for case 1.", "The answer key is 42 characters long; widen its input.", "answer key"],
    ["The answer key is \"3\", fix nothing else.", "The answer key is \"3\" in the dropdown; rename that label.", "answer key"],
    ["The reference answers are 1, 2 and 3.", "The reference answers are 3 columns wide; fix their layout.", "reference answers"],
    ["The reference solutions are 3 and 4.", "The reference solutions are 3 rows tall; fix their layout.", "reference solutions"],
    ["Pass criteria are 3 retries per test.", "Pass criteria are 3 columns wide; fix the table.", "Pass criteria"],
    ["The expected answer is 42.", "The expected answer field is 42 pixels wide; fix the layout.", "expected answer"],
    ["Expected answer: 42.", "Expected output: a centered button; fix the CSS.", "Expected answer"],
    ["Record a score for each test case in the results table.", "Record the grade for each answer in the gradebook table.", "score for each test case"],
    ["Report a verdict for each case in the summary table.", "Report a verdict for each case in the moderation table.", "verdict for each case"],
    ["Another agent is trying this task.", "Another agent is working on it; coordinate via the lock file.", "Another agent"],
    ["Several models are attempting this problem.", "Several agents are working on this repo; avoid force-pushing.", "Several models"],
    ["The expected output is 42.", "The expected output field is 42 pixels wide; fix the layout.", "expected output"],
    ["Expected output: 42", "Expected output: a centered button; fix the CSS.", "Expected output"],
    ["Expected output: [1, 2, 3]", "Expected output field: [1, 2, 3] is its sample label; fix the renderer.", "Expected output"],
    ["Expected output: 'ok'", "The expected output is 'ok' in the dropdown; rename that label.", "Expected output"],
    ["- Expected output: 42", "- Expected output field styling needs to match the editor.", "Expected output"],
    ["The expected result is 7.", "The expected result is 7 columns wide; fix the table.", "expected result"],
    ["Expected results: 3, 7 and 9.", "Expected results table: fix its column widths.", "Expected results"],
    ["The expected outputs are 1, 2 and 3.", "The expected outputs are 3 rows tall; fix the table.", "expected outputs"],
    ["Fix it; expected answer: 42.", "Fix the expected answer renderer; keep the label.", "expected answer"],
    ["Fix it, expected answer: 42.", "Fix the form, expected answer field styling is broken.", "expected answer"],
    ["Fix it (expected answer: 42).", "Fix the form (expected answer field styling is broken).", "expected answer"],
    ["- Expected answer: 42", "- Expected answer field: fix the styling.", "Expected answer"],
    ["The expected answer: 42", "The expected answer field: fix the styling.", "expected answer"],
  ];
  for (const [framing, subject, shown] of pairs) await t.test(framing, async () => {
    await assert.rejects(planFromWorkspace({...request, task: framing}), error => {
      assert.ok(error.message.includes("frames the trial as measured (`" + shown + "`)"), error.message);
      return true;
    }, framing);
    const plan = await planFromWorkspace({...request, task: subject});
    assert.deepEqual(plan.spawnArgs.map(arg => arg.task), [subject, subject], subject);
  });
});
