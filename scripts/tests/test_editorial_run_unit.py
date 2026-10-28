"""Dependency-free tests for the private article run ledger."""
import concurrent.futures
import os
import sqlite3
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import editorial_run


INPUT_HASH = "a" * 64
STAGE_INPUT = "b" * 64
OUTPUT_HASH = "c" * 64


class EditorialRunLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "private" / "runs.sqlite3"
        self.ledger = editorial_run.EditorialRunLedger(self.path)

    def create(self, **changes):
        values = {
            "input_ref": "collection-20261028",
            "input_sha256": INPUT_HASH,
            "topic_key": "tool-cost-comparison",
            "skill_version": "editorial-v1",
            "policy_version": "prepublish-v1",
            "model_version": "writer-model-v1",
            "budget_limit": 100,
            "max_attempts": 2,
        }
        values.update(changes)
        return self.ledger.create_run(**values)

    def test_ledger_is_private_and_records_no_article_text(self):
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)
        with sqlite3.connect(self.path) as conn:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 1)
        run, created = self.create()
        self.assertTrue(created)
        raw = self.path.read_bytes()
        self.assertNotIn(b"draft body", raw)
        self.assertEqual(run["state"], "ready")

    def test_create_is_idempotent_and_policy_budget_conflicts_are_visible(self):
        first, created = self.create()
        again, created_again = self.create()
        self.assertTrue(created)
        self.assertFalse(created_again)
        self.assertEqual(first["run_id"], again["run_id"])
        with self.assertRaisesRegex(editorial_run.LedgerError, "different budget"):
            self.create(budget_limit=101)
        different_model, distinct = self.create(model_version="writer-model-v2")
        self.assertTrue(distinct)
        self.assertNotEqual(first["run_id"], different_model["run_id"])

    def test_no_qualifying_topic_is_a_durable_terminal_outcome(self):
        run, created = self.create(no_topic=True, topic_key="")
        self.assertTrue(created)
        self.assertEqual(run["state"], "no_topic")
        with self.assertRaisesRegex(editorial_run.LedgerError, "no_topic"):
            self.ledger.start_stage(run["run_id"], "evidence_brief", input_sha256=STAGE_INPUT,
                                    model_id="editorial-model-v1", reserve_cost=1)

    def test_model_identifier_keeps_a_provider_path(self):
        run, _ = self.create()
        stage = self.ledger.start_stage(run["run_id"], "topic_selection",
                                        input_sha256=STAGE_INPUT,
                                        model_id="openai/gpt-4.1", reserve_cost=1)
        self.assertEqual(stage["attempt"], 1)
        self.assertEqual(self.ledger.show(run["run_id"])["stages"][0]["model_id"],
                         "openai/gpt-4.1")

    def test_stage_order_and_hash_bound_success(self):
        run, _ = self.create()
        with self.assertRaisesRegex(editorial_run.LedgerError, "finish earlier stage"):
            self.ledger.start_stage(run["run_id"], "evidence_brief", input_sha256=STAGE_INPUT,
                                    model_id="editorial-model-v1", reserve_cost=1)
        self.ledger.start_stage(run["run_id"], "topic_selection", input_sha256=STAGE_INPUT,
                                model_id="editorial-model-v1", reserve_cost=5)
        self.ledger.finish_stage(run["run_id"], "topic_selection", outcome="succeeded",
                                 actual_cost=3, output_sha256=OUTPUT_HASH)
        self.ledger.start_stage(run["run_id"], "evidence_brief", input_sha256=OUTPUT_HASH,
                                model_id="editorial-model-v1", reserve_cost=5)
        self.ledger.finish_stage(run["run_id"], "evidence_brief", outcome="succeeded",
                                 actual_cost=0, output_sha256=OUTPUT_HASH)
        with self.assertRaisesRegex(editorial_run.LedgerError, "complete"):
            self.ledger.start_stage(run["run_id"], "topic_selection", input_sha256=STAGE_INPUT,
                                    model_id="editorial-model-v1", reserve_cost=1)
        stage = self.ledger.start_stage(run["run_id"], "draft_en", input_sha256=OUTPUT_HASH,
                                        model_id="editorial-model-v1", reserve_cost=5)
        self.assertEqual(stage["attempt"], 1)
        self.ledger.finish_stage(run["run_id"], "draft_en", outcome="succeeded",
                                 actual_cost=4, output_sha256=INPUT_HASH)
        detail = self.ledger.show(run["run_id"])
        self.assertEqual(detail["run"]["budget_spent"], 7)
        self.assertEqual([event["kind"] for event in detail["events"]][:3],
                         ["created", "stage_started", "stage_finished"])
        self.assertEqual(detail["events"][1]["input_sha256"], STAGE_INPUT)
        self.assertEqual(detail["events"][1]["model_id"], "editorial-model-v1")
        self.assertEqual(detail["events"][2]["output_sha256"], OUTPUT_HASH)

    def test_full_stage_sequence_records_exact_publication_version(self):
        run, _ = self.create()
        for stage_name in editorial_run.STAGES:
            kwargs = ({"model_id": "editorial-model-v1", "reserve_cost": 5}
                      if stage_name in editorial_run.MODEL_STAGES else {})
            self.ledger.start_stage(run["run_id"], stage_name,
                                    input_sha256=STAGE_INPUT, **kwargs)
            finish = {"outcome": "succeeded", "output_sha256": OUTPUT_HASH}
            if stage_name == "prepublish":
                with self.assertRaisesRegex(editorial_run.LedgerError, "article id"):
                    self.ledger.finish_stage(run["run_id"], stage_name, **finish)
                finish.update(article_id="sample-article", article_version=3)
            self.ledger.finish_stage(run["run_id"], stage_name, **finish)
        detail = self.ledger.show(run["run_id"])
        self.assertEqual(detail["run"]["state"], "complete")
        self.assertEqual((detail["run"]["article_id"], detail["run"]["article_version"]),
                         ("sample-article", 3))
        self.assertEqual(detail["stages"][1]["model_id"], "editorial-model-v1")

    def test_budget_is_reserved_before_a_call_and_actual_overrun_holds_the_run(self):
        run, _ = self.create(budget_limit=10)
        self.ledger.start_stage(run["run_id"], "topic_selection",
                                input_sha256=STAGE_INPUT, reserve_cost=8,
                                model_id="editorial-model-v1")
        # A provider can exceed its estimate. Record the actual charge and stop
        # subsequent work instead of hiding the overrun.
        result = self.ledger.finish_stage(run["run_id"], "topic_selection",
                                          outcome="succeeded", actual_cost=11,
                                          output_sha256=OUTPUT_HASH)
        self.assertEqual(result["stage_state"], "held")
        self.assertEqual(result["run_state"], "budget_held")
        self.assertEqual(result["budget_spent"], 11)
        other, _ = self.create(topic_key="another-topic", budget_limit=10)
        self.ledger.start_stage(other["run_id"], "topic_selection",
                                input_sha256=STAGE_INPUT, reserve_cost=8,
                                model_id="editorial-model-v1")
        self.ledger.finish_stage(other["run_id"], "topic_selection", outcome="succeeded",
                                 actual_cost=8, output_sha256=OUTPUT_HASH)
        self.ledger.start_stage(other["run_id"], "evidence_brief", input_sha256=STAGE_INPUT,
                                model_id="editorial-model-v1", reserve_cost=1)
        self.ledger.finish_stage(other["run_id"], "evidence_brief", outcome="succeeded",
                                 actual_cost=1, output_sha256=OUTPUT_HASH)
        with self.assertRaisesRegex(editorial_run.LedgerError, "budget limit"):
            self.ledger.start_stage(other["run_id"], "draft_en",
                                    input_sha256=STAGE_INPUT, reserve_cost=3,
                                    model_id="editorial-model-v1")
        self.assertEqual(self.ledger.show(other["run_id"])["run"]["state"], "budget_held")

    def test_failed_attempts_are_bounded_and_each_attempt_is_audited(self):
        run, _ = self.create(max_attempts=2)
        for _ in range(2):
            self.ledger.start_stage(run["run_id"], "topic_selection", input_sha256=STAGE_INPUT,
                                    model_id="editorial-model-v1", reserve_cost=1)
            self.ledger.finish_stage(run["run_id"], "topic_selection", outcome="failed",
                                     actual_cost=1, error_code="provider_timeout")
        with self.assertRaisesRegex(editorial_run.LedgerError, "while failed"):
            self.ledger.start_stage(run["run_id"], "topic_selection", input_sha256=STAGE_INPUT,
                                    model_id="editorial-model-v1", reserve_cost=1)
        detail = self.ledger.show(run["run_id"])
        self.assertEqual(detail["run"]["state"], "failed")
        self.assertEqual(detail["stages"][0]["attempts"], 2)
        self.assertEqual(detail["run"]["budget_spent"], 2)

    def test_pause_and_resume(self):
        run, _ = self.create()
        self.ledger.pause(run["run_id"])
        with self.assertRaisesRegex(editorial_run.LedgerError, "while paused"):
            self.ledger.start_stage(run["run_id"], "topic_selection", input_sha256=STAGE_INPUT,
                                    model_id="editorial-model-v1", reserve_cost=1)
        resumed = self.ledger.resume(run["run_id"])
        self.assertEqual(resumed["state"], "ready")

    def test_resume_marks_a_crashed_stage_interrupted_and_releases_reservation(self):
        run, _ = self.create()
        self.ledger.start_stage(run["run_id"], "topic_selection",
                                input_sha256=STAGE_INPUT, reserve_cost=30,
                                model_id="editorial-model-v1")
        self.ledger.resume(run["run_id"])
        detail = self.ledger.show(run["run_id"])
        self.assertEqual(detail["run"]["state"], "ready")
        self.assertEqual(detail["run"]["budget_reserved"], 0)
        self.assertEqual(detail["stages"][0]["state"], "failed")
        self.assertEqual(detail["stages"][0]["error_code"], "interrupted")
        self.assertEqual(detail["run"]["budget_spent"], 30)
        retry = self.ledger.start_stage(run["run_id"], "topic_selection", input_sha256=STAGE_INPUT,
                                        model_id="editorial-model-v1", reserve_cost=10)
        self.assertEqual(retry["attempt"], 2)

    def test_concurrent_create_returns_one_run(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.create(), range(8)))
        self.assertEqual(sum(created for _, created in results), 1)
        self.assertEqual(len({run["run_id"] for run, _ in results}), 1)
        self.assertEqual(len(self.ledger.show(results[0][0]["run_id"])["events"]), 1)

    def test_error_codes_and_hashes_reject_text_and_malformed_values(self):
        run, _ = self.create()
        with self.assertRaisesRegex(editorial_run.LedgerError, "SHA-256"):
            self.ledger.start_stage(run["run_id"], "evidence_brief", input_sha256="draft body")
        self.ledger.start_stage(run["run_id"], "topic_selection", input_sha256=STAGE_INPUT,
                                model_id="editorial-model-v1", reserve_cost=1)
        with self.assertRaisesRegex(editorial_run.LedgerError, "error code"):
            self.ledger.finish_stage(run["run_id"], "topic_selection", outcome="failed",
                                     error_code="the secret prompt text")

    def test_symlink_ledger_is_refused(self):
        target = Path(self.temp.name) / "target.sqlite3"
        target.write_bytes(b"not a ledger")
        link = Path(self.temp.name) / "link.sqlite3"
        link.symlink_to(target)
        with self.assertRaisesRegex(editorial_run.LedgerError, "symbolic link"):
            editorial_run.EditorialRunLedger(link)


if __name__ == "__main__":
    unittest.main()
