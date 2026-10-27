#!/usr/bin/env python3
"""Workspace-owned exact-session pstack state. JSON stdin/stdout; no native DB access."""
import contextlib
import fcntl
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

STATE_DIR = '.pstack-session-state'
LIMIT = 32768
NAME = r'(?:pstack|poteto[-_ ]mode)'
# Bounded conversational preambles, not arbitrary substring matching in reports.
PREFIX = (r"(?:(?:ok(?:ay)?|well|so|now|please|hey|actually)[,.!]?\s+)*"
          r"(?:I[’']m\s+(?:annoyed|frustrated|confused|ready)[,.!]?\s+)?"
          r"(?:(?:can|could|would)\s+you\s+(?:please\s+)?|(?:let[’']s|lets)\s+)?")


class ModeError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise ModeError(code, message)


def keys(value, expected, code='INVALID_REQUEST'):
    require(type(value) is dict and set(value) == set(expected), code, 'Unexpected or missing fields')


def string(value, maximum=1024):
    return type(value) is str and 0 < len(value) <= maximum and not any(ord(c) < 32 for c in value)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


NATIVE_HEADER = "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:"
EXPLICIT_REFERENCE = re.compile(r'^(?:/(?:skill\s+)?|\$)(pstack|poteto[-_]mode)(?=$|\s)(.*)$', re.I | re.S)


def unwrap_native(text):
    if not text.startswith(NATIVE_HEADER):
        return text
    wrapped = re.fullmatch(re.escape(NATIVE_HEADER) +
                           r'\n(?P<refs>(?:- (?:pstack|poteto-mode)(?: \(SKILL\.md: [^\n)]+\))?\n)+)'
                           r'\nUser request:\n{1,2}(?P<body>.+)', text, re.S)
    if not wrapped:
        return None
    names = [line.split(' (SKILL.md:', 1)[0][2:] for line in wrapped['refs'].splitlines()]
    body = wrapped['body'].strip()
    reference = EXPLICIT_REFERENCE.match(body)
    if len(set(names)) != len(names) or not reference or reference[1].lower().replace('_', '-') not in names:
        return None
    return body


def parse_command(text):
    text = unwrap_native(text.strip())
    if text is None:
        return None
    slash = EXPLICIT_REFERENCE.match(text)
    if slash:
        args = slash[2].strip()
        if re.match(r'status(?=$|[\s,.!;])', args, re.I):
            return None
        if re.match(r'off(?=$|[\s,.!;])', args, re.I):
            return False
        # "stop the leak" and "disable retries" are tasks, not mode controls.
        if re.fullmatch(r'(?:disable|stop|stop-using-pstack)[.!]?', args, re.I):
            return False
        return True
    boundary = r'(?=$|[\s,.!;])'
    # Bare task verbs may concern pstack itself; require an immediate mode exit.
    exit_tail = (r'(?:\s+mode)?(?:\s+(?:now|please))*'
                 r'(?:\s*(?:$|[,.!;])|\s+and\s+)')
    off = PREFIX + (r'(?:(?:stop(?: using)?|disable|exit|quit|deactivate)\s+(?:native\s+)?' + NAME +
                    r'|turn\s+off\s+' + NAME + r'|turn\s+' + NAME + r'\s+off|' + NAME + r'\s+off)' + exit_tail)
    next_turn = r'\s+for (?:the )?(?:next|this) (?:question|answer|response|turn|session)'
    negative_use = (PREFIX + r'(?:do not use|don[’\x27]t use)\s+(?:native\s+)?' + NAME +
                    r'(?:' + exit_tail + '|' + next_turn + exit_tail + ')')
    if re.match(off, text, re.I) or re.match(negative_use, text, re.I):
        return False
    on = PREFIX + (r'(?:(?:use|enable|activate|switch to|keep using)\s+(?:native\s+)?' + NAME +
                   r'|turn\s+on\s+' + NAME + r'|turn\s+' + NAME + r'\s+on)' + boundary)
    return True if re.match(on, text, re.I) else None


def command(event):
    desired = parse_command(event['text'])
    if desired is not None and not event['trusted']:
        require(not event['missingProvenance'], 'UNQUALIFIED_PROVENANCE',
                'Mode change requires native provenance.kind=external_user; this row is unqualified')
        return None
    return desired


def validate_request(req):
    require(type(req) is dict and req.get('action') in ('status', 'turn'), 'INVALID_REQUEST', 'Expected status or turn')
    keys(req, ['action', 'workspace', 'identity'] + (['event'] if req['action'] == 'turn' else []))
    require(string(req['workspace'], 8192) and os.path.isabs(req['workspace']), 'INVALID_REQUEST', 'Workspace must be absolute')
    keys(req['identity'], ['userId', 'sessionKey', 'sessionId'])
    require(all(string(v) for v in req['identity'].values()), 'INVALID_REQUEST', 'Native exact-session identity required')
    normalized = None
    if req['action'] == 'turn':
        event = req['event']
        require(type(event) is dict, 'INVALID_REQUEST', 'Native message projection required')
        keys(event, ['role', 'content', 'timestamp', '__openclaw'] + (['provenance'] if 'provenance' in event else []))
        meta = event['__openclaw']
        keys(meta, ['id', 'seq', 'senderIdentity'])
        require(string(event['role']) and string(meta['id']), 'INVALID_REQUEST', 'Native message identity required')
        require(type(event['timestamp']) is int and 0 < event['timestamp'] < 2**53,
                'INVALID_REQUEST', 'Native message timestamp required')
        require(type(meta['seq']) is int and 0 <= meta['seq'] < 2**53,
                'INVALID_REQUEST', 'Native transcript sequence required')
        sender = meta['senderIdentity']
        require(type(sender) is dict and string(sender.get('id')), 'INVALID_REQUEST', 'Native sender identity required')
        content = event['content']
        if type(content) is list:
            require(all(type(part) is dict and part.get('type') == 'text' and type(part.get('text')) is str
                        for part in content), 'INVALID_REQUEST', 'Only native text content is supported')
            content = '\n'.join(part['text'] for part in content)
        require(type(content) is str, 'INVALID_REQUEST', 'Invalid native message content')
        try:
            content_bytes = len(content.encode('utf-8'))
        except UnicodeError:
            raise ModeError('INVALID_REQUEST', 'Invalid native message text encoding')
        require(content_bytes <= 262144, 'INVALID_REQUEST', 'Invalid native message content')
        provenance = event.get('provenance')
        human_sender = (event['role'] == 'user' and sender.get('type') == 'profile'
                        and sender['id'] == req['identity']['userId'])
        normalized = {'id': meta['id'], 'seq': meta['seq'], 'timestampMs': event['timestamp'], 'text': content,
                      'trusted': human_sender and type(provenance) is dict
                                 and provenance.get('kind') == 'external_user',
                      'missingProvenance': human_sender and (provenance is None or
                                           (type(provenance) is dict and not provenance.get('kind')))}
    workspace = str(Path(req['workspace']).resolve(strict=True))
    require(os.path.isdir(workspace), 'INVALID_REQUEST', 'Workspace is not a directory')
    identity = dict(req['identity'], workspace=workspace)
    digest = hashlib.sha256(canonical(identity).encode()).hexdigest()
    return workspace, identity, digest, normalized


def safe_stat(fd, directory=False):
    info = os.fstat(fd)
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and info.st_uid == os.getuid() and not info.st_mode & 0o077
            and (directory or info.st_nlink == 1), 'UNSAFE_PATH', 'State must be private, owned and a single-link regular file (or directory)')
    return info


@contextlib.contextmanager
def state_directory(workspace, create):
    # All state operations are directory-fd relative: path replacement cannot redirect them.
    with contextlib.ExitStack() as stack:
        root = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, root)
        if create:
            try:
                os.mkdir(STATE_DIR, mode=0o700, dir_fd=root)
            except FileExistsError:
                pass
        try:
            fd = os.open(STATE_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        except FileNotFoundError:
            yield None, None
            return
        stack.callback(os.close, fd)
        info = safe_stat(fd, directory=True)

        def current():
            current_info = os.stat(STATE_DIR, dir_fd=root, follow_symlinks=False)
            require((current_info.st_dev, current_info.st_ino) == (info.st_dev, info.st_ino),
                    'STATE_MOVED', 'State directory changed; re-observe before retry')
        yield fd, current


def read_state(fd, filename, identity):
    if fd is None:
        return None
    try:
        opened = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return None
    with os.fdopen(opened, 'rb') as source:
        inspected = safe_stat(source.fileno())
        data = source.read(LIMIT + 1)
    try:
        require(len(data) <= LIMIT, 'INVALID_STATE', 'Oversized session state')
        return decode_state(data, identity)
    except ModeError as error:
        if error.code == 'INVALID_STATE':
            error.inspected = (inspected.st_dev, inspected.st_ino)
        raise


def decode_state(data, identity):
    try:
        record = json.loads(data)
    except (ValueError, UnicodeError, RecursionError):
        raise ModeError('INVALID_STATE', 'Malformed session state')
    if type(record) is dict and 'identity' in record:
        require(record['identity'] == identity, 'IDENTITY_MISMATCH', 'Saved identity does not match this session')
    keys(record, ['version', 'identity', 'active', 'revision', 'lastEvent'], 'INVALID_STATE')
    require(type(record['version']) is int and record['version'] in (1, 2) and record['identity'] == identity
            and type(record['active']) is bool and type(record['revision']) is int and record['revision'] > 0,
            'INVALID_STATE', 'Invalid session state identity/version/value')
    last = record['lastEvent']
    keys(last, ['id', 'timestampMs', 'digest'] + (['seq'] if record['version'] == 2 else []), 'INVALID_STATE')
    if record['version'] == 1:
        # In-memory compatibility only: status must never rewrite legacy records.
        last = dict(last, seq=0)
        record = dict(record, lastEvent=last)
    require(string(last['id']) and type(last['timestampMs']) is int and 0 < last['timestampMs'] < 2**53
            and type(last['seq']) is int and 0 <= last['seq'] < 2**53
            and type(last['digest']) is str and re.fullmatch('[a-f0-9]{64}', last['digest']),
            'INVALID_STATE', 'Invalid saved event')
    return record


def verify_recovery_target(fd, filename, token):
    opened = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(opened, 'rb') as source:
        info = safe_stat(source.fileno())
        require((info.st_dev, info.st_ino) == token, 'STATE_MOVED', 'Corrupt record changed during opt-out recovery')


def result(record, effect):
    return {'ok': True, 'active': record['active'] if record else False,
            'revision': record['revision'] if record else 0, 'effect': effect}


def process_request(req):
    workspace, identity, digest, event = validate_request(req)
    desired = command(event) if event is not None else None
    filename = digest + '.json'
    with state_directory(workspace, desired is not None) as (fd, current):
        if desired is None:
            return result(read_state(fd, filename, identity), 'observed')
        lockname = digest + '.lock'
        lockfd = os.open(lockname, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                         0o600, dir_fd=fd)
        with os.fdopen(lockfd, 'r+b') as lock:
            lockinfo = safe_stat(lock.fileno())
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ModeError('BUSY', 'Another exact-session transition is active; observe then retry this event')
            recovered = False
            recovery_token = None
            try:
                record = read_state(fd, filename, identity)
            except ModeError as error:
                if desired is not False or error.code != 'INVALID_STATE' or not hasattr(error, 'inspected'):
                    raise
                # Only explicit human off may replace an inspected safe corrupt file.
                record = None
                recovered = True
                recovery_token = error.inspected
            stamp = {'id': event['id'], 'timestampMs': event['timestampMs'], 'seq': event['seq'],
                     'digest': hashlib.sha256(canonical(req['event']).encode()).hexdigest()}
            if record:
                last = record['lastEvent']
                if (stamp['timestampMs'], stamp['seq']) < (last['timestampMs'], last['seq']):
                    return result(record, 'stale-event')
                if stamp['id'] == last['id'] or (stamp['timestampMs'], stamp['seq']) == (last['timestampMs'], last['seq']):
                    require(stamp == last, 'EVENT_CONFLICT', 'Conflicting event identity/order; do not guess')
                    return result(record, 'duplicate')
            updated = {'version': 2, 'identity': identity, 'active': desired,
                       'revision': (record['revision'] if record else 0) + 1, 'lastEvent': stamp}
            current()
            named = os.stat(lockname, dir_fd=fd, follow_symlinks=False)
            require((named.st_dev, named.st_ino) == (lockinfo.st_dev, lockinfo.st_ino),
                    'STATE_MOVED', 'Session lock changed')
            temporary = digest + '.' + uuid.uuid4().hex + '.tmp'
            try:
                outfd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                0o600, dir_fd=fd)
                with os.fdopen(outfd, 'wb') as output:
                    output.write((canonical(updated) + '\n').encode())
                    output.flush()
                    os.fsync(output.fileno())
                current()
                if recovery_token is not None:
                    verify_recovery_target(fd, filename, recovery_token)
                os.replace(temporary, filename, src_dir_fd=fd, dst_dir_fd=fd)
                os.fsync(fd)
                current()
            finally:
                try:
                    os.unlink(temporary, dir_fd=fd)
                except FileNotFoundError:
                    pass
            return result(read_state(fd, filename, identity),
                          'recovered-off' if recovered else ('activated' if desired else 'deactivated'))


def main():
    try:
        data = sys.stdin.buffer.read(1048577)
        require(len(data) <= 1048576, 'INVALID_REQUEST', 'Oversized request')
        try:
            req = json.loads(data)
        except (ValueError, UnicodeError, RecursionError):
            raise ModeError('INVALID_REQUEST', 'Expected one JSON request on stdin')
        output = process_request(req)
        code = 0
    except (ModeError, OSError) as error:
        error_code = getattr(error, 'code', 'IO_ERROR')
        if isinstance(error, OSError) and error.errno in (errno.ELOOP, errno.ENOTDIR):
            error_code = 'UNSAFE_PATH'
        output = {'ok': False, 'active': None, 'code': error_code, 'error': str(error)}
        code = 1
    print(json.dumps(output, sort_keys=True))
    return code


if __name__ == '__main__':
    sys.exit(main())
