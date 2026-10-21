"""Linking posts to events (rule:post-links-to-event), without a database."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_pipeline import post_events

T0 = datetime(2026, 9, 3, 18, tzinfo=timezone.utc)


def post(reply_to=None, quote_of=None, repost_of=None, hours=1, text=""):
    return {"reply_to": reply_to, "quote_of": quote_of, "repost_of": repost_of,
            "published_at": T0 + timedelta(hours=hours), "text": text}


EVENTS = {"astra": {"occurred_at": T0, "terms": "gpt 6 astra"}}


def links(seeds, posts, events=EVENTS):
    return {(e, s): (link, depth, via) for e, s, link, depth, via in post_events.build_links(seeds, posts, events)}


class ChainsFromTheSourcePost(unittest.TestCase):
    def test_the_source_post_is_depth_zero(self):
        got = links({"astra": ["s"]}, {"s": post()})
        self.assertEqual(got[("astra", "s")], ("source", 0, None))

    def test_replies_quotes_and_reposts_follow_the_chain(self):
        posts = {"s": post(), "r": post(reply_to="s"), "q": post(quote_of="s"), "p": post(repost_of="s"),
                 "rr": post(reply_to="r")}
        got = links({"astra": ["s"]}, posts)
        self.assertEqual(got[("astra", "r")], ("reply", 1, "s"))
        self.assertEqual(got[("astra", "q")], ("quote", 1, "s"))
        self.assertEqual(got[("astra", "p")], ("repost", 1, "s"))
        self.assertEqual(got[("astra", "rr")], ("reply", 2, "r"))

    def test_an_upstream_we_never_collected_still_links_if_it_is_the_source(self):
        """The source post id is known from the event even if a reply is all we hold."""
        got = links({"astra": ["s"]}, {"r": post(reply_to="s")})
        self.assertEqual(got[("astra", "r")], ("reply", 1, "s"))

    def test_one_post_can_belong_to_two_events(self):
        events = {"fable": {"occurred_at": T0, "terms": None}, "mythos": {"occurred_at": T0, "terms": None}}
        got = links({"fable": ["s"], "mythos": ["s"]}, {"s": post(), "q": post(quote_of="s")}, events)
        self.assertIn(("fable", "q"), got)
        self.assertIn(("mythos", "q"), got)

    def test_a_cycle_does_not_loop(self):
        posts = {"a": post(reply_to="b"), "b": post(reply_to="a")}
        self.assertEqual(set(links({"astra": ["s"]}, posts)), {("astra", "s")})

    def test_depth_is_capped(self):
        posts = {"s": post()}
        prev = "s"
        for i in range(10):
            posts[f"r{i}"] = post(reply_to=prev)
            prev = f"r{i}"
        got = links({"astra": ["s"]}, posts)
        self.assertNotIn(("astra", "r9"), got)
        self.assertIn(("astra", "r5"), got)


class Mentions(unittest.TestCase):
    def test_a_post_naming_the_product_within_a_week_is_a_mention(self):
        got = links({"astra": ["s"]}, {"s": post(), "m": post(hours=30, text="Tried GPT-6 Astra today")})
        self.assertEqual(got[("astra", "m")], ("mention", 1, None))

    def test_outside_the_week_is_not(self):
        got = links({"astra": ["s"]}, {"s": post(), "m": post(hours=24 * 8, text="GPT-6 Astra again")})
        self.assertNotIn(("astra", "m"), got)

    def test_before_the_event_is_not(self):
        got = links({"astra": ["s"]}, {"s": post(), "m": post(hours=-2, text="GPT-6 Astra leak?")})
        self.assertNotIn(("astra", "m"), got)

    def test_a_chain_link_wins_over_a_mention(self):
        got = links({"astra": ["s"]}, {"s": post(), "q": post(quote_of="s", text="GPT-6 Astra is here")})
        self.assertEqual(got[("astra", "q")][0], "quote")

    def test_a_mention_goes_to_the_latest_event_before_it_not_every_event_in_a_series(self):
        events = {"launch": {"occurred_at": T0, "terms": "gpt 6 astra"},
                  "rollout": {"occurred_at": T0 + timedelta(days=2), "terms": "gpt 6 astra"}}
        seeds = {"launch": ["s1"], "rollout": ["s2"]}
        posts = {"s1": post(), "s2": post(hours=48), "m": post(hours=60, text="GPT-6 Astra is great")}
        got = links(seeds, posts, events)
        self.assertIn(("rollout", "m"), got)
        self.assertNotIn(("launch", "m"), got)

    def test_a_mention_goes_to_the_most_specific_product(self):
        events = {"gpt5": {"occurred_at": T0, "terms": "gpt 5"},
                  "gpt55": {"occurred_at": T0, "terms": "gpt 5 5"}}
        posts = {"m": post(hours=3, text="GPT-5.5 retires next month")}
        got = links({"gpt5": ["a"], "gpt55": ["b"]}, posts, events)
        self.assertIn(("gpt55", "m"), got)
        self.assertNotIn(("gpt5", "m"), got)

    def test_a_reply_in_an_unrelated_thread_can_still_be_a_mention(self):
        got = links({"astra": ["s"]}, {"s": post(), "t": post(reply_to="own-thread", hours=5,
                                                               text="Part 2: GPT-6 Astra built the app")})
        self.assertEqual(got[("astra", "t")][0], "mention")

    def test_a_brand_that_prefixes_other_products_is_too_broad_to_mention(self):
        """'gemini' is every Gemini product; a post about Gemini 3.8 is not about this case study."""
        events = {"case": {"occurred_at": T0, "terms": "gemini"},
                  "flash": {"occurred_at": T0 - timedelta(days=30), "terms": "gemini 3 8 flash"}}
        posts = {"m": post(hours=5, text="Gemini is everywhere this week")}
        got = links({"case": ["a"], "flash": ["b"]}, posts, events)
        self.assertNotIn(("case", "m"), got)

    def test_a_repost_is_never_a_mention(self):
        got = links({"astra": ["s"]}, {"s": post(), "p": post(repost_of="elsewhere", text="GPT-6 Astra")})
        self.assertNotIn(("astra", "p"), got)


class AttachedByReading(unittest.TestCase):
    def test_a_post_the_extractor_attached_is_linked(self):
        rows = post_events.with_attached([("e1", "s1", "source", 0, None)], [("e1", "p9")])
        self.assertIn(("e1", "p9", "attached", 1, None), rows)

    def test_a_raw_link_is_not_replaced_by_an_attachment(self):
        rows = post_events.with_attached([("e1", "p9", "reply", 1, "s1")], [("e1", "p9")])
        self.assertEqual(rows, [("e1", "p9", "reply", 1, "s1")])


if __name__ == "__main__":
    unittest.main()
