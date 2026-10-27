#!/usr/bin/env node
/** Read a JSON request on stdin; emit plans only, never call a model or change config. */
import {readFile, lstat} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveRole, validateConfigAgainstCatalog, validateSnapshot, buildSpawnArgs, custodyRecords, confirmSelection, HOST_BLIND_CAPABILITY} from './model-routing.mjs';

/**
 * Availability source, strongest first: a prepared host requester catalog, then a
 * caller-supplied catalog, otherwise none. Without one, availability is reported
 * unverified instead of every configured model being called unavailable.
 */
function chooseCatalog(request, requester) {
  if (requester?.state === 'prepared') {
    return {catalog: requester.catalog, catalogSource: 'requester', availability: 'checked',
      ...(request.catalog !== undefined ? {catalogNotice: 'The host requester catalog was used; the caller-supplied catalog was ignored.'} : {})};
  }
  if (request.catalog !== undefined) return {catalog: request.catalog, catalogSource: 'caller', availability: 'checked'};
  return {catalog: null, catalogSource: 'none', availability: 'unverified',
    catalogNotice: requester?.state === 'pending'
      ? 'The host requester catalog is still pending, which proves neither availability nor absence; native spawn admission stays authoritative.'
      : 'No native catalog was available, so model availability and controls are unverified; native spawn admission stays authoritative.'};
}

/**
 * `requester` is the host's prepared requester catalog projection and `hostBlind` whether the host
 * advertises native-subagent-blind-v1; neither is ever a request field.
 * @param {any} request
 * @param {{requester?: any, hostBlind?: boolean}} [options]
 */
export async function planFromWorkspace(request, {requester, hostBlind = false} = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw Error('Request must be an object');
  const allowed = ['action', 'workspace', 'role', 'overrides', 'catalog', 'parentModel', 'parentFamily', 'snapshot', 'task', 'spawnSchema', 'baseArgs', 'trialArgs', 'blind', 'withheld', 'requested', 'receipt', 'evidence'];
  for (const key of Object.keys(request)) if (!allowed.includes(key)) throw Error('Unknown request field: ' + key);
  if (request.action === 'confirm') return confirmSelection(request.requested, request.receipt, request.evidence);
  if (request.action !== undefined && request.action !== 'plan') throw Error('Unknown action');
  if (typeof request.workspace !== 'string' || !request.workspace.trim()) throw Error('Workspace root is required');
  const chosen = chooseCatalog(request, requester);
  const configPath = join(resolve(request.workspace), 'pstack-models.json');
  let config = null, configWarning, configPresent = false;
  try {
    // lstat observes the entry itself, so a dangling symlink is not absence.
    await lstat(configPath);
    configPresent = true;
    config = JSON.parse(await readFile(configPath, 'utf8'));
    if (config === null) throw Error('Config must be an object, not null');
    validateConfigAgainstCatalog(config, chosen.catalog);
  } catch (error) {
    if (error.code !== 'ENOENT' || configPresent) {
      if (!request.snapshot) throw Error('Cannot use pstack-models.json: ' + error.message);
      configWarning = 'Cannot use updated pstack-models.json; retaining the existing snapshot: ' + error.message;
    }
  }
  // Read config for every invocation, but never apply updates to a resumed delegation.
  if (request.snapshot && (request.overrides !== undefined || (request.role && request.role !== request.snapshot.role))) {
    throw Error('A resume snapshot cannot be replaced by a new role/override');
  }
  const snapshot = request.snapshot
    ? validateSnapshot(request.snapshot, chosen.catalog)
    : resolveRole({...request, config, catalog: chosen.catalog});
  const result = {configPath, configPresent, snapshot, catalogSource: chosen.catalogSource, availability: chosen.availability};
  if (chosen.catalogNotice) result.catalogNotice = chosen.catalogNotice;
  // Host records for the selected models, so a workflow setup can carry the same catalog.
  if (chosen.catalogSource === 'requester') {
    const used = new Set(snapshot.selections.map(s => s.model).filter(Boolean));
    result.catalog = chosen.catalog.filter(record => used.has(record.id));
  }
  if (configWarning) result.configWarning = configWarning;
  if ((request.blind !== undefined || request.trialArgs !== undefined) && request.task === undefined) throw Error('blind and trialArgs need a task');
  if (request.task !== undefined) {
    // Host blinding needs the capability and a current spawn schema that accepts `blind`.
    const native = request.blind === true && hostBlind === true && !!request.spawnSchema?.properties && Object.hasOwn(request.spawnSchema.properties, 'blind');
    result.spawnArgs = buildSpawnArgs({...request, catalog: chosen.catalog, workspace: resolve(request.workspace), snapshot, hostBlind: native});
    if (request.blind === true) {
      result.hostBlind = native
        ? {status: 'native', capability: HOST_BLIND_CAPABILITY, notice: 'Each spawn carries blind: true and context "isolated": the host omits the child\'s model identity, workspace and session keys from its own prompt. Spawn the arguments unchanged.'}
        : {status: 'unavailable', notice: (hostBlind ? 'This sessions_spawn schema has no blind field' : 'This host does not advertise ' + HOST_BLIND_CAPABILITY) +
          ', so host blinding is unavailable: the task carries no routing snapshot, model ID or workspace, but the child\'s own system prompt still names its model and workspace. Report the trial as not blind (blinding unavailable); never call it a blind trial.'};
    }
    // A blind plan keeps the continuation custody here, for the parent record, never in the task.
    if (request.blind === true) {
      result.blind = true;
      result.custody = custodyRecords({snapshot, catalog: chosen.catalog, workspace: resolve(request.workspace)});
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    console.log(JSON.stringify(await planFromWorkspace(JSON.parse(input))));
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: error.message}));
    process.exitCode = 1;
  }
  })();
}
