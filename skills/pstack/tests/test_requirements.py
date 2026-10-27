"""Native-text regression guards ONLY: these do not prove workflow execution.

Every listed gate is checked in its own route section. Deleting each fragment in
private scratch must fail the same doctor guard, even if it exists elsewhere.
"""
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('requirement_verifier', ROOT / 'scripts/verify_install.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
ROUTES = json.loads((ROOT / 'native/routes.json').read_text())


class RequirementRegressionGuards(unittest.TestCase):
    def test_complete_inventory_and_explicit_nonbehavioral_label(self):
        result = verifier.verify_requirements(ROOT, ROUTES)
        self.assertEqual(result['routes'], len(ROUTES['requirementGuards']))
        self.assertEqual(result['kind'], 'text-regression-guard-only')
        self.assertGreaterEqual(result['gates'], result['routes'])

    def test_missing_or_unexpected_requirement_is_rejected(self):
        for expected in ([], ROUTES['requirementGuards'] + ['missing-route']):
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(verifier.IntegrityError, 'inventory mismatch'):
                    verifier.verify_requirements(ROOT, {'requirementGuards': expected})

    def test_duplicate_requirement_route_is_rejected(self):
        with self.assertRaisesRegex(verifier.IntegrityError, 'duplicate requirement route'):
            verifier.verify_requirements(ROOT, {'requirementGuards': ['how', 'how']})


class SharedRouteRuleGuards(unittest.TestCase):
    """Text guards for the shared rules the route gates link to; not behavioral proof."""

    def test_native_text_needs_no_unshipped_launcher_skill(self):
        # The workstream-launcher skill ships with neither pstack nor the host, so no native text may require it.
        for path in sorted((ROOT / 'native').rglob('*.md')):
            self.assertNotIn('workstream-launcher', path.read_text(), str(path))

    def test_shared_rules_linked_from_routes_exist(self):
        headings = {}
        for name in ('contract.md', 'delegation.md'):
            text = (ROOT / 'native' / name).read_text()
            headings[name] = {re.sub(r'[^a-z0-9 -]', '', h.lower()).replace(' ', '-') for h in re.findall(r'^#{2,3} (.+)$', text, re.M)}
        for name, anchor in (('delegation.md', 'launch-rules'), ('delegation.md', 'planner-call'),
                             ('delegation.md', 'delivering-a-routed-result'), ('contract.md', 'bounded-wait-handoff'),
                             ('contract.md', 'visible-handoff'), ('delegation.md', 'checking-facts-before-delivery'),
                             ('contract.md', 'plan-completion-check-after-a-handoff')):
            self.assertIn(anchor, headings[name], name + '#' + anchor)
        routes = (ROOT / 'native/workflows.md').read_text() + (ROOT / 'native/playbooks.md').read_text()
        for link in sorted(set(re.findall(r'\((contract|delegation)\.md#([a-z0-9-]+)\)', routes))):
            self.assertIn(link[1], headings[link[0] + '.md'], '%s.md#%s' % link)

    def test_shared_rules_keep_their_operative_text(self):
        delegation = (ROOT / 'native/delegation.md').read_text()
        contract = (ROOT / 'native/contract.md').read_text()
        for fragment in (
                'Only a call with `task` and `spawnSchema` returns `spawnArgs`; a role-only call returns a snapshot, which routes nothing.',
                'A phase that was planned but not spawned is unrouted',
                'deliver its collected text verbatim: quote it in full, attribute it on the line before the quote',
                'A parent rewrite never stands in for the routed result.',
                # 1.2.4 (P3-66): a file-edit deliverable quotes the child's report, and labels the file as the file.
                'When a routed child\'s deliverable is a file edit, such as unslop\'s rewrite of a README, the child\'s own text is its report. Quote that report verbatim as the child\'s text, attributed as above. Show the edited file or its diff separately, labelled with its path as the file',
                'never under the child\'s attribution',
                'collectors need explicit collection in the turn that spawned them, with `agents_wait` and `awaitResults: true`, because nothing wakes the parent when a collector finishes.',
                'These rules are self-contained; read no other launcher skill.',
                'A collector child (`collect: true`) is one-shot and refuses `sessions_send`, so never try a same-owner correction on it',
                'Deliver the original quote unchanged, followed by a section headed `Parent verification:`',
                'never deliver text you know is false without the `Parent verification:` section.',
                'Check the quote itself as well as its claims: it must be the child\'s text byte for byte. A collector result can carry that text as a JSON-encoded string; decode it before quoting, so `\\"` becomes `"` and `\\n` a line break. Backslash-escaped quotation marks, literal `\\n` sequences or HTML entities that the child\'s own text does not contain are a delivery defect: quote the decoded text instead, never a rewording.'):
            self.assertIn(fragment, delegation)
        for fragment in (
                'choose each routed child\'s completion mode when you spawn it, by whether this turn may end before the child finishes',
                'Any routed phase that can outlive one bounded wait is spawned without `collect`. Wait for it with a `subagents` wait whose timeout is no more than 60 seconds.',
                # 1.2.4: a collector never wakes its parent (openclaw#184290), so it is collected in the turn that spawned it.
                'A collector (`collect: true`, for example a child with an `outputSchema`, or a short fan-out whose results this turn needs) never wakes its parent: nothing resumes the session when it finishes, so a handoff on a pending collector leaves its result uncollected until the user writes again.',
                'Collect every collector before the turn ends with `agents_wait` and `awaitResults: true`, without `timeoutSeconds`; the child\'s own `runTimeoutSeconds` bounds that wait, so every collector has one.',
                'Never end a turn with a collector pending.',
                'Once a wait returns with an announcing child still pending, stop collecting in this turn',
                # 1.2.4: the handoff ends the reply, and is never sent with a message tool (investigation, r6).
                'The six lines end the reply: nothing follows them, and a status sentence never stands in for them.',
                'Never send the handoff with a message tool; it is the reply text or the acknowledgment.',
                'into the task-owned record and the reply in the [visible handoff](#visible-handoff) form',
                'The same handoff also goes into the visible reply under [visible handoff](#visible-handoff)',
                'put the whole handoff in its `acknowledgment` field, which is the visible waiting reply',
                'Its `message` field is private context for the resumed turn and never counts as the reply.',
                "When the handoff is not in the turn's reply text, an empty acknowledgment, an acknowledgment without these lines, or a handoff written only in `message` or the task record fails the handoff.",
                'The host shows the acknowledgment only for an otherwise-silent turn, so the yielding turn has no other reply text or message send; if the turn does write reply text, put the whole handoff in that text.',
                'Only a `sessions_yield` result with `status: "yielded"` delivers the acknowledgment; if it returns any other status, the turn did not yield, so write the handoff as the final reply text (after `deferred`, first read the results that arrived with it and yield again only if a child is still pending).',
                'Never set `waitFor` to wait for routed children; it only matters when the session calling `sessions_yield` is itself a subagent, paused for an incoming message from its requester.',
                'Every `sessions_yield` in a skill-guided route is a handoff and carries these lines, including a yield that only waits for the completion delivery of a child that has already finished; its `Pending:` line then says `finished, completion delivery pending`. A status sentence is not a handoff.',
                'Call `sessions_yield` with exactly two fields, `acknowledgment` and `message`:',
                'sessions_yield({ acknowledgment: "Handoff: <route>, <phase> pending\\nOwner: <this session key>\\nPending: …\\nDone so far: …\\nSnapshot: …\\nNext: …", message: "<private resume notes>" })',
                'The host\'s tool text "Unfinished subagents awaiting an incoming continuation must set waitFor" describes a spawned subagent pausing for a message from its requester. A route\'s parent session waiting for its own children is not that case: their completion events resume it without `waitFor`, so `waitFor` is never needed for your own children.',
                # 1.2.4 (P3-64): the guard covers every top-level pstack-mode yield, strips waitFor, and accepts list or bold labels.
                'In pstack mode the plugin checks every `sessions_yield` of a top-level session, whether or not a route is running. It removes `waitFor` and lets the yield through, adding a note to the yield\'s result.',
                'a `- ` list marker or bold label is accepted, a placeholder such as `UNUSED` or a status sentence is not. After a refusal, retry the same `sessions_yield` at once with the six lines',
                "When the run's saved plan, its `progress_card` checklist, still has unfinished steps",
                'After a handoff, answer that message with exactly `NO_REPLY` and nothing else: no tool call, wait, read, collection, delivery or other text.',
                'The pending announcing child is the external dependency the check names, the handoff already reported it, and the check itself says to end with only `NO_REPLY` when the previous reply reported it. The host still delivers the handoff reply, and collection resumes on the next turn.',
                'To keep the check from firing, before writing such a handoff you may replace the progress card the way its tool describes for blocked work: `markdown` naming the pending child, the owner and the resume condition, with `plan` omitted. Never mark a pending step completed, and restore the checklist when the work resumes.',
                "A message that arrives later in the same turn, such as the host's [plan-completion check](#plan-completion-check-after-a-handoff), does not reopen collection."):
            self.assertIn(fragment, contract)
        for line in ('Handoff: <route>, <phase> pending', 'Owner: <this session key>', 'Pending: <role> run <run ID>, session <child session key>',
                     'Done so far: ', 'Snapshot: ', 'Next: <the exact resume action'):
            self.assertIn(line, contract)

    def test_routes_that_hand_off_spawn_announcing_children_and_collect_collectors_in_turn(self):
        # 1.2.5 (P3-67): a handoff needs announcing children; a collector never wakes its parent, so no route hands one off.
        sections = {}
        for name in ('workflows.md', 'playbooks.md'):
            for route, body in re.findall(r'^## ([^\n]+)\n(.*?)(?=^## |\Z)', (ROOT / 'native' / name).read_text(), re.M | re.S):
                sections[route] = body
        generic = [route for route, body in sections.items() if 'For long routed phases' in body]
        self.assertGreaterEqual(len(generic), 20)
        for route in generic:
            for line in re.findall(r'^.*For long routed phases.*$', sections[route], re.M):
                self.assertIn('For long routed phases, spawn announcing children (without `collect`; a collector is collected in the turn that spawned it) and use a short ', line, route)
        collector = 'collected in this turn with `agents_wait` and `awaitResults: true`, never handed off.'
        for route in ('maintain-verification-skill', 'prototype', 'opening-a-pr', 'trace-forensics'):
            self.assertIn(collector, sections[route], route)
            self.assertRegex(sections[route], r'Spawn [^.]* as (?:an )?announcing child(?:ren)? \(without `collect`\)', route)
        # P3-72 C3, C5: the collector sentences of trace-forensics step 10 and session-pickup step 8.
        self.assertIn('A collector is never handed off: collect it in this turn with `agents_wait` and `awaitResults: true`.', sections['trace-forensics'])
        self.assertIn('Never end the pickup turn on a handoff while a collector is pending: nothing resumes the session when a collector finishes.', sections['session-pickup'])
        # The r6 maintain-verification-skill text forbade the collector rule outright.
        for route, body in sections.items():
            self.assertNotIn('unbounded `awaitResults`', body, route)
            self.assertNotIn('An unbounded in-turn wait', body, route)
        # prototype and opening-a-pr use the six-line handoff, like investigation.
        for route in ('prototype', 'opening-a-pr', 'investigation'):
            self.assertIn('the six lines (Handoff, Owner, Pending, Done so far, Snapshot, Next) go in the `sessions_yield` acknowledgment, or are the final reply text when the turn ends without a yield', sections[route], route)

    def test_every_line_that_hands_off_after_a_wait_names_announcing_children(self):
        # 1.2.5 (P3-73): not only the sections with the shared line. Any paragraph or list item in the native
        # guidance that hands off (or collects under the bounded-wait handoff) after a wait with work pending says
        # which children are handed off: announcing ones, never a collector. Fenced examples and the six-line
        # format rule describe the handoff's form, not which child it covers.
        hand = re.compile(r'\bhand(?:s|ed|ing)? (?:it |them )?off\b|\bhandoff\b', re.I)
        wait = re.compile(r'\bwait(?:s|ed|ing)?\b|\bcollect(?:s|ed|ing|ion)?\b', re.I)
        checked, missing = 0, []
        for path in sorted((ROOT / 'native').rglob('*.md')):
            text = re.sub(r'^```.*?^```', '', path.read_text(), flags=re.M | re.S)
            for block in re.split(r'\n(?=\s*(?:[-*]|\d+\.)\s)|\n\s*\n', text):
                line = ' '.join(block.split())
                if line.startswith('#') or '(Handoff, Owner, Pending, Done so far, Snapshot, Next)' in line:
                    continue
                if 'bounded-wait-handoff' in line or (hand.search(line) and wait.search(line) and 'pending' in line.lower()):
                    checked += 1
                    if 'announcing' not in line and 'collector' not in line:
                        missing.append(path.name + ': ' + line[:160])
        self.assertGreaterEqual(checked, 24)
        self.assertEqual(missing, [])
        # The four r6 residues the 1.2.5 review named, and the lines the widened check found.
        native = {name: (ROOT / 'native' / name).read_text() for name in ('workflows.md', 'playbooks.md', 'workflow-ledger.md', 'route-commands.md', 'contract.md')}
        for name, fragment in (('workflows.md', '6. Spawn how, why and the teaching child as announcing children (without `collect`)'),
                               ('playbooks.md', 'For long `drive` or `background` work, spawn routed children as announcing children (without `collect`; a collector is collected in the turn that spawned it'),
                               ('workflow-ledger.md', 'Wait for an\n  announcing child with the supported native bounded wait'),
                               ('route-commands.md', 'Hand off only announcing children, after a short bounded wait'),
                               ('playbooks.md', '9. Spawn the parser, the confirming judgment and any correction child as announcing children'),
                               ('playbooks.md', '6. Spawn each verifier and fixer as an announcing child'),
                               ('contract.md', 'Hand off only after one bounded wait has returned with an announcing child still pending.')):
            self.assertIn(fragment, native[name], name)

    def test_collector_bound_and_reply_order_are_shared_rules(self):
        contract = (ROOT / 'native/contract.md').read_text()
        # 1.2.5 (P3-68): a collector waited with awaitResults has no other bound, so every collector has one.
        for fragment in ("the child's own `runTimeoutSeconds` bounds that wait, so every collector has one. `pstack_route` gives a collector's spawn arguments `runTimeoutSeconds: 600` when they have none (or 0, which means no limit); give a collector you spawn without `pstack_route` the same bound.",
                         # P3-75: the bound runs from the child's start, and a structured-output phase cannot be announcing.
                         "The bound counts from the child's own start, so time a collector spends queued behind other children is extra.",
                         'A collector may ask for at most 900 seconds, and in pstack mode the plugin refuses a `sessions_spawn` collector that asks for more; a phase that may take longer is an announcing child.',
                         'A structured-output phase (`outputSchema`) is always a collector, so it has at most 900 seconds.',
                         # P2-1: the plugin never rewrites a spawn, so agents.run and controller children keep the host's bound.
                         "The plugin never changes a spawn's arguments, so a Code Mode `agents.run` child and a native controller's child keep the host's own bound.",
                         'In skill-guided routes only announcing children are handed off; a collector is collected in the turn that spawned it'):
            self.assertIn(fragment, contract)
        self.assertNotIn('large parallel fan-out', contract)
        self.assertNotIn('the plugin gives a `sessions_spawn` collector without one the same bound', contract)
        # 1.2.5 (P3-69): a route's required block precedes the six lines, which still end the reply.
        self.assertIn("A block that a route requires in every reply, such as show-me-your-work's Attention or opening-a-pr's readiness line, goes immediately before the six lines, never after them.", contract)
        workflows = (ROOT / 'native/workflows.md').read_text()
        playbooks = (ROOT / 'native/playbooks.md').read_text()
        self.assertIn('EVERY reply for a run that produced a trail ends with Attention, except a handoff reply: there Attention goes immediately before the six [visible handoff](contract.md#visible-handoff) lines, which end the reply.', workflows)
        self.assertIn('including each `sessions_yield` acknowledgment, where Attention comes before the six handoff lines.', workflows)
        self.assertIn('In a handoff reply, the readiness line comes immediately before the six [visible handoff](contract.md#visible-handoff) lines, which end the reply.', playbooks)

    def test_rejected_delegate_reports_rerun_as_fresh_children(self):
        # A collector child is one-shot; the shared brief rule must send a rejected report to a fresh child.
        briefs = (ROOT / 'native/agent-briefs.md').read_text()
        self.assertIn('Rerun it as a fresh child: plan the same role again', briefs)
        self.assertIn('A collector child is one-shot and refuses `sessions_send`, so that refusal never ends the phase.', briefs)
        delegate = (ROOT / 'native/agents/poteto-agent.md').read_text()
        self.assertIn('each entry exactly as its path appears under Required reads, with no `#` anchor or section note', delegate)


def route_guard(route):
    def test(self):
        record = json.loads((ROOT / 'native/requirements' / (route + '.json')).read_text())
        document = record['document']
        original = (ROOT / 'native' / document).read_text()
        section = re.search(r'^## ' + re.escape(route) + r'\n(.*?)(?=^## |\Z)', original, re.M | re.S)
        self.assertIsNotNone(section)
        with tempfile.TemporaryDirectory(prefix='pstack-requirement-') as temporary:
            root = Path(temporary)
            (root / 'native/requirements').mkdir(parents=True)
            (root / 'native/requirements' / (route + '.json')).write_text(json.dumps(record))
            for source in record['upstream']:
                target = root / 'upstream' / source
                target.parent.mkdir(parents=True, exist_ok=True)
                target.touch()
            path = root / 'native' / document
            path.write_text(original)
            self.assertEqual(verifier.verify_requirements(root, {'requirementGuards': [route]})['routes'], 1)
            for gate in record['gates']:
                with self.subTest(gate=gate['id']):
                    changed = section.group(1).replace(gate['text'], '')
                    # A copy in another route cannot satisfy the guard.
                    path.write_text(original[:section.start(1)] + changed + original[section.end(1):] + '\n## unrelated\n' + gate['text'])
                    with self.assertRaisesRegex(verifier.IntegrityError, 'requirement text disappeared'):
                        verifier.verify_requirements(root, {'requirementGuards': [route]})
    return test


for route in ROUTES['requirementGuards']:
    setattr(RequirementRegressionGuards, 'test_regression_guard_' + route.replace('-', '_'), route_guard(route))

if __name__ == '__main__':
    unittest.main()
