"""Offline unit tests for observation extraction: prefilter, prompt, assembly, cost.

Dependency-free on purpose (no psycopg, no network): this file runs under
`pnpm data:test:unit` with the system python.
"""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_pipeline import deepseek  # noqa: E402
from data_pipeline.observation_extraction import (  # noqa: E402
    ACTOR_ROLES, DIRECTIONS, assemble_observations, observation_id, prefilter)

TEXT = ("We moved month-end close to the agent. Reconciliation now takes 2 days instead of 6, "
        "but a person still signs off every entry.")


def post(sid="1", text=TEXT, handle="jane_cpa", official=False, relay=False):
    return {"source_id": sid, "handle": handle, "account_key": f"x:{handle}", "url": f"https://x.com/{handle}/status/{sid}",
            "published_at": datetime(2026, 10, 1, 12, tzinfo=timezone.utc), "text": text,
            "official": official, "relay": relay}


def item(**overrides):
    base = {"source_ids": ["1"], "actor": "jane_cpa", "actor_role": "practitioner", "subject": "Claude",
            "work": "accounting", "task": "Reconcile accounts at month-end close.",
            "evidence_type": "own_use", "outcome": "partly", "direction": "ai_takes_on",
            "facts": [{"value": "2", "unit": "days", "what": "time to reconcile", "baseline": "6 days",
                       "quote": "Reconciliation now takes 2 days instead of 6"}],
            "conditions": "a person still signs off every entry", "occurred_at": None,
            "quote": "We moved month-end close to the agent."}
    return {**base, **overrides}


class Prefilter(unittest.TestCase):
    def test_relays_and_posts_without_words_of_their_own_are_not_read(self):
        self.assertEqual(prefilter(post(relay=True)), "relay")
        self.assertEqual(prefilter(post(text="So clever https://t.co/abc @someone")), "too_short")
        self.assertIsNone(prefilter(post()))

    def test_a_chinese_character_counts_twice(self):
        self.assertIsNone(prefilter(post(text="我们把月末对账交给了智能体，原来要六天，现在两天，但每笔仍要人签字")))
        self.assertEqual(prefilter(post(text="Codex 今天送重置卡")), "too_short")


class Prompt(unittest.TestCase):
    def test_observations_extend_the_prompt_and_leave_the_daily_one_alone(self):
        plain, extended = deepseek.system_prompt(), deepseek.system_prompt(observations=True)
        self.assertTrue(extended.startswith(plain))
        self.assertNotIn("OBSERVATIONS", plain)
        for term in ACTOR_ROLES | DIRECTIONS:
            self.assertIn(f"- {term}:", extended)
        self.assertNotEqual(deepseek.prompt_sha256(), deepseek.observation_prompt_sha256())

    def test_the_prompt_asks_for_every_basis_and_for_failures(self):
        extended = deepseek.system_prompt(observations=True)
        for basis in ("vendor_claim", "production_use", "own_use", "measurement", "statistic"):
            self.assertIn(f"({basis}", extended)
        self.assertIn("acting without being asked", extended)


class Assembly(unittest.TestCase):
    def test_a_checked_observation_keeps_its_quote_facts_and_conditions(self):
        [obs], refused = assemble_observations([post()], [{"observations": [item()]}])
        self.assertEqual(refused, {})
        self.assertEqual(obs["actor_key"], "x:jane_cpa")
        self.assertEqual(obs["subject_key"], "claude")
        self.assertEqual(obs["work_key"], "unmapped")
        self.assertEqual(obs["occurred_on"], "2026-10-01")
        self.assertEqual(obs["sources"][0]["quote"], "We moved month-end close to the agent.")
        self.assertEqual(obs["facts"][0]["baseline"], "6 days")

    def test_a_quote_not_in_the_post_refuses_the_observation(self):
        observations, refused = assemble_observations(
            [post()], [{"observations": [item(quote="The agent closed the books alone.")]}])
        self.assertEqual(observations, [])
        self.assertEqual(refused, {"quote_not_in_source": 1})

    def test_a_term_outside_the_vocabulary_or_an_unknown_post_is_refused(self):
        batches = [{"observations": [item(direction="replaces_humans"), item(source_ids=["99"]),
                                     item(actor_role="vendor"), "not an object"]}]
        observations, refused = assemble_observations([post()], batches)
        self.assertEqual(observations, [])
        self.assertEqual(refused, {"bad_direction": 1, "no_known_source": 1, "bad_actor_role": 1,
                                   "not_an_object": 1})

    def test_a_fact_whose_quote_is_missing_is_dropped_not_the_observation(self):
        bad = {"value": "90", "unit": "%", "what": "accuracy", "quote": "90% accurate"}
        [obs], _ = assemble_observations([post()], [{"observations": [item(facts=[bad])]}])
        self.assertEqual(obs["facts"], [])
        self.assertEqual(obs["refused_facts"], 1)

    def test_one_actor_subject_and_work_on_one_day_told_twice_is_one_observation(self):
        posts = [post("1"), post("2", text=TEXT + " Week two, same result.")]
        batches = [{"observations": [item()]}, {"observations": [item(source_ids=["2"])]}]
        [obs], _ = assemble_observations(posts, batches)
        self.assertEqual([s["source_id"] for s in obs["sources"]], ["1", "2"])

    def test_different_work_by_the_same_actor_stays_apart(self):
        batches = [{"observations": [item(), item(work="auditing", task="Sample invoices for audit.")]}]
        self.assertEqual(len(assemble_observations([post()], batches)[0]), 2)

    def test_a_registered_company_is_its_org_id_and_a_stranger_stays_unresolved(self):
        batches = [{"observations": [item(actor="OpenAI", actor_role="maker", evidence_type="vendor_claim"),
                                     item(actor="Acme Bookkeeping LLC", actor_role="adopter", work="bookkeeping")]}]
        keys = sorted(o["actor_key"] for o in assemble_observations([post()], batches)[0])
        self.assertEqual(keys, ["org:openai", "unresolved:acme-bookkeeping-llc"])

    def test_the_id_is_obs_and_sixteen_hex_digits(self):
        self.assertRegex(observation_id("openai", "chatgpt", "unmapped", "2026-10-01"), r"^obs-[0-9a-f]{16}$")


class Cost(unittest.TestCase):
    def test_peak_hours_are_weekday_utc_windows(self):
        monday_02 = datetime(2026, 11, 2, 2, tzinfo=timezone.utc).timestamp()
        monday_05 = datetime(2026, 11, 2, 5, tzinfo=timezone.utc).timestamp()
        saturday_02 = datetime(2026, 11, 7, 2, tzinfo=timezone.utc).timestamp()
        self.assertEqual([deepseek.is_peak(t) for t in (monday_02, monday_05, saturday_02)], [True, False, False])

    def test_cost_prices_hits_misses_and_output_and_halves_off_peak(self):
        prices = {"cache_hit": 0.01, "cache_miss": 1.0, "output": 2.0}
        usage = {"prompt_tokens": 1_000_000, "prompt_cache_hit_tokens": 600_000,
                 "prompt_cache_miss_tokens": 400_000, "completion_tokens": 500_000}
        self.assertAlmostEqual(deepseek.call_cost(usage, prices, True), 0.006 + 0.4 + 1.0)
        self.assertAlmostEqual(deepseek.call_cost(usage, prices, False), (0.006 + 0.4 + 1.0) / 2)
        self.assertAlmostEqual(deepseek.call_cost({"prompt_tokens": 1_000_000}, prices, True), 1.0)


if __name__ == "__main__":
    unittest.main()
