"""The class of an update with no kind: the prompt comes from the vocabulary, a model
can only pick a term of it, and what the extractor wrote itself needs no model."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_pipeline import event_extraction, event_unresolved, ontology_schema  # noqa: E402


class Prompt(unittest.TestCase):
    def test_every_term_a_model_may_pick_is_offered_with_its_definition(self):
        text = event_unresolved.prompt()
        for term in ontology_schema.current_term_ids(event_unresolved.VOCABULARY):
            if term == event_unresolved.FAULT:
                self.assertNotIn(term, text)
            else:
                self.assertIn(f"- {term}: {ontology_schema.term(event_unresolved.VOCABULARY, term)['definition']['en']}", text)


class Choose(unittest.TestCase):
    def test_a_term_is_kept(self):
        self.assertEqual(event_unresolved.choose({"class": "teaser"}), "teaser")

    def test_anything_else_is_no_term(self):
        for answer in ({"class": "other"}, {"class": None}, {}, None, {"class": event_unresolved.FAULT}):
            self.assertIsNone(event_unresolved.choose(answer), answer)


class Fault(unittest.TestCase):
    def test_the_reasons_the_extractor_writes_itself_are_faults(self):
        for raw in ({"kind": None}, {"kind": "misc"}):
            kind, reason = event_extraction._kind_of(raw)
            self.assertIsNone(kind)
            self.assertTrue(event_unresolved.is_fault(reason), reason)

    def test_a_reason_a_model_wrote_is_not(self):
        kind, reason = event_extraction._kind_of({"kind": None, "unresolved_reason": "Only a link."})
        self.assertIsNone(kind)
        self.assertFalse(event_unresolved.is_fault(reason))
        self.assertFalse(event_unresolved.is_fault(None))


if __name__ == "__main__":
    unittest.main()
