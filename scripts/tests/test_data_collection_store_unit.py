"""Offline unit tests for crawler-run -> collection-store row building (no DB)."""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_pipeline.collection_store import build_rows, recover_renamed  # noqa: E402


def post(pid, created_utc, handle="OpenAI", author_id="4398626122", reply=False, text="hello"):
    return {
        "id": pid, "source_type": "x", "author": handle, "author_id": author_id,
        "url": f"https://x.com/{handle}/status/{pid}",
        "created_at": "Wed Sep 10 00:00:00 +0000 2026", "created_utc": created_utc,
        "text": text, "text_source": "legacy.full_text",
        "is_reply": reply, "is_repost": False, "quoted_post_id": None,
        "metrics": {"likes": 5, "reposts": 1, "replies": None, "quotes": 0, "bookmarks": 2, "views": 100},
        "metrics_observed_at": "2026-09-12T00:00:00+00:00", "metrics_updated_at": None,
    }


def run_doc(status="queries_exhausted", ok=True):
    pub = 1757462400.0  # 2026-09-10T00:00:00Z
    job_status = "search_ended" if status == "queries_exhausted" else "incomplete"
    return {
        "version": "crawler-run-1", "source": "x", "synthetic": False, "ok": ok, "status": status,
        "started_at": "2026-09-12T00:00:00+00:00", "finished_at": "2026-09-12T00:05:00+00:00",
        "concurrency": 2, "publication_window": {"start": "2026-09-08T00:00:00+00:00", "end": "2026-09-11T00:00:00+00:00"},
        "registry_sha256": "a" * 64, "implementation_sha256": {"engine.py": "b" * 64},
        "jobs": [{
            "id": "job1", "handle": "OpenAI", "company": "OpenAI", "status": job_status,
            "stop_reason": "window_start_reached" if job_status == "search_ended" else "transport_exhausted",
            "pages": 2, "accepted_count": 2, "attempts": 0, "account_label": "SCRAPER_ACCT_SECRET_LABEL",
            "window_start": "2026-09-08T00:00:00+00:00", "window_end": "2026-09-11T00:00:00+00:00",
            "posts": [post("111", pub + 100), post("222", pub + 200, reply=True)],
            "quarantine": [], "next_cursor": None,
            "requests": [{"page": 1, "raw_file": "00001.json", "raw_sha256": "c" * 64},
                         {"page": 2, "raw_file": "00002.json", "raw_sha256": "d" * 64}],
        }],
        "account_usage": {"jobs": [{"handle": "OpenAI", "account_label": "SCRAPER_ACCT_SECRET_LABEL"}],
                          "failovers": [], "pool_final": {}},
    }


class BuildRowsTests(unittest.TestCase):
    def test_builds_sources_captures_gaps(self):
        run, sources, captures, gaps = build_rows(run_doc(), "run-2026")
        self.assertEqual(run["run_id"], "run-2026")
        self.assertEqual(run["source_count"], 2)
        self.assertEqual(run["capture_count"], 2)
        self.assertEqual(len(run["raw_pages"]), 2)
        self.assertEqual(run["raw_pages"][0]["file"], "job1/00001.json")
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["status"], "complete")
        self.assertIsNone(gaps[0]["gap_note"])
        s = {r["source_id"]: r for r in sources}
        self.assertEqual(s["111"]["account_handle"], "OpenAI")
        self.assertEqual(s["111"]["canonical_url"], "https://x.com/OpenAI/status/111")
        self.assertTrue(s["222"]["is_reply"])
        self.assertTrue(isinstance(s["111"]["published_at"], datetime))

    def test_capture_preserves_null_metric_and_excerpt(self):
        _, _, captures, _ = build_rows(run_doc(), "r")
        c = {r["capture_id"]: r for r in captures}
        self.assertIsNone(c["111"]["metrics"]["replies"])   # null stays null
        self.assertEqual(c["111"]["metrics"]["views"], 100)
        self.assertEqual(c["111"]["public_excerpt"], "hello")
        self.assertEqual(len(c["111"]["text_sha256"]), 64)

    def test_no_scraper_account_label_leaks(self):
        run, sources, captures, gaps = build_rows(run_doc(), "r")
        blob = repr((run, sources, captures, gaps))
        self.assertNotIn("SCRAPER_ACCT_SECRET_LABEL", blob)  # collection store holds monitored, not scraper, identity

    def test_needs_attention_gap_marked_partial(self):
        _, _, _, gaps = build_rows(run_doc(status="needs_attention", ok=False), "r")
        self.assertEqual(gaps[0]["status"], "partial")
        self.assertEqual(gaps[0]["gap_note"], "transport_exhausted")

    def test_rejects_non_crawler_doc(self):
        with self.assertRaises(ValueError):
            build_rows({"version": "something-else", "status": "queries_exhausted", "jobs": []}, "r")

    def test_rejects_planned_run(self):
        with self.assertRaises(ValueError):
            build_rows({"version": "crawler-run-1", "status": "planned", "jobs": []}, "r")

    def test_run_sha256_is_deterministic(self):
        a = build_rows(run_doc(), "r")[0]["run_sha256"]
        b = build_rows(run_doc(), "r")[0]["run_sha256"]
        self.assertEqual(a, b)
        self.assertEqual(len(a), 64)


class RecoverRenamedTests(unittest.TestCase):
    """@Microsoft365 became @MSFTCopilot under the same id, and every post went to quarantine."""

    # 2026-09-10T00:00:00Z, inside the job's window; the older one is 2026-09-04.

    def doc(self, *held):
        doc = run_doc()
        doc["jobs"] = [{"id": "j1", "handle": "OpenAI", "company": "OpenAI", "status": "search_ended",
                        "stop_reason": "window_start_reached",
                        "window_start": "2026-09-08T00:00:00+00:00", "window_end": "2026-09-11T00:00:00+00:00",
                        "posts": [], "requests": [],
                        "quarantine": [{"post_id": p["id"], "reason": "author_identity_mismatch", "post": p}
                                       for p in held]}]
        return doc

    def test_a_renamed_accounts_post_in_its_window_comes_back_under_the_registered_handle(self):
        renamed = post("1", 1788998400.0, handle="OpenAIRenamed")
        doc = recover_renamed([("run-a", self.doc(renamed))], {"openai": "4398626122"}, "2026-10-16T00:00:00+00:00")
        [job] = doc["jobs"]
        [back] = job["posts"]
        self.assertEqual((back["author"], back["author_handle_seen"], job["recovered_from"]),
                         ("OpenAI", "OpenAIRenamed", "run-a"))
        self.assertEqual(doc["handle_changes"], [{"from": "OpenAI", "to": "OpenAIRenamed",
                                                  "first_post_id": "1", "first_seen_in": "run-a"}])
        # It ingests like any run, under the account it belongs to.
        _, sources, _, _ = build_rows(doc, "renamed-recovery")
        self.assertEqual([s["account_handle"] for s in sources], ["OpenAI"])

    def test_another_account_a_post_outside_the_window_and_a_repeat_stay_out(self):
        imposter = post("2", 1788998400.0, handle="Imposter", author_id="999")
        too_old = post("3", 1788500000.0, handle="OpenAIRenamed")
        kept = post("4", 1788998400.0, handle="OpenAIRenamed")
        runs = [("run-a", self.doc(imposter, too_old, kept)), ("run-b", self.doc(kept))]
        doc = recover_renamed(runs, {"openai": "4398626122"}, "2026-10-16T00:00:00+00:00")
        self.assertEqual([p["id"] for j in doc["jobs"] for p in j["posts"]], ["4"])
        self.assertEqual(doc["total"], 1)

    def test_nothing_to_recover_is_none(self):
        self.assertIsNone(recover_renamed([("run-a", self.doc())], {"openai": "4398626122"}, "now"))


if __name__ == "__main__":
    unittest.main()
