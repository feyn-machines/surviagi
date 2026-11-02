"""The observation tables against a real PostgreSQL: the rules the schema states
for them (ontology 2.5.0), and a hand-annotated sample of real sources.

The annotated sample is local: it quotes third-party posts, so it stays under
the ignored `data/` and the test skips when it is absent.
"""

import hashlib
import json
from pathlib import Path
import sys
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psycopg
from psycopg import sql

from data_pipeline import ontology_schema
from data_pipeline.db import connect, migrate

ANNOTATIONS = Path(__file__).resolve().parents[2] / "data/ontology/observation-annotations-20261103.json"


def observation_id(actor_key, subject_key, work_key, occurred_on):
    identity = "\n".join([actor_key, subject_key, work_key, occurred_on or ""])
    return "obs-" + hashlib.sha256(identity.encode()).hexdigest()[:16]


BASE = dict(actor_key="org:acme", actor_name="Acme", actor_role="maker", subject_key="product:acme:desk",
            work_key="unmapped", task="Answer customer tickets.", evidence_type="vendor_claim",
            outcome="succeeded", direction="ai_takes_on", extractor="test@1", schema_version="2.5.0")


class ObservationTables(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = "openaiwill_observations_test_" + uuid.uuid4().hex
        with connect() as admin:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(cls.database)))
        cls.addClassCleanup(cls.remove_database)
        cls.conn = connect(cls.database)
        cls.addClassCleanup(cls.conn.close)
        migrate(cls.conn)
        # Posts are other tests' business; here a source row names a post by id only.
        cls.conn.execute("ALTER TABLE observation_sources DROP CONSTRAINT observation_sources_source_id_fkey")

    @classmethod
    def remove_database(cls):
        with connect() as admin:
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(cls.database)))

    def insert(self, **override):
        row = {**BASE, **override}
        row.setdefault("observation_id", observation_id(row["actor_key"], row["subject_key"], row["work_key"], None))
        columns = list(row)
        self.conn.execute(
            sql.SQL("INSERT INTO observations ({}) VALUES ({})").format(
                sql.SQL(", ").join(map(sql.Identifier, columns)), sql.SQL(", ").join(sql.Placeholder() * len(columns))),
            list(row.values()))
        return row["observation_id"]

    def refused(self, statement, params=()):
        with self.assertRaises(psycopg.errors.CheckViolation), self.conn.transaction():
            self.conn.execute(statement, params)

    def test_an_observation_with_a_source_and_a_fact_is_stored(self):
        oid = self.insert(actor_key="org:one")
        self.conn.execute("INSERT INTO observation_sources (source_ref, observation_id, source_type, url, quote) "
                          "VALUES (%s, %s, 'case_page', 'https://example.test/case', 'cut handling time')", (oid + ":1", oid))
        self.conn.execute("INSERT INTO observation_facts (fact_id, observation_id, value, unit, what, baseline, method_note, quote) "
                          "VALUES (%s, %s, '40', '%%', 'drop in handling time', 'before the rollout', 'one quarter, one site', 'by 40%%')", (oid + ":f", oid))
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM observation_facts WHERE observation_id = %s", (oid,)).fetchone()["n"], 1)

    def test_the_id_is_the_hash_of_the_identity_and_nothing_else_is_accepted(self):
        with self.assertRaises(psycopg.errors.CheckViolation), self.conn.transaction():
            self.insert(observation_id="obs-not-a-hash", actor_key="org:two")

    def test_evidence_type_takes_statistic_and_the_old_basis_list_still_holds(self):
        self.insert(actor_key="org:stat", evidence_type="statistic", actor_role="researcher", direction="neutral")
        with self.assertRaises(psycopg.errors.CheckViolation), self.conn.transaction():
            self.insert(actor_key="org:bad", evidence_type="rumour")
        self.conn.execute("SELECT 1 FROM extracted_events WHERE basis = 'statistic'")

    def test_a_person_decision_carries_its_time_and_a_machine_proposal_does_not(self):
        with self.assertRaises(psycopg.errors.CheckViolation), self.conn.transaction():
            self.insert(actor_key="org:r1", review_state="human_confirmed")
        with self.assertRaises(psycopg.errors.CheckViolation), self.conn.transaction():
            self.insert(actor_key="org:r2", reviewed_at="2026-11-03T00:00:00Z")
        self.insert(actor_key="org:r3", review_state="human_confirmed", reviewed_at="2026-11-03T00:00:00Z")

    def test_an_actor_must_be_named(self):
        with self.assertRaises(psycopg.errors.CheckViolation), self.conn.transaction():
            self.insert(actor_key="unresolved:nobody", actor_name=None)

    def test_an_x_source_names_its_post_and_another_source_does_not(self):
        oid = self.insert(actor_key="org:src")
        self.refused("INSERT INTO observation_sources (source_ref, observation_id, source_type, url, quote) "
                     "VALUES ('a', %s, 'x_post', 'https://x.test/1', 'q')", (oid,))
        self.refused("INSERT INTO observation_sources (source_ref, observation_id, source_type, url, source_id, quote) "
                     "VALUES ('b', %s, 'report', 'https://x.test/2', 'post-1', 'q')", (oid,))

    def test_a_model_proposed_work_mapping_stays_a_candidate(self):
        oid = self.insert(actor_key="org:map")
        self.refused("INSERT INTO observation_concepts (observation_id, concept_id, method, status) "
                     "VALUES (%s, 'oaw:occupation:x', 'ai_proposed', 'reviewed')", (oid,))
        self.conn.execute("INSERT INTO observation_concepts (observation_id, concept_id, method, status) "
                          "VALUES (%s, 'oaw:occupation:x', 'ai_proposed', 'candidate')", (oid,))

    def test_an_adoption_needs_an_observation_one_subject_and_a_name(self):
        oid = self.insert(actor_key="org:adopt")
        self.conn.execute("INSERT INTO products (product_id, owner_name, name) VALUES ('product:acme:desk', 'Acme', 'Desk')"
                          " ON CONFLICT DO NOTHING")
        ok = ("INSERT INTO adoptions (adoption_id, adopter_name, product_id, stage, observation_id) "
              "VALUES (%s, 'Some Bank', 'product:acme:desk', 'pilot', %s)")
        self.conn.execute(ok, ("a1", oid))
        with self.assertRaises(psycopg.errors.ForeignKeyViolation), self.conn.transaction():
            self.conn.execute(ok, ("a2", "obs-0000000000000000"))
        self.refused("INSERT INTO adoptions (adoption_id, product_id, stage, observation_id) VALUES ('a3', 'product:acme:desk', 'pilot', %s)", (oid,))
        self.refused("INSERT INTO adoptions (adoption_id, adopter_name, stage, observation_id) VALUES ('a4', 'Some Bank', 'pilot', %s)", (oid,))

    def test_a_product_has_a_maker_and_an_investment_is_not_in_oneself(self):
        self.refused("INSERT INTO products (product_id, name) VALUES ('product:acme:orphan', 'Orphan')")
        self.conn.execute("INSERT INTO org_registry (org_id, canonical_name_en, aliases, record_sha256) "
                          "VALUES ('org:inv-test', 'Investor', '[]', repeat('a', 64)) ON CONFLICT DO NOTHING")
        self.refused("INSERT INTO org_investments (investment_id, investor_org_id, investee_org_id, source_url) "
                     "VALUES ('i1', 'org:inv-test', 'org:inv-test', 'https://x.test')")

    def test_every_new_vocabulary_term_is_one_the_database_accepts(self):
        # The CHECK lists are compared with the vocabularies by ontology:check;
        # this proves the lists are live constraints and not just text.
        for term in ontology_schema.current_term_ids("observation_direction"):
            self.insert(actor_key="org:dir-" + term, direction=term)


@unittest.skipUnless(ANNOTATIONS.is_file(), "the hand-annotated sample is local and absent")
class AnnotatedSample(unittest.TestCase):
    """Twenty real sources written out by hand as observations: every field the
    sources needed has a column, and every quotation is found in its source."""

    @classmethod
    def setUpClass(cls):
        cls.database = "openaiwill_annotated_test_" + uuid.uuid4().hex
        with connect() as admin:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(cls.database)))
        cls.addClassCleanup(ObservationTables.remove_database.__func__, cls)
        cls.conn = connect(cls.database)
        cls.addClassCleanup(cls.conn.close)
        migrate(cls.conn)
        cls.conn.execute("ALTER TABLE observation_sources DROP CONSTRAINT observation_sources_source_id_fkey")
        cls.sample = json.loads(ANNOTATIONS.read_text())

    def test_all_twenty_sources_are_expressed_without_a_free_text_escape(self):
        self.assertEqual(len(self.sample), 20)
        written = 0
        for source in self.sample:
            for n, o in enumerate(source["observations"]):
                with self.subTest(sample=source["sample_index"], n=n):
                    self.assertIn(o["source_quote"], source["source_text"])
                    oid = observation_id(o["actor_key"], o["subject_key"], o["work_key"], o["occurred_on"])
                    self.conn.execute(
                        """INSERT INTO observations (observation_id, actor_key, actor_name, actor_role, subject_key, work_key, task,
                               evidence_type, outcome, direction, scale, conditions, extractor, schema_version)
                           VALUES (%(id)s, %(actor_key)s, %(actor_name)s, %(actor_role)s, %(subject_key)s, %(work_key)s, %(task)s,
                               %(evidence_type)s, %(outcome)s, %(direction)s, %(scale)s, %(conditions)s, 'annotation@1', '2.5.0')
                           ON CONFLICT (observation_id) DO NOTHING""", {**o, "id": oid, "actor_name": o["actor_name"] or o["actor_key"]})
                    self.conn.execute(
                        "INSERT INTO observation_sources (source_ref, observation_id, source_type, url, source_id, quote) "
                        "VALUES (%s, %s, 'x_post', %s, %s, %s) ON CONFLICT DO NOTHING",
                        (f"{oid}:{source['source_id']}", oid, source["url"], source["source_id"], o["source_quote"]))
                    for k, fact in enumerate(o["facts"]):
                        self.assertIn(fact["quote"], source["source_text"])
                        self.conn.execute(
                            "INSERT INTO observation_facts (fact_id, observation_id, value, unit, what, baseline, method_note, quote) "
                            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
                            (f"{oid}:{k}", oid, fact["value"], fact["unit"], fact["what"], fact["baseline"] or None,
                             fact["method_note"] or None, fact["quote"]))
                    for concept in o["concerns"]:
                        self.conn.execute(
                            "INSERT INTO observation_concepts (observation_id, concept_id, method, status) VALUES (%s, %s, %s, %s) "
                            "ON CONFLICT DO NOTHING", (oid, concept["concept_id"], concept["method"], concept["status"]))
                    adoption = o["adoption"]
                    if adoption:
                        self.conn.execute(
                            "INSERT INTO products (product_id, owner_name, name) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                            (adoption["product_key"] if adoption["product_key"].startswith("product:") else "product:test:" + str(source["sample_index"]),
                             o["actor_name"], adoption["product_key"]))
                        self.conn.execute(
                            "INSERT INTO adoptions (adoption_id, adopter_name, product_id, stage, scale, observation_id) "
                            "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
                            (f"{oid}:adopt", adoption["org_name"],
                             adoption["product_key"] if adoption["product_key"].startswith("product:") else "product:test:" + str(source["sample_index"]),
                             adoption["stage"], adoption["scale"], oid))
                    written += 1
        self.assertEqual(written, sum(len(s["observations"]) for s in self.sample))
        self.assertEqual(sum(1 for s in self.sample if not s["observations"]), 2,
                         "a launch and a pricing change are updates and name no piece of work done")


if __name__ == "__main__":
    unittest.main()
