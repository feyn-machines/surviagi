"""Offline unit tests for mapping observations to the catalog and finding the ones that are one.

Dependency-free on purpose (no psycopg, no network): this file runs under
`pnpm data:test:unit` with the system python.
"""
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_pipeline.observation_mapping import (  # noqa: E402
    LIMITS, UNMAPPED, choose, merge_groups, prompt_sha256, user_message, work_key_of)

OFFERED = {"work": ["w:support", "w:billing", "w:legal"],
           "occupations": ["o:csr", "o:clerk"],
           "tasks": ["t:answer", "t:refund", "t:file"]}
TASK_OCCUPATION = {"t:answer": "o:csr", "t:refund": "o:csr", "t:file": "o:clerk"}


def entry(cid, why="same work"):
    return {"id": cid, "why": why}


def row(oid, work_key="w:support", day=date(2026, 9, 10), minute=0, actor="org:openai", subject="support-agent",
        stated=None, urls=None):
    return {"observation_id": oid, "actor_key": actor, "subject_key": subject, "work_key": work_key,
            "occurred_on": stated, "day": stated or day, "urls": urls or [f"https://x.com/OpenAI/status/{oid}"],
            "created_at": datetime(2026, 11, 3, 0, minute, tzinfo=timezone.utc)}


class Choose(unittest.TestCase):
    def test_only_offered_entries_are_kept_once_and_within_the_limits(self):
        answer = {"work": [entry("w:support"), entry("w:support"), entry("w:nowhere"), entry("w:billing"),
                           entry("w:legal")],
                  "occupations": [entry("o:csr")], "tasks": [entry("t:answer"), "not an object"]}
        picked = choose(answer, OFFERED, TASK_OCCUPATION)
        self.assertEqual([e["id"] for e in picked["work"]], ["w:support", "w:billing"])
        self.assertEqual(len(picked["work"]), LIMITS["work"])
        self.assertEqual([e["id"] for e in picked["tasks"]], ["t:answer"])

    def test_an_entry_offered_in_another_section_is_not_taken(self):
        picked = choose({"work": [entry("o:csr")], "occupations": [entry("w:support")]}, OFFERED, TASK_OCCUPATION)
        self.assertEqual(picked, {"work": [], "occupations": [], "tasks": []})

    def test_a_task_stays_only_under_an_occupation_that_was_picked(self):
        picked = choose({"occupations": [entry("o:csr")], "tasks": [entry("t:refund"), entry("t:file")]},
                        OFFERED, TASK_OCCUPATION)
        self.assertEqual([e["id"] for e in picked["tasks"]], ["t:refund"])

    def test_no_answer_is_no_entry(self):
        self.assertEqual(choose(None, OFFERED, TASK_OCCUPATION), {"work": [], "occupations": [], "tasks": []})
        self.assertEqual(choose({"work": "w:support"}, OFFERED, TASK_OCCUPATION)["work"], [])

    def test_the_reason_is_cut_short(self):
        picked = choose({"work": [entry("w:support", "x" * 500)]}, OFFERED, TASK_OCCUPATION)
        self.assertEqual(len(picked["work"][0]["why"]), 200)


class WorkKey(unittest.TestCase):
    def test_the_first_work_item_else_the_first_occupation_else_unmapped(self):
        self.assertEqual(work_key_of({"work": [entry("w:a"), entry("w:b")], "occupations": [entry("o:a")]}), "w:a")
        self.assertEqual(work_key_of({"work": [], "occupations": [entry("o:a")]}), "o:a")
        # A task alone never stands: it is kept only under a picked occupation.
        self.assertEqual(work_key_of({"work": [], "occupations": [], "tasks": []}), UNMAPPED)


class MergeGroups(unittest.TestCase):
    def test_the_same_actor_subject_work_and_day_merge_into_the_earliest(self):
        pairs = merge_groups([row("obs-b", minute=5), row("obs-a", minute=1), row("obs-c", minute=9)])
        self.assertEqual(pairs, [("obs-a", "obs-b"), ("obs-a", "obs-c")])

    def test_any_difference_keeps_them_apart(self):
        rows = [row("obs-a"), row("obs-b", work_key="w:billing"), row("obs-c", day=date(2026, 9, 11)),
                row("obs-d", actor="org:anthropic"), row("obs-e", subject="claude")]
        self.assertEqual(merge_groups(rows), [])

    def test_unmapped_observations_never_merge(self):
        self.assertEqual(merge_groups([row("obs-a", work_key=UNMAPPED), row("obs-b", work_key=UNMAPPED)]), [])

    def test_a_day_not_stated_meets_a_stated_one_through_the_post_they_share(self):
        post = ["https://x.com/OpenAI/status/1"]
        pairs = merge_groups([row("obs-a", urls=post), row("obs-b", stated=date(2026, 9, 8), urls=post, minute=1)])
        self.assertEqual(pairs, [("obs-a", "obs-b")])
        # Without a shared post, a different day is a different fact.
        self.assertEqual(merge_groups([row("obs-a"), row("obs-b", stated=date(2026, 9, 8), minute=1)]), [])

    def test_two_stated_days_stay_apart_even_from_one_post(self):
        post = ["https://x.com/OpenAI/status/1"]
        rows = [row("obs-a", stated=date(2026, 9, 8), urls=post), row("obs-b", stated=date(2026, 9, 9), urls=post),
                row("obs-c", urls=post, minute=2)]
        # The undated one joins the first; the second stated day keeps its own fact.
        self.assertEqual(merge_groups(rows), [("obs-a", "obs-c")])

    def test_a_tie_in_time_goes_to_the_smaller_id(self):
        self.assertEqual(merge_groups([row("obs-b"), row("obs-a")]), [("obs-a", "obs-b")])


class Prompt(unittest.TestCase):
    def test_the_message_lists_each_shortlist_with_its_labels(self):
        observation = {"actor_name": "OpenAI", "actor_role": "maker", "subject": "Support Agent",
                       "subject_key": "support-agent", "work": "customer support", "task": "Answer tickets.",
                       "evidence_type": "vendor_claim", "quote": "q" * 600}
        labels = {cid: cid.upper() for section in OFFERED.values() for cid in section}
        message = user_message(observation, OFFERED, labels)
        self.assertIn("w:support | W:SUPPORT", message)
        self.assertIn("t:file | T:FILE", message)
        self.assertNotIn("q" * 401, message)
        self.assertRegex(prompt_sha256(), r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
