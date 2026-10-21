"""The schema's properties against the real database: every declared column exists
and is nullable exactly when the property is optional."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_pipeline import ontology_schema
from data_pipeline.db import connect, migrate


class PropertiesMatchColumns(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = connect()
        migrate(cls.conn)
        cls.columns = {(r["table_name"], r["column_name"]): r["is_nullable"] == "YES" for r in cls.conn.execute(
            "SELECT table_name, column_name, is_nullable FROM information_schema.columns "
            "WHERE table_schema = 'public'").fetchall()}
        cls.schema = ontology_schema.load_schema()

    def test_every_declared_column_exists_with_the_declared_optionality(self):
        for key, body in self.schema["properties"].items():
            if "column" not in body:
                continue
            table, column = body["column"].split(".")
            with self.subTest(property=key):
                self.assertIn((table, column), self.columns)
                if body["max"] == 1:  # a many-valued property is rows in its own table
                    self.assertEqual(self.columns[(table, column)], body["min"] == 0)

    def test_every_class_table_and_relation_table_exists(self):
        tables = {table for table, _ in self.columns}
        for name, body in self.schema["classes"].items():
            if "table" in body:
                self.assertIn(body["table"], tables, name)
        for name, body in self.schema["relations"].items():
            if body["storage"].startswith("pg:"):
                self.assertIn(body["storage"][3:].split(".")[0], tables, name)

    def test_process_records_are_tables_no_class_claims(self):
        tables = {table for table, _ in self.columns}
        claimed = {body.get("table") for body in self.schema["classes"].values()}
        for table in self.schema["process_records"]["tables"]:
            self.assertIn(table, tables)
            self.assertNotIn(table, claimed)


if __name__ == "__main__":
    unittest.main()
