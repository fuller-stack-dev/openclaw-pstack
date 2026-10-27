#!/usr/bin/env python3
"""Behavioral tests use private fixtures, never live stores or installations."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'scripts/verify_install.py'
spec = importlib.util.spec_from_file_location('verify_install', MODULE)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class IntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pstack-verify-test-')
        self.root = Path(self.temporary.name)
        self.path = self.root / 'asset.txt'
        self.path.write_bytes(b'original')
        self.record = {'path': 'asset.txt', 'bytes': 8,
                       'sha256': hashlib.sha256(b'original').hexdigest(),
                       'mode': oct(self.path.stat().st_mode & 0o777)}

    def tearDown(self):
        self.temporary.cleanup()

    def test_valid_content_read_without_modification(self):
        before = self.path.stat()
        self.assertEqual(verifier.verify_records(self.root, [self.record], exact=True),
                         {'files': 1, 'bytes': 8})
        self.assertEqual(self.path.read_bytes(), b'original')
        self.assertEqual(self.path.stat().st_mtime_ns, before.st_mtime_ns)

    def test_same_length_corruption_rejected(self):
        self.path.write_bytes(b'corrupt!')
        with self.assertRaisesRegex(verifier.IntegrityError, 'content mismatch'):
            verifier.verify_records(self.root, [self.record])

    def test_missing_file_rejected(self):
        self.path.unlink()
        with self.assertRaisesRegex(verifier.IntegrityError, 'missing file'):
            verifier.verify_records(self.root, [self.record])

    def test_extra_source_file_rejected(self):
        (self.root / 'unexpected').touch()
        with self.assertRaisesRegex(verifier.IntegrityError, 'unexpected source inventory'):
            verifier.verify_records(self.root, [self.record], exact=True)

    def test_duplicate_manifest_entry_rejected(self):
        with self.assertRaisesRegex(verifier.IntegrityError, 'duplicate'):
            verifier.verify_records(self.root, [self.record, self.record])

    def test_parent_escape_and_absolute_paths_rejected(self):
        for path in ('../outside', '/etc/passwd', 'x/../asset.txt'):
            with self.subTest(path=path):
                with self.assertRaisesRegex(verifier.IntegrityError, 'unsafe'):
                    verifier.verify_records(self.root, [dict(self.record, path=path)])

    def test_file_and_directory_symlinks_rejected(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.path)
        with self.assertRaisesRegex(verifier.IntegrityError, 'symlink'):
            verifier.verify_records(self.root, [dict(self.record, path='alias')])
        directory = self.root / 'directory'
        directory.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(verifier.IntegrityError, 'symlink'):
            verifier.verify_records(self.root, [dict(self.record, path='directory/asset.txt')])

    def test_exact_npm_ignore_relocation_is_verified_and_reported(self):
        self.path.rename(self.root / '.npmignore')
        record = dict(self.record, path='.gitignore')
        before = (self.root / '.npmignore').stat()
        result = verifier.verify_records(self.root, [record], exact=True, npm_ignores=True)
        self.assertEqual(result['npmIgnoreRelocations'],
                         [{'source': '.gitignore', 'installed': '.npmignore'}])
        self.assertFalse((self.root / '.gitignore').exists())
        self.assertEqual((self.root / '.npmignore').stat().st_mtime_ns, before.st_mtime_ns)
        with self.assertRaisesRegex(verifier.IntegrityError, 'missing file'):
            verifier.verify_records(self.root, [record], exact=True)
        (self.root / '.npmignore').write_bytes(b'corrupt!')
        with self.assertRaisesRegex(verifier.IntegrityError, 'content mismatch'):
            verifier.verify_records(self.root, [record], exact=True, npm_ignores=True)

    def test_npm_ignore_alias_does_not_hide_extra_files_or_links(self):
        record = dict(self.record, path='.gitignore')
        self.path.rename(self.root / '.gitignore')
        (self.root / '.npmignore').write_bytes(b'original')
        with self.assertRaisesRegex(verifier.IntegrityError, 'unexpected source inventory'):
            verifier.verify_records(self.root, [record], exact=True, npm_ignores=True)
        (self.root / '.gitignore').unlink()
        (self.root / '.npmignore').unlink()
        (self.root / '.npmignore').symlink_to(self.root / 'outside')
        with self.assertRaisesRegex(verifier.IntegrityError, 'symlink'):
            verifier.verify_records(self.root, [record], exact=True, npm_ignores=True)

    def test_mode_change_rejected_when_requested(self):
        self.path.chmod(0o700 if self.record['mode'] != '0o700' else 0o600)
        with self.assertRaisesRegex(verifier.IntegrityError, 'mode mismatch'):
            verifier.verify_records(self.root, [self.record], modes=True)


class ManualRouteIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pstack-route-integrity-')
        self.root = Path(self.temporary.name) / 'skills/pstack'
        (self.root / 'native').mkdir(parents=True)
        self.routes = {'workflows': ['architect'], 'playbooks': []}
        self.file = self.root.parent / 'routes/pstack-architect/SKILL.md'
        self.file.parent.mkdir(parents=True)
        self.file.write_text('---\nname: pstack-architect\nuser-invocable: true\ndisable-model-invocation: true\n---\nGuide\n')
        self.input = self.root / 'native/workflows.md'
        self.input.write_text('## architect\nMandatory native contract\n')
        def record(path, relative):
            data = path.read_bytes()
            return {'path': relative, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        inputs = [record(self.input, 'native/workflows.md')]
        for path in ('source-manifest.json', 'native/routes.json', 'native/playbooks.md'):
            target = self.root / path
            target.write_text('fixture input')
            inputs.append(record(target, path))
        self.manifest = {'schema': 1, 'kind': 'manual-route-discovery-only',
                         'inputs': inputs,
                         'files': [dict(record(self.file, 'pstack-architect/SKILL.md'), route='architect')]}
        self.save()

    def save(self):
        (self.root / 'native/route-skills.json').write_text(json.dumps(self.manifest))

    def tearDown(self):
        self.temporary.cleanup()

    def test_reads_external_manual_files_without_mutation(self):
        before = self.file.stat().st_mtime_ns
        self.assertEqual(verifier.verify_route_skills(self.root, self.routes)['files'], 1)
        self.assertEqual(self.file.stat().st_mtime_ns, before)

    def test_corrupted_missing_extra_and_linked_guides_fail(self):
        data = self.file.read_bytes()
        self.file.write_bytes(b'corrupt')
        with self.assertRaisesRegex(verifier.IntegrityError, 'content mismatch'):
            verifier.verify_route_skills(self.root, self.routes)
        self.file.unlink()
        with self.assertRaisesRegex(verifier.IntegrityError, 'missing file'):
            verifier.verify_route_skills(self.root, self.routes)
        self.file.write_bytes(data)
        extra = self.file.parent / 'extra.txt'
        extra.write_text('unexpected')
        with self.assertRaisesRegex(verifier.IntegrityError, 'inventory'):
            verifier.verify_route_skills(self.root, self.routes)
        extra.unlink()
        self.file.unlink()
        self.file.symlink_to(self.input)
        with self.assertRaisesRegex(verifier.IntegrityError, 'symlink'):
            verifier.verify_route_skills(self.root, self.routes)

    def test_changed_native_input_or_route_identity_fails(self):
        self.input.write_text('changed contract')
        with self.assertRaisesRegex(verifier.IntegrityError, 'content mismatch'):
            verifier.verify_route_skills(self.root, self.routes)
        self.input.write_text('## architect\nMandatory native contract\n')
        self.manifest['files'][0]['route'] = 'arena'
        self.save()
        with self.assertRaisesRegex(verifier.IntegrityError, 'name mismatch'):
            verifier.verify_route_skills(self.root, self.routes)

    def test_missing_input_hash_cannot_hide_changed_native_contract(self):
        self.manifest['inputs'] = []
        self.save()
        with self.assertRaisesRegex(verifier.IntegrityError, 'input inventory'):
            verifier.verify_route_skills(self.root, self.routes)

    def test_refreshed_hash_cannot_make_auto_invocable_manual_skill_eligible(self):
        self.file.write_text(self.file.read_text().replace('disable-model-invocation: true', 'disable-model-invocation: false'))
        data = self.file.read_bytes()
        self.manifest['files'][0].update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        self.save()
        with self.assertRaisesRegex(verifier.IntegrityError, 'invocation policy'):
            verifier.verify_route_skills(self.root, self.routes)


class LoaderBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.rows = [{'name': name, 'eligible': True, 'modelVisible': True, 'userInvocable': False,
                      'commandVisible': False} for name in ('existing', 'pstack', 'poteto-mode')]

    def test_two_native_entries_preserve_existing_skill(self):
        result = verifier.verify_inventory(self.rows, ['existing'])
        self.assertEqual(result['preExistingNamesPreserved'], 1)
        self.assertEqual(result['sourceOnlyEntries'], 0)

    def test_source_helper_leak_rejected(self):
        self.rows.append({'name': 'how', 'eligible': True})
        with self.assertRaisesRegex(verifier.IntegrityError, 'unexpected new'):
            verifier.verify_inventory(self.rows, ['existing'])

    def test_unavailable_alias_rejected(self):
        self.rows[-1]['commandVisible'] = True
        with self.assertRaisesRegex(verifier.IntegrityError, 'unavailable'):
            verifier.verify_inventory(self.rows, ['existing'])

    def test_existing_skill_disappearance_rejected(self):
        with self.assertRaisesRegex(verifier.IntegrityError, 'pre-existing skills missing'):
            verifier.verify_inventory(self.rows[1:], ['existing'])

    def test_supplied_inventory_baseline_is_portable_and_still_enforced(self):
        root = MODULE.parents[1]
        routes = json.loads((root / 'native/routes.json').read_text())
        manual = [{'name': 'pstack-' + name, 'eligible': True, 'modelVisible': False,
                   'userInvocable': True, 'commandVisible': True}
                  for name in routes['workflows'] + routes['playbooks']]
        rows = self.rows + manual
        result = verifier.verify(root, {'skills': rows, 'baselineSkillNames': ['existing']})
        self.assertEqual(result['loader']['preExistingNamesPreserved'], 1)
        with self.assertRaisesRegex(verifier.IntegrityError, 'unexpected new'):
            verifier.verify(root, {'skills': rows, 'baselineSkillNames': []})
        with self.assertRaisesRegex(verifier.IntegrityError, 'pre-existing skills missing'):
            verifier.verify(root, {'skills': rows[1:], 'baselineSkillNames': ['existing']})

    def test_manual_routes_are_visible_only_to_explicit_user_invocation(self):
        row = {'name': 'pstack-architect', 'eligible': True, 'modelVisible': False,
               'userInvocable': True, 'commandVisible': True}
        self.assertEqual(verifier.verify_inventory(self.rows + [row], ['existing'],
                         ['pstack-architect'])['manualRouteSkills'], 1)
        for flag in ('eligible', 'modelVisible', 'userInvocable', 'commandVisible'):
            with self.subTest(flag=flag):
                changed = dict(row, **{flag: not row[flag]})
                with self.assertRaisesRegex(verifier.IntegrityError, 'manual route'):
                    verifier.verify_inventory(self.rows + [changed], ['existing'], ['pstack-architect'])
        with self.assertRaisesRegex(verifier.IntegrityError, 'manual route'):
            verifier.verify_inventory(self.rows, ['existing'], ['pstack-architect'])
        with self.assertRaisesRegex(verifier.IntegrityError, 'duplicate'):
            verifier.verify_inventory(self.rows + [self.rows[0]], ['existing'])

    def test_model_hidden_alias_rejected(self):
        self.rows[-1]['modelVisible'] = False
        with self.assertRaisesRegex(verifier.IntegrityError, 'unavailable'):
            verifier.verify_inventory(self.rows, ['existing'])


class WatchPrTemplateIntegrityTests(unittest.TestCase):
    """Private copies of the shipped skill; each drift in the watch-pr template must fail the doctor."""

    def setUp(self):
        import shutil
        self.temporary = tempfile.TemporaryDirectory(prefix='pstack-watch-pr-test-')
        self.root = Path(self.temporary.name) / 'pstack'
        shutil.copytree(MODULE.parents[1], self.root, ignore=shutil.ignore_patterns('tests', '__pycache__'))

    def tearDown(self):
        self.temporary.cleanup()

    def check(self):
        routes = json.loads((self.root / 'native/routes.json').read_text())
        native = json.loads((self.root / 'native-manifest.json').read_text())
        return verifier.verify_watch_pr(self.root, routes, native)

    def edit(self, rel, old, new, pattern):
        path = self.root / rel
        text = path.read_text()
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1))
        with self.assertRaisesRegex(verifier.IntegrityError, pattern):
            self.check()
        path.write_text(text)
        self.check()

    def test_shipped_template_passes_without_modification(self):
        script = self.root / 'scripts/watch-pr.mjs'
        before = script.read_bytes()
        self.assertEqual(self.check(), {'kind': 'user-installed-template', 'ghCommands': 2, 'queries': 2, 'exitCodes': 6})
        self.assertEqual(script.read_bytes(), before)
        self.assertEqual(verifier.verify(MODULE.parents[1])['watchPr']['exitCodes'], 6)

    def test_guide_entry_link_and_manifest_are_required(self):
        self.edit('native/routes.json', '"watch-pr template"', '"watch template"', 'native extensions')
        self.edit('native/automation/README.md', '](watch-pr.md)', '](missing.md)', 'not linked')
        self.edit('native-manifest.json', '"scripts/watch-pr.mjs"', '"scripts/watch-pr-old.mjs"', 'missing from native manifest')

    def test_write_capable_commands_or_queries_fail(self):
        script = 'scripts/watch-pr.mjs'
        self.edit(script, '[["auth", "status"], ["api", "graphql"]]', '[["auth", "status"], ["api", "graphql"], ["pr", "merge"]]', 'allowlist')
        self.edit(script, 'export const THREAD_QUERY = `query(', 'export const THREAD_QUERY = `mutation(', 'read-only query')
        self.edit(script, 'reviewThreads(first:100){pageInfo', 'addComment(input:{}){clientMutationId} reviewThreads(first:100){pageInfo', 'read-only query')

    def test_process_outside_the_guard_fails(self):
        script = 'scripts/watch-pr.mjs'
        self.edit(script, 'import { spawn } from "node:child_process";', 'import { spawn, execFile } from "node:child_process";', 'read-only gh guard')
        self.edit(script, '  assertReadOnly(args, options.hostname);\n  return new Promise', '  return new Promise', 'read-only gh guard')
        self.edit(script, 'export function findGh(env) {', 'export function findGh(env) {\n  spawn("crontab", ["-l"]);', 'read-only gh guard')

    def test_exit_codes_and_guide_must_agree(self):
        self.edit('native/automation/watch-pr.md', '| 6 | `state-error` |', '| state-error |', 'exit codes')
        self.edit('scripts/watch-pr.mjs', '  state: 6,\n', '  state: 6,\n  merged: 7,\n', 'exit codes')


if __name__ == '__main__':
    unittest.main(verbosity=2)


class AgentBriefIntegrityTests(unittest.TestCase):
    """Private copies of the shipped skill; each mutation must fail the doctor."""

    def setUp(self):
        import shutil
        self.temporary = tempfile.TemporaryDirectory(prefix='pstack-agents-test-')
        self.root = Path(self.temporary.name) / 'pstack'
        shutil.copytree(MODULE.parents[1], self.root, ignore=shutil.ignore_patterns('tests', '__pycache__'))
        self.contracts_path = self.root / 'native/agents/contracts.json'
        self.contracts = json.loads(self.contracts_path.read_text())

    def tearDown(self):
        self.temporary.cleanup()

    def check(self):
        source = json.loads((self.root / 'source-manifest.json').read_text())
        routes = json.loads((self.root / 'native/routes.json').read_text())
        return verifier.verify_agents(self.root, source, routes)

    def mutate(self, change, pattern):
        contracts = json.loads(json.dumps(self.contracts))
        change(contracts)
        self.contracts_path.write_text(json.dumps(contracts))
        with self.assertRaisesRegex(verifier.IntegrityError, pattern):
            self.check()

    def test_shipped_briefs_and_contracts_pass_without_modification(self):
        before = self.contracts_path.read_bytes()
        self.assertEqual(self.check(), {'kind': 'agent-attested-briefs', 'profiles': 2, 'panelProfiles': 2, 'panelRoles': 4, 'schemas': 6})
        self.assertEqual(self.contracts_path.read_bytes(), before)

    def test_open_unbounded_or_unsupported_schemas_fail(self):
        def field(c):
            return c['schemas']['arena-runner']['properties']
        self.mutate(lambda c: c['schemas']['arena-runner'].update(additionalProperties=True), 'open output schema')
        self.mutate(lambda c: c['schemas']['arena-runner']['required'].append('score'), 'open output schema')
        self.mutate(lambda c: field(c)['rationale'].pop('maxLength'), 'unbounded')
        self.mutate(lambda c: field(c)['alternatives'].pop('maxItems'), 'unbounded')
        self.mutate(lambda c: field(c)['rationale'].update(format='uri'), 'unsupported')
        self.mutate(lambda c: field(c).update(score={'type': 'number'}), 'unsupported')

    def test_panel_coverage_and_contract_inventory_fail_closed(self):
        self.mutate(lambda c: c['panelRoles'].pop('arena cross-judge pool'), 'coverage')
        self.mutate(lambda c: c['schemas'].update(spare={'type': 'boolean'}), 'unused or missing')
        self.mutate(lambda c: c['profiles'].pop(), 'inventory')

    def test_profile_provenance_reads_and_route_wiring_fail(self):
        self.mutate(lambda c: c['profiles'][0].update(upstreamSha256='0' * 64), 'provenance')
        self.mutate(lambda c: c['profiles'][0].update(outputSchema='delegate-result'), 'output contract mismatch')
        self.mutate(lambda c: c['profiles'][1]['requiredReads'].append('native/workflows.md#not-a-route'), 'required read missing')
        self.mutate(lambda c: c['profiles'][1]['requiredReads'].append('../outside.md'), 'unsafe manifest path')
        self.mutate(lambda c: c['profiles'][0].update(route='tdd'), 'not wired')

    def test_panel_profiles_must_ship_instructions_deny_writers_and_keep_ids_unique(self):
        self.mutate(lambda c: c['panelProfiles'][0].update(instructionsFile='native/agents/missing.md'), 'instructions missing: panel-reviewer')
        self.mutate(lambda c: c['panelProfiles'][1]['narrowTools']['deny'].remove('write'), 'not read-only: panel-judge')
        self.mutate(lambda c: c['panelProfiles'][0]['narrowTools']['deny'].remove('group:plugins'), 'not read-only: panel-reviewer')
        self.mutate(lambda c: c['panelProfiles'][1].update(id='comment-sicko'), 'duplicate profile id')
        self.mutate(lambda c: c['panelProfiles'][0].update(instructionsFile='../outside.md'), 'unsafe manifest path')

    def test_removed_route_wiring_or_brief_contract_text_fails(self):
        workflows = self.root / 'native/workflows.md'
        text = workflows.read_text()
        workflows.write_text(text.replace('profile `comment-sicko`', 'profile reviewer'))
        with self.assertRaisesRegex(verifier.IntegrityError, 'not wired'):
            self.check()
        workflows.write_text(text)
        brief = self.root / 'native/agents/poteto-agent.md'
        brief.write_text(brief.read_text().replace('`delegate-result`', 'report'))
        with self.assertRaisesRegex(verifier.IntegrityError, 'output contract mismatch: poteto-agent'):
            self.check()


class SemanticOverlayIntegrityTests(unittest.TestCase):
    """Private copies of the shipped skill; each overlay defect must fail the doctor."""

    def setUp(self):
        import shutil
        self.temporary = tempfile.TemporaryDirectory(prefix='pstack-overlay-test-')
        # Copy the sibling route and alias skills too, so the full doctor can run.
        shutil.copytree(MODULE.parents[2], Path(self.temporary.name) / 'skills',
                        ignore=shutil.ignore_patterns('tests', '__pycache__'))
        self.root = Path(self.temporary.name) / 'skills/pstack'
        self.overlay_path = self.root / 'native/semantic-overlay.json'
        self.document_path = self.root / 'native/semantic-overlay.md'
        self.originals = (self.overlay_path.read_bytes(), self.document_path.read_bytes())
        self.source = json.loads((self.root / 'source-manifest.json').read_text())

    def tearDown(self):
        self.temporary.cleanup()

    def check(self):
        return verifier.verify_overlay(self.root, self.source)

    def overlay(self):
        return json.loads(self.overlay_path.read_text())

    def save(self, overlay, regenerate_marker=True):
        data = json.dumps(overlay, indent=2).encode() + b'\n'
        self.overlay_path.write_bytes(data)
        if regenerate_marker:
            # Keep the generated document's overlay hash current so only the defect under test fails.
            document = self.root / 'native/semantic-overlay.md'
            text = document.read_text()
            text = re.sub(r'^Overlay: `semantic-overlay\.json` sha256 `[0-9a-f]{64}`$',
                          'Overlay: `semantic-overlay.json` sha256 `%s`' % hashlib.sha256(data).hexdigest(), text, flags=re.M)
            document.write_text(text)

    def rule(self, overlay, path='skills/technical-writing/SKILL.md', index=0):
        return next(f for f in overlay['files'] if f['path'] == path)['rules'][index]

    def expect(self, change, pattern):
        self.overlay_path.write_bytes(self.originals[0])
        self.document_path.write_bytes(self.originals[1])
        overlay = self.overlay()
        change(overlay)
        self.save(overlay)
        with self.assertRaisesRegex(verifier.IntegrityError, pattern):
            self.check()

    def test_shipped_overlay_maps_every_rule_without_modification(self):
        before = self.overlay_path.read_bytes()
        result = self.check()
        self.assertEqual((result['kind'], result['files'], result['rules']), ('reviewed-text-coverage', 93, 328))
        self.assertEqual(result['gateTargets'] + result['nativeTargets'] + result['sameTargets'] + result['exclusions'],
                         sum(len(r['map']) for f in self.overlay()['files'] for r in f['rules']))
        self.assertEqual(self.overlay_path.read_bytes(), before)

    def test_full_doctor_reports_overlay(self):
        self.assertEqual(verifier.verify(self.root)['overlay']['rules'], 328)

    def test_unmapped_or_undisposed_rule_fails(self):
        self.expect(lambda o: next(f for f in o['files'] if f['path'] == 'skills/technical-writing/SKILL.md')['rules'].pop(),
                    r'unmapped upstream rule: skills/technical-writing/SKILL\.md:\d+ r-')
        self.expect(lambda o: self.rule(o).update(map=[]), r'unmapped upstream rule: r-')

    def test_new_rule_in_rule_free_file_fails(self):
        path = self.root / 'upstream/skills/sharpen/SKILL.md'
        data = path.read_bytes() + b'\nAgents must never rewrite the prompt.\n'
        path.write_bytes(data)
        record = next(r for r in self.source['files'] if r['path'] == 'skills/sharpen/SKILL.md')
        record.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        with self.assertRaisesRegex(verifier.IntegrityError, r'unmapped upstream rule: skills/sharpen/SKILL\.md:\d+'):
            self.check()

    def test_upstream_drift_fails_even_with_a_refreshed_manifest(self):
        path = self.root / 'upstream/skills/technical-writing/SKILL.md'
        data = path.read_bytes() + b'\nA harmless trailing note.\n'
        path.write_bytes(data)
        record = next(r for r in self.source['files'] if r['path'] == 'skills/technical-writing/SKILL.md')
        record.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        with self.assertRaisesRegex(verifier.IntegrityError, 'upstream drift from semantic overlay: skills/technical-writing'):
            self.check()

    def test_pinned_commit_line_and_inventory_drift_fail(self):
        self.expect(lambda o: o.update(upstreamCommit='0' * 40), 'different upstream commit')
        self.expect(lambda o: self.rule(o).update(line=self.rule(o)['line'] + 1), 'semantic overlay line drift')
        self.expect(lambda o: o['files'].append({'path': 'skills/sharpen/SKILL.md', 'sha256': '0' * 64, 'rules': []}),
                    'stale or reordered semantic overlay entries')
        self.expect(lambda o: o['files'].reverse(), 'stale or reordered semantic overlay entries')
        self.expect(lambda o: o.update(reviewedBy='anyone'), 'invalid semantic overlay')

    def test_targets_must_resolve_to_current_native_text(self):
        cases = [
            ([{'gate': 'tdd/no-such-gate'}], 'missing gate'),
            ([{'gate': 'not-a-route/x'}], 'missing gate'),
            ([{'gate': 'tdd/red-green-report/extra'}], 'missing gate'),
            ([{'native': '../README.md', 'quote': 'pstack adapter text'}], 'invalid native document'),
            ([{'native': 'semantic-overlay.md', 'quote': 'Upstream rule overlay'}], 'invalid native document'),
            ([{'native': 'principles.md', 'quote': 'Proceed'}], 'disappeared'),
            ([{'native': 'missing.md', 'quote': 'anything at all here'}], 'disappeared'),
            ([{'native': 'principles.md', 'quote': 'text that is not in the principles'}], 'disappeared'),
            ([{'exclude': 'not-relevant', 'reason': 'This reason is long enough to pass the length rule.'}], 'unjustified'),
            ([{'exclude': 'non-normative', 'reason': 'too short'}], 'unjustified'),
            ([{'exclude': 'non-normative', 'reason': 'x', 'gate': 'tdd/red-green-report'}], 'invalid semantic overlay disposition'),
            ([{'same': 'r-0000000000000000'}], 'invalid same-rule reference'),
        ]
        for targets, pattern in cases:
            with self.subTest(targets=targets):
                self.expect(lambda o: self.rule(o).update(map=targets), pattern)

    def test_same_rule_cannot_reference_itself_or_chain(self):
        self.expect(lambda o: self.rule(o).update(map=[{'same': self.rule(o)['id']}]), 'invalid same-rule reference')
        def chain(o):
            chained = next(r for f in o['files'] for r in f['rules'] if any('same' in t for t in r['map']))
            self.rule(o)['map'] = [{'same': chained['id']}]
        self.expect(chain, 'invalid same-rule reference')

    def test_deleted_or_duplicated_native_text_fails(self):
        path = self.root / 'native/principles.md'
        text = path.read_text()
        quote = 'Avoid a new framework for a one-off task.'
        path.write_text(text.replace(quote, ''))
        with self.assertRaisesRegex(verifier.IntegrityError, 'native text for semantic overlay disappeared'):
            self.check()
        path.write_text(text + '\n' + quote + '\n')
        with self.assertRaisesRegex(verifier.IntegrityError, 'native text for semantic overlay disappeared'):
            self.check()

    def test_stale_generated_document_fails(self):
        overlay = self.overlay()
        self.rule(overlay)['map'].append({'gate': 'tdd/red-green-report'})
        self.save(overlay, regenerate_marker=False)
        with self.assertRaisesRegex(verifier.IntegrityError, 'generated semantic overlay document is stale'):
            self.check()

    def test_npm_relocated_gitignore_is_still_read(self):
        (self.root / 'upstream/.gitignore').rename(self.root / 'upstream/.npmignore')
        self.assertEqual(self.check()['rules'], 328)
