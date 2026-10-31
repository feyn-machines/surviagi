"""Topic health: what counts as stalled, failed or in need of a person, and how its Issues follow."""

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_pipeline import topic_health, topic_mining  # noqa: E402

NOW = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)
SOUND = {name: True for name in topic_mining.CHECKS}


def topic(tid, obj, status="one_sided", opened=NOW - timedelta(days=30), claims=None, checks=SOUND, qtype="replacement"):
    claims = claims if claims is not None else [{"published_at": (NOW - timedelta(days=1)).isoformat()}]
    return {"id": tid, "object": obj, "question_type": qtype, "status": status, "checks": checks, "accounts": 1,
            "question": {"en": f"Will AI replace most {obj}s?", "zh-CN": f"AI 会取代大多数{obj}吗？"},
            "opened_at": opened.isoformat(), "claims": claims, "anchor": None}


def healthy(**changes):
    r = {"checked_at": NOW.isoformat(), "topics": 2, "topics_by_status": {"open": 1, "one_sided": 1, "fails": 0},
         "topics_unanchored": 0, "latest_mining_run": "topics-a", "hours_since_mining": 3.0,
         "latest_batches_failed": 0, "mining_runs_7d": 14, "claims_7d": 30, "new_topics_7d": 4,
         "last_topic_opened_at": NOW.isoformat(), "last_search_at": NOW.isoformat(), "hours_since_search": 3.0,
         "topics_ever_searched": 40, "latest_evidence_run": {"run_id": "e", "status": "completed"},
         "daily_window": "w", "daily_topic_steps": {}, "_topics": [topic("t:a", "accountant", "open")], "_searched": {}}
    return {**r, **changes}


class Findings(unittest.TestCase):
    def test_a_healthy_reading_finds_nothing(self):
        self.assertEqual(topic_health.findings(healthy(), NOW), {})

    def test_no_search_for_three_days_is_a_pipeline_problem(self):
        found = topic_health.findings(healthy(hours_since_search=470.0, last_search_at="2026-10-11T13:01:49+00:00"), NOW)
        self.assertEqual(list(found), ["pipeline"])
        self.assertIn("搜索回流 470.0 小时没有运行", found["pipeline"]["reasons"][0])

    def test_never_searched_and_never_mined_are_problems_too(self):
        found = topic_health.findings(healthy(hours_since_search=None, hours_since_mining=None), NOW)
        self.assertEqual(len(found["pipeline"]["reasons"]), 2)

    def test_failed_batches_failed_evidence_and_an_unfinished_daily_step_are_reasons(self):
        found = topic_health.findings(healthy(latest_batches_failed=2,
                                              latest_evidence_run={"run_id": "e", "status": "failed"},
                                              daily_topic_steps={"topic-search": {"finished": False, "exit": 1},
                                                                 "mine-topics": {"finished": True, "exit": 0}}), NOW)
        reasons = found["pipeline"]["reasons"]
        self.assertEqual(len(reasons), 3)
        self.assertTrue(any("topic-search 未完成（退出码 1）" in r for r in reasons))

    def test_no_new_topic_or_too_few_claims_in_a_week_is_stalled(self):
        self.assertIn("stalled", topic_health.findings(healthy(new_topics_7d=0), NOW))
        self.assertIn("stalled", topic_health.findings(healthy(claims_7d=9), NOW))
        self.assertNotIn("stalled", topic_health.findings(healthy(claims_7d=10, new_topics_7d=1), NOW))

    def test_one_sided_after_three_searches_and_two_weeks_lacks_evidence(self):
        young = topic("t:young", "nurse", opened=NOW - timedelta(days=3))
        old = topic("t:old", "pilot")
        open_ = topic("t:open", "judge", status="open")
        searched = {t: {"runs": 3} for t in ("t:young", "t:old", "t:open")}
        found = topic_health.findings(healthy(_topics=[young, old, open_], _searched=searched), NOW)
        self.assertEqual([i["key"] for i in found["evidence"]["items"]], ["one_sided:t:old"])

    def test_a_topic_nobody_argued_for_45_days_is_listed_as_quiet(self):
        quiet = topic("t:q", "typist", status="open", claims=[{"published_at": (NOW - timedelta(days=50)).isoformat()}])
        found = topic_health.findings(healthy(_topics=[quiet]), NOW)
        self.assertEqual(found["evidence"]["items"][0]["key"], "quiet:t:q")
        self.assertIn("50 天没有新主张", found["evidence"]["items"][0]["note"])

    def test_a_failed_standard_and_a_contained_object_need_a_person(self):
        failing = topic("t:f", "writer", status="fails", checks={**SOUND, "specific": False})
        found = topic_health.findings(healthy(_topics=[topic("t:m", "manager"), topic("t:mm", "middle manager"),
                                                       topic("t:v", "manager", qtype="viability"), failing]), NOW)
        keys = [i["key"] for i in found["review"]["items"]]
        self.assertEqual(keys, ["fails:t:f", "duplicate:t:m,t:mm"])
        self.assertIn("specific", found["review"]["items"][0]["note"])

    def test_an_object_is_matched_by_whole_words_only(self):
        pairs = topic_health.duplicate_pairs([topic("a", "artist"), topic("b", "martist"), topic("c", "3d artist")])
        self.assertEqual([(a["id"], b["id"]) for a, b in pairs], [("a", "c")])

    def test_a_resolved_item_is_not_listed_again(self):
        topics = [topic("t:m", "manager"), topic("t:wm", "wealth manager")]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "reviewed.json"
            with self.assertRaises(ValueError):
                topic_health.resolve(path, "duplicate:t:m,t:wm", " ", NOW)
            topic_health.resolve(path, "duplicate:t:m,t:wm", "different jobs", NOW)
            found = topic_health.findings(healthy(_topics=topics), NOW, topic_health.load_reviewed(path))
            self.assertNotIn("review", found)
            self.assertEqual(json.loads(path.read_text())[0]["reason"], "different jobs")


class DailyRecord(unittest.TestCase):
    def test_the_newest_readable_window_is_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            for tag, body in (("2026-10-29T0000_x", '{"steps": {}}'), ("2026-10-30T0000_x", "{"),
                              ("2026-10-29T1200_x", '{"steps": {"mine-topics": {"finished": true, "exit": 0}}}')):
                (Path(tmp) / tag).mkdir()
                (Path(tmp) / tag / "record.json").write_text(body)
            tag, record = topic_health.latest_daily_record(tmp)
            self.assertEqual(tag, "2026-10-29T1200_x")
            self.assertIn("mine-topics", record["steps"])
        self.assertEqual(topic_health.latest_daily_record(None), (None, {}))


class FakeGitHub:
    def __init__(self, issues=()):
        self.list, self.calls = list(issues), []

    def issues(self):
        return self.list

    def ensure_label(self):
        self.calls.append(("label",))

    def create(self, title, body):
        self.calls.append(("create", title, body))
        return "https://github.com/o/r/issues/99"

    def edit(self, number, body):
        self.calls.append(("edit", number, body))

    def comment(self, number, body):
        self.calls.append(("comment", number, body))

    def close(self, number, comment):
        self.calls.append(("close", number, comment))

    def reopen(self, number, comment):
        self.calls.append(("reopen", number, comment))


def issue(kind, number, state="OPEN", closed=None, first="2026-10-20T00:00Z", body=None):
    return {"number": number, "state": state, "closedAt": closed,
            "body": body or f"<!-- topic-health:{kind} first-seen={first} -->\nx\ny\nold"}


PIPELINE = {"pipeline": {"reasons": ["搜索回流没有运行"], "items": []}}


class Sync(unittest.TestCase):
    def test_a_new_finding_opens_one_labelled_issue_with_every_field(self):
        gh = FakeGitHub()
        actions = topic_health.sync(PIPELINE, healthy(), gh, NOW)
        self.assertEqual(actions, [{"kind": "pipeline", "do": "create", "title": topic_health.TITLES["pipeline"],
                                    "url": "https://github.com/o/r/issues/99"}])
        self.assertEqual(gh.calls[0], ("label",))
        body = gh.calls[1][2]
        self.assertTrue(body.startswith("<!-- topic-health:pipeline first-seen=2026-10-30T12:00Z -->"))
        for field in ("**类型**", "**状态**", "**触发原因**", "**当前读数**", "**建议处理**", "**自动关闭条件**"):
            self.assertIn(field, body)
        self.assertNotIn("| _topics", body)

    def test_an_open_issue_is_edited_quietly_and_keeps_when_it_was_first_seen(self):
        gh = FakeGitHub([issue("pipeline", 5)])
        self.assertEqual(topic_health.sync(PIPELINE, healthy(), gh, NOW), [{"kind": "pipeline", "do": "edit", "issue": 5}])
        self.assertIn("first-seen=2026-10-20T00:00Z", gh.calls[0][2])
        # The same body again changes nothing.
        unchanged = FakeGitHub([issue("pipeline", 5, body=gh.calls[0][2])])
        self.assertEqual(topic_health.sync(PIPELINE, healthy(), unchanged, NOW), [])

    def test_a_cleared_condition_closes_its_issue_with_a_comment(self):
        gh = FakeGitHub([issue("pipeline", 5), issue("review", 6, state="CLOSED", closed="2026-10-01T00:00:00Z")])
        self.assertEqual(topic_health.sync({}, healthy(), gh, NOW), [{"kind": "pipeline", "do": "close", "issue": 5}])
        self.assertIn("条件已解除", gh.calls[0][2])

    def test_a_condition_back_within_a_week_reopens_the_old_issue_else_opens_a_new_one(self):
        recent = FakeGitHub([issue("pipeline", 5, state="CLOSED", closed="2026-10-28T00:00:00Z")])
        self.assertEqual(topic_health.sync(PIPELINE, healthy(), recent, NOW)[0]["do"], "reopen")
        self.assertEqual([c[0] for c in recent.calls], ["reopen", "edit"])
        old = FakeGitHub([issue("pipeline", 5, state="CLOSED", closed="2026-10-01T00:00:00Z")])
        self.assertEqual(topic_health.sync(PIPELINE, healthy(), old, NOW)[0]["do"], "create")

    def test_issues_of_other_kinds_or_without_a_marker_are_left_alone(self):
        gh = FakeGitHub([issue("review", 6), {"number": 7, "state": "OPEN", "closedAt": None, "body": "hand written"}])
        self.assertEqual(topic_health.sync({}, healthy(), gh, NOW, only=["pipeline"]), [])
        self.assertEqual(gh.calls, [])

    def test_a_dry_run_says_what_it_would_do_and_does_nothing(self):
        gh = FakeGitHub([issue("review", 6)])
        actions = topic_health.sync(PIPELINE, healthy(), gh, NOW, dry_run=True)
        self.assertEqual([a["do"] for a in actions], ["create", "close"])
        self.assertEqual(gh.calls, [])

    def test_gh_is_called_with_the_label_and_the_repository(self):
        seen = []
        gh = topic_health.GitHub(repo="o/r", run=lambda argv: seen.append(argv) or "[]")
        gh.issues()
        gh.create("t", "b")
        self.assertEqual(seen[0][:4], ["gh", "issue", "list", "-R"])
        self.assertIn(topic_health.LABEL, seen[0])
        self.assertEqual(seen[1][-2:], ["--label", topic_health.LABEL])


if __name__ == "__main__":
    unittest.main()
