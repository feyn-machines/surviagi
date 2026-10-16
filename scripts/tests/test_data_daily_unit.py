import json
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import data_daily as daily  # noqa: E402

NOW = datetime(2026, 10, 17, 3, 25, tzinfo=timezone.utc)
LAST_END = datetime(2026, 10, 16, 3, 0, tzinfo=timezone.utc)
STEP_NAMES = [s.name for s in daily.steps(daily.Window(LAST_END, NOW))]


class FakeRunner:
    """Answers each step by name; records what ran."""

    def __init__(self, answers=None):
        self.answers = answers or {}
        self.ran = []
        self.root = None

    def __call__(self, step, log):
        self.ran.append(step.name)
        if step.name == "extract-events" and "--output" in step.argv and step.name not in self.answers:
            # A clean extraction writes its record with no failed batches.
            output = self.root / step.argv[step.argv.index("--output") + 1]
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps({"params": {"failed_batches": []}}))
        answer = self.answers.get(step.name, (0, "{}"))
        if callable(answer):
            answer = answer()
        code, stdout = answer
        outcome = daily.Outcome(code, stdout, 1.0)
        outcome.result = daily.json_result(stdout)
        return outcome


class DailyCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.state = self.tmp / "daily" / "state.json"
        self.lines = []
        patcher = mock.patch.object(daily, "typesafe_preflight", lambda: None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def make(self, runner, collection_end=LAST_END, now=NOW):
        runner.root = self.tmp
        return daily.Daily(root=self.tmp, state_path=self.state, daily_dir=self.tmp / "daily", runner=runner,
                           now=lambda: now, collection_end=lambda: collection_end,
                           out=self.lines.append, sleep=lambda _s: None)

    def saved(self):
        return json.loads(self.state.read_text())


class WindowTest(DailyCase):
    def test_first_window_starts_where_the_newest_collection_ended_and_ends_at_the_last_full_hour(self):
        _, window = self.make(FakeRunner()).window(None)
        self.assertEqual(window.start, LAST_END)
        self.assertEqual(window.end, datetime(2026, 10, 17, 3, 0, tzinfo=timezone.utc))
        self.assertEqual(window.tag, "2026-10-16T0300_2026-10-17T0300")

    def test_two_windows_on_the_same_day_have_different_tags(self):
        morning = daily.Window(datetime(2026, 10, 16, 3, 0, tzinfo=timezone.utc), datetime(2026, 10, 16, 11, 0, tzinfo=timezone.utc))
        evening = daily.Window(morning.end, datetime(2026, 10, 16, 18, 0, tzinfo=timezone.utc))
        self.assertNotEqual(morning.tag, evening.tag)

    def test_a_window_shorter_than_six_hours_is_left_for_later(self):
        runner = FakeRunner()
        code = self.make(runner, now=datetime(2026, 10, 16, 8, 30, tzinfo=timezone.utc)).main([])
        self.assertEqual(code, 0)
        self.assertEqual(runner.ran, [])
        self.assertIn("nothing to do", self.lines[-1])

    def test_without_any_earlier_window_the_first_run_needs_a_start(self):
        code = self.make(FakeRunner(), collection_end=None).main([])
        self.assertEqual(code, 1)
        self.assertIn("--start", self.lines[-1])

    def test_newest_collection_end_reads_the_run_files(self):
        runs = self.tmp / "runs"
        runs.mkdir()
        for name, end in (("a", "2026-10-13T15:20:00+00:00"), ("b", "2026-10-16T03:00:00+00:00")):
            (runs / f"{name}.json").write_text(json.dumps({"publication_window": {"start": "x", "end": end}}))
        (runs / "broken.json").write_text("{")
        self.assertEqual(daily.newest_collection_end(runs), LAST_END)


class RunTest(DailyCase):
    def test_a_clean_run_processes_every_step_in_order_then_releases_and_promotes(self):
        runner = FakeRunner()
        code = self.make(runner).main(["--promote"])
        self.assertEqual(code, 0)
        self.assertEqual(runner.ran, STEP_NAMES + ["data:release", "data:promote"])
        state = self.saved()
        self.assertEqual(state["window_end"], "2026-10-17T03:00:00+00:00")
        self.assertNotIn("pending", state)

    def test_without_promote_the_release_is_verified_but_not_made_live(self):
        runner = FakeRunner()
        self.assertEqual(self.make(runner).main([]), 0)
        self.assertEqual(runner.ran[-1], "data:release")

    def test_a_failed_step_keeps_the_window_and_the_next_run_resumes_at_that_step(self):
        failing = FakeRunner({"route-events": (1, "")})
        self.assertEqual(self.make(failing).main(["--promote"]), 1)
        self.assertEqual(failing.ran, STEP_NAMES[:STEP_NAMES.index("route-events") + 1])
        state = self.saved()
        self.assertNotIn("window_end", state)
        self.assertEqual(state["pending"]["end"], "2026-10-17T03:00:00+00:00")

        # A day later the same window is finished first; nothing already done runs again.
        later = FakeRunner()
        tomorrow = datetime(2026, 10, 18, 3, 10, tzinfo=timezone.utc)
        self.assertEqual(self.make(later, now=tomorrow).main(["--promote"]), 0)
        self.assertEqual(later.ran, STEP_NAMES[STEP_NAMES.index("route-events"):] + ["data:release", "data:promote"])
        self.assertEqual(self.saved()["window_end"], "2026-10-17T03:00:00+00:00")

    def test_failed_or_fallback_batches_hold_the_release_back_from_going_live(self):
        routed = json.dumps({"events": 49, "fallback_batches": 0, "failed_batches": 2})
        runner = FakeRunner({"route-events": (0, "Routing...\n" + routed)})
        code = self.make(runner).main(["--promote"])
        self.assertEqual(code, 2)
        self.assertEqual(runner.ran[-1], "data:release")
        self.assertTrue(any("route-events: failed_batches = 2" in line for line in self.lines))
        # The window itself is complete: the data is in the snapshot and the release.
        self.assertEqual(self.saved()["window_end"], "2026-10-17T03:00:00+00:00")

    def test_a_crawl_that_needs_attention_is_processed_but_not_made_live(self):
        runner = FakeRunner({"crawl-panel": (2, "")})
        self.assertEqual(self.make(runner).main(["--promote"]), 2)
        self.assertNotIn("data:promote", runner.ran)
        self.assertIn("publish-snapshot", runner.ran)

    def test_a_crawl_that_is_rejected_stops_the_run(self):
        runner = FakeRunner({"crawl-official": (1, "")})
        self.assertEqual(self.make(runner).main(["--promote"]), 1)
        self.assertEqual(runner.ran, ["crawl-official"])

    def test_typesafe_unreachable_stops_before_the_first_judge_call(self):
        def blocked():
            raise daily.Stop("TypeSafe answers 451")
        runner = FakeRunner()
        with mock.patch.object(daily, "typesafe_preflight", blocked):
            self.assertEqual(self.make(runner).main(["--promote"]), 1)
        self.assertEqual(runner.ran, ["crawl-official", "crawl-panel", "extract-events"])
        self.assertIn("pending", self.saved())

    def test_partly_failed_extraction_is_read_from_its_output_file(self):
        extraction = self.tmp / "data" / "extraction" / "v230-2026-10-16T0300_2026-10-17T0300.json"

        def extract():
            extraction.parent.mkdir(parents=True)
            extraction.write_text(json.dumps({"params": {"failed_batches": [{"error": "x"}]}}))
            return 0, "{}"
        runner = FakeRunner({"extract-events": extract})
        self.assertEqual(self.make(runner).main(["--promote"]), 2)
        self.assertTrue(any("extract-events: failed_batches = 1" in line for line in self.lines))

    def test_an_extraction_file_left_by_a_stopped_run_is_ingested_not_extracted_again(self):
        extraction = self.tmp / "data" / "extraction" / "v230-2026-10-16T0300_2026-10-17T0300.json"
        extraction.parent.mkdir(parents=True)
        extraction.write_text("{}")
        argv = {s.name: s.argv for s in daily.steps(daily.Window(LAST_END, daily.last_full_hour(NOW)), self.tmp)}["extract-events"]
        self.assertEqual(argv[:3], ["pnpm", "-s", "data:ingest:events"])

    def test_the_release_is_retried_when_the_connection_drops(self):
        answers = iter([(1, ""), (0, "release r imported and verified")])
        runner = FakeRunner({"data:release": lambda: next(answers)})
        self.assertEqual(self.make(runner).main(["--promote"]), 0)
        self.assertEqual(runner.ran.count("data:release"), 2)

    def test_plan_prints_the_steps_and_runs_nothing(self):
        runner = FakeRunner()
        self.assertEqual(self.make(runner).main(["--plan"]), 0)
        self.assertEqual(runner.ran, [])
        self.assertTrue(any("crawl timeline --targets official --start 2026-10-16T03:00:00+00:00" in line
                            for line in self.lines))
        self.assertFalse(self.state.exists())


class PieceTest(unittest.TestCase):
    def test_json_result_is_the_last_object_printed(self):
        self.assertEqual(daily.json_result('progress\n{\n  "a": 1\n}\n'), {"a": 1})
        self.assertEqual(daily.json_result("no json here"), {})

    def test_problems_are_positive_counts_or_non_empty_lists_under_known_keys(self):
        found = daily.problems_in({"failed": 0, "x": {"batches_failed": 3}, "failed_batches": [], "seen": 9})
        self.assertEqual(found, ["x.batches_failed = 3"])

    def test_preflight_accepts_any_answer_but_a_region_block(self):
        def answering(code):
            def opener(request, timeout):
                raise urllib.error.HTTPError(request.full_url, code, "", {}, None)
            return opener
        daily.typesafe_preflight(opener=answering(401))
        daily.typesafe_preflight(opener=answering(403))
        with self.assertRaises(daily.Stop):
            daily.typesafe_preflight(opener=answering(451))

        def unreachable(request, timeout):
            raise urllib.error.URLError("timed out")
        with self.assertRaises(daily.Stop):
            daily.typesafe_preflight(opener=unreachable)


if __name__ == "__main__":
    unittest.main()
