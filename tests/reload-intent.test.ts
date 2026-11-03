import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realpath } from 'node:fs/promises';
import { createTestPluginApi } from 'openclaw/plugin-sdk/plugin-test-api';
import { createOpenClawTestState } from 'openclaw/plugin-sdk/test-state';
import { createPluginStateKeyedStoreV2ForTests, resetPluginStateStoreForTests } from 'openclaw/plugin-sdk/plugin-state-test-runtime';
import { register as sourceRegister } from '../src/index.js';
import { register as artifactRegister } from '../dist/index.js';
let fixture: any, serial = 0;
beforeAll(async () => { fixture = await createOpenClawTestState({ label: 'reload-intent', applyEnv: true }); });
afterAll(async () => { resetPluginStateStoreForTests(); await fixture.cleanup(); });
function instances(register: typeof sourceRegister) {
  const session = { sessionKey: 'agent:worker:dashboard:reload-' + ++serial, sessionId: 'incarnation-1', agentId: 'worker' };
  const make = () => {
    const commands = new Map<string, any>(), hooks = new Map<string, any>();
    const config = { plugins: { entries: { pstack: { hooks: { allowConversationAccess: true } } } } };
    const api = createTestPluginApi({ id: 'pstack', runtime: {
      config: { current: () => config },
      state: { openKeyedStoreV2: (spec: any, opts: any) => createPluginStateKeyedStoreV2ForTests('pstack', spec, opts) },
      agent: { session: { getSessionEntryAsync: async ({sessionKey}: any) => sessionKey === session.sessionKey ? { sessionId: session.sessionId, spawnedWorkspaceDir: await realpath(fixture.workspaceDir) } : undefined }, resolveAgentWorkspaceDir: () => { throw Error('unexpected fallback'); } }
    }, registerCommand: (command: any) => commands.set(command.name, command), on: (name: string, hook: any) => hooks.set(name, hook) } as any);
    register(api);
    return {
      command: (name: string, args: string, overrides: any = {}) => commands.get(name).handler({ ...session, senderId: 'fixture-owner', isAuthorizedSender: true, gatewayClientScopes: ['operator.write'], channel: 'webchat', args, commandBody: '/' + name + ' ' + args, config, assertOwnerCurrent() {}, ...overrides }),
      prompt: (text: string, overrides: any = {}) => hooks.get('before_prompt_build')({prompt: text, currentUserMessage: text, messages: []}, { ...session, hookInvocation: { assertActive() {} }, ...overrides }),
    };
  };
  return { make };
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
    for (const route of ['poteto-help', 'setup-pstack']) it('successor consumes pending ' + route + ' intent exactly once after instance replacement', async () => {
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
  });
}
