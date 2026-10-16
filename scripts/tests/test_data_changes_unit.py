"""The release-changes brief: what it counts as changed and how it says so. No database."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_pipeline import changes  # noqa: E402


def event(event_id, org="OpenAI", subject_key=None, kind="product_launch", engagement=None, **more):
    return {"event_id": event_id, "title": f"title {event_id}", "org_name": org,
            "primary_org_id": f"org:{org.lower()}" if org else None, "subject_key": subject_key,
            "subject": subject_key, "kind": kind, "occurred_at": "2026-10-15T00:00:00+00:00",
            "attention": {"engagement": engagement} if engagement else None,
            "source_urls": [f"https://x.com/a/status/{event_id}"], **more}


def activity(activity_id, level):
    return {"activity_id": activity_id, "label_en": activity_id, "label_zh_cn": f"工作{activity_id}",
            "market_zh_cn": "某赛道", "level": level, "best_tier": "T3"}


def payload(events=(), activities=(), evidence=(), topics=(), models=(), stages=None):
    return {"events": list(events),
            "chain": {"events": [{"event_id": r["event_id"]} for r in evidence], "evidence": list(evidence),
                      "activities": list(activities)},
            "topics": list(topics), "models": list(models),
            "progress": {"global": [{"stage": s, "coverage": "assessed", "work_items": n}
                                    for s, n in (stages or {}).items()]}}


class CanonicalSubjectsTest(unittest.TestCase):
    def test_a_maker_prefix_folds_into_the_key_in_use(self):
        events = [event("a", subject_key="decisions-api"),
                  event("b", org=None, subject_key="openai-decisions-api")]
        self.assertEqual(changes.canonical_subjects(events),
                         {"decisions-api": "decisions-api", "openai-decisions-api": "decisions-api"})

    def test_a_product_named_after_its_maker_stays_when_nothing_else_uses_the_rest(self):
        events = [event("a", org="Google", subject_key="google-workspace")]
        self.assertEqual(changes.canonical_subjects(events), {"google-workspace": "google-workspace"})

    def test_a_prefix_that_is_no_organisation_is_left_alone(self):
        events = [event("a", subject_key="opus-5-5"), event("b", subject_key="claude-opus-5-5")]
        self.assertEqual(changes.canonical_subjects(events)["claude-opus-5-5"], "claude-opus-5-5")


class CompareTest(unittest.TestCase):
    def setUp(self):
        old = payload(events=[event("e1", subject_key="gpt")],
                      activities=[activity("w1", None), activity("w2", 2.0)],
                      evidence=[{"event_id": "e1", "activity_id": "w2"}],
                      topics=[{"topic_id": "t1", "question": {"zh-CN": "旧问题"}, "claims": [1]}],
                      models=[{"model_id": "m1"}], stages={1: 5})
        new = payload(events=[event("e1", subject_key="gpt"), event("e2", subject_key="gpt", engagement=10),
                              event("e3", org="Google", subject_key="gemini", engagement=99)],
                      activities=[activity("w1", 2.0), activity("w2", 2.0)],
                      evidence=[{"event_id": "e1", "activity_id": "w2"}, {"event_id": "e2", "activity_id": "w1"}],
                      topics=[{"topic_id": "t1", "question": {"zh-CN": "旧问题"}, "claims": [1, 2, 3]},
                              {"topic_id": "t2", "question": {"zh-CN": "新问题"}, "claims": [1]}],
                      models=[{"model_id": "m1"}, {"model_id": "m2", "name": "M2", "owner": "OpenAI"}],
                      stages={1: 5, 2: 3})
        self.result = changes.compare(old, new)

    def test_new_updates_are_those_not_in_the_older_release_hottest_first(self):
        self.assertEqual([e["event_id"] for e in self.result["added_events"]], ["e3", "e2"])

    def test_a_level_change_names_the_new_evidence_behind_it(self):
        [changed] = self.result["level_changes"]
        self.assertEqual((changed["activity_id"], changed["was"], changed["now"], changed["new_events"]),
                         ("w1", None, 2.0, ["e2"]))

    def test_only_a_subject_with_two_new_updates_is_a_series(self):
        self.assertEqual(self.result["series"], [])
        self.assertEqual(self.result["counts"]["updates"], (1, 3))

    def test_topics_opened_and_topics_that_gained_claims_are_told_apart(self):
        self.assertEqual([t["topic_id"] for t in self.result["opened_topics"]], ["t2"])
        self.assertEqual([(t["topic_id"], t["gained"]) for t in self.result["grown_topics"]], [("t1", 2)])

    def test_new_models_and_stage_counts(self):
        self.assertEqual([m["model_id"] for m in self.result["new_models"]], ["m2"])
        self.assertEqual(self.result["stages"], ({1: 5}, {1: 5, 2: 3}))

    def test_the_brief_says_it_is_unreviewed_and_labels_kinds_in_chinese(self):
        text = changes.render(self.result, "OLD", "NEW")
        self.assertIn("未经人工审核", text)
        self.assertIn("产品首发", text)
        self.assertNotIn("product_launch", text)
        self.assertIn("工作w1", text)
        self.assertIn("无 → L2", text)
        self.assertIn("新问题", text)

    def test_two_identical_releases_report_nothing_new(self):
        same = payload(events=[event("e1")], activities=[activity("w1", 1.0)])
        text = changes.render(changes.compare(same, same), "A", "B")
        for line in ("没有工作的等级发生变化。", "没有新更新。", "没有新话题。", "没有新模型。"):
            self.assertIn(line, text)


class KindLabelTest(unittest.TestCase):
    def test_an_unknown_or_missing_kind_is_still_written(self):
        self.assertEqual(changes.kind_label(None), "类型未定")
        self.assertEqual(changes.kind_label("no_such_kind"), "no_such_kind")


if __name__ == "__main__":
    unittest.main()
