"""Real PostgreSQL regressions for the model field of an update (migration 032).

Each test runs inside a transaction that is rolled back, so the live registry is
never touched.
"""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from psycopg import errors

from data_pipeline import model_identification as mi
from data_pipeline.db import connect, migrate

RELEASED = datetime(2026, 9, 3, 18, tzinfo=timezone.utc)
SHA = "0" * 64


class ModelRegistry(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = connect()
        migrate(cls.conn)

    def run_rolled_back(self, body):
        class Rollback(Exception):
            pass
        try:
            with self.conn.transaction():
                body()
                raise Rollback
        except Rollback:
            pass

    def seed(self):
        run = self.conn.execute("SELECT run_id FROM extraction_runs LIMIT 1").fetchone()["run_id"]
        self.conn.execute(
            """INSERT INTO judgment_runs (run_id, judge, model, task, prompt_sha256, rubric_sha256,
                 method_version, params, started_at, status, run_sha256)
               VALUES ('t-models', 'deepseek', 't', 'model_identification', %s, %s, %s, '{}', now(), 'running', %s)""",
            (SHA, SHA, mi.METHOD_VERSION, SHA))
        for event_id, kind, org in (("t-ev-release", "version_release", "org:google"),
                                    ("t-ev-other", "version_release", "org:microsoft"),
                                    ("t-ev-adopt", "production_adoption", "org:google")):
            self.conn.execute(
                """INSERT INTO extracted_events (event_id, dedup_key, kind, title, summary, occurred_at,
                     occurrence_status, first_extraction_run_id, record_sha256, kind_vocabulary, primary_org_id)
                   VALUES (%s, %s, %s, 't', 't', %s, 'occurred', %s, %s, 'event_kind-2.0.0', %s)""",
                (event_id, event_id, kind, RELEASED, run, SHA, org))
        reg = mi.Registry()
        links = (mi.links_for(reg, "t-ev-release", [self.mention("Tgem 9 Flash", "subject")])
                 + mi.links_for(reg, "t-ev-other", [self.mention("Tgem 9 Pro", "subject")])
                 + mi.links_for(reg, "t-ev-adopt", [self.mention("Tgem 9 Ultra", "subject")]))
        for row in reg.new_models:
            self.conn.execute(
                """INSERT INTO models (model_id, org_id, owner_name, level, parent_model_id, name, version,
                     variant, status, first_seen_event_id)
                   VALUES (%(model_id)s, %(org_id)s, %(owner_name)s, %(level)s, %(parent_model_id)s, %(name)s,
                           %(version)s, %(variant)s, %(status)s, %(first_seen_event_id)s)""", row)
        for link in links:
            self.conn.execute(
                "INSERT INTO event_models (event_id, model_id, role, mention, confidence, run_id) "
                "VALUES (%(event_id)s, %(model_id)s, %(role)s, %(mention)s, %(confidence)s, 't-models')", link)

    @staticmethod
    def mention(name, role):
        return {"mention": name, "name": name, "family": "Tgem", "version": "9",
                "variant": name.split()[-1], "owner": "Google", "role": role, "confidence": 0.9}

    def status(self, slug):
        return self.conn.execute("SELECT status, released_at FROM models WHERE model_id = %s",
                                 (f"model:google:{slug}",)).fetchone()

    def test_the_owners_release_update_confirms_and_dates_a_model(self):
        def body():
            self.seed()
            mi.confirm(self.conn)
            self.assertEqual(self.status("tgem-9-flash"), {"status": "confirmed", "released_at": RELEASED})
            self.assertEqual(self.status("tgem")["status"], "confirmed")
        self.run_rolled_back(body)

    def test_another_companys_update_or_another_kind_confirms_nothing(self):
        def body():
            self.seed()
            mi.confirm(self.conn)
            self.assertEqual(self.status("tgem-9-pro"), {"status": "candidate", "released_at": None})
            self.assertEqual(self.status("tgem-9-ultra"), {"status": "candidate", "released_at": None})
        self.run_rolled_back(body)

    def seed_short_name_duplicate(self):
        """Tgem Nova 9 exists; a later post that says only "Nova 9" opened a second row."""
        self.seed()
        self.conn.execute(
            "INSERT INTO models (model_id, org_id, level, parent_model_id, name, status, first_seen_event_id) VALUES "
            "('model:google:tgem-nova-9', 'org:google', 'release', 'model:google:tgem', 'Tgem Nova 9', 'confirmed', 't-ev-release'), "
            "('model:google:nova', 'org:google', 'family', NULL, 'Nova', 'candidate', 't-ev-adopt'), "
            "('model:google:nova-9', 'org:google', 'release', 'model:google:nova', 'Nova 9', 'candidate', 't-ev-adopt')")
        self.conn.execute("INSERT INTO model_aliases (alias, model_id) VALUES ('tgem nova 9', 'model:google:tgem-nova-9'), "
                          "('nova 9', 'model:google:nova-9')")
        self.conn.execute(
            "INSERT INTO event_models (event_id, model_id, role, mention, run_id) VALUES "
            "('t-ev-release', 'model:google:tgem-nova-9', 'subject', 'Tgem Nova 9', 't-models'), "
            "('t-ev-adopt', 'model:google:nova-9', 'distributed', 'Nova 9', 't-models'), "
            "('t-ev-release', 'model:google:nova-9', 'subject', 'Nova 9', 't-models')")

    def test_a_short_name_duplicate_is_folded_into_its_model(self):
        def body():
            self.seed_short_name_duplicate()
            result = mi.reconcile(self.conn)
            # Membership, not equality: the live registry may hold duplicates of its own.
            self.assertIn({"from": "model:google:nova-9", "into": "model:google:tgem-nova-9"}, result["merged"])
            self.assertIn("model:google:nova", result["empty_families_removed"])
            self.assertIsNone(self.conn.execute(
                "SELECT 1 FROM models WHERE model_id = 'model:google:nova-9'").fetchone())
            links = self.conn.execute(
                "SELECT event_id, role FROM event_models WHERE model_id = 'model:google:tgem-nova-9' "
                "ORDER BY event_id, role").fetchall()
            # The release update already named the model as subject: one link, not two.
            self.assertEqual(links, [{"event_id": "t-ev-adopt", "role": "distributed"},
                                     {"event_id": "t-ev-release", "role": "subject"}])
            alias = self.conn.execute("SELECT model_id FROM model_aliases WHERE alias = 'nova 9'").fetchone()
            self.assertEqual(alias["model_id"], "model:google:tgem-nova-9")
            self.assertEqual(mi.reconcile(self.conn), {"merged": [], "short_aliases_added": 0,
                                                       "empty_families_removed": []})
        self.run_rolled_back(body)

    def test_a_short_name_held_by_a_confirmed_model_is_left_alone(self):
        def body():
            self.seed_short_name_duplicate()
            self.conn.execute("UPDATE models SET status = 'confirmed' WHERE model_id = 'model:google:nova-9'")
            self.assertNotIn("model:google:nova-9", [m["from"] for m in mi.reconcile(self.conn)["merged"]])
            self.assertIsNotNone(self.conn.execute(
                "SELECT 1 FROM models WHERE model_id = 'model:google:nova-9'").fetchone())
        self.run_rolled_back(body)

    def test_a_family_carries_no_version(self):
        def body():
            self.seed()
            with self.assertRaises(errors.CheckViolation), self.conn.transaction():
                self.conn.execute("UPDATE models SET version = '9' WHERE model_id = 'model:google:tgem'")
        self.run_rolled_back(body)

    def test_an_unknown_role_is_refused(self):
        def body():
            self.seed()
            with self.assertRaises(errors.CheckViolation), self.conn.transaction():
                self.conn.execute(
                    "INSERT INTO event_models (event_id, model_id, role, mention, run_id) "
                    "VALUES ('t-ev-adopt', 'model:google:tgem', 'mentioned', 'Tgem', 't-models')")
        self.run_rolled_back(body)


if __name__ == "__main__":
    unittest.main()
