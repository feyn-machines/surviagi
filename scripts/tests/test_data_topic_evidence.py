"""Updates under a topic's answers: the parts that need neither the judge nor the database."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_pipeline import ontology_schema, topic_evidence, topic_mining  # noqa: E402


class Shortlisting(unittest.TestCase):
    VECTORS = {"near": [1.0, 0.0], "also": [0.9, 0.436], "far": [0.0, 1.0]}

    def test_only_topics_above_the_floor_are_put_to_the_judge(self):
        self.assertEqual(topic_evidence.shortlist([1.0, 0.0], self.VECTORS, set()), ["near", "also"])

    def test_a_topic_already_judged_is_not_asked_again(self):
        self.assertEqual(topic_evidence.shortlist([1.0, 0.0], self.VECTORS, {"near"}), ["also"])

    def test_no_more_topics_than_the_rule_allows(self):
        many = {f"t{n}": [1.0, 0.0] for n in range(10)}
        self.assertEqual(len(topic_evidence.shortlist([1.0, 0.0], many, set())), topic_evidence.TOPICS_PER_UPDATE)


class Asking(unittest.TestCase):
    def test_each_answer_is_asked_on_its_own_with_its_question(self):
        topic = {"id": "topic:replacement:accountant:0f5f53ad", "question": {"en": "Will AI replace most accountants?"},
                 "options": [{"key": "a", "en": "Yes."}, {"key": "b", "en": "No."}]}
        asked = topic_evidence.answers(topic)
        self.assertEqual([o.id for o in asked], [topic_mining.option_id(topic["id"], k) for k in "ab"])
        self.assertEqual(asked[1].label, "Question: Will AI replace most accountants? Answer: No.")

    def test_the_judge_and_the_threshold_come_from_the_rule(self):
        rule = ontology_schema.rule("rule:updates-weigh-on-answers-by-judgment")["expression"]
        self.assertEqual((topic_evidence.JUDGE, topic_evidence.WEIGHS_ABOVE), (rule["judge"], rule["weighs_above"]))
        self.assertEqual(topic_evidence.JUDGE, "typesafe")

    def test_both_ways_are_asked_and_being_in_the_same_field_is_not_enough(self):
        self.assertEqual(set(topic_evidence.QUESTIONS), set(ontology_schema.term_ids("answer_evidence_sign")))
        for question, _ in topic_evidence.QUESTIONS.values():
            self.assertIn("same field", question)


class Weighing(unittest.TestCase):
    def test_only_what_the_judge_was_sure_of_is_kept(self):
        kept = topic_evidence.weigh({"supports": {"a": 0.9, "b": 0.6, "c": 0.2}, "contradicts": {"a": 0.1, "c": 0.7}})
        self.assertEqual(kept, {"a": ("supports", 0.9), "c": ("contradicts", 0.7)})

    def test_for_and_against_the_same_answer_keeps_the_surer_side(self):
        self.assertEqual(topic_evidence.weigh({"supports": {"a": 0.7}, "contradicts": {"a": 0.8}}),
                         {"a": ("contradicts", 0.8)})

    def test_a_refutation_of_one_answer_is_not_support_for_another(self):
        # "The model beat twelve licensed accountants" refutes "AI cannot do the work" and proves nothing else.
        kept = topic_evidence.weigh({"supports": {"fewer": 0.4, "cannot": 0.02}, "contradicts": {"fewer": 0.1, "cannot": 0.91}})
        self.assertEqual(kept, {"cannot": ("contradicts", 0.91)})


if __name__ == "__main__":
    unittest.main()
