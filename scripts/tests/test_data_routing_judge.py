"""Event routing records the judge that actually answered (real PostgreSQL).

On 2026-10-16 TypeSafe answered HTTP 451 from this machine's region; every batch
fell back to the comparison model, and the 113 rows that run wrote all said
`judge: typesafe`. The same run's level reads failed too, and those rows - with
no level - would have blocked the retry, since evidence is inserted ON CONFLICT
DO NOTHING. And a run with undecided updates could not be closed at all: the
status it closes with was refused by the table's CHECK.

Routing runs here against one real update and one real activity with a fake
judge, inside a transaction that is rolled back: nothing is left behind.
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psycopg  # noqa: E402

from data_pipeline import event_routing  # noqa: E402
from data_pipeline.classify import Reading  # noqa: E402
from data_pipeline.db import connect, migrate  # noqa: E402
from data_pipeline.judge import JudgeError  # noqa: E402


class FakeClassifier:
    """Answers every option with `judge`, as Classifier does after a fallback."""
    judge = "deepseek"

    def __init__(self, *args):
        self.primary = mock.Mock(model="test-model")
        self.failed_batches = 0
        self.fallback_batches = 0

    def classify(self, state, options, progress=None):
        self.fallback_batches += self.judge == "deepseek"
        return [Reading(option.id, 0.9, self.judge) for option in options]


class RoutingJudgeAgainstPostgres(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = connect()
        migrate(cls.conn)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def route(self, judge, levels):
        """Route one update against one activity it has no evidence for; return what was written."""
        pair = self.conn.execute(
            """SELECT e.event_id, a.activity_id, a.ontology_version
                 FROM public.extracted_events e
                 CROSS JOIN LATERAL (SELECT activity_id, ontology_version FROM public.activity_evidence
                                      ORDER BY activity_id LIMIT 1) a
                WHERE NOT EXISTS (SELECT 1 FROM public.activity_evidence v
                                   WHERE v.event_id = e.event_id AND v.activity_id = a.activity_id)
                LIMIT 1""").fetchone()
        if pair is None:
            self.skipTest("no routed evidence in the local database to borrow an activity from")
        event = {"event_id": pair["event_id"], "title": "t", "summary": "s", "kind": "k",
                 "occurred_at": None, "org": "o"}
        option = event_routing.Option(pair["activity_id"], "an activity")
        written = []
        fake = type("Fake", (FakeClassifier,), {"judge": judge})
        try:
            with self.conn.transaction():
                with mock.patch.object(event_routing, "activity_options", return_value=[option]), \
                        mock.patch.object(event_routing, "events", return_value=[event]), \
                        mock.patch.object(event_routing, "Classifier", fake), \
                        mock.patch.object(event_routing, "read_levels", side_effect=levels), \
                        mock.patch.object(event_routing, "_state", return_value={}):
                    result = event_routing.run(self.conn, ontology_version=pair["ontology_version"], resume=False)
                written = self.conn.execute(
                    """SELECT judge, observed_level FROM public.activity_evidence
                        WHERE judgment_run_id = %s""", (result["run_id"],)).fetchall()
                result["status"] = self.conn.execute(
                    "SELECT status FROM public.judgment_runs WHERE run_id = %s", (result["run_id"],)).fetchone()["status"]
                raise psycopg.Rollback()
        except psycopg.Rollback:
            pass
        return result, written

    def test_a_fallback_reading_is_recorded_as_the_comparison_model(self):
        result, written = self.route("deepseek", lambda judge, event, hits: {
            hits[0][0]: {"level": 2, "tier": "T3"}})
        self.assertEqual([row["judge"] for row in written], ["deepseek"])
        self.assertEqual(result["fallback_batches"], 1)

    def test_a_jev_reading_is_recorded_as_jev(self):
        _, written = self.route("typesafe", lambda judge, event, hits: {
            hits[0][0]: {"level": 2, "tier": "T3"}})
        self.assertEqual([row["judge"] for row in written], ["typesafe"])

    def test_an_update_whose_levels_could_not_be_read_writes_nothing_and_stays_due(self):
        def fail(judge, event, hits):
            raise JudgeError("HTTP 451")
        result, written = self.route("typesafe", fail)
        self.assertEqual(written, [])
        self.assertEqual((result["evidence_rows"], result["events_incomplete"]), (0, 1))
        # The run closes as finished-with-failures; until migration 044 the CHECK refused that.
        self.assertEqual(result["status"], "completed_with_failures")


if __name__ == "__main__":
    unittest.main()
