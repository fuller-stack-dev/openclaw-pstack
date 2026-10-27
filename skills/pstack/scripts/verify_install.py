#!/usr/bin/env python3
"""Read-only integrity and optional runtime-inventory verification."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys


class IntegrityError(ValueError):
    pass


def safe_relative(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or '..' in path.parts or str(path) != value:
        raise IntegrityError('unsafe manifest path: ' + value)
    return path


def verify_records(root, records, exact=False, modes=False, npm_ignores=False):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise IntegrityError('missing or linked root: ' + str(root))
    seen = set()
    total = 0
    expected_disk = set()
    relocated = []
    for record in records:
        rel = str(safe_relative(record['path']))
        if rel in seen:
            raise IntegrityError('duplicate manifest path: ' + rel)
        seen.add(rel)
        path = root / rel
        disk_rel = rel
        # npm/pacote renames .gitignore to .npmignore during managed installs.
        # Accept only that exact representation, with identical pinned bytes;
        # never repair files, ignore a missing record, or accept both copies.
        if npm_ignores and path.name == '.gitignore' and not path.exists() and not path.is_symlink():
            path = path.with_name('.npmignore')
            disk_rel = path.relative_to(root).as_posix()
            relocated.append({'source': rel, 'installed': disk_rel})
        if disk_rel in expected_disk:
            raise IntegrityError('duplicate installed path: ' + disk_rel)
        expected_disk.add(disk_rel)
        cursor = path
        while cursor != root:
            if cursor.is_symlink():
                raise IntegrityError('symlink in source path: ' + rel)
            cursor = cursor.parent
        if not path.is_file():
            raise IntegrityError('missing file: ' + rel)
        data = path.read_bytes()
        if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
            raise IntegrityError('content mismatch: ' + rel)
        if modes and oct(path.stat().st_mode & 0o777) != record['mode']:
            raise IntegrityError('mode mismatch: ' + rel)
        total += len(data)
    if exact:
        actual = set()
        for path in root.rglob('*'):
            if path.is_symlink():
                raise IntegrityError('unexpected symlink: ' + str(path))
            if path.is_file():
                actual.add(path.relative_to(root).as_posix())
        if actual != expected_disk:
            raise IntegrityError('unexpected source inventory: ' + repr(sorted(actual ^ expected_disk)))
    result = {'files': len(seen), 'bytes': total}
    if relocated:
        result['npmIgnoreRelocations'] = relocated
    return result


def headings(path):
    return re.findall(r'^## (.+)$', path.read_text(), re.M)


def verify_requirements(root, routes):
    """Text regression guard only; not evidence that a model executed the gates."""
    root = Path(root)
    expected = routes.get('requirementGuards', [])
    if len(expected) != len(set(expected)):
        raise IntegrityError('duplicate requirement route')
    directory = root / 'native/requirements'
    actual = {p.stem for p in directory.glob('*.json')}
    if actual != set(expected):
        raise IntegrityError('requirement inventory mismatch')
    gates = 0
    for route in expected:
        record = json.loads((directory / (route + '.json')).read_text())
        document = record.get('document')
        if record.get('schema') != 1 or record.get('route') != route or document not in ('workflows.md', 'playbooks.md'):
            raise IntegrityError('invalid requirement record: ' + route)
        if not record.get('upstream') or not record.get('gates'):
            raise IntegrityError('empty requirement record: ' + route)
        for source in record['upstream']:
            if not (root / 'upstream' / str(safe_relative(source))).is_file():
                raise IntegrityError('missing requirement provenance: ' + route)
        text = (root / 'native' / document).read_text()
        sections = dict(re.findall(r'^## ([^\n]+)\n(.*?)(?=^## |\Z)', text, re.M | re.S))
        section = sections.get(route, '')
        ids = set()
        for gate in record['gates']:
            identifier, fragment = gate.get('id'), gate.get('text')
            if not isinstance(identifier, str) or not identifier or identifier in ids or not isinstance(fragment, str) or not fragment.strip():
                raise IntegrityError('invalid requirement gate: ' + route)
            ids.add(identifier)
            if fragment not in section:
                raise IntegrityError('requirement text disappeared: ' + route + '/' + identifier)
            gates += 1
    return {'kind': 'text-regression-guard-only', 'routes': len(expected), 'gates': gates}


def verify_route_skills(root, routes):
    """Integrity/discovery only; no upstream semantic review or execution claim."""
    root = Path(root)
    manifest = json.loads((root / 'native/route-skills.json').read_text())
    names = routes['workflows'] + routes['playbooks']
    if manifest.get('schema') != 1 or manifest.get('kind') != 'manual-route-discovery-only':
        raise IntegrityError('invalid generated route manifest')
    expected = {'pstack-' + name + '/SKILL.md' for name in names}
    records = manifest['files']
    if {record['path'] for record in records} != expected or len(records) != len(names):
        raise IntegrityError('generated route inventory mismatch')
    # Ancestor checks include skills/routes; never follow a linked route root.
    result = verify_records(root.parent / 'routes', records, exact=True)
    expected_inputs = {'source-manifest.json', 'native/routes.json',
                       'native/workflows.md', 'native/playbooks.md'} | {
                           'native/requirements/' + name + '.json'
                           for name in routes.get('requirementGuards', [])}
    if {record['path'] for record in manifest['inputs']} != expected_inputs or len(manifest['inputs']) != len(expected_inputs):
        raise IntegrityError('generated route input inventory mismatch')
    verify_records(root, manifest['inputs'])
    for record in records:
        name = 'pstack-' + record['route']
        if record['path'] != name + '/SKILL.md':
            raise IntegrityError('generated route name mismatch')
        text = (root.parent / 'routes' / record['path']).read_text()
        if not text.startswith('---\nname: ' + name + '\n') or not all(
                field in text.split('---', 2)[1].splitlines()
                for field in ('user-invocable: true', 'disable-model-invocation: true')):
            raise IntegrityError('generated route invocation policy mismatch')
    return dict(result, kind='manual-discovery-only')


def verify_watch_pr(root, routes, native):
    """Template integrity only: no schedule, fixed read-only gh reads, documented exits. Not GitHub semantics."""
    root = Path(root)
    if 'watch-pr template' not in routes.get('nativeExtensions', []):
        raise IntegrityError('watch-pr guide entry missing from native extensions')
    listed = {record['path'] for record in native['files']}
    for rel in ('scripts/watch-pr.mjs', 'native/automation/watch-pr.md'):
        if rel not in listed:
            raise IntegrityError('watch-pr file missing from native manifest: ' + rel)
    if '](watch-pr.md)' not in (root / 'native/automation/README.md').read_text():
        raise IntegrityError('watch-pr guide not linked from the automation guide')
    script = (root / 'scripts/watch-pr.mjs').read_text()
    commands = re.search(r'^export const READ_ONLY_COMMANDS = (\[.*?\]);$', script, re.M)
    if not commands or json.loads(commands.group(1)) != [['auth', 'status'], ['api', 'graphql']]:
        raise IntegrityError('watch-pr gh command allowlist changed')
    queries = re.findall(r'^export const (?:WATCH|THREAD)_QUERY = `([^`]*)`;$', script, re.M)
    if len(queries) != 2 or any(not q.startswith('query(') or re.search(r'mutation|subscription', q, re.I) for q in queries):
        raise IntegrityError('watch-pr GraphQL document is not a fixed read-only query')
    if re.findall(r'^import .*child_process.*$', script, re.M) != ['import { spawn } from "node:child_process";'] or \
            script.count('child_process') != 1 or \
            re.findall(r'(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(', script) != ['spawn'] or \
            not re.search(r'^function gh\(executable, args, options\) \{\n  assertReadOnly\(args, options\.hostname\);$', script, re.M):
        raise IntegrityError('watch-pr starts a process outside the read-only gh guard')
    exits = re.search(r'^export const EXIT = Object\.freeze\(\{(.*?)\}\);$', script, re.M | re.S)
    codes = {int(code) for code in re.findall(r':\s*(\d+)', exits.group(1))} if exits else set()
    documented = {int(code) for code in re.findall(r'^\| (\d+) \|', (root / 'native/automation/watch-pr.md').read_text(), re.M)}
    if not codes or codes != documented:
        raise IntegrityError('watch-pr exit codes and guide disagree')
    return {'kind': 'user-installed-template', 'ghCommands': 2, 'queries': len(queries), 'exitCodes': len(codes)}


SCHEMA_KEYWORDS = {
    'object': {'type', 'description', 'additionalProperties', 'required', 'properties'},
    'array': {'type', 'description', 'items', 'minItems', 'maxItems'},
    'string': {'type', 'description', 'minLength', 'maxLength', 'enum', 'pattern'},
    'integer': {'type', 'description', 'minimum', 'maximum'},
    'boolean': {'type', 'description'},
}


def closed_schema(schema, path):
    kind = schema.get('type') if isinstance(schema, dict) else None
    if kind not in SCHEMA_KEYWORDS or set(schema) - SCHEMA_KEYWORDS[kind]:
        raise IntegrityError('unsupported output schema at ' + path)
    if kind == 'object':
        props = schema.get('properties')
        if schema.get('additionalProperties') is not False or not isinstance(props, dict) or \
                not set(schema.get('required', [None])) <= set(props):
            raise IntegrityError('open output schema at ' + path)
        for name, child in props.items():
            closed_schema(child, path + '.' + name)
    elif kind == 'array':
        if not isinstance(schema.get('minItems'), int) or not isinstance(schema.get('maxItems'), int):
            raise IntegrityError('unbounded output schema at ' + path)
        closed_schema(schema.get('items'), path + '[]')
    elif kind == 'string' and not ('enum' in schema or 'pattern' in schema or 'maxLength' in schema):
        raise IntegrityError('unbounded output schema at ' + path)
    elif kind == 'integer' and not ('minimum' in schema and 'maximum' in schema):
        raise IntegrityError('unbounded output schema at ' + path)


def verify_agents(root, source, routes):
    """Brief/contract integrity only; briefs stay agent-attested until a host profile capability exists."""
    root = Path(root)
    contracts = json.loads((root / 'native/agents/contracts.json').read_text())
    if contracts.get('schema') != 1 or contracts.get('kind') != 'agent-attested-brief-and-output-contracts':
        raise IntegrityError('invalid agent contracts')
    schemas = contracts['schemas']
    for name, schema in schemas.items():
        closed_schema(schema, name)
    if set(contracts['panelRoles']) != {'architect runners', 'arena runners', 'arena cross-judge pool', 'interrogate reviewers'}:
        raise IntegrityError('panel output contract coverage mismatch')
    hashes = {record['path']: record['sha256'] for record in source['files']}
    sections = {}
    for document in ('workflows.md', 'playbooks.md'):
        text = (root / 'native' / document).read_text()
        sections.update(dict(re.findall(r'^## ([^\n]+)\n(.*?)(?=^## |\Z)', text, re.M | re.S)))
    ids = [p['id'] for p in contracts['profiles']]
    if sorted(ids) != sorted(p.stem for p in (root / 'upstream/agents').glob('*.md')) or len(set(ids)) != len(ids):
        raise IntegrityError('agent brief inventory mismatch')
    used = set(contracts['panelRoles'].values())
    for profile in contracts['profiles']:
        name = profile['id']
        if hashes.get(profile['upstream']) != profile['upstreamSha256'] or profile['upstream'] != 'agents/' + name + '.md':
            raise IntegrityError('agent brief provenance mismatch: ' + name)
        brief = root / str(safe_relative(profile['instructionsFile']))
        if profile['outputSchema'] not in schemas or '`' + profile['outputSchema'] + '`' not in brief.read_text():
            raise IntegrityError('agent brief output contract mismatch: ' + name)
        used.add(profile['outputSchema'])
        for read in profile['requiredReads']:
            target, _, anchor = read.partition('#')
            if not (root / str(safe_relative(target))).is_file() or (anchor and anchor not in sections):
                raise IntegrityError('agent brief required read missing: ' + read)
        if profile['route'] not in routes['workflows'] or 'pstack_brief' not in sections[profile['route']] or name not in sections[profile['route']]:
            raise IntegrityError('agent brief not wired into route: ' + name)
    if used != set(schemas):
        raise IntegrityError('unused or missing output contract')
    # Host profiles for read-only controller roles: shipped instructions, file-editing and plugin tools denied.
    panel_ids = [p['id'] for p in contracts['panelProfiles']]
    if len(set(panel_ids + ids)) != len(panel_ids + ids):
        raise IntegrityError('duplicate profile id')
    for profile in contracts['panelProfiles']:
        if not (root / str(safe_relative(profile['instructionsFile']))).is_file():
            raise IntegrityError('panel profile instructions missing: ' + profile['id'])
        deny = profile['narrowTools']['deny']
        if any(tool not in deny for tool in ('write', 'edit', 'apply_patch', 'sessions_spawn', 'group:plugins')):
            raise IntegrityError('panel profile is not read-only: ' + profile['id'])
    return {'kind': 'agent-attested-briefs', 'profiles': len(ids), 'panelProfiles': len(panel_ids), 'panelRoles': len(contracts['panelRoles']), 'schemas': len(schemas)}


# Mirrors scripts/sync-overlay.mjs; tests prove both extract identical rules.
RULE_PATTERN = re.compile(r"\b(?:must(?:n['\u2019]t)?|required|never)\b", re.I | re.A)
EXCLUSIONS = ('non-normative', 'source-only-code', 'cursor-harness', 'guide-example')
NATIVE_DOC = re.compile(r'[a-z0-9-]+(?:/[a-z0-9-]+)*\.md')


def extract_rules(root, records):
    """Rule lines of pinned UTF-8 upstream files, in manifest and line order."""
    root = Path(root)
    result = []
    for record in records:
        path = root / 'upstream' / str(safe_relative(record['path']))
        if path.name == '.gitignore' and not path.exists() and not path.is_symlink():
            path = path.with_name('.npmignore')
        data = path.read_bytes()
        if b'\0' in data:
            continue
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            continue
        seen = {}
        rules = []
        for index, raw in enumerate(text.split('\n')):
            line = raw.rstrip(' \t\r')
            if not RULE_PATTERN.search(line):
                continue
            occurrence = seen.get(line, 0)
            seen[line] = occurrence + 1
            digest = hashlib.sha256((record['path'] + '\n' + str(occurrence) + '\n' + line).encode('utf-8')).hexdigest()
            rules.append({'id': 'r-' + digest[:16], 'line': index + 1, 'text': line})
        if rules:
            result.append({'path': record['path'], 'sha256': record['sha256'], 'rules': rules})
    return result


def verify_overlay(root, source):
    """Every upstream MUST/required/never line maps to a native target or a justified exclusion.

    Reviewed text coverage only; not evidence that a model followed any rule.
    """
    root = Path(root)
    overlay_bytes = (root / 'native/semantic-overlay.json').read_bytes()
    overlay = json.loads(overlay_bytes)
    if not isinstance(overlay, dict) or sorted(overlay) != ['extraction', 'files', 'kind', 'schema', 'upstreamCommit'] or \
            overlay['schema'] != 1 or overlay['kind'] != 'upstream-rule-overlay' or not isinstance(overlay['files'], list) or \
            not all(isinstance(f, dict) and sorted(f) == ['path', 'rules', 'sha256'] and isinstance(f['rules'], list) and
                    all(isinstance(r, dict) and sorted(r) == ['id', 'line', 'map'] for r in f['rules']) for f in overlay['files']):
        raise IntegrityError('invalid semantic overlay')
    if overlay.get('upstreamCommit') != source['commit']:
        raise IntegrityError('semantic overlay pins a different upstream commit')
    extracted = extract_rules(root, source['files'])
    reviewed = {file['path']: file for file in overlay['files']}
    if len(reviewed) != len(overlay['files']):
        raise IntegrityError('duplicate semantic overlay file')
    for file in extracted:
        entry = reviewed.get(file['path'])
        if entry is None:
            first = file['rules'][0]
            raise IntegrityError('unmapped upstream rule: %s:%d %s' % (file['path'], first['line'], first['id']))
        if entry.get('sha256') != file['sha256']:
            raise IntegrityError('upstream drift from semantic overlay: ' + file['path'])
        mapped = {rule['id']: rule for rule in entry.get('rules', [])}
        for rule in file['rules']:
            if rule['id'] not in mapped:
                raise IntegrityError('unmapped upstream rule: %s:%d %s' % (file['path'], rule['line'], rule['id']))
            if mapped[rule['id']].get('line') != rule['line']:
                raise IntegrityError('semantic overlay line drift: ' + rule['id'])
    if [(f['path'], [r['id'] for r in f['rules']]) for f in extracted] != \
            [(f['path'], [r['id'] for r in f.get('rules', [])]) for f in overlay['files']]:
        raise IntegrityError('stale or reordered semantic overlay entries')
    gates = {}
    for route in json.loads((root / 'native/routes.json').read_text())['requirementGuards']:
        record = json.loads((root / 'native/requirements' / (route + '.json')).read_text())
        gates[route] = {gate['id'] for gate in record['gates']}
    rules = {rule['id']: rule for file in overlay['files'] for rule in file['rules']}
    docs = {}
    counts = {'gate': 0, 'native': 0, 'same': 0, 'exclude': 0}
    for ident, rule in rules.items():
        targets = rule.get('map')
        if not isinstance(targets, list) or not targets:
            raise IntegrityError('unmapped upstream rule: ' + ident)
        for target in targets:
            fields = sorted(target) if isinstance(target, dict) else None
            if fields == ['gate']:
                route, _, gate = str(target['gate']).partition('/')
                if '/' in gate or gate not in gates.get(route, ()):
                    raise IntegrityError('semantic overlay names a missing gate: ' + str(target['gate']))
            elif fields == ['native', 'quote']:
                document, quote = target['native'], target['quote']
                if not isinstance(document, str) or not NATIVE_DOC.fullmatch(document) or document == 'semantic-overlay.md':
                    raise IntegrityError('semantic overlay names an invalid native document: ' + ident)
                if document not in docs:
                    path = root / 'native' / document
                    docs[document] = path.read_text() if path.is_file() and not path.is_symlink() else None
                if not isinstance(quote, str) or len(quote) < 12 or '\n' in quote or docs[document] is None or docs[document].count(quote) != 1:
                    raise IntegrityError('native text for semantic overlay disappeared: ' + ident)
            elif fields == ['exclude', 'reason']:
                reason = target['reason']
                if target['exclude'] not in EXCLUSIONS or not isinstance(reason, str) or len(reason.strip()) < 40 or '\n' in reason:
                    raise IntegrityError('unjustified semantic overlay exclusion: ' + ident)
            elif fields == ['same']:
                other = rules.get(target['same'])
                if other is None or target['same'] == ident or any(isinstance(t, dict) and 'same' in t for t in other.get('map') or []):
                    raise IntegrityError('invalid same-rule reference: ' + ident)
            else:
                raise IntegrityError('invalid semantic overlay disposition: ' + ident)
            counts[fields[0]] += 1
    marker = 'Overlay: `semantic-overlay.json` sha256 `%s`' % hashlib.sha256(overlay_bytes).hexdigest()
    if marker not in (root / 'native/semantic-overlay.md').read_text().split('\n'):
        raise IntegrityError('generated semantic overlay document is stale')
    return {'kind': 'reviewed-text-coverage', 'files': len(extracted), 'rules': len(rules),
            'gateTargets': counts['gate'], 'nativeTargets': counts['native'], 'sameTargets': counts['same'],
            'exclusions': counts['exclude']}


def verify(root, inventory=None):
    root = Path(root).absolute()
    manifest = json.loads((root / 'source-manifest.json').read_text())
    source = verify_records(root / 'upstream', manifest['files'], exact=True, npm_ignores=True)
    if source['files'] != manifest['fileCount']:
        raise IntegrityError('source manifest count mismatch')
    native = json.loads((root / 'native-manifest.json').read_text())
    native_result = verify_records(root, native['files'])
    names = {p.parent.name for p in (root / 'upstream/skills').glob('*/SKILL.md')}
    workflows = headings(root / 'native/workflows.md')
    principles = headings(root / 'native/principles.md')
    routes = json.loads((root / 'native/routes.json').read_text())
    if set(workflows + principles) != names or len(workflows + principles) != len(names):
        raise IntegrityError('native route coverage mismatch')
    if workflows != routes['workflows'] or principles != routes['principles']:
        raise IntegrityError('route index mismatch')
    if headings(root / 'native/playbooks.md') != routes['playbooks']:
        raise IntegrityError('playbook index mismatch')
    for record in native['files']:
        path = root / record['path']
        if path.suffix != '.md':
            continue
        for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
            if '://' not in target and not target.startswith('#'):
                resolved = (path.parent / target.split('#')[0]).resolve()
                if not resolved.is_relative_to(root.resolve()) or not resolved.exists():
                    raise IntegrityError('broken native reference: ' + target)
    requirements = verify_requirements(root, routes)
    route_skills = verify_route_skills(root, routes)
    agents = verify_agents(root, manifest, routes)
    overlay = verify_overlay(root, manifest)
    watch_pr = verify_watch_pr(root, routes, native)
    alias = root.parent / 'poteto-mode/SKILL.md'
    if not alias.is_file() or alias.is_symlink():
        raise IntegrityError('missing paired poteto-mode skill')
    if hashlib.sha256(alias.read_bytes()).hexdigest() != native['aliasSha256']:
        raise IntegrityError('alias content mismatch')
    loader = None
    if inventory is not None:
        loader = verify_inventory(inventory['skills'], inventory.get('baselineSkillNames', native['baselineSkillNames']), ['pstack-' + name for name in routes['workflows'] + routes['playbooks']])
    return {'ok': True, 'source': source, 'native': native_result,
            'sourceCommit': manifest['commit'], 'workflowRoutes': len(workflows),
            'principles': len(principles), 'playbooks': len(routes['playbooks']),
            'loader': loader, 'requirements': requirements, 'routeSkills': route_skills,
            'agents': agents, 'overlay': overlay, 'watchPr': watch_pr}


def verify_inventory(rows, baseline, route_names=()):
    by_name = {row['name']: row for row in rows}
    for name in ('pstack', 'poteto-mode'):
        row = by_name.get(name, {})
        if not (row.get('eligible') is True and row.get('modelVisible') is True and
                row.get('userInvocable') is False and row.get('commandVisible') is False):
            raise IntegrityError('native skill missing or unavailable: ' + name)
    if len(by_name) != len(rows):
        raise IntegrityError('duplicate loader name')
    for name in route_names:
        row = by_name.get(name, {})
        if not (row.get('eligible') is True and row.get('modelVisible') is False and
                row.get('userInvocable') is True and row.get('commandVisible') is True):
            raise IntegrityError('manual route skill missing or unavailable: ' + name)
    extra = set(by_name) - set(baseline) - {'pstack', 'poteto-mode'} - set(route_names)
    if extra:
        raise IntegrityError('unexpected new loader entries: ' + repr(sorted(extra)))
    missing = set(baseline) - set(by_name)
    if missing:
        raise IntegrityError('pre-existing skills missing: ' + repr(sorted(missing)))
    for row in rows:
        if '/pstack/upstream/' in row.get('filePath', ''):
            raise IntegrityError('source-only skill leaked into loader')
    return {'nativeEligible': ['pstack', 'poteto-mode'], 'sourceOnlyEntries': 0,
            'preExistingNamesPreserved': len(baseline), 'manualRouteSkills': len(route_names)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--inventory', type=Path)
    args = parser.parse_args()
    try:
        inventory = json.loads(args.inventory.read_text()) if args.inventory else None
        print(json.dumps(verify(args.root, inventory), indent=2))
    except (IntegrityError, OSError, KeyError, ValueError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
