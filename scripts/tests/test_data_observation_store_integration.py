"""Observation runs written into a real PostgreSQL: one transaction, idempotent,
an id fixed at its first write, and the posts a run read."""
import json
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from psycopg import sql

from data_pipeline.collection_store import ingest_run
from data_pipeline.db import connect, migrate
from data_pipeline.observation_extraction import EXTRACTOR
from data_pipeline.observation_store import build_run, ingest_observations, read_source_ids
from test_data_event_extraction_integration import crawler_run, seed_org_registry

LAUNCH = "Our support agent now answers 60% of tickets on its own, and a person reviews every refund."
FOLLOW_UP = "Update on the support agent: it now resolves 70% of tickets without a person."
META = {"model": "deepseek-flash", "prompt_sha256": "a" * 64, "params": {"limit": None},
        "window": {"start": "2026-09-08T00:00:00+00:00", "end": "2026-09-11T00:00:00+00:00"},
        "started_at": "2026-11-03T00:00:00+00:00", "finished_at": "2026-11-03T00:01:00+00:00"}


def post(sid, text):
    return {"source_id": sid, "handle": "OpenAI", "account_key": "x:openai",
            "url": f"https://x.com/OpenAI/status/{sid}",
            "published_at": datetime(2026, 9, 10, tzinfo=timezone.utc), "text": text}


def item(source_id, quote, fact_quote, value):
    return {"source_ids": [source_id], "actor": "OpenAI", "actor_role": "maker", "subject": "Support Agent",
            "work": "customer support", "task": "Answer customer tickets.", "evidence_type": "vendor_claim",
            "outcome": "succeeded", "direction": "ai_takes_on", "conditions": "a person reviews every refund",
            "facts": [{"value": value, "unit": "% of tickets", "what": "tickets answered alone", "baseline": None,
                       "quote": fact_quote}],
            "occurred_at": None, "quote": quote}


class ObservationStore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = "openaiwill_observation_store_test_" + uuid.uuid4().hex
        with connect() as admin:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(cls.database)))
        cls.addClassCleanup(cls.remove_database)
        cls.conn = connect(cls.database)
        cls.addClassCleanup(cls.conn.close)
        migrate(cls.conn)
        seed_org_registry(cls.conn)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "seed-run.json"
            path.write_text(json.dumps(crawler_run(["11", "12", "13"], "seed-run")))
            ingest_run(cls.conn, path)

    @classmethod
    def remove_database(cls):
        with connect() as admin:
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(cls.database)))

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def write(self, run_id, posts, batches, failures=(), batch_size=25):
        doc = build_run(posts, batches, list(failures), batch_size, META)
        path = self.tmp / f"{run_id}.json"
        path.write_text(json.dumps(doc, default=lambda value: value.isoformat()))
        return path

    def one(self, query, *params):
        return self.conn.execute(query, params).fetchone()

    def test_a_run_is_written_once_and_a_later_run_adds_to_the_same_observation(self):
        first_posts = [post("11", LAUNCH)]
        first = self.write("observations-a", first_posts, [{"observations": [
            item("11", "Our support agent now answers 60% of tickets on its own", "answers 60% of tickets", "60")]}])
        result = ingest_observations(self.conn, first)
        self.assertEqual((result["new_observations"], result["found_again"], result["read"]), (1, 0, 1))
        oid = self.one("SELECT observation_id FROM observation_sources WHERE source_id = '11'")["observation_id"]
        row = self.one("SELECT * FROM observations WHERE observation_id = %s", oid)
        self.assertEqual((row["actor_org_id"], row["actor_name"], row["work_key"]), ("org:openai", "OpenAI", "unmapped"))
        self.assertIsNone(row["occurred_on"])
        self.assertEqual(row["announced_at"], datetime(2026, 9, 10, tzinfo=timezone.utc))
        self.assertIsNotNone(row["observed_at"])
        self.assertEqual((row["extractor"], row["review_state"]), (EXTRACTOR, "machine_proposed"))

        self.assertTrue(ingest_observations(self.conn, first)["reused"])
        self.assertEqual(self.one("SELECT count(*) AS n FROM observation_facts WHERE observation_id = %s", oid)["n"], 1)

        later = self.write("observations-b", [post("12", FOLLOW_UP)], [{"observations": [
            item("12", "it now resolves 70% of tickets without a person", "resolves 70% of tickets", "70")]}])
        result = ingest_observations(self.conn, later)
        self.assertEqual((result["new_observations"], result["found_again"]), (0, 1))
        self.assertEqual(self.one("SELECT count(*) AS n FROM observation_sources WHERE observation_id = %s", oid)["n"], 2)
        self.assertEqual(self.one("SELECT count(*) AS n FROM observation_facts WHERE observation_id = %s", oid)["n"], 2)
        self.assertEqual(self.one("SELECT count(*) AS n FROM observation_readings WHERE observation_id = %s", oid)["n"], 2)
        self.assertEqual(self.one("SELECT conditions FROM observations WHERE observation_id = %s", oid)["conditions"],
                         "a person reviews every refund")
        self.assertTrue({"11", "12"} <= read_source_ids(self.conn))

    def test_the_same_run_id_with_other_content_is_refused(self):
        path = self.write("observations-c", [post("13", LAUNCH)], [{"observations": []}])
        ingest_observations(self.conn, path)
        changed = self.write("observations-c", [post("13", LAUNCH), post("12", FOLLOW_UP)], [{"observations": []}])
        with self.assertRaises(ValueError):
            ingest_observations(self.conn, changed)

    def test_posts_of_a_failed_batch_stay_unread(self):
        posts = [post("11", LAUNCH), post("13", LAUNCH)]
        path = self.write("observations-d", posts, [{"observations": []}, {"observations": []}],
                          failures=[{"batch": 2, "error": "timeout"}], batch_size=1)
        ingest_observations(self.conn, path)
        read = {r["source_id"] for r in self.conn.execute(
            "SELECT source_id FROM observation_reads WHERE run_id = 'observations-d'").fetchall()}
        self.assertEqual(read, {"11"} - {r["source_id"] for r in self.conn.execute(
            "SELECT source_id FROM observation_reads WHERE run_id <> 'observations-d'").fetchall()})
        self.assertEqual(self.one("SELECT read_count, candidate_count FROM observation_runs WHERE run_id = 'observations-d'"),
                         {"read_count": 1, "candidate_count": 2})


if __name__ == "__main__":
    unittest.main()
