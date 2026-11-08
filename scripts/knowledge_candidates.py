"""Read-only, private previews of operator-selected collection leads.

This module deliberately has no GitHub write, model or database integration.
A preview is unapproved prose, never evidence of a capability or a publication.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
import unicodedata
from pathlib import Path

from editorial_inputs import ROOT, EditorialInputError, verify_inputs

REPOSITORY = 'feyn-machines/surviagi-knowledge'
TEXT_FIELDS = ('question', 'summary', 'value', 'conditions', 'gap')


class CandidateError(ValueError):
    """A local selection is incomplete, ambiguous or unsafe."""


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def _digest(value):
    return hashlib.sha256(_canonical(value)).hexdigest()


def _text(value, name, limit=2000):
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or any(unicodedata.category(c) == 'Cc' and c != '\n' for c in value)):
        raise CandidateError(f'{name} must be nonempty plain text (max {limit} characters)')
    return value.strip()


def _question(value):
    # Case/width/whitespace only: paraphrases and punctuation differences require
    # an explicit operator choice rather than a guessed semantic equivalence.
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def _private_path(path, root):
    path = Path(os.path.abspath(root / path))
    try:
        relative = path.relative_to(root / 'data')
    except ValueError as exc:
        raise CandidateError('local files must be under data/') from exc
    current = root / 'data'
    for part in ('', *relative.parts):
        current = current / part
        if current.is_symlink():
            raise CandidateError('local paths must not use symbolic links')
    return path


def read_private_json(path, *, root=ROOT):
    root = Path(root).resolve()
    path = _private_path(Path(path), root)
    if not path.is_file() or stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise CandidateError('local input must be a private regular file (0600)')
    if path.stat().st_size > 10 * 1024 * 1024:
        raise CandidateError('local input exceeds 10 MiB')
    return json.loads(path.read_text(encoding='utf-8'))


def _issues(rows):
    if not isinstance(rows, list):
        raise CandidateError('issue snapshot must be an array')
    result = {}
    for row in rows:
        if (not isinstance(row, dict) or type(row.get('number')) is not int or row['number'] <= 0
                or row.get('state') not in ('OPEN', 'CLOSED') or not isinstance(row.get('body'), str)):
            raise CandidateError('malformed issue snapshot record')
        _text(row.get('title'), 'issue title', 256)
        if row['number'] in result:
            raise CandidateError('duplicate issue number in snapshot')
        result[row['number']] = row
    return result


def _associate(candidate, issue_number, issues):
    if issue_number is not None and (type(issue_number) is not int or issue_number not in issues):
        raise CandidateError('unknown issue number; refresh the snapshot')
    recorded = [n for n, issue in issues.items() if candidate['marker'] in issue['body']]
    if len(recorded) > 1:
        raise CandidateError('ambiguous candidate marker in multiple issues')
    if recorded:
        if issue_number is not None and recorded != [issue_number]:
            raise CandidateError('candidate is already recorded in a different issue')
        return 'already_recorded', recorded[0]
    if issue_number is not None:
        return 'append_to_issue', issue_number
    matches = [n for n, issue in issues.items() if _question(issue['title']) == _question(candidate['question'])]
    if len(matches) > 1:
        raise CandidateError('ambiguous question title; specify issue_number')
    return ('append_to_issue', matches[0]) if matches else ('new_issue', None)


def _save(result, root):
    directory = _private_path(Path('data/knowledge-candidates/previews'), root)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory.parent, 0o700)
    os.chmod(directory, 0o700)
    target = directory / (result['preview_id'] + '.json')
    encoded = _canonical(result) + b'\n'
    if target.exists() or target.is_symlink():
        if (target.is_symlink() or not target.is_file() or target.read_bytes() != encoded
                or stat.S_IMODE(target.stat().st_mode) != 0o600):
            raise CandidateError('existing preview has conflicting content or permissions')
        return
    fd, name = tempfile.mkstemp(prefix='.preview-', dir=directory)
    temporary = Path(name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError:
            if (target.is_symlink() or not target.is_file() or target.read_bytes() != encoded
                    or stat.S_IMODE(target.stat().st_mode) != 0o600):
                raise CandidateError('racing preview has conflicting content')
    finally:
        temporary.unlink(missing_ok=True)


def preview(input_id, selections, issues, *, root=ROOT):
    root = Path(root).resolve()
    # Also check ancestors that the older input-manifest verifier does not check.
    _private_path(Path('data/editorial/inputs'), root)
    manifest = verify_inputs(input_id, root=root)
    available = set()
    for source in manifest['sources']:
        record = json.loads((root / source['path']).read_text(encoding='utf-8'))
        posts = (record['posts'] if record['version'] == 'official-x-collection-1'
                 else [post for job in record.get('jobs', record.get('queries', [])) for post in job['posts']])
        for post in posts:
            if isinstance(post, dict) and re.fullmatch(r'[0-9]+', str(post.get('id', ''))):
                available.add(str(post['id']))
    issue_map = _issues(issues)
    if not isinstance(selections, list):
        raise CandidateError('selections must be an array')
    grouped = {}
    for row in selections:
        if not isinstance(row, dict) or type(row.get('include')) is not bool:
            raise CandidateError('each selection requires a boolean include')
        if not row['include']:
            continue
        if set(row) - {*TEXT_FIELDS, 'include', 'source_ids', 'issue_number'}:
            raise CandidateError('unknown selection fields; original material must stay in the collection')
        candidate = {name: _text(row.get(name), name, 256 if name == 'question' else 2000) for name in TEXT_FIELDS}
        source_ids = row.get('source_ids')
        if (not isinstance(source_ids, list) or not source_ids
                or any(not isinstance(s, str) or s not in available for s in source_ids)):
            raise CandidateError('source_ids must name existing numeric posts in the pinned collections')
        key = _question(candidate['question'])
        candidate['question'] = key
        candidate['source_ids'] = sorted(set(source_ids))
        candidate['issue_number'] = row.get('issue_number')
        previous = grouped.get(key)
        if previous is not None:
            if any(previous[name] != candidate[name] for name in (*TEXT_FIELDS, 'issue_number')):
                raise CandidateError('conflicting selections for the same question')
            candidate['source_ids'] = sorted(set(previous['source_ids'] + source_ids))
        grouped[key] = candidate
    unique = {}
    for candidate in grouped.values():
        issue_number = candidate.pop('issue_number')
        identity = _digest({'question': _question(candidate['question']), 'source_ids': candidate['source_ids']})
        candidate['candidate_id'] = 'lead-' + identity
        candidate['marker'] = '<!-- surviagi-candidate:' + candidate['candidate_id'] + ' -->'
        candidate['source_urls'] = ['https://x.com/i/status/' + s for s in candidate['source_ids']]
        candidate['action'], candidate['issue_number'] = _associate(candidate, issue_number, issue_map)
        unique[identity] = candidate
    # Ensure no collection changed between verification and extraction.
    verify_inputs(input_id, root=root)
    payload = {'version': 'knowledge-candidate-preview-1', 'repository': REPOSITORY,
               'input_id': input_id, 'input_sha256': manifest['input_sha256'],
               'issues_sha256': _digest(sorted(issues, key=lambda x: x['number'])),
               'status': 'local_unapproved_preview',
               'candidates': sorted(unique.values(), key=lambda x: x['candidate_id'])}
    result = {**payload, 'preview_id': 'preview-' + _digest(payload)}
    _save(result, root)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description='Prepare a local, unapproved candidate preview; never writes GitHub.')
    parser.add_argument('--input-id', required=True)
    parser.add_argument('--selections', required=True, help='private JSON array under data/')
    parser.add_argument('--issues', required=True, help='private gh issue snapshot JSON array under data/')
    args = parser.parse_args(argv)
    try:
        result = preview(args.input_id, read_private_json(args.selections), read_private_json(args.issues))
    except (CandidateError, EditorialInputError, OSError, ValueError, TypeError) as exc:
        # Do not echo untrusted source text or raw JSON diagnostics.
        parser.exit(1, f'Candidate preview refused ({type(exc).__name__}); check private inputs and permissions.\n')
    print(json.dumps({'preview_id': result['preview_id'], 'count': len(result['candidates']),
                      'status': result['status']}))
    return 0
