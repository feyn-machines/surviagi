"""Classing updates with no kind in a real PostgreSQL: the class is written beside the
update and leaves it unchanged, a read update is not asked again, a failed call stays
pending, and what the extractor wrote itself costs no call. The model is a stand-in."""
import json
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from psycopg import errors, sql

from data_pipeline import deepseek, event_unresolved
from data_pipeline.db import connect, migrate
from data_pipeline.event_extraction import NO_KIND_REASON
from test_data_event_extraction_integration import seed_org_registry

SHA = "a" * 64
CFG = {"api_key": "test", "model": "deepseek-flash", "base_url": "http://127.0.0.1:9"}
ANSWERS = {"Only a link.": {"class": "no_readable_content"}, "A teaser.": {"class": "teaser"},
           "Odd one.": {"class": "other"}}


def fake_chat(messages, cfg, timeout=120, usage=None):
    reason = json.loads(messages[1]["content"])["reason"]
    if reason == "Call fails.":
        raise deepseek.DeepSeekError("down")
    return ANSWERS[reason]


class Classing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = "openaiwill_event_unresolved_test_" + uuid.uuid4().hex
        with connect() as admin:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(cls.database)))
        cls.addClassCleanup(cls.remove_database)
        cls.conn = connect(cls.database)
        cls.addClassCleanup(cls.conn.close)
        migrate(cls.conn)
        seed_org_registry(cls.conn)
        cls.conn.execute("""INSERT INTO extraction_runs (run_id, collection_run_ids, model, prompt_sha256, params,
                              started_at, finished_at, status, run_sha256, candidate_count, event_count)
                            VALUES ('run', '[]', 'm', %s, '{}', now(), now(), 'completed', %s, 0, 0)""", (SHA, SHA))

    @classmethod
    def remove_database(cls):
        with connect() as admin:
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(cls.database)))

    def setUp(self):
        for table in ("event_unresolved_classes", "event_unresolved_runs", "extracted_events"):
            self.conn.execute(sql.SQL("DELETE FROM {}").format(sql.Identifier(table)))

    def add(self, event_id, reason, kind=None):
        self.conn.execute("""
            INSERT INTO extracted_events (event_id, dedup_key, kind, kind_vocabulary, unresolved_reason, title, summary,
                                          primary_org_id, occurrence_status, first_extraction_run_id, record_sha256)
            VALUES (%s, %s, %s, 'event_kind-2.0.0', %s, 't', 's', 'org:openai', 'occurred', 'run', %s)
        """, (event_id, event_id, kind, reason, SHA))

    def classify(self, chat=fake_chat):
        with mock.patch.object(deepseek, "chat", chat), mock.patch.object(event_unresolved.time, "sleep"):
            return event_unresolved.classify(self.conn, CFG)

    def stored(self):
        return {r["event_id"]: r["unresolved_class"]
                for r in self.conn.execute("SELECT event_id, unresolved_class FROM event_unresolved_classes").fetchall()}

    def test_the_whole_pass(self):
        self.add("ev-link", "Only a link.")
        self.add("ev-teaser", "A teaser.")
        self.add("ev-odd", "Odd one.")
        self.add("ev-fault", NO_KIND_REASON)
        self.add("ev-down", "Call fails.")
        self.add("ev-kind", None, kind="product_launch")
        before = self.conn.execute("SELECT * FROM extracted_events ORDER BY event_id").fetchall()

        first = self.classify()
        self.assertEqual({k: first[k] for k in ("unresolved", "classed", "no_term", "failed")},
                         {"unresolved": 5, "classed": 3, "no_term": 1, "failed": 1})
        self.assertEqual(first["by_class"], {"no_readable_content": 1, "teaser": 1, "extractor_fault": 1})
        self.assertEqual(self.stored(), {"ev-link": "no_readable_content", "ev-teaser": "teaser", "ev-odd": None,
                                         "ev-fault": "extractor_fault"})
        self.assertEqual(self.conn.execute("SELECT * FROM extracted_events ORDER BY event_id").fetchall(), before)
        run = self.conn.execute("SELECT model, prompt_sha256 FROM event_unresolved_runs WHERE run_id = %s",
                                (first["run_id"],)).fetchone()
        self.assertEqual(run, {"model": "deepseek-flash", "prompt_sha256": event_unresolved.prompt_sha256()})

        # Only the update whose call failed is asked again.
        asked = []

        def again(messages, cfg, timeout=120, usage=None):
            asked.append(json.loads(messages[1]["content"])["reason"])
            return {"class": "not_an_update"}
        second = self.classify(again)
        self.assertEqual(asked, ["Call fails."])
        self.assertEqual(second["classed"], 1)
        self.assertEqual(self.stored()["ev-down"], "not_an_update")

        # Nothing left: no run, no model configuration needed.
        with mock.patch.object(deepseek, "config_from_env", side_effect=AssertionError("asked for a key")):
            third = event_unresolved.classify(self.conn)
        self.assertEqual((third["run_id"], third["unresolved"]), (None, 0))

    def test_a_pass_of_only_extractor_faults_needs_no_key(self):
        self.add("ev-only-fault", NO_KIND_REASON)
        with mock.patch.object(deepseek, "config_from_env", side_effect=AssertionError("asked for a key")):
            result = event_unresolved.classify(self.conn)
        self.assertEqual(result["by_class"], {"extractor_fault": 1})
        run = self.conn.execute("SELECT model FROM event_unresolved_runs WHERE run_id = %s", (result["run_id"],)).fetchone()
        self.assertIsNone(run["model"])

    def test_the_database_refuses_a_class_outside_the_vocabulary(self):
        self.add("ev-refused", "Refused.")
        self.conn.execute("INSERT INTO event_unresolved_runs (run_id, prompt_sha256, counts) VALUES ('r', 'x', '{}')")
        with self.assertRaises(errors.CheckViolation):
            self.conn.execute("INSERT INTO event_unresolved_classes VALUES ('ev-refused', 'other', 'r')")


if __name__ == "__main__":
    unittest.main()
