"""Topics and the search index: the parts that need neither a model nor a server."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_pipeline import embedding, market_measures, ontology_schema, search_index, topic_mining  # noqa: E402


def claim(post, handle, option, day="2026-10-01"):
    return {"id": post, "handle": handle, "option": option, "views": 10,
            "published_at": f"{day}T00:00:00+00:00", "object": "accountant", "claim": "x"}


def topic(claims, options=("a", "b"), checks=None):
    return {"id": "topic:replacement:accountant:00000000", "question_type": "replacement",
            "object": "accountant", "anchor": None, "question": {"en": "Will AI replace most accountants?", "zh-CN": "AI 会取代大多数会计吗？"},
            "options": [{"key": k, "en": k, "zh-CN": k} for k in options],
            "checks": checks or {name: True for name in topic_mining.CHECKS}, "claims": claims}


class TopicStanding(unittest.TestCase):
    def test_every_claim_on_one_answer_is_one_sided(self):
        found = topic_mining.describe(topic([claim("1", "ann", "a"), claim("2", "bob", "a")]))
        self.assertEqual(found["status"], "one_sided")
        self.assertEqual([o["accounts"] for o in found["options"]], [2, 0])

    def test_two_argued_answers_make_it_open_even_with_a_third_unargued(self):
        found = topic_mining.describe(topic([claim("1", "ann", "a"), claim("2", "bob", "b")], options=("a", "b", "c")))
        self.assertEqual(found["status"], "open")

    def test_the_same_account_twice_is_counted_once(self):
        found = topic_mining.describe(topic([claim("1", "ann", "a"), claim("2", "ann", "a", day="2026-10-02")]))
        self.assertEqual((found["accounts"], found["posts"], found["days"]), (1, 2, ["2026-10-01", "2026-10-02"]))

    def test_a_failed_check_or_a_single_answer_fails(self):
        checks = {**{name: True for name in topic_mining.CHECKS}, "specific": False}
        self.assertEqual(topic_mining.describe(topic([claim("1", "ann", "a")], checks=checks))["status"], "fails")
        self.assertEqual(topic_mining.describe(topic([claim("1", "ann", "a")], options=("a",)))["status"], "fails")

    def test_an_id_follows_the_identity_not_the_wording(self):
        one = topic_mining.topic_id("replacement", "prompt engineer")
        self.assertEqual(one, topic_mining.topic_id("replacement", "prompt engineer"))
        self.assertNotEqual(one, topic_mining.topic_id("viability", "prompt engineer"))
        self.assertTrue(one.startswith("topic:replacement:prompt-engineer:"))
        self.assertEqual(topic_mining.option_id(one, "b"), one + "#b")

    def test_claims_are_read_by_calendar_quarter(self):
        self.assertEqual([topic_mining.quarter(d) for d in ("2026-09-30", "2026-10-01", "2026-12-31", "2027-01-01")],
                         ["2026-Q3", "2026-Q4", "2026-Q4", "2027-Q1"])
        found = topic_mining.describe(topic([claim("1", "ann", "a", day="2026-09-30"), claim("2", "bob", "b"),
                                             claim("3", "cat", "b", day="2026-10-02")]))
        self.assertEqual(found["by_quarter"], {"2026-Q3": {"a": 1}, "2026-Q4": {"b": 2}})

    def test_the_standard_comes_from_the_schema(self):
        self.assertEqual((topic_mining.MIN_OPTIONS, topic_mining.MAX_OPTIONS), (2, 4))
        self.assertEqual(set(topic_mining.QUESTION_TYPES), {"replacement", "viability"})


class Rewording(unittest.TestCase):
    def test_a_rewording_is_taken_only_when_every_answer_came_back_short(self):
        found = topic(claims=[])
        good = {"options": [{"key": "a", "en": "Far fewer accountants are needed", "zh-CN": "会计需求大幅减少"},
                            {"key": "b", "en": "Accountants stay, doing different work", "zh-CN": "会计还在，工作变了"}]}
        self.assertEqual(set(topic_mining.reworded(found, good)), {"a", "b"})
        missing = {"options": good["options"][:1]}
        long = {"options": [good["options"][0], {"key": "b", "zh-CN": "太长", "en": " ".join(["word"] * 20)}]}
        one_language = {"options": [good["options"][0], {"key": "b", "en": "Accountants stay"}]}
        for bad in (missing, long, one_language, None):
            self.assertIsNone(topic_mining.reworded(found, bad))

    def test_the_writing_rule_names_the_limit_from_the_schema(self):
        self.assertIn(f"at most {topic_mining.OPTION_MAX_WORDS} English words", topic_mining.OPTION_STYLE)
        self.assertIn(topic_mining.OPTION_STYLE, topic_mining.PLACE_PROMPT)
        self.assertIn(topic_mining.OPTION_STYLE, topic_mining.REWORD_PROMPT)


class ReadersVotes(unittest.TestCase):
    DOC = {"running_quarter": "2026-Q4", "votes": [
        {"topic_id": "t1", "quarter": "2026-Q4", "option_id": "t1#a", "votes": 3},
        {"topic_id": "t1", "quarter": "2026-Q4", "option_id": "t1#b", "votes": 2},
        {"topic_id": "t2", "quarter": "2026-Q3", "option_id": "t2#a", "votes": 40},
    ]}

    def test_only_the_running_quarter_says_what_readers_ask_about_now(self):
        self.assertEqual(topic_mining.votes_by_topic(self.DOC), {"t1": 5})

    def test_no_file_means_no_votes(self):
        self.assertEqual(topic_mining.votes_by_topic(None), {})


class Shortlist(unittest.TestCase):
    def test_nearest_ranks_by_likeness_and_respects_the_floor(self):
        vectors = {"same": [1.0, 0.0], "near": [0.8, 0.6], "far": [0.0, 1.0]}
        self.assertEqual([key for key, _ in embedding.nearest([1.0, 0.0], vectors, 2)], ["same", "near"])
        self.assertEqual([key for key, _ in embedding.nearest([1.0, 0.0], vectors, 3, floor=0.5)], ["same", "near"])


class MarketMeasurements(unittest.TestCase):
    def test_a_pick_counts_only_when_it_was_on_the_shortlist(self):
        answer = {"entries": [{"id": "oaw:market:games", "why": "counts game revenue"},
                              {"id": "oaw:market:invented", "why": "not offered"},
                              {"id": "oaw:market:games", "why": "again"}, "noise"]}
        self.assertEqual(market_measures.choose(answer, {"oaw:market:games", "oaw:market:software"}),
                         [{"id": "oaw:market:games", "why": "counts game revenue"}])
        self.assertEqual(market_measures.choose(None, {"oaw:market:games"}), [])

    def test_at_most_two_entries_are_kept(self):
        offered = {f"oaw:market:{n}" for n in "abc"}
        answer = {"entries": [{"id": i} for i in sorted(offered)]}
        self.assertEqual(len(market_measures.choose(answer, offered)), 2)

    def test_the_kind_is_current_and_is_the_one_routing_leaves_out(self):
        self.assertIn(market_measures.KIND, ontology_schema.current_term_ids("event_kind"))
        # Routing reads the same rule, so the kind it leaves out cannot drift from this one.
        routing = (Path(__file__).resolve().parents[1] / "data_pipeline" / "event_routing.py").read_text()
        self.assertIn('rule("rule:market-measurement-moves-no-level")["expression"]["kind"]', routing)
        self.assertFalse(ontology_schema.term("event_kind", market_measures.KIND)["can_demonstrate_capability"])


class SearchDocuments(unittest.TestCase):
    def test_a_document_id_holds_only_what_the_index_accepts(self):
        self.assertEqual(search_index.doc_id("oaw:occupation:13-2011.00"), "oaw_occupation_13-2011_00")

    def test_a_topic_document_carries_both_languages_and_its_real_id(self):
        described = topic_mining.describe(topic([claim("1", "ann", "a")]))
        doc = search_index.topic_documents([described])[0]
        self.assertEqual(doc["key"], described["id"])
        self.assertEqual((doc["title"], doc["title_zh"]), ("Will AI replace most accountants?", "AI 会取代大多数会计吗？"))
        self.assertEqual(doc["status"], "one_sided")


if __name__ == "__main__":
    unittest.main()
