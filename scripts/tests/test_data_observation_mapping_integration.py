"""Mapping observations to catalog entries in a real PostgreSQL: candidates written,
an observation that fits nothing stays unmapped, the same fact read in other words
merged into the earlier id with a redirect, and what a later run finds again under a
merged id also written under the one it stands under; a number told again in
another form is written and published once. The model and the embedding are
stand-ins; the catalog is a small one."""
import json
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from psycopg import sql

from data_pipeline import observation_mapping, publish
from data_pipeline.collection_store import ingest_run
from data_pipeline.db import connect, migrate
from data_pipeline.observation_mapping import MAPPER, map_observations
from data_pipeline.observation_store import build_run, ingest_observations
from test_data_event_extraction_integration import crawler_run, seed_org_registry

LAUNCH = "Our support agent now answers 60% of tickets on its own, and a person reviews every refund."
FOLLOW_UP = "Update on the support agent: it now resolves 70% of tickets without a person."
GAIN = "Our support agent gains +32 on support tickets this month, and solves 40 more each day."
CHAT = "We asked the support agent for a poem about Mondays and it wrote a lovely one."
META = {"model": "deepseek-flash", "prompt_sha256": "a" * 64, "params": {"limit": None},
        "window": None, "started_at": "2026-11-03T00:00:00+00:00", "finished_at": "2026-11-03T00:01:00+00:00"}
CATALOG = ({"w:support": "Customer support (Contact centers)", "w:legal": "Contract review (Legal services)"},
           {"o:csr": "Customer Service Representatives"},
           {"o:csr": {"t:answer": "Answer customer questions (Customer Service Representatives)"}})
CFG = {"api_key": "test", "model": "deepseek-flash", "base_url": "http://127.0.0.1:9"}


def post(sid, text):
    return {"source_id": sid, "handle": "OpenAI", "account_key": "x:openai",
            "url": f"https://x.com/OpenAI/status/{sid}",
            "published_at": datetime(2026, 9, 10, tzinfo=timezone.utc), "text": text}


def item(source_id, work, task, quote, fact_quote=None, value=None):
    facts = [{"value": value, "unit": "% of tickets", "what": "tickets answered alone", "baseline": None,
              "quote": fact_quote}] if value else []
    return {"source_ids": [source_id], "actor": "OpenAI", "actor_role": "maker", "subject": "Support Agent",
            "work": work, "task": task, "evidence_type": "vendor_claim", "outcome": "succeeded",
            "direction": "ai_takes_on", "conditions": None, "facts": facts, "occurred_at": None, "quote": quote}


def fake_embed(texts, cfg=None, form="similarity", batch_size=32):
    # Support-ish texts point one way, everything else the other.
    return [[1.0, 0.0] if any(w in t.lower() for w in ("support", "ticket", "customer")) else [0.0, 1.0]
            for t in texts]


def fake_chat(messages, cfg, timeout=120, usage=None):
    observation = json.loads(messages[1]["content"].split("\n")[1])
    if usage is not None:
        usage.append({"model": "deepseek-flash", "at": 0, "prompt_tokens": 1000, "completion_tokens": 50})
    if "poem" in observation["task"]:
        return {"work": [], "occupations": [], "tasks": []}
    return {"work": [{"id": "w:support", "why": "answers tickets"}],
            "occupations": [{"id": "o:csr", "why": "their job"}],
            "tasks": [{"id": "t:answer", "why": "that task"}]}


class ObservationMapping(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = "openaiwill_observation_mapping_test_" + uuid.uuid4().hex
        with connect() as admin:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(cls.database)))
        cls.addClassCleanup(cls.remove_database)
        cls.conn = connect(cls.database)
        cls.addClassCleanup(cls.conn.close)
        migrate(cls.conn)
        seed_org_registry(cls.conn)
        cls.tmp = Path(tempfile.mkdtemp())
        path = cls.tmp / "seed-run.json"
        path.write_text(json.dumps(crawler_run(["11", "12", "13", "14"], "seed-run")))
        ingest_run(cls.conn, path)

    @classmethod
    def remove_database(cls):
        with connect() as admin:
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(cls.database)))

    def write(self, run_id, posts, observations):
        doc = build_run(posts, [{"observations": observations}], [], 25, META)
        path = self.tmp / f"{run_id}.json"
        path.write_text(json.dumps(doc, default=lambda value: value.isoformat()))
        return ingest_observations(self.conn, path)

    def one(self, query, *params):
        return self.conn.execute(query, params).fetchone()

    def oid(self, source_id):
        return self.one("SELECT observation_id FROM observation_sources WHERE source_id = %s "
                        "ORDER BY source_ref LIMIT 1", source_id)["observation_id"]

    def map(self, chat=fake_chat):
        with mock.patch.object(observation_mapping, "catalog", lambda conn: CATALOG), \
                mock.patch.object(observation_mapping.embedding, "embed", fake_embed), \
                mock.patch.object(observation_mapping.embedding, "config_from_env",
                                  lambda: {"model": "embeddinggemma-2", "url": "http://127.0.0.1:9"}), \
                mock.patch.object(observation_mapping.deepseek, "chat", chat):
            return map_observations(self.conn, cfg=CFG, workers=2)

    def test_mapping_proposes_candidates_merges_the_same_fact_and_redirects_later_finds(self):
        self.write("observations-a", [post("11", LAUNCH)], [
            item("11", "customer support", "Answer customer tickets.", "answers 60% of tickets on its own",
                 "answers 60% of tickets", "60")])
        self.write("observations-b", [post("12", FOLLOW_UP)], [
            item("12", "support desk", "Resolve tickets without a person.", "resolves 70% of tickets without a person",
                 "resolves 70% of tickets", "70")])
        self.write("observations-c", [post("13", CHAT)], [
            item("13", "creative writing", "Write a poem about Mondays.", "it wrote a lovely one")])
        first, second, poem = self.oid("11"), self.oid("12"), self.oid("13")
        self.assertEqual(len({first, second, poem}), 3)

        with mock.patch.object(observation_mapping.time, "sleep", lambda s: None):
            failing = self.map(chat=mock.Mock(side_effect=observation_mapping.deepseek.DeepSeekError("down")))
        self.assertEqual((failing["failed"], failing["mapped"]), (3, 0))
        self.assertEqual(self.one("SELECT count(*) AS n FROM observation_mapping_checked")["n"], 0)

        result = self.map()
        self.assertEqual((result["observations"], result["mapped"], result["unmapped"], result["merged"]), (3, 2, 1, 1))
        self.assertEqual(result["concerns"], 6)
        self.assertGreater(result["usd"], 0)

        self.assertEqual(self.one("SELECT work_key FROM observations WHERE observation_id = %s", first)["work_key"],
                         "w:support")
        self.assertEqual(self.one("SELECT work_key FROM observations WHERE observation_id = %s", poem)["work_key"],
                         "unmapped")
        self.assertEqual(self.one("SELECT count(*) AS n FROM observation_concepts WHERE observation_id = %s", poem)["n"], 0)
        concepts = self.conn.execute("SELECT concept_id, method, status FROM observation_concepts "
                                     "WHERE observation_id = %s ORDER BY concept_id", (first,)).fetchall()
        self.assertEqual([(c["concept_id"], c["method"], c["status"]) for c in concepts],
                         [("o:csr", "ai_proposed", "candidate"), ("t:answer", "ai_proposed", "candidate"),
                          ("w:support", "ai_proposed", "candidate")])

        # The later one stands under the earlier: a redirect, its own rows kept, its words under the head too.
        self.assertEqual(self.one("SELECT merged_into FROM observation_merges WHERE observation_id = %s",
                                  second)["merged_into"], first)
        self.assertEqual(self.one("SELECT count(*) AS n FROM observation_sources WHERE observation_id = %s", second)["n"], 1)
        self.assertEqual({r["source_id"] for r in self.conn.execute(
            "SELECT source_id FROM observation_sources WHERE observation_id = %s", (first,)).fetchall()}, {"11", "12"})
        self.assertEqual({r["value"] for r in self.conn.execute(
            "SELECT value FROM observation_facts WHERE observation_id = %s", (first,)).fetchall()}, {"60", "70"})

        # Nothing is asked twice, and a run with nothing new merges nothing.
        again = self.map()
        self.assertEqual((again["run_id"], again["observations"]), (None, 0))
        self.assertEqual(self.one("SELECT count(*) AS n FROM observation_mapping_checked WHERE mapper = %s",
                                  MAPPER)["n"], 3)

        # A later run that reads the merged fact again in the same words gives its new source to the head too.
        found = self.write("observations-d", [post("14", FOLLOW_UP)], [
            item("14", "support desk", "Resolve tickets without a person.", "resolves 70% of tickets without a person")])
        self.assertEqual((found["new_observations"], found["found_again"]), (0, 1))
        self.assertEqual({r["source_id"] for r in self.conn.execute(
            "SELECT source_id FROM observation_sources WHERE observation_id = %s", (first,)).fetchall()},
            {"11", "12", "14"})

        # Published: the head with its redirect, never the merged one as a row of its own (contract 1.2.0).
        rows = {r["observation_id"]: r for r in publish.observations(self.conn, "no-catalog")}
        self.assertEqual(set(rows), {first, poem})
        head = rows[first]
        self.assertEqual(head["merged_from"], [second])
        self.assertEqual({s["source_id"] for s in head["sources"]}, {"11", "12", "14"})
        self.assertEqual({f["value"] for f in head["facts"]}, {"60", "70"})
        self.assertEqual([(c["concept_id"], c["status"]) for c in head["concerns"]],
                         [("o:csr", "candidate"), ("t:answer", "candidate"), ("w:support", "candidate")])
        self.assertEqual((rows[poem]["work_key"], rows[poem]["concerns"], rows[poem]["merged_from"]),
                         ("unmapped", [], []))
        json.dumps(list(rows.values()))

        # A person's rejection takes the observation, or the entry, off the published record.
        self.conn.execute("UPDATE observations SET review_state = 'human_rejected', reviewed_at = now() "
                          "WHERE observation_id = %s", (poem,))
        self.conn.execute("UPDATE observation_concepts SET method = 'reviewed', status = 'rejected' "
                          "WHERE observation_id = %s AND concept_id = 't:answer'", (first,))
        rows = {r["observation_id"]: r for r in publish.observations(self.conn, "no-catalog")}
        self.assertEqual(set(rows), {first})
        self.assertEqual([c["concept_id"] for c in rows[first]["concerns"]], ["o:csr", "w:support"])

    def test_numbers_told_again_in_another_form_are_one_fact(self):
        # Runs after the mapping test, which counts every observation in the database.
        ingest_run(self.conn, self.seed("21", "22"))

        def gain(source_id, work, value, unit, quote="gains +32 on support tickets"):
            # Another subject, so these do not merge with the mapping test's observations.
            observation = {**item(source_id, work, "Answer support tickets.", "gains +32 on support tickets"),
                           "subject": "Ticket Bot"}
            observation["facts"] = [{"value": value, "unit": unit, "what": "gain on tickets", "baseline": None,
                                     "quote": quote}]
            return observation

        self.write("observations-e", [post("21", GAIN)], [gain("21", "ticket desk", "+32", None)])
        first = self.oid("21")
        # Found again under its own id: "32 points" is the "+32" already there.
        found = self.write("observations-f", [post("21", GAIN)], [gain("21", "ticket desk", "32", "points")])
        self.assertEqual(found["found_again"], 1)
        facts = self.conn.execute("SELECT value FROM observation_facts WHERE observation_id = %s", (first,)).fetchall()
        self.assertEqual([f["value"] for f in facts], ["+32"])

        # Merged: the member's "32" is not copied, its other number is.
        self.write("observations-g", [post("22", GAIN)], [
            {**gain("22", "help line", "32", None),
             "facts": [{"value": "32", "unit": None, "what": "gain", "baseline": None,
                        "quote": "gains +32 on support tickets"},
                       {"value": "40", "unit": "tickets a day", "what": "more solved", "baseline": None,
                        "quote": "solves 40 more each day"}]}])
        second = self.oid("22")
        self.map()
        head = self.one("SELECT merged_into FROM observation_merges WHERE observation_id IN (%s, %s)",
                        first, second)["merged_into"]
        self.assertEqual({f["value"] for f in self.conn.execute(
            "SELECT value FROM observation_facts WHERE observation_id = %s", (head,)).fetchall()},
            {"40", "+32" if head == first else "32"})

        # A row written before forms were compared is published once, the fuller form standing.
        self.conn.execute(
            """INSERT INTO observation_facts (fact_id, observation_id, value, unit, what, quote)
               VALUES ('fact-old-form', %s, '32', 'points', 'gain', 'gains +32 on support tickets')""", (head,))
        published = {r["observation_id"]: r for r in publish.observations(self.conn, "no-catalog")}[head]
        self.assertEqual(sorted((f["value"], f["unit"]) for f in published["facts"]),
                         [("32", "points"), ("40", "tickets a day")])

    def seed(self, *source_ids):
        path = self.tmp / f"seed-{'-'.join(source_ids)}.json"
        path.write_text(json.dumps(crawler_run(list(source_ids), path.stem)))
        return path


if __name__ == "__main__":
    unittest.main()
