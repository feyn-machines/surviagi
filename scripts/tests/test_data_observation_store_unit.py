"""Offline unit tests for the observation run document and its rows.

Dependency-free on purpose (no psycopg, no network): this file runs under
`pnpm data:test:unit` with the system python.
"""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_pipeline.observation_extraction import EXTRACTOR  # noqa: E402
from data_pipeline.observation_store import build_rows, build_run  # noqa: E402

TEXT = ("We moved month-end close to the agent. Reconciliation now takes 2 days instead of 6, "
        "but a person still signs off every entry.")
META = {"model": "deepseek-flash", "prompt_sha256": "p" * 64, "params": {"limit": None},
        "window": None, "started_at": "2026-11-03T00:00:00+00:00", "finished_at": "2026-11-03T00:01:00+00:00"}


def post(sid, text=TEXT, handle="jane_cpa"):
    return {"source_id": sid, "handle": handle, "account_key": f"x:{handle}",
            "url": f"https://x.com/{handle}/status/{sid}",
            "published_at": datetime(2026, 10, 1, 12, tzinfo=timezone.utc), "text": text}


def item(source_ids=("1",), **overrides):
    base = {"source_ids": list(source_ids), "actor": "jane_cpa", "actor_role": "practitioner", "subject": "Claude",
            "work": "accounting", "task": "Reconcile accounts at month-end close.",
            "evidence_type": "own_use", "outcome": "partly", "direction": "ai_takes_on",
            "facts": [{"value": "2", "unit": "days", "what": "time to reconcile", "baseline": "6 days",
                       "quote": "Reconciliation now takes 2 days instead of 6"}],
            "conditions": None, "occurred_at": None, "quote": "We moved month-end close to the agent."}
    return {**base, **overrides}


class RunDocument(unittest.TestCase):
    def test_posts_of_a_failed_batch_are_not_counted_as_read(self):
        posts = [post(str(n)) for n in range(1, 6)]
        batches = [{"observations": [item()]}, {"observations": []}, {"observations": []}]
        doc = build_run(posts, batches, [{"batch": 2, "error": "timeout"}], 2, META)
        self.assertEqual(doc["read"], ["1", "2", "5"])
        self.assertEqual(doc["candidate_count"], 5)
        self.assertEqual(doc["extractor"], EXTRACTOR)
        self.assertEqual(doc["params"]["failed_batches"], [{"batch": 2, "error": "timeout"}])
        self.assertEqual(len(doc["observations"]), 1)


class Rows(unittest.TestCase):
    def rows(self, posts, items):
        return build_rows(build_run(posts, [{"observations": items}], [], 25, META), "observations-r1")

    def test_an_unstated_day_is_stored_as_null_though_the_id_uses_the_post_day(self):
        observations, sources, facts, readings, unquoted = self.rows([post("1")], [item()])
        row = observations[0]
        self.assertIsNone(row["occurred_on"])
        self.assertEqual(row["work_key"], "unmapped")
        self.assertEqual(row["announced_at"], datetime(2026, 10, 1, 12, tzinfo=timezone.utc))
        self.assertEqual(readings, [{"observation_id": row["observation_id"], "run_id": "observations-r1",
                                     "work": "accounting", "actor": "jane_cpa", "subject": "Claude"}])
        self.assertEqual(len(facts), 1)
        self.assertEqual((len(sources), unquoted), (1, 0))

    def test_a_stated_day_is_stored(self):
        observations, *_ = self.rows([post("1")], [item(occurred_at="2026-09-30T00:00:00Z")])
        self.assertEqual(observations[0]["occurred_on"], "2026-09-30")

    def test_a_second_post_is_a_source_only_with_words_checked_against_it(self):
        posts = [post("1"), post("2", text="Follow-up on our close: it now needs 3 people instead of 8."),
                 post("3", text="Our team agrees with all of this, it is a very good change for us.")]
        staff = {"value": "3", "unit": "people", "what": "staff on the close", "baseline": "8",
                 "quote": "it now needs 3 people instead of 8"}
        observations, sources, *_rest, unquoted = self.rows(
            posts, [item(source_ids=("1", "2", "3"), facts=[item()["facts"][0], staff])])
        self.assertEqual(observations[0]["source_ids"], ["1", "2"])
        self.assertEqual([s["quote"] for s in sources],
                         ["We moved month-end close to the agent.", "it now needs 3 people instead of 8"])
        self.assertEqual(unquoted, 1)

    def test_ids_of_sources_and_facts_are_stable(self):
        first = self.rows([post("1")], [item()])
        again = self.rows([post("1")], [item()])
        self.assertEqual([s["source_ref"] for s in first[1]], [s["source_ref"] for s in again[1]])
        self.assertEqual([f["fact_id"] for f in first[2]], [f["fact_id"] for f in again[2]])
        self.assertRegex(first[1][0]["source_ref"], r"^obs-src-[0-9a-f]{16}$")


if __name__ == "__main__":
    unittest.main()
