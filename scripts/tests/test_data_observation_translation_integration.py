"""The translation pass in a real PostgreSQL: it fills what is missing and nothing else,
changes no original wording and no id, leaves what failed for the next pass, and skips
what is not published. The model is a stand-in."""
import json
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from psycopg import sql

from data_pipeline import deepseek, observation_translation, publish
from data_pipeline.db import connect, migrate

CFG = {"api_key": "test", "model": "deepseek-flash", "base_url": "http://127.0.0.1:9"}
CALLS = []
WORDS = {"Answer tickets.": "回答工单。", "Sort invoices.": "整理发票。", "a person checks refunds": "由人核对退款",
         "tickets closed": "已处理的工单", "minutes": "分钟", "a Virginia librarian": "弗吉尼亚州的一位图书管理员",
         "time saved": "节省的时间", "Rejected work.": "被否决的工作。", "Merged work.": "并入的工作。"}


def fake_chat(messages, cfg, timeout=120, usage=None):
    items = json.loads(messages[1]["content"])["items"]
    CALLS.append(items)
    if any(item.get("task") == "Call fails." for item in items):
        raise deepseek.DeepSeekError("down")

    def words(entry):
        return {key: WORDS.get(value, value) for key, value in entry.items() if key not in ("id", "facts")}

    return {"translations": [{"id": item["id"], **words(item),
                              "facts": [{"id": f["id"], **words(f)} for f in item.get("facts", [])]} for item in items]}


class Translating(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = "openaiwill_observation_translation_test_" + uuid.uuid4().hex
        with connect() as admin:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(cls.database)))
        cls.addClassCleanup(cls.remove_database)
        cls.conn = connect(cls.database)
        cls.addClassCleanup(cls.conn.close)
        migrate(cls.conn)

    @classmethod
    def remove_database(cls):
        with connect() as admin:
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(cls.database)))

    def setUp(self):
        CALLS.clear()
        self.conn.execute("TRUNCATE observations, observation_translation_runs, observation_mapping_runs CASCADE")

    def add(self, oid, task, actor="OpenAI", conditions=None, review="machine_proposed"):
        self.conn.execute(
            """INSERT INTO observations (observation_id, actor_key, actor_name, actor_role, subject_key, work_key, task,
                                         evidence_type, outcome, direction, conditions, review_state, reviewed_at, extractor, schema_version)
               VALUES (%s, 'unresolved:x', %s, 'maker', 'unspecified', 'unmapped', %s, 'vendor_claim', 'succeeded', 'ai_takes_on', %s,
                       %s, CASE WHEN %s = 'machine_proposed' THEN NULL ELSE now() END, 'test', '2.9.0')""",
            (oid, actor, task, conditions, review, review))

    def add_fact(self, oid, fact_id, what="tickets closed", unit="%"):
        self.conn.execute("""INSERT INTO observation_facts (fact_id, observation_id, value, unit, what, quote)
                             VALUES (%s, %s, '48', %s, %s, 'closed 48%%')""", (fact_id, oid, unit, what))

    def run_pass(self, **kwargs):
        with mock.patch.object(deepseek, "chat", fake_chat), mock.patch.object(observation_translation, "WORKERS", 1):
            return observation_translation.translate(self.conn, CFG, **kwargs)

    def stored(self, oid):
        return self.conn.execute("SELECT * FROM observations WHERE observation_id = %s", (oid,)).fetchone()

    def test_it_fills_the_translations_and_changes_nothing_else(self):
        oid = "obs-" + "1" * 16
        self.add(oid, "Answer tickets.", actor="a Virginia librarian", conditions="a person checks refunds")
        self.add_fact(oid, "fact-1")
        before = self.stored(oid)
        result = self.run_pass()
        self.assertEqual((result["observations"], result["facts"], result["refused"], result["failed_batches"]), (1, 1, 0, 0))
        after = self.stored(oid)
        self.assertEqual((after["task_zh_cn"], after["conditions_zh_cn"], after["actor_name_zh_cn"]),
                         ("回答工单。", "由人核对退款", "弗吉尼亚州的一位图书管理员"))
        for column, value in before.items():
            if not column.endswith("_zh_cn") and column != "translation_run_id":
                self.assertEqual(after[column], value, column)
        fact = self.conn.execute("SELECT * FROM observation_facts WHERE fact_id = 'fact-1'").fetchone()
        # "%" has no letters: copied, not asked.
        self.assertEqual((fact["what"], fact["what_zh_cn"], fact["unit"], fact["unit_zh_cn"]), ("tickets closed", "已处理的工单", "%", "%"))
        self.assertEqual(CALLS[0][0]["facts"], [{"id": "fact-1", "what": "tickets closed"}])
        run = self.conn.execute("SELECT * FROM observation_translation_runs").fetchone()
        self.assertEqual((run["run_id"], run["model"]), (after["translation_run_id"], "deepseek-flash"))
        self.assertEqual(run["prompt_sha256"], observation_translation.prompt_sha256())

    def test_a_second_pass_asks_nothing_and_a_new_fact_is_asked_alone(self):
        oid = "obs-" + "2" * 16
        self.add(oid, "Answer tickets.")
        self.add_fact(oid, "fact-1")
        self.run_pass()
        CALLS.clear()
        self.assertEqual(self.run_pass()["run_id"], None)
        self.assertEqual(CALLS, [])
        # A later run adds a number to the old observation.
        self.add_fact(oid, "fact-2", what="time saved", unit="minutes")
        self.run_pass()
        self.assertEqual(CALLS, [[{"id": oid, "facts": [{"id": "fact-2", "what": "time saved", "unit": "minutes"}]}]])
        self.assertEqual(self.stored(oid)["task_zh_cn"], "回答工单。")

    def test_a_failed_batch_stays_pending_and_says_so(self):
        good, bad = "obs-" + "3" * 16, "obs-" + "4" * 16
        self.add(good, "Sort invoices.")
        self.add(bad, "Call fails.")
        with mock.patch.object(observation_translation, "BATCH", 1), mock.patch("data_pipeline.deepseek.time.sleep"):
            result = self.run_pass()
        self.assertEqual((result["observations"], result["failed_batches"]), (1, 1))
        self.assertEqual(self.stored(good)["task_zh_cn"], "整理发票。")
        self.assertIsNone(self.stored(bad)["task_zh_cn"])
        self.assertEqual([row["observation_id"] for row in observation_translation.pending(self.conn)], [bad])

    def test_a_row_that_is_not_published_is_not_read(self):
        rejected, merged, head = "obs-" + "5" * 16, "obs-" + "6" * 16, "obs-" + "7" * 16
        self.add(rejected, "Rejected work.", review="human_rejected")
        self.add(merged, "Merged work.")
        self.add(head, "Answer tickets.")
        self.conn.execute("""INSERT INTO observation_mapping_runs (run_id, mapper, model, embedding_model, prompt_sha256, counts, started_at)
                             VALUES ('m', 'test', 'm', 'e', %s, '{}', now())""", ("a" * 64,))
        self.conn.execute("INSERT INTO observation_merges (observation_id, merged_into, run_id) VALUES (%s, %s, 'm')", (merged, head))
        self.run_pass()
        self.assertEqual([item["id"] for call in CALLS for item in call], [head])
        self.assertIsNone(self.stored(rejected)["task_zh_cn"])
        self.assertIsNone(self.stored(merged)["task_zh_cn"])

    def test_the_release_carries_them_and_null_until_made(self):
        done, later = "obs-" + "8" * 16, "obs-" + "9" * 16
        self.add(done, "Answer tickets.")
        self.add_fact(done, "fact-1")
        self.run_pass()
        self.add(later, "Sort invoices.")
        rows = {row["observation_id"]: row for row in publish.observations(self.conn, "1.0.0")}
        self.assertEqual(rows[done]["task_zh_cn"], "回答工单。")
        self.assertEqual(rows[done]["facts"][0]["what_zh_cn"], "已处理的工单")
        self.assertIsNone(rows[later]["task_zh_cn"])


if __name__ == "__main__":
    unittest.main()
