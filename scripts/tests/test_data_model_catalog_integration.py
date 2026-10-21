"""Real PostgreSQL regressions for the model catalog import (migration 033).

Each test runs inside a transaction that is rolled back, so the live registry is
never touched.
"""
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from psycopg import errors

from data_pipeline import model_catalog as mc
from data_pipeline.db import connect, migrate

SHA = "0" * 64
AT = datetime(2026, 10, 3, tzinfo=timezone.utc)
MAPPING = {
    "source": "t-catalog", "url": "https://example.invalid/api.json", "since": "2026-01-01",
    "owners": {"google": "org:google"},
    "providers": [{"key": "t-google", "name": "T Google", "kind": "first_party", "org_id": "org:google"},
                  {"key": "t-cloud", "name": "T Cloud", "kind": "cloud", "org_id": None}],
}


def row(name, slug, released=date(2026, 9, 2), offerings=(("t-google", date(2026, 9, 2)),)):
    return {"catalog_id": f"google/{slug}", "org_id": "org:google", "name": name, "released_on": released,
            "aliases": [mc.normalize(name)], "open_weights": False, "output_modalities": ["text", "image"],
            "offerings": list(offerings)}


class CatalogImport(unittest.TestCase):
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

    def model(self, model_id):
        return self.conn.execute("SELECT * FROM models WHERE model_id = %s", (model_id,)).fetchone()

    def seed_mentioned(self):
        """What a mention leaves behind: a family and one candidate release, with their aliases."""
        self.conn.execute(
            "INSERT INTO models (model_id, org_id, level, name, status, first_seen_event_id) "
            "VALUES ('model:google:tgem', 'org:google', 'family', 'Tgem', 'candidate', 't-ev')")
        self.conn.execute(
            "INSERT INTO models (model_id, org_id, level, parent_model_id, name, version, variant, status, "
            "first_seen_event_id) VALUES ('model:google:tgem-9-flash', 'org:google', 'release', "
            "'model:google:tgem', 'Tgem 9 Flash', '9', 'Flash', 'candidate', 't-ev')")
        self.conn.execute("INSERT INTO model_aliases (alias, model_id) VALUES "
                          "('tgem', 'model:google:tgem'), ('tgem 9 flash', 'model:google:tgem-9-flash')")

    def test_a_catalog_entry_joins_the_model_a_mention_opened(self):
        def body():
            self.seed_mentioned()
            counts = mc.apply(self.conn, [row("Tgem 9 Flash", "tgem-9-flash")], MAPPING, SHA, AT)
            self.assertEqual((counts["matched"], counts["added"]), (1, 0))
            model = self.model("model:google:tgem-9-flash")
            self.assertEqual((model["catalog_id"], model["catalog_released_on"]),
                             ("google/tgem-9-flash", date(2026, 9, 2)))
            # Listed is not confirmed, and the catalog's date is not the release update's.
            self.assertEqual((model["status"], model["released_at"], model["first_seen_event_id"]),
                             ("candidate", None, "t-ev"))
            self.assertIs(model["open_weights"], False)
            outputs = self.conn.execute("SELECT modality FROM model_output_modalities WHERE model_id = %s "
                                        "ORDER BY modality", (model["model_id"],)).fetchall()
            self.assertEqual([r["modality"] for r in outputs], ["image", "text"])
        self.run_rolled_back(body)

    def test_an_unmentioned_model_enters_as_a_candidate_under_its_family(self):
        def body():
            self.seed_mentioned()
            counts = mc.apply(self.conn, [row("Tgem 9 Pro", "tgem-9-pro")], MAPPING, SHA, AT)
            self.assertEqual(counts["added"], 1)
            model = self.model("model:google:tgem-9-pro")
            self.assertEqual((model["status"], model["level"], model["parent_model_id"], model["first_seen_event_id"]),
                             ("candidate", "release", "model:google:tgem", None))
            alias = self.conn.execute("SELECT model_id FROM model_aliases WHERE alias = 'tgem 9 pro'").fetchone()
            self.assertEqual(alias["model_id"], "model:google:tgem-9-pro")
        self.run_rolled_back(body)

    def test_importing_twice_changes_nothing(self):
        def body():
            self.seed_mentioned()
            rows = [row("Tgem 9 Flash", "tgem-9-flash"),
                    row("Tgem 9 Pro", "tgem-9-pro", offerings=(("t-cloud", date(2026, 9, 5)),))]
            mc.apply(self.conn, rows, MAPPING, SHA, AT)
            before = self.conn.execute("SELECT count(*) AS n FROM models").fetchone()["n"]
            again = mc.apply(self.conn, rows, MAPPING, SHA, AT)
            self.assertEqual((again["added"], again["matched"], again["aliases_added"]), (0, 0, 0))
            self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM models").fetchone()["n"], before)
            offering = self.conn.execute(
                "SELECT provider_id, listed_on FROM model_offerings WHERE model_id = 'model:google:tgem-9-pro'"
            ).fetchall()
            self.assertEqual(offering, [{"provider_id": "provider:t-cloud", "listed_on": date(2026, 9, 5)}])
            imports = self.conn.execute("SELECT count(*) AS n FROM model_catalog_imports "
                                        "WHERE source = 't-catalog'").fetchone()["n"]
            self.assertEqual(imports, 1)
        self.run_rolled_back(body)

    def test_a_name_that_already_means_a_family_is_left_alone(self):
        def body():
            self.seed_mentioned()
            counts = mc.apply(self.conn, [row("Tgem", "tgem")], MAPPING, SHA, AT)
            self.assertEqual((counts["skipped_name_taken"], counts["added"], counts["matched"]), (1, 0, 0))
            self.assertIsNone(self.model("model:google:tgem")["catalog_id"])
        self.run_rolled_back(body)

    def test_a_model_needs_a_mention_or_a_catalog_entry(self):
        def body():
            with self.assertRaises(errors.CheckViolation), self.conn.transaction():
                self.conn.execute("INSERT INTO models (model_id, org_id, level, name, status) "
                                  "VALUES ('model:google:tgem-orphan', 'org:google', 'release', 'T', 'candidate')")
        self.run_rolled_back(body)


if __name__ == "__main__":
    unittest.main()
