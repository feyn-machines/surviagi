"""Local candidate workflow with synthetic collection fixtures only."""
import copy
import json
import stat
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import editorial_inputs
try:
    import knowledge_candidates as candidates
except ModuleNotFoundError:
    candidates = None


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for role, folder in [('official', 'official-x'), ('panel', 'panel')]:
            path = self.root / 'data/collection' / folder / 'run.json'
            path.parent.mkdir(parents=True)
            record = {
                'version': 'crawler-run-1', 'source': 'x', 'synthetic': False,
                'ok': True, 'status': 'queries_exhausted',
                'started_at': '2026-11-08T00:00:00Z', 'finished_at': '2026-11-08T01:00:00Z',
                'publication_window': {'start': '2026-11-07T12:00:00Z', 'end': '2026-11-08T00:00:00Z'},
                'total': 2, 'jobs': [{'status': 'search_ended', 'posts': [
                    {'id': '101', 'text': 'PRIVATE ORIGINAL TEXT'},
                    {'id': '102', 'text': 'OTHER RAW MATERIAL'},
                ]}],
            }
            path.write_text(json.dumps(record))
            path.chmod(0o600)
        self.manifest, _ = editorial_inputs.prepare_inputs(
            'data/collection/official-x/run.json', 'data/collection/panel/run.json', root=self.root)
        self.selection = {'include': True, 'question': 'Can AI do task A?',
                          'summary': 'A reported attempt needs checking.', 'value': 'A concrete deliverable.',
                          'conditions': 'Tool version unknown.', 'gap': 'No independent check.',
                          'source_ids': ['102', '101', '101']}

    def preview(self, selections=None, issues=None):
        self.assertIsNotNone(candidates, 'candidate preview implementation is missing')
        return candidates.preview(self.manifest['input_id'],
                                  selections if selections is not None else [self.selection],
                                  issues or [], root=self.root)

    def test_filters_and_deduplicates_without_copying_originals(self):
        result = self.preview([self.selection, {'include': False}])
        self.assertEqual(len(result['candidates']), 1)
        row = result['candidates'][0]
        self.assertEqual(row['source_ids'], ['101', '102'])
        self.assertEqual(row['action'], 'new_issue')
        self.assertEqual(row['source_urls'], ['https://x.com/i/status/101', 'https://x.com/i/status/102'])
        self.assertNotIn('PRIVATE ORIGINAL TEXT', json.dumps(result))
        self.assertNotIn('OTHER RAW MATERIAL', json.dumps(result))

    def test_repeat_and_input_order_have_one_private_preview(self):
        first = self.preview([self.selection, copy.deepcopy(self.selection)])
        reverse = copy.deepcopy(self.selection)
        reverse['source_ids'].reverse()
        second = self.preview([reverse])
        self.assertEqual(first, second)
        path = self.root / 'data/knowledge-candidates/previews' / (first['preview_id'] + '.json')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(len(list(path.parent.glob('*.json'))), 1)

    def test_exact_title_prefers_existing_issue_including_closed(self):
        result = self.preview(issues=[{'number': 7, 'title': 'ＣＡＮ AI do task A？', 'body': '', 'state': 'CLOSED'}])
        row = result['candidates'][0]
        self.assertEqual((row['action'], row['issue_number']), ('append_to_issue', 7))

    def test_explicit_association_and_ambiguity(self):
        issues = [{'number': n, 'title': self.selection['question'], 'body': '', 'state': 'OPEN'} for n in [7, 8]]
        self.preview()  # Ensure a missing implementation fails as an assertion.
        with self.assertRaisesRegex(candidates.CandidateError, 'ambiguous'):
            self.preview(issues=issues)
        chosen = {**self.selection, 'issue_number': 8}
        row = self.preview([chosen], issues)['candidates'][0]
        self.assertEqual(row['issue_number'], 8)
        with self.assertRaisesRegex(candidates.CandidateError, 'unknown issue'):
            self.preview([{**chosen, 'issue_number': 99}], issues)

    def test_existing_marker_suppresses_republication_across_title_change(self):
        row = self.preview()['candidates'][0]
        result = self.preview(issues=[{'number': 9, 'title': 'Renamed question',
                                       'body': row['marker'], 'state': 'OPEN'}])
        self.assertEqual(result['candidates'][0]['action'], 'already_recorded')
        self.assertEqual(result['candidates'][0]['issue_number'], 9)

    def test_rejects_unknown_sources_empty_value_and_unknown_fields(self):
        self.preview()
        for change in [{'source_ids': ['999']}, {'value': ''}, {'raw_text': 'do not copy'},
                       {'include': 'yes'}, {'source_ids': []}, {'question': '\x00bad'}]:
            with self.subTest(change=change), self.assertRaises(candidates.CandidateError):
                self.preview([{**self.selection, **change}])

    def test_rejects_changed_collection(self):
        self.preview()
        path = self.root / 'data/collection/panel/run.json'
        path.write_text(path.read_text().replace('PRIVATE ORIGINAL TEXT', 'CHANGED'))
        with self.assertRaises(editorial_inputs.EditorialInputError):
            self.preview()

    def test_rejects_output_symlinks_and_tampering(self):
        result = self.preview()
        path = self.root / 'data/knowledge-candidates/previews' / (result['preview_id'] + '.json')
        path.write_text('{}')
        with self.assertRaisesRegex(candidates.CandidateError, 'conflicting'):
            self.preview()
        path.unlink()
        directory = path.parent
        directory.rmdir()
        outside = self.root / 'outside'
        outside.mkdir()
        directory.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(candidates.CandidateError, 'symbolic'):
            self.preview()
        self.assertEqual(list(outside.iterdir()), [])

    def test_duplicate_issue_numbers_and_conflicting_selection_are_refused(self):
        self.preview()
        with self.assertRaises(candidates.CandidateError):
            self.preview(issues=[{'number': 1, 'title': 'A', 'body': '', 'state': 'OPEN'}] * 2)
        with self.assertRaisesRegex(candidates.CandidateError, 'conflicting'):
            self.preview([self.selection, {**self.selection, 'summary': 'Different summary'}])

    def test_same_question_combines_sources_before_association(self):
        a = {**self.selection, 'source_ids': ['101']}
        b = {**self.selection, 'source_ids': ['102']}
        result = self.preview([a, b])
        self.assertEqual(len(result['candidates']), 1)
        self.assertEqual(result['candidates'][0]['source_ids'], ['101', '102'])
        self.assertEqual(result, self.preview([b, a]))

    def test_private_input_reader_rejects_public_files_and_symlinks(self):
        self.preview()
        path = self.root / 'data/selection.json'
        path.write_text('[]')
        path.chmod(0o644)
        with self.assertRaises(candidates.CandidateError):
            candidates.read_private_json(path, root=self.root)
        path.chmod(0o600)
        self.assertEqual(candidates.read_private_json(path, root=self.root), [])
        link = self.root / 'data/link.json'
        link.symlink_to(path)
        with self.assertRaises(candidates.CandidateError):
            candidates.read_private_json(link, root=self.root)
        outside = self.root / 'outside.json'
        outside.write_text('[]')
        outside.chmod(0o600)
        with self.assertRaises(candidates.CandidateError):
            candidates.read_private_json(outside, root=self.root)

    def test_cli_prints_only_metadata_and_refuses_publish_arguments(self):
        self.preview()
        script_dir = self.root / 'scripts'
        script_dir.mkdir()
        source_dir = Path(__file__).resolve().parents[1]
        for name in ['knowledge_candidates.py', 'knowledge-candidates.py', 'editorial_inputs.py']:
            shutil.copyfile(source_dir / name, script_dir / name)
        for name, content in [('selections', [self.selection]), ('issues', [])]:
            path = self.root / 'data' / (name + '.json')
            path.write_text(json.dumps(content))
            path.chmod(0o600)
        command = [sys.executable, str(script_dir / 'knowledge-candidates.py'),
                   '--input-id', self.manifest['input_id'],
                   '--selections', 'data/selections.json', '--issues', 'data/issues.json']
        result = subprocess.run(command, cwd=self.root, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(set(output), {'preview_id', 'count', 'status'})
        self.assertEqual(output['count'], 1)
        denied = subprocess.run(command + ['--publish'], cwd=self.root, text=True, capture_output=True)
        self.assertNotEqual(denied.returncode, 0)
        (self.root / 'data/selections.json').write_text('PRIVATE INVALID JSON')
        invalid = subprocess.run(command, cwd=self.root, text=True, capture_output=True)
        self.assertNotEqual(invalid.returncode, 0)
        self.assertNotIn('PRIVATE INVALID JSON', invalid.stdout + invalid.stderr)


if __name__ == '__main__':
    unittest.main()
