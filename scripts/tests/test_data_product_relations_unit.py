"""Subjects do not become models by substring, version inference or app backing."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_pipeline.product_relations import resolve, subject_index


class SubjectResolution(unittest.TestCase):
    def setUp(self):
        self.index = subject_index(
            [{'product_id': 'product:acme:desk', 'name': 'Acme Desk'},
             {'product_id': 'product:acme:shared', 'name': 'Shared'},
             {'product_id': 'product:acme:zh', 'name': '中文产品'}],
            [{'model_id': 'model:acme:core', 'name': 'Core 3.5'},
             {'model_id': 'model:acme:shared', 'name': 'Shared'}],
            [{'alias': 'Acme Core', 'model_id': 'model:acme:core'}])

    def test_exact_names_ids_and_recorded_aliases(self):
        for name in ['ACME-DESK', 'Acme Desk', 'product:acme:desk']:
            self.assertEqual(resolve(self.index, [name]), ('product', 'product:acme:desk'))
        self.assertEqual(resolve(self.index, ['Acme Core']), ('model', 'model:acme:core'))
        self.assertEqual(resolve(self.index, ['中文产品']), ('product', 'product:acme:zh'))

    def test_no_guessing_or_collisions(self):
        for names in [[], ['Shared'], ['Core'], ['Core 3.6'], ['Acme Desk and Core 3.5'],
                      ['Acme Desk', 'Core 3.5'], ['Acme Desk', 'unregistered name']]:
            self.assertIsNone(resolve(self.index, names), names)
