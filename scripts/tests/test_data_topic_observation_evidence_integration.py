"""Observations under a topic's answers in a real PostgreSQL: Jev's readings are written
as candidates on the answers they were sure of, a pair already judged is not asked
again, a reading that was not Jev's writes nothing, an observation merged into another
is judged once and published as the one it stands under, and a person's rejection takes
it off the published topic. The judge and the embedding are stand-ins."""
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

from data_pipeline import publish, topic_evidence, topic_mining
from data_pipeline.classify import Reading
from data_pipeline.collection_store import ingest_run
from data_pipeline.db import connect, migrate
from data_pipeline.observation_store import build_run, ingest_observations
from test_data_event_extraction_integration import crawler_run, seed_org_registry

META = {"model": "deepseek-flash", "prompt_sha256": "a" * 64, "params": {"limit": None},
        "window": None, "started_at": "2026-11-03T00:00:00+00:00", "finished_at": "2026-11-03T00:01:00+00:00"}
TOPIC = "topic:replacement:csr:00000001"
TICKETS = "Our support agent now answers 60% of tickets on its own, and a person reviews every refund."
POEM = "We asked the support agent for a poem about Mondays and it wrote a lovely one."
OTHER = "The new hire handled the angriest customer all by themselves and the agent could not."


def post(sid, text):
    return {"source_id": sid, "handle": "OpenAI", "account_key": "x:openai",
            "url": f"https://x.com/OpenAI/status/{sid}",
            "published_at": datetime(2026, 9, 10, tzinfo=timezone.utc), "text": text}


def item(source_id, work, task, quote, direction="ai_takes_on", value=None):
    facts = [{"value": value, "unit": "% of tickets", "what": "tickets answered alone", "baseline": None,
              "quote": quote}] if value else []
    return {"source_ids": [source_id], "actor": "OpenAI", "actor_role": "maker", "subject": "Support Agent",
            "work": work, "task": task, "evidence_type": "vendor_claim", "outcome": "succeeded",
            "direction": direction, "conditions": None, "facts": facts, "occurred_at": None, "quote": quote}


def embed(texts, cfg=None, form="similarity", batch_size=32):
    # Support talk and the topic point one way, the poem the other.
    return [[0.0, 1.0] if "poem" in t.lower() else [1.0, 0.0] for t in texts]


class Judge:
    """Stands in for Classifier: answers a and b, 'fewer' is supported by tickets and contradicted by hiring."""
    judge = "typesafe"
    asked = []

    def __init__(self, question, criteria, subject_key, option_key, **more):
        self.sign = "contradicts" if "NOT" in question else "supports"
        self.primary = mock.Mock(model="jev-test")
        self.failed_batches = self.fallback_batches = 0

    def classify(self, state, options, progress=None):
        Judge.asked.append((self.sign, state["work_done"], [o.id for o in options]))
        said = state["source_words"]
        out = []
        for option in options:
            first = option.id.endswith("#a")
            if "tickets" in said:
                value = 0.9 if (first and self.sign == "supports") else 0.1
            elif "could not" in said:
                value = 0.8 if (first and self.sign == "contradicts") else 0.1
            else:
                value = 0.1
            out.append(Reading(option.id, value, self.judge))
        return out


class TopicObservationEvidence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = "openaiwill_topic_obs_test_" + uuid.uuid4().hex
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
        cls.conn.execute(
            """INSERT INTO topics (topic_id, question_type, object_key, question_en, question_zh_cn, origin,
                                   opened_at, schema_version, checks)
               VALUES (%s, 'replacement', 'customer service representative',
                       'Will AI replace most customer service representatives?', '人工智能会取代大多数客服吗？',
                       'editor', now(), '2.7.0',
                       '{"specific": true, "closed": true, "exclusive": true, "movable": true}')""", (TOPIC,))
        for position, (en, zh) in enumerate([("Yes, most of them.", "会，大多数。"), ("No, most stay.", "不会，大多留下。")], 1):
            cls.conn.execute("INSERT INTO topic_options (option_id, topic_id, position, text_en, text_zh_cn) "
                             "VALUES (%s, %s, %s, %s, %s)",
                             (topic_mining.option_id(TOPIC, "ab"[position - 1]), TOPIC, position, en, zh))

    @classmethod
    def remove_database(cls):
        with connect() as admin:
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(cls.database)))

    def write(self, name, posts, observations):
        doc = build_run(posts, [{"observations": observations}], [], 25, META)
        self.assertFalse(any(doc["refused"].values()), doc["refused"])
        path = self.tmp / f"{name}.json"
        path.write_text(json.dumps(doc, default=lambda value: value.isoformat()))
        return ingest_observations(self.conn, path)

    def one(self, query, *params):
        return self.conn.execute(query, params).fetchone()

    def oid(self, source_id):
        return self.one("SELECT observation_id FROM observation_sources WHERE source_id = %s "
                        "ORDER BY source_ref LIMIT 1", source_id)["observation_id"]

    def run_judge(self, **more):
        Judge.asked = []
        with mock.patch.object(topic_evidence, "Classifier", Judge), \
                mock.patch.object(topic_evidence.embedding, "embed", embed):
            return topic_evidence.run(self.conn, **more)

    def evidence(self):
        return {(r["observation_id"], r["option_id"].rsplit("#", 1)[1]): (r["sign"], float(r["confidence"]), r["status"])
                for r in self.conn.execute("SELECT * FROM topic_option_observations").fetchall()}

    def test_observations_under_a_topics_answers(self):
        self.write("a", [post("11", TICKETS)], [item("11", "customer support", "Answer customer tickets.", "answers 60% of tickets on its own", value="60")])
        self.write("b", [post("12", OTHER)], [item("12", "escalations", "Handle an angry customer.", "the agent could not", "human_still_needed")])
        self.write("c", [post("13", POEM)], [item("13", "creative writing", "Write a poem about Mondays.", "it wrote a lovely one")])
        tickets, angry, poem = self.oid("11"), self.oid("12"), self.oid("13")

        result = self.run_judge()
        self.assertEqual((result["observations"], result["observations_near_a_topic"]), (3, 2))
        self.assertEqual((result["supports"], result["contradicts"], result["observations_weighing_on_an_answer"]), (1, 1, 2))
        # The poem is not near the topic at all; nothing was asked about it.
        self.assertFalse([a for a in Judge.asked if "poem" in a[1]])
        self.assertEqual(self.evidence(), {(tickets, "a"): ("supports", 0.9, "candidate"),
                                           (angry, "a"): ("contradicts", 0.8, "candidate")})
        row = self.one("SELECT judge, method, method_version FROM topic_option_observations WHERE observation_id = %s", tickets)
        self.assertEqual((row["judge"], row["method"], row["method_version"]), ("typesafe", "ai_proposed", topic_evidence.METHOD_VERSION))
        self.assertEqual(self.one("SELECT count(*) AS n FROM topic_observation_checked")["n"], 2)

        # Nothing judged is asked again.
        again = self.run_judge()
        self.assertEqual((again["observations_near_a_topic"], again["answers_asked"], again["evidence_rows"]), (0, 0, 0))
        self.assertEqual(Judge.asked, [])

        # Published: ids and the way they weigh, in option order; the answer's counts come from them.
        (topic,) = [t for t in publish.topics(self.conn) if t["topic_id"] == TOPIC]
        self.assertEqual(topic["evidence"], [])
        self.assertEqual([(e["observation_id"], e["option"], e["sign"]) for e in topic["observation_evidence"]],
                         [(tickets, "a", "supports"), (angry, "a", "contradicts")])
        first = topic["options"][0]
        self.assertEqual((first["supports"], first["contradicts"], topic["options"][1]["supports"]), (1, 1, 0))

        # A person's rejection takes the observation off the published topic.
        self.conn.execute("UPDATE observations SET review_state = 'human_rejected', reviewed_at = now() "
                          "WHERE observation_id = %s", (angry,))
        (topic,) = [t for t in publish.topics(self.conn) if t["topic_id"] == TOPIC]
        self.assertEqual([e["observation_id"] for e in topic["observation_evidence"]], [tickets])

        # A reading that was not Jev's writes nothing and is asked again.
        self.write("d", [post("14", TICKETS + " Again.")], [item("14", "ticket triage", "Answer tickets alone.", "answers 60% of tickets on its own")])
        fresh = self.oid("14")

        class Fallback(Judge):
            judge = "deepseek"
        before = self.one("SELECT count(*) AS n FROM topic_option_observations")["n"]
        with mock.patch.object(topic_evidence, "Classifier", Fallback), \
                mock.patch.object(topic_evidence.embedding, "embed", embed):
            result = topic_evidence.run(self.conn)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(self.one("SELECT count(*) AS n FROM topic_option_observations")["n"], before)
        self.assertEqual(self.one("SELECT count(*) AS n FROM topic_observation_checked WHERE observation_id = %s", fresh)["n"], 0)
        # Jev back: it is read this time.
        self.run_judge()
        self.assertEqual(self.one("SELECT count(*) AS n FROM topic_observation_checked WHERE observation_id = %s", fresh)["n"], 1)

        # Found to be the same as another, it stands under that one: published once, as the head.
        self.assertEqual(self.one("SELECT sign FROM topic_option_observations WHERE observation_id = %s", fresh)["sign"], "supports")
        self.conn.execute("INSERT INTO observation_mapping_runs (run_id, mapper, model, embedding_model, prompt_sha256, counts, started_at) "
                          "VALUES ('map-1', 'test', 'm', 'e', %s, '{}', now())", ("b" * 64,))
        self.conn.execute("INSERT INTO observation_merges (observation_id, merged_into, run_id) VALUES (%s, %s, 'map-1')", (fresh, tickets))
        (topic,) = [t for t in publish.topics(self.conn) if t["topic_id"] == TOPIC]
        self.assertEqual([e["observation_id"] for e in topic["observation_evidence"]], [tickets])
        # And it is no longer read as an observation of its own: of the five, one was rejected and one merged.
        self.assertEqual(self.run_judge()["observations"], 2)


if __name__ == "__main__":
    unittest.main()
