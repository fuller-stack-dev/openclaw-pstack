"""Actual process/file behavior; private fixtures only, no model or live state."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/session_mode.py'


class SessionModeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='pstack-session-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.identity = {'userId': 'operator-a', 'sessionKey': 'agent:main:dashboard:case-a',
                         'sessionId': 'incarnation-a'}

    def request(self, text=None, tick=1, **changes):
        req = {'action': 'status' if text is None else 'turn', 'workspace': str(self.root),
               'identity': dict(self.identity)}
        if text is not None:
            req['event'] = {'role': 'user', 'content': text, 'timestamp': tick,
                            'provenance': {'kind': 'external_user'},
                            '__openclaw': {'id': 'event-' + str(tick), 'seq': tick,
                                           'senderIdentity': {'type': 'profile', 'id': self.identity['userId']}}}
        req.update(changes)
        return req

    def call(self, req, ok=True, error=None):
        p = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(req),
                           text=True, capture_output=True, timeout=10)
        self.assertEqual(p.returncode, 0 if ok else 1, p.stderr + p.stdout)
        result = json.loads(p.stdout)
        if error is not None:
            self.assertEqual(result['code'], error, p.stdout)
        return result

    def activate(self):
        result = self.call(self.request('/pstack implement the fix'))
        self.assertTrue(result['active'])
        return result

    def state_path(self):
        return next((self.root / '.pstack-session-state').glob('*.json'))

    def test_first_status_is_inactive_and_read_only(self):
        self.assertFalse(self.call(self.request())['active'])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_activation_next_turn_and_stateless_recall(self):
        self.assertTrue(self.activate()['active'])
        before = self.state_path().read_bytes()
        # Every call is a fresh process: no transcript/global/module-memory recall.
        self.assertTrue(self.call(self.request('Now fix the second issue', 2))['active'])
        self.assertTrue(self.call(self.request())['active'])
        self.assertEqual(self.state_path().read_bytes(), before)

    def test_opt_out_and_reactivation_with_alias(self):
        self.activate()
        self.assertFalse(self.call(self.request('stop using pstack', 2))['active'])
        self.assertFalse(self.call(self.request('Now explain it', 3))['active'])
        self.assertTrue(self.call(self.request('/poteto_mode fix the bug', 4))['active'])
        self.assertFalse(self.call(self.request('/pstack off, answer normally', 5))['active'])
        self.assertFalse(self.call(self.request())['active'])
        self.assertTrue(self.call(self.request('use pstack', 6))['active'])
        self.assertFalse(self.call(self.request('stop using pstack and answer normally', 7))['active'])
        self.assertTrue(self.call(self.request('/pstack', 8))['active'])
        self.assertFalse(self.call(self.request("Don't use pstack for the next question", 9))['active'])

    def test_exact_user_session_incarnation_and_workspace_isolation(self):
        self.activate()
        for field in self.identity:
            identity = dict(self.identity, **{field: self.identity[field] + '-other'})
            self.assertFalse(self.call(self.request(identity=identity))['active'], field)
        with tempfile.TemporaryDirectory() as other:
            self.assertFalse(self.call(self.request(workspace=other))['active'])
        self.assertTrue(self.call(self.request())['active'])

    def test_plain_language_and_explicit_alias_forms(self):
        forms = ['Use native pstack to fix it', 'Please use pstack for this',
                 "Let's use poteto mode", 'turn pstack on', 'enable poteto-mode',
                 "ok now I’m annoyed use pstack and figure out how to make it sticky",
                 'Could you please use pstack to fix this?',
                 '$pstack how is this built?', '/skill poteto-mode fix this',
                 '/pstack help', '/poteto-mode']
        for text in forms:
            with self.subTest(text=text):
                self.assertTrue(self.call(self.request(text))['active'])
                self.assertFalse(self.call(self.request('/pstack off', 2))['active'])
                # Distinct incarnation permits a new fixture timeline.
                self.identity['sessionId'] += 'x'

    def test_untrusted_receipts_quotes_examples_and_mentions_do_not_activate(self):
        texts = ['> /pstack fix it', '\x1b/pstack fix it', '"/pstack fix it"',
                 '```\n/pstack fix it\n```', 'Example: use pstack to fix it',
                 'The report says: /pstack fix it', 'The report says do not use pstack',
                 'Do you support pstack?', 'Explain how to use pstack',
                 'Earlier I said use pstack', 'pstack is installed']
        for text in texts:
            self.assertFalse(self.call(self.request(text))['active'], text)
        for source in ['assistant', 'tool', 'subagent', 'inter-session', 'report']:
            req = self.request('/pstack fix it')
            req['event']['provenance'] = {'kind': source}
            self.assertFalse(self.call(req)['active'], source)
        req = self.request('/pstack fix it')
        req['event']['role'] = 'assistant'
        self.assertFalse(self.call(req)['active'])
        self.assertEqual(list(self.root.iterdir()), [])
        self.activate()
        req = self.request('/pstack off', 2)
        req['event']['provenance'] = {'kind': 'inter_session'}
        self.assertTrue(self.call(req)['active'])

    def test_status_and_generic_stop_do_not_change_mode(self):
        self.assertFalse(self.call(self.request('/pstack status'))['active'])
        self.activate()
        for text in ['/pstack status', '/stop', 'stop', 'off', 'stop using the debugger']:
            self.assertTrue(self.call(self.request(text, 2))['active'])

    def test_old_invocation_cannot_override_new_off_and_duplicate_is_idempotent(self):
        self.activate()
        self.call(self.request('/pstack off', 3))
        before = self.state_path().read_bytes()
        result = self.call(self.request('/pstack fix it', 1))
        self.assertEqual(result['effect'], 'stale-event')
        self.assertFalse(result['active'])
        self.assertEqual(self.state_path().read_bytes(), before)
        self.assertEqual(self.call(self.request('/pstack off', 3))['effect'], 'duplicate')
        conflict = self.request('/pstack fix it', 3)
        self.assertEqual(self.call(conflict, ok=False)['code'], 'EVENT_CONFLICT')

    def test_malformed_identity_schema_and_input_are_rejected_without_writes(self):
        for req in [self.request(identity={}), self.request(identity={**self.identity, 'sessionId': ''}),
                    self.request(unexpected=True), self.request(action='activate')]:
            self.assertFalse(self.call(req, ok=False, error='INVALID_REQUEST')['ok'])
        p = subprocess.run([sys.executable, str(SCRIPT)], input='{broken', text=True,
                           capture_output=True, timeout=10)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(json.loads(p.stdout)['code'], 'INVALID_REQUEST')
        deep = subprocess.run([sys.executable, str(SCRIPT)], input='[' * 2000 + '0' + ']' * 2000,
                              text=True, capture_output=True, timeout=10)
        self.assertEqual(deep.returncode, 1)
        self.assertEqual(json.loads(deep.stdout)['code'], 'INVALID_REQUEST')
        surrogate = self.request('\ud800')
        self.call(surrogate, ok=False, error='INVALID_REQUEST')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_corrupt_oversized_and_wrong_identity_records_do_not_become_inheritance(self):
        self.activate()
        path = self.state_path()
        saved = path.read_bytes()
        for bad in [b'{bad', b'x' * 32769, b'{}', b'[' * 2000 + b'0' + b']' * 2000]:
            path.write_bytes(bad)
            self.assertFalse(self.call(self.request(), ok=False, error='INVALID_STATE')['ok'])
        record = json.loads(saved)
        record['identity']['sessionId'] = 'not-this-incarnation'
        path.write_text(json.dumps(record))
        self.assertEqual(self.call(self.request(), ok=False)['code'], 'IDENTITY_MISMATCH')
        before = path.read_bytes()
        self.call(self.request('/pstack off', 2), ok=False, error='IDENTITY_MISMATCH')
        self.assertEqual(path.read_bytes(), before)

    def test_symlink_state_root_and_record_never_follow_target(self):
        target = self.root / 'target'
        target.mkdir()
        state = self.root / '.pstack-session-state'
        state.symlink_to(target, target_is_directory=True)
        self.call(self.request('/pstack'), ok=False, error='UNSAFE_PATH')
        self.assertEqual(list(target.iterdir()), [])
        state.unlink()
        self.activate()
        path = self.state_path()
        path.unlink()
        outside = self.root / 'outside.json'
        outside.write_text('sentinel')
        path.symlink_to(outside)
        self.call(self.request(), ok=False, error='UNSAFE_PATH')
        self.call(self.request('/pstack off', 2), ok=False, error='UNSAFE_PATH')
        self.assertEqual(outside.read_text(), 'sentinel')

    def test_nonregular_hardlinked_and_public_records_are_rejected(self):
        self.activate()
        path = self.state_path()
        saved = path.read_bytes()
        path.unlink()
        os.mkfifo(path, 0o600)
        self.call(self.request(), ok=False, error='UNSAFE_PATH')
        path.unlink()
        path.write_bytes(saved)
        os.link(path, self.root / 'hardlink')
        self.call(self.request(), ok=False, error='UNSAFE_PATH')
        self.call(self.request('/pstack off', 2), ok=False, error='UNSAFE_PATH')
        (self.root / 'hardlink').unlink()
        path.chmod(0o644)
        self.call(self.request(), ok=False, error='UNSAFE_PATH')
        self.call(self.request('/pstack off', 2), ok=False, error='UNSAFE_PATH')

    def test_concurrent_lock_does_not_lose_off_or_change_record(self):
        self.activate()
        lock = next((self.root / '.pstack-session-state').glob('*.lock'))
        before = self.state_path().read_bytes()
        with lock.open('r+') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.call(self.request('/pstack off', 2), ok=False, error='BUSY')
            self.assertEqual(self.state_path().read_bytes(), before)
        self.assertFalse(self.call(self.request('/pstack off', 2))['active'])
        self.assertEqual(list(lock.parent.glob('*.tmp')), [])

    def test_out_of_order_competing_processes_preserve_latest_event(self):
        self.activate()
        requests = [self.request('/pstack on', 2), self.request('/pstack off', 3)]
        children = [subprocess.Popen([sys.executable, str(SCRIPT)], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in requests]
        def settle(child):
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream is not None:
                    stream.close()
        for child in children:
            self.addCleanup(settle, child)
        results = []
        for child, req in zip(children, requests):
            child.stdin.write(json.dumps(req))
            child.stdin.close()
            child.stdin = None
        for child in children:
            out, err = child.communicate(timeout=10)
            results.append((child.returncode, json.loads(out)))
        # A BUSY caller must re-observe/retry its exact event after the owner exits.
        for req, (code, result) in zip(requests, results):
            if code:
                self.assertEqual(result['code'], 'BUSY')
                self.call(req)
        self.assertFalse(self.call(self.request())['active'])
        saved = json.loads(self.state_path().read_text())
        self.assertEqual(saved['lastEvent']['id'], 'event-3')
        self.assertEqual(saved['lastEvent']['seq'], 3)
        self.assertEqual(list(self.state_path().parent.glob('*.tmp')), [])

    @staticmethod
    def native_wrapper(body, names=('pstack',), gap=1, located=False):
        header = "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:"
        rows = ['- ' + name + (' (SKILL.md: /fixture/SKILL.md)' if located else '') for name in names]
        # Same array/join construction as native chat-command-invocation.ts.
        return '\n'.join([header, *rows, '', 'User request:', '']) + '\n' * (gap - 1) + body

    def test_exact_native_wrapper_activation_off_and_alias(self):
        tick = 1
        for name, command in [('pstack', '/pstack'), ('poteto-mode', '/poteto_mode')]:
            for gap, located in [(1, False), (2, True)]:
                on = self.native_wrapper(command + ' fix it', (name,), gap, located)
                self.assertTrue(self.call(self.request(on, tick))['active'])
                off = self.native_wrapper(command + ' off', (name,), gap, located)
                self.assertFalse(self.call(self.request(off, tick + 1))['active'])
                tick += 2
        req = self.request('/pstack', tick)
        req['event']['content'] = [{'type': 'text', 'text': self.native_wrapper('/pstack fix it')}]
        self.assertTrue(self.call(req)['active'])

    def test_wrapper_rejects_mismatched_names_quotes_and_arbitrary_extraction(self):
        valid = self.native_wrapper('/pstack fix it')
        for text in [self.native_wrapper('/pstack fix it', ('github',)),
                     self.native_wrapper('/pstack fix it', ('poteto-mode',)),
                     self.native_wrapper('/pstack fix it', ('pstack', 'github')),
                     self.native_wrapper('/pstack fix it', ('pstack', 'pstack')),
                     self.native_wrapper('Example: /pstack fix it'), '> ' + valid,
                     'Report:\n' + valid, '"' + valid + '"', valid.replace('User request:', 'Report:')]:
            self.assertFalse(self.call(self.request(text))['active'], text)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_native_provenance_and_sender_are_required_not_rendered_projection(self):
        for alteration in ['missing', 'internal', 'wrong-sender']:
            req = self.request('/pstack fix it')
            if alteration == 'missing':
                del req['event']['provenance']
            elif alteration == 'internal':
                req['event']['provenance'] = {'kind': 'inter_session'}
            else:
                req['event']['__openclaw']['senderIdentity']['id'] = 'other-user'
            if alteration == 'missing':
                self.call(req, ok=False, error='UNQUALIFIED_PROVENANCE')
            else:
                self.assertFalse(self.call(req)['active'], alteration)
        req = self.request('ordinary human message')
        req['event']['modelPromptProjection'] = '/pstack fix it'
        self.call(req, ok=False, error='INVALID_REQUEST')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_stop_and_disable_tasks_are_not_mode_commands(self):
        self.activate()
        for tick, task in enumerate(['/pstack stop the leak', '/pstack disable the broken retry',
                                     '/poteto_mode stop the process'], 2):
            self.assertTrue(self.call(self.request(task, tick))['active'], task)
        self.assertFalse(self.call(self.request('/pstack stop', 5))['active'])
        self.assertTrue(self.call(self.request('/pstack fix it', 6))['active'])
        self.assertFalse(self.call(self.request('/pstack disable', 7))['active'])

    def test_obvious_plain_language_on_off_forms(self):
        for tick, text in enumerate(['turn off pstack and answer normally', 'stop pstack',
                                     'exit pstack', 'quit pstack', 'deactivate pstack'], 2):
            on = self.request('turn on pstack', tick * 2)
            self.assertTrue(self.call(on)['active'])
            self.assertFalse(self.call(self.request(text, tick * 2 + 1))['active'], text)

    def test_same_timestamp_uses_native_sequence_not_id_lexical_order(self):
        first = self.request('/pstack', 10)
        first['event']['__openclaw']['id'] = 'z-first'
        self.assertTrue(self.call(first)['active'])
        off = self.request('/pstack off', 10)
        off['event']['__openclaw'].update(id='a-later', seq=11)
        self.assertFalse(self.call(off)['active'])
        older = self.request('/pstack on', 10)
        older['event']['__openclaw'].update(id='zz-older', seq=9)
        self.assertEqual(self.call(older)['effect'], 'stale-event')
        self.assertFalse(self.call(self.request())['active'])
        self.assertEqual(self.call(off)['effect'], 'duplicate')
        conflict = self.request('/pstack on', 10)
        conflict['event']['__openclaw'].update(id='different-at-same-position', seq=11)
        self.call(conflict, ok=False, error='EVENT_CONFLICT')

    def test_explicit_off_recovers_only_inspected_private_corrupt_record(self):
        self.activate()
        path = self.state_path()
        for tick, bad in enumerate([b'{bad', b'x' * 32769, b'{}', b'[' * 2000 + b'0' + b']' * 2000], 2):
            path.write_bytes(bad)
            self.call(self.request(), ok=False, error='INVALID_STATE')
            self.call(self.request('/pstack on', tick * 2), ok=False, error='INVALID_STATE')
            result = self.call(self.request('/pstack off', tick * 2 + 1))
            self.assertFalse(result['active'])
            self.assertEqual(result['effect'], 'recovered-off')
        self.assertEqual(list(path.parent.glob('*.tmp')), [])

    def test_public_directory_and_symlink_lock_fail_without_mutation(self):
        self.activate()
        path = self.state_path()
        before = path.read_bytes()
        path.parent.chmod(0o755)
        self.call(self.request(), ok=False, error='UNSAFE_PATH')
        path.parent.chmod(0o700)
        lock = next(path.parent.glob('*.lock'))
        lock.unlink()
        target = self.root / 'lock-target'
        target.write_text('untouched')
        lock.symlink_to(target)
        self.call(self.request('/pstack off', 2), ok=False, error='UNSAFE_PATH')
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(target.read_text(), 'untouched')


    def legacy_record(self, active=True, tick=1):
        self.activate()
        path = self.state_path()
        record = json.loads(path.read_text())
        record.update(version=1, active=active, revision=7)
        del record['lastEvent']['seq']
        record['lastEvent']['timestampMs'] = tick
        path.write_text(json.dumps(record))
        return path

    def test_v1_status_is_read_only_and_next_transition_writes_v2(self):
        for active in [True, False]:
            path = self.legacy_record(active)
            before = path.read_bytes()
            observed = self.call(self.request())
            self.assertEqual(observed['active'], active)
            self.assertEqual(observed['revision'], 7)
            self.assertEqual(self.call(self.request('ordinary followup', 2))['active'], active)
            self.assertEqual(path.read_bytes(), before)
            updated = self.call(self.request('/pstack off' if active else '/pstack on', 3))
            self.assertEqual(updated['active'], not active)
            self.assertEqual(updated['revision'], 8)
            self.assertEqual(updated['effect'], 'deactivated' if active else 'activated')
            saved = json.loads(path.read_text())
            self.assertEqual(saved['version'], 2)
            self.assertEqual(saved['lastEvent']['seq'], 3)
            path.unlink()  # Each loop case owns one legacy record fixture.
            self.identity['sessionId'] += 'x'

    def test_v1_stale_event_cannot_migrate_or_reactivate_off(self):
        path = self.legacy_record(False, tick=10)
        before = path.read_bytes()
        result = self.call(self.request('/pstack on', 9))
        self.assertFalse(result['active'])
        self.assertEqual(result['effect'], 'stale-event')
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.call(self.request())['revision'], 7)

    def test_malformed_v1_records_remain_invalid(self):
        path = self.legacy_record()
        original = json.loads(path.read_text())
        for malformed in ['seq', 'digest', 'active', 'version']:
            record = json.loads(json.dumps(original))
            if malformed == 'seq':
                record['lastEvent']['seq'] = 0
            elif malformed == 'digest':
                record['lastEvent']['digest'] = 'not-a-digest'
            elif malformed == 'active':
                record['active'] = 1
            else:
                record['version'] = True
            path.write_text(json.dumps(record))
            before = path.read_bytes()
            self.call(self.request(), ok=False, error='INVALID_STATE')
            self.assertEqual(path.read_bytes(), before)

    def test_plain_language_tasks_and_deferred_exit_do_not_opt_out(self):
        self.activate()
        before = self.state_path().read_bytes()
        for text in ['stop pstack from spawning so many agents',
                     'disable pstack routing for reviewers', 'exit pstack after this task',
                     'quit pstack after the tests finish', 'deactivate pstack routing for one role',
                     'stop using pstack after this task', 'stop pstackand answer normally',
                     'do not use pstack after this task', "don't use pstack routing for reviewers"]:
            self.assertTrue(self.call(self.request(text, 2))['active'], text)
            self.assertEqual(self.state_path().read_bytes(), before)
        for tick, text in enumerate(['stop pstack mode now and answer normally',
                                     'disable pstack please', 'exit pstack, answer normally'], 3):
            self.assertFalse(self.call(self.request(text, tick * 2))['active'], text)
            self.assertTrue(self.call(self.request('/pstack', tick * 2 + 1))['active'])

    def test_bare_webchat_missing_provenance_is_explicit_compatibility_limit(self):
        # Native-shaped profile row, not a command-input echo or synthetic provenance.
        for text in ['/pstack fix it', self.native_wrapper('/pstack fix it')]:
            on = self.request(text)
            del on['event']['provenance']
            self.call(on, ok=False, error='UNQUALIFIED_PROVENANCE')
            self.assertEqual(list(self.root.iterdir()), [])
        self.activate()
        before = self.state_path().read_bytes()
        for text in ['/pstack off', self.native_wrapper('/pstack off')]:
            off = self.request(text, 2)
            del off['event']['provenance']
            self.call(off, ok=False, error='UNQUALIFIED_PROVENANCE')
            self.assertTrue(self.call(self.request())['active'])
            self.assertEqual(self.state_path().read_bytes(), before)
        status = self.request('/pstack status', 3)
        del status['event']['provenance']
        self.assertTrue(self.call(status)['active'])
        ordinary = self.request('next question', 4)
        del ordinary['event']['provenance']
        self.assertTrue(self.call(ordinary)['active'])
        self.assertFalse(self.call(self.request('stop using pstack and answer normally', 5))['active'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
