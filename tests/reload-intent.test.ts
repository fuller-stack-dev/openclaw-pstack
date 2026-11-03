import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, realpath } from 'node:fs/promises';
import { createTestPluginApi } from 'openclaw/plugin-sdk/plugin-test-api';
import { createOpenClawTestState } from 'openclaw/plugin-sdk/test-state';
import { createPluginStateKeyedStoreV2ForTests, resetPluginStateStoreForTests } from 'openclaw/plugin-sdk/plugin-state-test-runtime';
import { join } from 'node:path';
import { hash } from '../src/state.js';
import { createWorkflow, digest, workflowKey } from '../src/workflow.js';
import { resolveRole } from '../skills/pstack/scripts/model-routing.mjs';
import { WORKFLOW_RETENTION } from '../src/workflow-tool.js';
import { register as sourceRegister } from '../src/index.js';
import { register as artifactRegister } from '../dist/index.js';
let fixture: any, serial = 0;
beforeAll(async () => { fixture = await createOpenClawTestState({ label: 'reload-intent', applyEnv: true }); });
afterAll(async () => { resetPluginStateStoreForTests(); await fixture.cleanup(); });
const allSpecs = new Map<string, any>();
afterEach(async () => {
  vi.restoreAllMocks();
  for (const spec of allSpecs.values()) await createPluginStateKeyedStoreV2ForTests('pstack', spec, { assertCurrent() {} }).clear();
});
const intentNamespace = 'read-only-turn-v1';
const notice = (value: any) => value?.prependContext?.includes(' for this turn: answer') ?? false;
type Boundary = { namespace: string; method: string; args: any[]; run: () => Promise<any> };
type Controls = { entry?: (entry: any) => Promise<any>; around?: (call: Boundary) => Promise<any> };
function instances(register: typeof sourceRegister) {
  const session = { sessionKey: 'agent:worker:dashboard:reload-' + ++serial, sessionId: 'incarnation-1', agentId: 'worker' };
  const controls: Controls = {}, specs = new Map<string, any>();
  const warnings: string[] = [];
  const rawStore = (namespace = intentNamespace) => createPluginStateKeyedStoreV2ForTests('pstack', specs.get(namespace), { assertCurrent() {} });
  const make = () => {
    const commands = new Map<string, any>(), hooks = new Map<string, any>();
    const config = { plugins: { entries: { pstack: { hooks: { allowConversationAccess: true } } } } };
    const api = createTestPluginApi({ id: 'pstack', logger: { info() {}, debug() {}, error() {}, warn: (s: string) => warnings.push(s) }, runtime: {
      config: { current: () => config },
      state: { openKeyedStoreV2: (spec: any, opts: any) => {
        specs.set(spec.namespace, spec); allSpecs.set(spec.namespace, spec);
        // Like the host runtime, the fixture retains authority without an optional invocation callback.
        const store: any = createPluginStateKeyedStoreV2ForTests('pstack', spec, opts ?? { assertCurrent() {} });
        for (const method of ['register', 'observe', 'compareAndApply', 'lookup']) {
          const original = store[method];
          store[method] = (...args: any[]) => {
            const call = { namespace: spec.namespace, method, args, run: () => original(...args) };
            return controls.around ? controls.around(call) : call.run();
          };
        }
        return store;
      } },
      agent: { session: { getSessionEntryAsync: async ({sessionKey}: any) => { const entry = sessionKey === session.sessionKey ? { sessionId: session.sessionId, spawnedWorkspaceDir: await realpath(fixture.workspaceDir) } : undefined; return controls.entry ? controls.entry(entry) : entry; } }, resolveAgentWorkspaceDir: () => { throw Error('unexpected fallback'); } }
    }, registerCommand: (command: any) => commands.set(command.name, command), on: (name: string, hook: any) => hooks.set(name, hook) } as any);
    register(api);
    return {
      command: (name: string, args: string, overrides: any = {}) => commands.get(name).handler({ ...session, senderId: 'fixture-owner', isAuthorizedSender: true, gatewayClientScopes: ['operator.write'], channel: 'webchat', args, commandBody: '/' + name + ' ' + args, config, assertOwnerCurrent() {}, ...overrides }),
      prompt: (text: string, overrides: any = {}, event: any = {}) => hooks.get('before_prompt_build')({prompt: text, currentUserMessage: text, messages: [], ...event}, { ...session, hookInvocation: { assertActive() {} }, ...overrides }),
    };
  };
  return { make, session, controls, rawStore, warnings, key: () => hash(JSON.stringify([session.sessionKey, session.sessionId])) };
}
for (const [label, register] of [['source', sourceRegister], ['dist', artifactRegister]] as const) {
  describe(label + ' register with real shared keyed-store V2', () => {
    it('baseline same-instance read-only context is question-bound, incarnation-bound and one-shot, with mode off', async () => {
      const {make} = instances(register), a = make();
      const question = 'Which route explains drains?';
      expect(await a.command('pstack-poteto-help', question)).toEqual({continueAgent: true, suppressReply: true});
      expect(await a.prompt('unrelated queued message')).toBeUndefined();
      expect(await a.prompt(question, {sessionId: 'incarnation-2'})).toBeUndefined();
      expect((await a.prompt(question))?.prependContext).toContain('Pstack read-only route /pstack-poteto-help for this turn');
      expect(await a.prompt(question)).toBeUndefined();
      expect((await a.command('pstack', 'status')).text).toContain('Pstack off;');
    });
    it('baseline sticky mode survives a new instance and another requester cannot switch it off', async () => {
      const {make} = instances(register), a = make();
      expect(await a.command('pstack', 'on')).toEqual({text: 'Pstack on (revision 1).'});
      const b = make();
      expect((await b.prompt('follow-up'))?.prependContext).toContain('Pstack mode is active');
      expect((await b.command('pstack', 'off', {senderId: 'another-requester'})).text).toContain('another activating requester');
      expect(await b.command('poteto_mode', 'off')).toEqual({text: 'Pstack off (revision 2).'});
      expect(await a.prompt('follow-up')).toBeUndefined();
    });
    it('baseline unauthorized read-only command leaves no prompt intent', async () => {
      const {make} = instances(register), a = make();
      expect((await a.command('pstack-setup-pstack', 'show role counts', {isAuthorizedSender: false})).text).toContain('Static help');
      expect(await a.prompt('show role counts')).toBeUndefined();
      expect(await make().prompt('show role counts')).toBeUndefined();
    });
    for (const route of ['poteto-help', 'setup-pstack']) it('successor consumes pending ' + route + ' intent with at-most-once claim after instance replacement', async () => {
      const {make} = instances(register), a = make();
      const question = 'Show the route and current role counts without changing mode.';
      expect(await a.command('pstack-' + route, question)).toEqual({continueAgent: true, suppressReply: true});
      const b = make();
      expect(await b.prompt('unrelated queued message')).toBeUndefined();
      expect(await b.prompt(question, {sessionId: 'incarnation-2'})).toBeUndefined();
      const actual = await b.prompt('/pstack-' + route + ' ' + question);
      const oldAfterSuccessor = await a.prompt(question);
      console.log(JSON.stringify({artifact: label, route, successorPrompt: actual ?? null, oldInstanceStillHasIntent: oldAfterSuccessor?.prependContext?.includes('Pstack read-only route') ?? false, expected: 'successor context once; no context remaining in old instance', modeStatus: (await b.command('pstack', 'status')).text}));
      expect(actual, 'successor must retain the authorized read-only route intent').toEqual(expect.objectContaining({prependContext: expect.stringContaining('Pstack read-only route /pstack-' + route + ' for this turn')}));
      expect(await b.prompt(question)).toBeUndefined();
      expect(oldAfterSuccessor).toBeUndefined();
      expect(await make().prompt(question)).toBeUndefined();
      expect((await b.command('pstack', 'status')).text).toContain('Pstack off;');
    });

    for (const route of ['poteto-help', 'setup-pstack']) it('claims ' + route + ' across registrations without changing active Mode', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack', 'on');
      const before = await h.rawStore('session-mode-v2').entries();
      await a.command('pstack-' + route, 'active question');
      const b = h.make();
      expect(notice(await b.prompt('active question'))).toBe(true);
      for (const instance of [a, b, h.make()]) {
        const result = await instance.prompt('active question');
        expect(notice(result)).toBe(false);
        expect(result.prependContext).toContain('Pstack mode is active');
      }
      expect(await h.rawStore('session-mode-v2').entries()).toEqual(before);
    });
    it('allows one of two concurrent real CAS claimants and no later replay', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack-poteto-help', 'race');
      let observed = 0, release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      h.controls.around = async c => {
        const result = await c.run();
        if (c.namespace === intentNamespace && c.method === 'observe') {
          if (++observed === 2) release();
          await ready;
        }
        return result;
      };
      const result = await Promise.all([h.make().prompt('race'), h.make().prompt('race')]);
      expect(result.filter(notice)).toHaveLength(1);
      expect(result.filter(r => r === undefined)).toHaveLength(1);
      h.controls.around = undefined;
      expect(await a.prompt('race')).toBeUndefined();
      expect(await h.make().prompt('race')).toBeUndefined();
    });
    it('does not erase an overwrite between observe and delete; latest command wins', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack-poteto-help', 'old question');
      let intercepted = false;
      h.controls.around = async c => {
        if (!intercepted && c.namespace === intentNamespace && c.method === 'compareAndApply') {
          intercepted = true;
          await a.command('pstack-setup-pstack', 'new question');
        }
        return c.run();
      };
      expect(await h.make().prompt('old question')).toBeUndefined();
      expect(intercepted).toBe(true);
      expect((await h.rawStore().lookup(h.key()))).toMatchObject({ route: 'setup-pstack', question: 'new question' });
      expect((await h.make().prompt('new question')).prependContext).toContain('/pstack-setup-pstack for this turn');
      expect(await a.prompt('old question')).toBeUndefined();
    });
    it('rechecks matching on every explicit conflict and bounds contention', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack-poteto-help', 'same question');
      let attempts = 0;
      h.controls.around = async c => {
        if (c.namespace === intentNamespace && c.method === 'compareAndApply') {
          attempts++;
          const row: any = await h.rawStore().lookup(h.key());
          await h.rawStore().register(h.key(), { ...row, route: attempts % 2 ? 'setup-pstack' : 'poteto-help' });
        }
        return c.run();
      };
      expect((await a.prompt('same question')).prependContext).toContain('(contended)');
      expect(attempts).toBe(4);
      expect(await h.rawStore().lookup(h.key())).toBeDefined();
      h.controls.around = undefined;
      expect(notice(await h.make().prompt('same question'))).toBe(true);
    });
    it('uses current message rather than history, normalizes whitespace and stores only 400 characters', async () => {
      const h = instances(register), a = h.make();
      const suffix = '  show\n  roles\t now  ';
      await a.command('pstack-poteto-help', suffix);
      expect(await a.prompt('unrelated', {}, { prompt: suffix })).toBeUndefined();
      expect(notice(await h.make().prompt('show roles now'))).toBe(true);
      const prefix = 'x'.repeat(399) + ' ';
      await a.command('pstack-setup-pstack', prefix + 'private trailing details'.repeat(100));
      const row: any = await h.rawStore().lookup(h.key());
      expect(row.question).toBe(prefix);
      expect(JSON.stringify(row)).not.toContain('private trailing details');
      expect(await a.prompt('x'.repeat(399))).toBeUndefined();
      expect(notice(await a.prompt(prefix + 'another suffix'))).toBe(true);
      await a.command('pstack-poteto-help', '');
      expect(notice(await h.make().prompt('next ordinary message'))).toBe(true);
      expect(await a.prompt('next ordinary message')).toBeUndefined();
    });
    it('enforces semantic expiry independently of host TTL visibility', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack-poteto-help', 'before deadline');
      const first: any = await h.rawStore().lookup(h.key());
      await h.rawStore().register(h.key(), first, { ttlMs: 600_000 });
      const clock = vi.spyOn(Date, 'now').mockReturnValue(first.expires - 1);
      expect(notice(await h.make().prompt('before deadline'))).toBe(true);
      clock.mockRestore();
      await a.command('pstack-poteto-help', 'at deadline');
      const second: any = await h.rawStore().lookup(h.key());
      await h.rawStore().register(h.key(), second, { ttlMs: 600_000 });
      vi.spyOn(Date, 'now').mockReturnValue(second.expires);
      expect(await h.make().prompt('at deadline')).toBeUndefined();
      // Extend only this fixture row’s host TTL so caller/worker visibility cannot mask the plugin deadline.
      expect(await h.rawStore().lookup(h.key())).toEqual(second);
    });
    it('uses real host TTL invisibility and resets TTL on an existing-key upsert', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack-poteto-help', 'old');
      const store = h.rawStore(), row = await store.lookup(h.key());
      await store.register(h.key(), row, { ttlMs: 1 });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(await store.lookup(h.key())).toBeUndefined();
      await a.command('pstack-poteto-help', 'new');
      await store.register(h.key(), await store.lookup(h.key()), { ttlMs: 200 });
      expect(await store.lookup(h.key())).toBeDefined();
      await a.command('pstack-setup-pstack', 'replacement');
      await new Promise(resolve => setTimeout(resolve, 250));
      expect((await store.lookup(h.key()))).toMatchObject({ question: 'replacement' });
      expect(notice(await h.make().prompt('replacement'))).toBe(true);
      const absent = await store.observe(h.key());
      expect(await store.compareAndApply(h.key(), absent.comparison, { operation: 'delete', action: 'delete' })).toEqual({ status: 'unchanged' });
    });

    it('keeps stale incarnation/agent and unavailable nonmatching turns from consuming', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack-poteto-help', 'question');
      for (const override of [{ sessionId: 'stale' }, { agentId: 'other' }, { sessionKey: undefined }])
        expect(await h.make().prompt('question', override)).toBeUndefined();
      h.controls.entry = async () => { throw Error('private metadata failure'); };
      expect(await a.prompt('unrelated')).toBeUndefined();
      expect(await h.rawStore().lookup(h.key())).toBeDefined();
      h.controls.entry = undefined;
      expect(notice(await h.make().prompt('question'))).toBe(true);
    });
    it('retires a matching intent with unavailable scope without exposing the stored workspace', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack', 'on');
      await a.command('pstack-poteto-help', 'question');
      h.controls.entry = async () => { throw Error('private metadata failure'); };
      const result = (await h.make().prompt('question')).prependContext;
      expect(result).toContain('(scope)');
      expect(result).not.toContain(fixture.workspaceDir);
      expect(result).not.toContain('Pstack mode is active');
      expect(notice({ prependContext: result })).toBe(false);
      expect(h.warnings.join(' ')).not.toContain('private metadata failure');
      expect(await h.rawStore().lookup(h.key())).toBeUndefined();
    });
    for (const stage of ['initial', 'pre', 'post', 'integration']) it('refuses a workspace change at ' + stage + ' without executable context or replay', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack', 'on');
      await a.command('pstack-setup-pstack', 'question');
      const other = join(fixture.workspaceDir, 'other-' + ++serial);
      await mkdir(other);
      let changed = stage === 'initial';
      h.controls.entry = async entry => changed ? { ...entry, spawnedWorkspaceDir: other } : entry;
      h.controls.around = async c => {
        const result = await c.run();
        if ((stage === 'pre' && c.namespace === intentNamespace && c.method === 'observe') ||
            (stage === 'post' && c.namespace === intentNamespace && c.method === 'compareAndApply') ||
            (stage === 'integration' && c.namespace === 'session-mode-v2' && c.method === 'lookup')) changed = true;
        return result;
      };
      const result = (await h.make().prompt('question')).prependContext;
      expect(result).toContain('workspace changed after the command');
      expect(result).not.toContain('Pstack mode is active');
      expect(result).not.toContain('pstack-models.json');
      expect(result).not.toContain('pstack_workflow apply');
      expect(await h.rawStore().lookup(h.key())).toBeUndefined();
      expect(await h.make().prompt('question')).toBeUndefined();
    });
    for (const stage of ['pre', 'post']) it('fails a ' + stage + '-CAS scope fence safely', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack-poteto-help', 'question');
      h.controls.around = async c => {
        const result = await c.run();
        if (c.namespace === intentNamespace && c.method === (stage === 'pre' ? 'observe' : 'compareAndApply'))
          h.controls.entry = async () => { throw Error('scope vanished'); };
        return result;
      };
      const result = (await h.make().prompt('question')).prependContext;
      expect(result).toContain('could not verify a pending read-only route');
      expect(notice({ prependContext: result })).toBe(false);
      expect(await h.rawStore().lookup(h.key()) !== undefined).toBe(stage === 'pre');
    });
    for (const stage of ['entry', 'observe', 'compareAndApply', 'native', 'mode']) it('propagates hook revocation after ' + stage + ' rather than returning a notice', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack-poteto-help', 'question');
      let revoked = false;
      if (stage === 'entry') h.controls.entry = async entry => { revoked = true; return entry; };
      h.controls.around = async c => {
        const result = await c.run();
        if ((c.namespace === intentNamespace && c.method === stage) ||
            (stage === 'native' && c.namespace === 'native-active-v1' && c.method === 'observe') ||
            (stage === 'mode' && c.namespace === 'session-mode-v2' && c.method === 'lookup')) revoked = true;
        return result;
      };
      await expect(h.make().prompt('question', { hookInvocation: { assertActive() { if (revoked) throw Error('hook revoked'); } } })).rejects.toThrow('hook revoked');
      expect(revoked).toBe(true);
      expect(await h.rawStore().lookup(h.key()) !== undefined).toBe(stage !== 'compareAndApply');
    });
    it('rechecks command scope and owner after awaited preparation and publication', async () => {
      for (const stage of ['preparation', 'publication']) {
        const h = instances(register), a = h.make();
        let revoked = false, writes = 0;
        if (stage === 'preparation') h.controls.entry = async entry => { revoked = true; return entry; };
        h.controls.around = async c => {
          if (c.namespace === intentNamespace && c.method === 'register') {
            writes++;
            const result = await c.run(); revoked = true; return result;
          }
          return c.run();
        };
        const result = await a.command('pstack-poteto-help', 'question', { assertOwnerCurrent() { if (revoked) throw Error('owner revoked'); } });
        expect(result.continueAgent).toBeUndefined();
        expect(result.text).toContain('owner revoked');
        expect(writes).toBe(stage === 'preparation' ? 0 : 1);
      }
      const h = instances(register), a = h.make();
      let entries = 0;
      h.controls.entry = async entry => ++entries >= 2 ? { ...entry, sessionId: 'reset' } : entry;
      expect((await a.command('pstack-poteto-help', 'question')).continueAgent).toBeUndefined();
    });
    it('keeps public optional invocation callbacks optional without changing authority', async () => {
      const h = instances(register), a = h.make();
      expect(await a.command('pstack-poteto-help', 'question', { assertOwnerCurrent: undefined })).toEqual({ continueAgent: true, suppressReply: true });
      expect(notice(await h.make().prompt('question', { hookInvocation: undefined }))).toBe(true);
      expect((await a.command('pstack-poteto-help', 'question', { assertOwnerCurrent: undefined, isAuthorizedSender: false })).continueAgent).toBeUndefined();
    });
    for (const method of ['register', 'observe', 'compareAndApply']) for (const after of [false, true])
      it('does not retry an uncertain ' + method + (after ? ' after effect' : ' before effect'), async () => {
        const h = instances(register), a = h.make();
        if (method !== 'register') await a.command('pstack-poteto-help', 'question');
        let calls = 0;
        h.controls.around = async c => {
          if (c.namespace === intentNamespace && c.method === method) {
            calls++;
            if (after) await c.run();
            throw Object.assign(Error('private store details'), { code: 'TEST_STORE_FAILURE' });
          }
          return c.run();
        };
        if (method === 'register') {
          const result = await a.command('pstack-poteto-help', 'question');
          expect(result.continueAgent).toBeUndefined();
          expect(result.text).toContain('Pstack error:');
        } else {
          const result = (await h.make().prompt('question')).prependContext;
          expect(result).toContain('(TEST_STORE_FAILURE)');
          expect(result).not.toContain('private store details');
          expect(notice({ prependContext: result })).toBe(false);
          expect(h.warnings.join(' ')).not.toContain('private store details');
        }
        expect(calls).toBe(1);
        const stored = await h.rawStore().lookup(h.key());
        expect(stored !== undefined).toBe(method === 'register' ? after : method !== 'compareAndApply' || !after);
      });
    it('keeps corrupt and future rows until the next independently authorized command', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack-poteto-help', 'question');
      const valid: any = await h.rawStore().lookup(h.key());
      const invalid = [null, 'bad', [], { ...valid, version: 2 }, { ...valid, extra: true },
        { ...valid, sessionId: 'foreign' }, { ...valid, route: 'shipping' }, { ...valid, question: 'x'.repeat(401) },
        { ...valid, expires: Date.now() + 600_000 }, { ...valid, workspace: '' }];
      for (const value of invalid) {
        await h.rawStore().register(h.key(), value);
        const result = (await h.make().prompt('question')).prependContext;
        expect(result).toContain('(unreadable)');
        expect(await h.rawStore().lookup(h.key())).toEqual(value);
        expect((await a.command('pstack-poteto-help', 'question', { isAuthorizedSender: false })).continueAgent).toBeUndefined();
        expect(await h.rawStore().lookup(h.key())).toEqual(value);
        expect(await a.command('pstack-setup-pstack', 'replacement')).toEqual({ continueAgent: true, suppressReply: true });
        expect(notice(await h.make().prompt('replacement'))).toBe(true);
      }
    });

    it('rejects the 1025th real command, preserves 1024 rows and permits overwrite at capacity', async () => {
      const h = instances(register), a = h.make(), original = h.session.sessionId;
      for (let n = 0; n < 1024; n++) {
        h.session.sessionId = 'capacity-' + n;
        expect(await a.command('pstack-poteto-help', 'question-' + n)).toEqual({ continueAgent: true, suppressReply: true });
      }
      const store = h.rawStore(), before = await store.entries();
      expect(before).toHaveLength(1024);
      h.session.sessionId = 'overflow';
      const refused = await a.command('pstack-poteto-help', 'overflow');
      expect(refused.continueAgent).toBeUndefined();
      expect(refused.text).toContain('1024 pending route turns are retained');
      expect(await store.entries()).toEqual(before);
      h.session.sessionId = 'capacity-0';
      expect(await a.command('pstack-setup-pstack', 'overwritten')).toEqual({ continueAgent: true, suppressReply: true });
      expect(await store.count()).toBe(1024);
      expect(notice(await h.make().prompt('overwritten'))).toBe(true);
      expect(await store.count()).toBe(1023);
      expect(await h.rawStore('session-mode-v2').count()).toBe(0);
      h.session.sessionId = original;
    });
    it('suppresses native and sticky instructions on refusal without changing their durable rows', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack', 'on');
      await a.prompt('baseline');
      const owner = { sessionKey: h.session.sessionKey, sessionId: h.session.sessionId, workspace: await realpath(fixture.workspaceDir) };
      const id = 'pw-0123456789ab';
      const record = createWorkflow(id, owner, { kind: 'how', task: 'explain', taskDigest: digest('explain'), sourceDigest: digest('source'),
        snapshots: [resolveRole({ role: 'how explainer', catalog: [] })], catalog: [], options: { complexity: 'simple' } }, 2);
      const spec = { namespace: 'workflow-v1', maxEntries: 256, overflowPolicy: 'reject-new' as const, defaultTtlMs: WORKFLOW_RETENTION.idleTtlMs };
      allSpecs.set(spec.namespace, spec);
      const workflow = createPluginStateKeyedStoreV2ForTests('pstack', spec, { assertCurrent() {} });
      await workflow.register(workflowKey(owner, id), record);
      await h.rawStore('native-active-v1').register(digest(['native-active', owner.sessionKey, owner.sessionId, owner.workspace]), { version: 1, owner, workflowId: id, kind: 'how' });
      const baseline = (await a.prompt('baseline')).prependContext;
      expect(baseline).toContain('Native pstack how workflow');
      expect(baseline).toContain('Pstack mode is active');
      const modeBefore = await h.rawStore('session-mode-v2').entries(), workflowBefore = await workflow.entries(), pointerBefore = await h.rawStore('native-active-v1').entries();
      await a.command('pstack-poteto-help', 'question');
      h.controls.around = async c => {
        if (c.namespace === intentNamespace && c.method === 'observe') throw Error('private detail');
        return c.run();
      };
      const result = (await h.make().prompt('question')).prependContext;
      expect(result).toContain('could not verify a pending read-only route');
      expect(result).not.toContain('Native pstack how workflow');
      expect(result).not.toContain('Pstack mode is active');
      expect(result).not.toContain('Gates to record');
      expect(await h.rawStore('session-mode-v2').entries()).toEqual(modeBefore);
      expect(await workflow.entries()).toEqual(workflowBefore);
      expect(await h.rawStore('native-active-v1').entries()).toEqual(pointerBefore);
      h.controls.around = undefined;
      expect(notice(await h.make().prompt('question'))).toBe(true);
      expect(await h.rawStore('session-mode-v2').entries()).toEqual(modeBefore);
      expect(await workflow.entries()).toEqual(workflowBefore);
      expect(await h.rawStore('native-active-v1').entries()).toEqual(pointerBefore);
    });

    for (const stage of ['scope', 'claim']) it('does not emit route context when expiry crosses the ' + stage + ' await', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack-poteto-help', 'question');
      const row: any = await h.rawStore().lookup(h.key());
      await h.rawStore().register(h.key(), row, { ttlMs: 600_000 });
      const now = vi.spyOn(Date, 'now').mockReturnValue(row.expires - 1);
      h.controls.around = async c => {
        const result = await c.run();
        if (c.namespace === intentNamespace && c.method === 'observe' && stage === 'scope')
          h.controls.entry = async entry => { now.mockReturnValue(row.expires); return entry; };
        if (c.namespace === intentNamespace && c.method === 'compareAndApply' && stage === 'claim') now.mockReturnValue(row.expires);
        return result;
      };
      expect(await h.make().prompt('question')).toBeUndefined();
      expect(await h.rawStore().lookup(h.key()) !== undefined).toBe(stage === 'scope');
    });

    it('retains the claimed read-only restriction if the independent Mode lookup fails', async () => {
      const h = instances(register), a = h.make();
      await a.command('pstack-poteto-help', 'question');
      h.controls.around = async c => {
        if (c.namespace === 'session-mode-v2' && c.method === 'lookup') throw Error('Mode unavailable');
        return c.run();
      };
      const result = await h.make().prompt('question');
      expect(notice(result)).toBe(true);
      expect(result.prependContext).toContain('Pstack state lookup FAILED CLOSED:');
      expect(result.prependContext).not.toContain('Pstack mode is active');
      expect(await h.rawStore().lookup(h.key())).toBeUndefined();
    });
  });
}
