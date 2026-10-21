"""Offline unit tests for event extraction: candidate selection, assembly, rows.

Dependency-free on purpose (no psycopg, no network): this file runs under
`pnpm data:test:unit` with the system python.
"""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_pipeline.event_extraction import (  # noqa: E402
    CURRENT_EVENT_KINDS, EVENT_KINDS, EVENT_KIND_VOCABULARY, ORGANIZATIONS, assemble_extraction,
    build_extraction_rows, dedup_key, event_id_for, event_times, resolve_org, select_candidates,
    title_dedup_key)
from data_pipeline import deepseek  # noqa: E402


def row(sid, published="2026-09-10T00:00:00+00:00", captured="2026-09-12T00:00:00+00:00",
        reply=False, repost=False, run="run-A"):
    return {"run_id": run, "source_id": sid, "platform": "x", "account_handle": "OpenAI",
            "company": "OpenAI", "canonical_url": f"https://x.com/OpenAI/status/{sid}",
            "is_reply": reply, "is_repost": repost, "published_at": published,
            "captured_at": captured, "public_excerpt": f"post {sid}", "metrics": {"views": 100}}


def cand(sid, run="run-A"):
    return {"run_id": run, "source_id": sid, "platform": "x", "handle": "OpenAI",
            "company": "OpenAI", "url": f"https://x.com/OpenAI/status/{sid}",
            "published_at": datetime(2026, 9, 10, tzinfo=timezone.utc), "excerpt": "x", "metrics": {},
            "account_key": "x:openai", "official": True}


def meta():
    return {"model": "deepseek-chat", "prompt_sha256": "a" * 64, "params": {"batch_size": 25},
            "window": None, "started_at": "2026-09-14T00:00:00+00:00",
            "finished_at": "2026-09-14T00:05:00+00:00", "status": "completed"}


def model_event(**overrides):
    """One event as the model returns it, under the controlled vocabulary."""
    event = {"kind": "product_launch", "title": "GPT-X", "summary": "s", "primary_org": "OpenAI",
             "subject_key": "gpt-x", "occurred_at": "2026-09-10T00:00:00+00:00",
             "occurrence_status": "occurred", "confidence": 0.9, "source_ids": ["1"]}
    event.update(overrides)
    return event


class SelectCandidatesTests(unittest.TestCase):
    def test_drops_reposts_and_replies(self):
        rows = [row("1"), row("2", repost=True), row("3", reply=True)]
        got = select_candidates(rows)
        self.assertEqual([c["source_id"] for c in got], ["1"])

    def test_keeps_latest_capture_per_post(self):
        rows = [row("1", captured="2026-09-12T00:00:00+00:00"),
                row("1", captured="2026-09-13T00:00:00+00:00", run="run-B")]
        got = select_candidates(rows)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["run_id"], "run-B")  # newer observation wins

    def test_the_model_reads_the_whole_post_not_the_excerpt(self):
        long_post = "GPT-X scores 91.2 on the benchmark. " * 20
        got = select_candidates([dict(row("1"), full_text=long_post)])
        self.assertEqual(got[0]["text"], long_post)
        self.assertEqual(got[0]["excerpt"], "post 1")  # the public excerpt is kept as it was
        self.assertIn(long_post, deepseek._post_message(got))

    def test_a_post_without_stored_full_text_falls_back_to_the_excerpt(self):
        got = select_candidates([row("1")])
        self.assertEqual(got[0]["text"], "post 1")
        self.assertIn("post 1", deepseek._post_message(got))

    def test_window_is_half_open(self):
        rows = [row("early", published="2026-09-07T00:00:00+00:00"),
                row("in", published="2026-09-09T00:00:00+00:00"),
                row("end", published="2026-09-11T00:00:00+00:00")]
        got = select_candidates(rows, {"start": "2026-09-08T00:00:00+00:00", "end": "2026-09-11T00:00:00+00:00"})
        self.assertEqual([c["source_id"] for c in got], ["in"])  # [start, end)


class AssembleTests(unittest.TestCase):
    def test_maps_events_and_resolves_sources(self):
        batches = [{"events": [model_event(source_ids=["1", "2"])]}]
        doc = assemble_extraction([cand("1"), cand("2")], batches, meta())
        self.assertEqual(len(doc["events"]), 1)
        e = doc["events"][0]
        self.assertEqual(e["event_id"], event_id_for(dedup_key("org:openai", "product_launch", "gpt-x")))
        self.assertEqual(e["primary_org_id"], "org:openai")
        self.assertEqual(e["kind_vocabulary"], EVENT_KIND_VOCABULARY)
        self.assertEqual(e["identity_confidence"], "high")
        self.assertIsNone(e["unresolved_reason"])
        self.assertEqual({s["source_id"] for s in e["sources"]}, {"1", "2"})
        self.assertEqual(doc["collection_run_ids"], ["run-A"])
        self.assertEqual(doc["dropped"], {})

    def test_event_without_known_source_is_dropped(self):
        batches = [{"events": [model_event(title="Ghost", source_ids=["999"])]}]
        doc = assemble_extraction([cand("1")], batches, meta())
        self.assertEqual(doc["events"], [])
        self.assertEqual(doc["dropped"]["no_known_source"], 1)

    def test_dedup_merges_sources_across_batches(self):
        batches = [{"events": [model_event(source_ids=["1"])]},
                   {"events": [model_event(source_ids=["2"])]}]
        doc = assemble_extraction([cand("1"), cand("2")], batches, meta())
        self.assertEqual(len(doc["events"]), 1)
        self.assertEqual({s["source_id"] for s in doc["events"][0]["sources"]}, {"1", "2"})

    def test_relation_resolved_by_local_index(self):
        batches = [{"events": [
            model_event(kind="availability_change", title="Agents API GA", subject_key="agents-api",
                        source_ids=["1"],
                        relations=[{"to_index": 1, "kind": "follows", "rationale": "GA follows beta"}]),
            model_event(kind="product_launch", title="Agents API beta", subject_key="agents-api-beta",
                        source_ids=["2"])]}]
        doc = assemble_extraction([cand("1"), cand("2")], batches, meta())
        rels = [r for e in doc["events"] for r in e["relations"]]
        self.assertEqual(len(rels), 1)
        self.assertEqual(rels[0]["kind"], "follows")
        self.assertEqual(rels[0]["to_event_id"],
                         event_id_for(dedup_key("org:openai", "product_launch", "agents-api-beta")))

    def test_invalid_category_filtered(self):
        batches = [{"events": [model_event(categories=[
            {"taxonomy": "bogus", "category_id": "c1", "taxonomy_version": "1"},
            {"taxonomy": "platform", "category_id": "coding", "taxonomy_version": "v1.0.0"}])]}]
        doc = assemble_extraction([cand("1")], batches, meta())
        cats = doc["events"][0]["categories"]
        self.assertEqual([c["category_id"] for c in cats], ["coding"])

    def test_doc_records_the_rubric_it_was_classified_under(self):
        doc = assemble_extraction([cand("1")], [{"events": [model_event()]}], meta())
        self.assertEqual(doc["kind_vocabulary"], EVENT_KIND_VOCABULARY)
        self.assertEqual(len(doc["rubric_sha256"]), 64)
        self.assertEqual(doc["schema_version"], "2.4.0")


def person_cand(sid, text, key="x:somebody"):
    return dict(cand(sid), handle="somebody", company=None, account_key=key, official=False, text=text)


class PostOutcomeTests(unittest.TestCase):
    """rule:post-outcome: a new update, attached to a known one, or dropped."""

    def use(self, **overrides):
        event = model_event(kind="usage_report", primary_org=None, subject_key="opus-5-5",
                            subject="Opus 5.5", basis="own_use", task="Build a browser extension.",
                            result="succeeded", quote="it worked in 90 seconds",
                            facts=[{"value": "90", "unit": "seconds", "what": "time to build",
                                    "quote": "worked in 90 seconds"}])
        event.update(overrides)
        return event

    def test_a_person_s_update_is_acted_by_their_account_and_names_no_company(self):
        post = person_cand("1", "I asked Opus 5.5 for an extension and it worked in 90 seconds.")
        event = assemble_extraction([post], [{"events": [self.use()]}], meta())["events"][0]
        self.assertEqual(event["actor_account_key"], "x:somebody")
        self.assertIsNone(event["primary_org_id"])
        self.assertEqual((event["basis"], event["task"], event["result"]),
                         ("own_use", "Build a browser extension.", "succeeded"))
        self.assertEqual(event["schema_version"], "2.4.0")

    def test_a_company_the_person_names_is_not_the_actor(self):
        post = person_cand("1", "it worked in 90 seconds")
        event = assemble_extraction([post], [{"events": [self.use(primary_org="OpenAI")]}], meta())["events"][0]
        self.assertIsNone(event["primary_org_id"])

    def test_someone_passing_on_their_own_company_s_announcement_is_a_relay(self):
        post = dict(person_cand("1", "We just launched GPT-X."), employer_org_id="org:openai")
        launch = model_event(primary_org=None, basis="vendor_claim")
        doc = assemble_extraction([post], [{"events": [launch]}], meta())
        self.assertEqual(doc["events"], [])
        self.assertEqual(doc["dropped"], {"relay_of_employer": 1})
        self.assertTrue(doc["post_outcomes"]["1"]["reason"].startswith("relay:"))

    def test_a_relay_account_never_makes_an_update_but_may_attach(self):
        post = dict(person_cand("1", "Gemini app skills are rolling out to everyone."), relay=True)
        doc = assemble_extraction([post], [{"events": [self.use(source_ids=["1"])]}], meta())
        self.assertEqual(doc["events"], [])
        self.assertEqual(doc["post_outcomes"]["1"]["reason"], "relay: relay_account")
        self.assertEqual(doc["model_output"][0]["events"][0]["kind"], "usage_report")  # kept for re-assembly
        attached = assemble_extraction(
            [post], [{"events": [], "attachments": [{"source_id": "1", "event_ref": "E1",
                                                     "event_title": "Gemini app adds Skills", "says": "Rolling out."}]}],
            meta(), known_events=self.known())
        self.assertEqual(attached["post_outcomes"]["1"], {"outcome": "attach", "event_id": "ev-skills"})

    def test_an_author_found_by_search_is_named_for_registration_only_when_they_make_an_update(self):
        rows = [dict(row("1"), account_handle="ColdNiko", account_external_id="11", company=None, panel_role=None,
                     full_text="Strata now runs it at 76 tokens per second."),
                dict(row("2"), account_handle="Passerby", account_external_id="22", company=None, panel_role=None)]
        found = select_candidates(rows)
        self.assertEqual(found[0]["account_key"], "x:coldniko")
        self.assertEqual(found[0]["unregistered"], {"handle": "ColdNiko", "platform_account_id": "11"})
        self.assertFalse(found[0]["official"])
        launch = model_event(primary_org=None, kind="capability_update", basis="vendor_claim",
                             title="Strata gets faster", subject="Strata", subject_key="strata", source_ids=["1"])
        doc = assemble_extraction(found, [{"events": [launch], "dropped": [{"source_id": "2", "reason": "chat"}]}], meta())
        self.assertEqual(doc["events"][0]["actor_account_key"], "x:coldniko")
        self.assertEqual(doc["new_accounts"], {"x:coldniko": {"handle": "ColdNiko", "platform_account_id": "11"}})

    def test_one_person_s_measurement_is_not_merged_into_another_s(self):
        posts = [person_cand("1", "On my 5090 it runs at 140 tokens per second.", "x:a"),
                 person_cand("2", "On my 3070 it runs at 31 tokens per second.", "x:b")]
        merged = self.use(kind="independent_evaluation", basis="measurement", source_ids=["1", "2"],
                          quote="it runs at 140 tokens per second",
                          facts=[{"value": "140", "unit": "tokens/s", "what": "speed", "quote": "140 tokens per second"},
                                 {"value": "31", "unit": "tokens/s", "what": "speed", "quote": "31 tokens per second"}])
        doc = assemble_extraction(posts, [{"events": [merged]}], meta())
        event = doc["events"][0]
        self.assertEqual((event["actor_account_key"], [s["source_id"] for s in event["sources"]]), ("x:a", ["1"]))
        self.assertEqual([f["value"] for f in event["facts"]], ["140"])
        self.assertEqual(doc["post_outcomes"]["2"], {"outcome": "unaccounted"})

    def test_a_listed_account_is_never_named_for_registration(self):
        doc = assemble_extraction([cand("1")], [{"events": [model_event()]}], meta())
        self.assertEqual(doc["new_accounts"], {})

    def test_a_relay_of_an_update_we_hold_is_attached_to_it(self):
        relay = dict(person_cand("1", "Google releases Gemini 4 Argon."), relay=True)
        relayed = model_event(primary_org=None, basis="vendor_claim", title="Google releases Gemini 4 Argon",
                              subject_key="gemini-4-argon", source_ids=["1"])
        official = model_event(primary_org="Google", title="Gemini 4 Argon", subject_key="gemini-4-argon",
                               source_ids=["2"])
        same_run = assemble_extraction([relay, cand("2")], [{"events": [relayed, official]}], meta())
        self.assertEqual(len(same_run["events"]), 1)
        self.assertEqual(same_run["post_outcomes"]["1"],
                         {"outcome": "attach", "event_id": same_run["events"][0]["event_id"]})
        stored = {"E1": {"event_id": "ev-argon", "title": "Gemini 4 Argon", "subject_key": "gemini-4-argon",
                         "primary_org_id": "org:google"}}
        earlier = assemble_extraction([relay], [{"events": [relayed]}], meta(), known_events=stored)
        self.assertEqual(earlier["attachments"][0]["event_id"], "ev-argon")
        nothing = assemble_extraction([relay], [{"events": [relayed]}], meta())
        self.assertEqual(nothing["post_outcomes"]["1"], {"outcome": "drop", "reason": "relay: relay_account"})

    def test_a_non_official_post_that_fits_no_kind_is_dropped_not_kept(self):
        post = person_cand("1", "lovely weather")
        junk = model_event(primary_org=None, kind=None, unresolved_reason="A joke with no update content.")
        doc = assemble_extraction([post], [{"events": [junk]}], meta())
        self.assertEqual(doc["events"], [])
        self.assertEqual(doc["post_outcomes"]["1"], {"outcome": "drop", "reason": "A joke with no update content."})

    def test_a_retired_kind_from_the_model_is_dropped(self):
        doc = assemble_extraction([cand("1")], [{"events": [model_event(kind="event_announcement")]}], meta())
        self.assertEqual(doc["events"], [])
        self.assertEqual(doc["dropped"], {"retired_kind": 1})

    def test_a_registered_company_s_claim_repeated_by_an_outsider_is_a_relay(self):
        post = person_cand("1", "Google releases Gemini 4 Argon.")
        launch = model_event(primary_org=None, basis="vendor_claim", title="Google releases Gemini 4 Argon",
                             subject="Gemini 4 Argon")
        doc = assemble_extraction([post], [{"events": [launch]}], meta())
        self.assertEqual(doc["dropped"], {"relay_of_registered_company": 1})

    def test_an_outsider_s_own_tool_is_their_own_claim(self):
        post = person_cand("1", "My tool Nativ 0.4 now browses the web.")
        launch = model_event(primary_org=None, basis="vendor_claim", title="Nativ v0.4.0 adds web browsing",
                             subject="Nativ", subject_key="nativ-0-4-0")
        doc = assemble_extraction([post], [{"events": [launch]}], meta())
        self.assertEqual(len(doc["events"]), 1)

    def test_an_official_source_decides_the_actor_whoever_else_wrote_about_it(self):
        employee = dict(person_cand("1", "We just launched GPT-X."), employer_org_id="org:openai")
        launch = model_event(basis="vendor_claim", source_ids=["1", "2"])
        doc = assemble_extraction([employee, cand("2")], [{"events": [launch]}], meta())
        self.assertEqual(len(doc["events"]), 1)
        self.assertEqual(doc["events"][0]["actor_account_key"], "x:openai")
        self.assertEqual(doc["events"][0]["primary_org_id"], "org:openai")

    def test_official_accounts_are_read_under_their_own_prompt(self):
        official, other = deepseek.system_prompt(official=True), deepseek.system_prompt()
        self.assertNotIn("Relays:", official)
        self.assertIn("never a relay", official)
        self.assertIn("Relays:", other)
        seen = []
        original = deepseek.chat
        deepseek.chat = lambda messages, cfg, timeout=120: seen.append(messages[0]["content"]) or {"events": []}
        try:
            deepseek.extract_events([person_cand("1", "a"), cand("2")], cfg={"model": "m"}, batch_size=20)
        finally:
            deepseek.chat = original
        self.assertEqual(seen, [official, other])

    def test_the_same_person_s_own_first_hand_use_is_still_an_update(self):
        post = dict(person_cand("1", "it worked in 90 seconds"), employer_org_id="org:openai")
        doc = assemble_extraction([post], [{"events": [self.use()]}], meta())
        self.assertEqual(len(doc["events"]), 1)

    def test_two_people_reporting_the_same_subject_are_two_updates(self):
        posts = [person_cand("1", "it worked in 90 seconds", "x:a"), person_cand("2", "it worked in 90 seconds", "x:b")]
        doc = assemble_extraction(posts, [{"events": [self.use(source_ids=["1"]), self.use(source_ids=["2"])]}], meta())
        self.assertEqual(len(doc["events"]), 2)

    def test_a_fact_is_kept_only_when_its_quote_is_in_the_post(self):
        post = person_cand("1", "It  WORKED in 90\nseconds, cost me $2.")
        facts = [{"value": "90", "unit": "seconds", "what": "time", "quote": "worked in 90 seconds"},
                 {"value": "5", "unit": "x", "what": "speedup", "quote": "five times faster"},
                 {"value": "2", "unit": "USD", "what": "cost", "quote": "cost me $2"}]
        doc = assemble_extraction([post], [{"events": [self.use(facts=facts)]}], meta())
        self.assertEqual([f["value"] for f in doc["events"][0]["facts"]], ["90", "2"])
        self.assertEqual(doc["events"][0]["facts"][0]["source_id"], "1")
        self.assertEqual(doc["facts_refused"], 1)

    def test_the_work_and_its_result_belong_to_use_kinds_only(self):
        launch = model_event(task="Announce it.", result="succeeded")
        event = assemble_extraction([cand("1")], [{"events": [launch]}], meta())["events"][0]
        self.assertIsNone(event["task"])
        self.assertIsNone(event["result"])

    def test_a_basis_outside_the_vocabulary_is_left_empty(self):
        event = assemble_extraction([cand("1")], [{"events": [model_event(basis="hearsay")]}], meta())["events"][0]
        self.assertIsNone(event["basis"])

    def test_every_post_gets_one_outcome(self):
        posts = [person_cand("1", "it worked in 90 seconds"), person_cand("2", "watermark is off by default in the API"),
                 person_cand("3", "lovely weather"), person_cand("4", "hm"), person_cand("5", "also this")]
        batch = {"events": [self.use()],
                 "attachments": [{"source_id": "2", "event_ref": "E1", "says": "Off by default in the API.",
                                  "quote": "off by default in the API"},
                                 {"source_id": "5", "event_ref": "E9", "says": "x"}],
                 "dropped": [{"source_id": "3", "reason": "weather"}]}
        doc = assemble_extraction(posts, [batch], meta(), known_events={"E1": "ev-known"})
        outcomes = doc["post_outcomes"]
        self.assertEqual(outcomes["1"]["outcome"], "new_event")
        self.assertEqual(outcomes["2"], {"outcome": "attach", "event_id": "ev-known"})
        self.assertEqual(outcomes["3"], {"outcome": "drop", "reason": "weather"})
        self.assertEqual(outcomes["4"], {"outcome": "unaccounted"})
        self.assertEqual(outcomes["5"], {"outcome": "drop", "reason": "attachment refused: names_no_listed_update"})
        self.assertEqual(doc["attachments"], [{"event_id": "ev-known", "source_id": "2",
                                               "says": "Off by default in the API.",
                                               "quote": "off by default in the API"}])

    def known(self):
        return {"E1": {"event_id": "ev-skills", "title": "Gemini app adds Skills", "subject_key": "gemini-app-skills",
                       "primary_org_id": "org:google"},
                "E2": {"event_id": "ev-credits", "title": "OpenAI adds credits for Pro users",
                       "subject_key": "chatgpt-pro-credits", "primary_org_id": "org:openai"}}

    def attach(self, post, **raw):
        raw = {"source_id": post["source_id"], "says": "It adds a detail.", **raw}
        return assemble_extraction([post], [{"events": [], "attachments": [raw]}], meta(), known_events=self.known())

    def test_the_copied_title_decides_when_the_ref_slipped_a_row(self):
        post = person_cand("1", "ChatGPT Pro users got 62,500 credits back.")
        doc = self.attach(post, event_ref="E1", event_title="OpenAI adds credits for Pro users")
        self.assertEqual(doc["post_outcomes"]["1"], {"outcome": "attach", "event_id": "ev-credits"})

    def test_an_attachment_whose_title_matches_nothing_is_refused(self):
        post = person_cand("1", "ChatGPT Pro users got 62,500 credits back.")
        doc = self.attach(post, event_ref="E1", event_title="Some other update")
        self.assertEqual(doc["attachments"], [])
        self.assertEqual(doc["post_outcomes"]["1"]["reason"], "attachment refused: names_no_listed_update")

    def test_a_post_that_never_names_the_update_is_not_attached_to_it(self):
        post = person_cand("1", "Pro users got 62,500 credits back.")
        doc = self.attach(post, event_ref="E1", event_title="Gemini app adds Skills")
        self.assertEqual(doc["attachments"], [])
        self.assertEqual(doc["dropped"], {"attachment_does_not_name_the_update": 1})

    def test_a_company_account_attaches_only_to_its_own_update(self):
        post = dict(cand("1"), text="Skills in the Gemini app are neat.")  # an OpenAI official account
        doc = self.attach(post, event_ref="E1", event_title="Gemini app adds Skills")
        self.assertEqual(doc["post_outcomes"]["1"]["reason"], "attachment refused: another_company_s_update")

    def test_posts_read_again_land_on_the_update_they_already_made(self):
        prior = {"1": [{"event_id": "ev-stored", "dedup_key": "openai|product_launch|gpt-x-old-name"}]}
        doc = assemble_extraction([cand("1")], [{"events": [model_event(subject_key="gpt-x-new-name")]}],
                                  meta(), prior=prior)
        self.assertEqual(doc["events"][0]["event_id"], "ev-stored")
        self.assertEqual(doc["events"][0]["dedup_key"], "openai|product_launch|gpt-x-old-name")
        self.assertEqual(doc["reidentified"], 1)

    def test_an_earlier_document_is_still_ingestible(self):
        doc = assemble_extraction([cand("1")], [{"events": [model_event()]}], meta())
        doc["version"] = "event-extraction-2"
        doc["kind_vocabulary"] = "event_kind-2.0.0"
        for event in doc["events"]:
            event["kind_vocabulary"] = "event_kind-2.0.0"
            for name in ("actor_account_key", "subject", "basis", "task", "result", "quote", "schema_version", "facts"):
                event.pop(name, None)
        _, events, *_ = build_extraction_rows(doc, "r")
        self.assertEqual(events[0]["kind_vocabulary"], "event_kind-2.0.0")
        self.assertIsNone(events[0]["schema_version"])


class EventTimesTests(unittest.TestCase):
    POSTED = datetime(2026, 10, 4, 10, 0, 11, tzinfo=timezone.utc)
    LATER = datetime(2026, 10, 6, tzinfo=timezone.utc)

    def test_a_date_after_the_post_is_the_planned_date(self):
        self.assertEqual(event_times(self.LATER, None, [self.POSTED]), (self.POSTED, self.LATER))

    def test_a_given_planned_date_is_kept(self):
        planned = datetime(2026, 10, 7, tzinfo=timezone.utc)
        self.assertEqual(event_times(self.LATER, planned, [self.POSTED]), (self.POSTED, planned))

    def test_the_newest_source_post_is_the_limit(self):
        newer = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        self.assertEqual(event_times(self.LATER, None, [self.POSTED, newer]), (self.LATER, None))

    def test_past_and_missing_dates_are_unchanged(self):
        earlier = datetime(2026, 10, 1, tzinfo=timezone.utc)
        self.assertEqual(event_times(earlier, None, [self.POSTED]), (earlier, None))
        self.assertEqual(event_times(None, self.LATER, [self.POSTED]), (None, self.LATER))


class KindTests(unittest.TestCase):
    """There is no "other" bucket: an undecided kind is null plus a reason."""

    def assemble(self, **overrides):
        batches = [{"events": [model_event(**overrides)]}]
        return assemble_extraction([cand("1")], batches, meta())["events"][0]

    def test_unknown_kind_becomes_null_with_a_reason(self):
        event = self.assemble(kind="launch")  # a term from the old free-text list
        self.assertIsNone(event["kind"])
        self.assertIn("launch", event["unresolved_reason"])
        self.assertTrue(event["unresolved_reason"].strip())

    def test_unknown_kind_is_never_coerced_to_other(self):
        for value in ("launch", "other", "misc", "", None, 7):
            with self.subTest(value=value):
                event = self.assemble(kind=value)
                self.assertNotEqual(event["kind"], "other")
                self.assertIsNone(event["kind"])
                self.assertTrue((event["unresolved_reason"] or "").strip())
        self.assertNotIn("other", EVENT_KINDS)

    def test_model_supplied_reason_is_kept_for_a_null_kind(self):
        event = self.assemble(kind=None, unresolved_reason="between version_release and capability_update")
        self.assertIsNone(event["kind"])
        self.assertEqual(event["unresolved_reason"], "between version_release and capability_update")

    def test_null_kind_without_a_model_reason_still_gets_one(self):
        event = self.assemble(kind=None)
        self.assertIsNone(event["kind"])
        self.assertTrue(event["unresolved_reason"].strip())

    def test_every_controlled_term_is_accepted(self):
        for kind in sorted(CURRENT_EVENT_KINDS):
            with self.subTest(kind=kind):
                event = self.assemble(kind=kind)
                self.assertEqual(event["kind"], kind)
                self.assertIsNone(event["unresolved_reason"])

    def test_resolved_kind_ignores_a_stray_model_reason(self):
        event = self.assemble(kind="product_launch", unresolved_reason="not sure")
        self.assertEqual(event["kind"], "product_launch")
        self.assertIsNone(event["unresolved_reason"])


class IdentityTests(unittest.TestCase):
    """Identity is (org, kind, subject); the title is display text only."""

    def test_two_titles_one_event(self):
        # The regression: "Qwen3.8-Max-0902 tops CodeArena WebDev" arrived in four
        # wordings and became four events. Same triple -> one event id.
        wordings = ["Qwen3.8-Max-0902 tops CodeArena WebDev",
                    "Alibaba's Qwen3.8-Max-0902 takes #1 on CodeArena WebDev",
                    "New #1 on CodeArena WebDev: Qwen3.8-Max-0902",
                    "CodeArena WebDev leaderboard now led by Qwen3.8-Max-0902"]
        batches = [{"events": [
            model_event(kind="benchmark_result", primary_org="Alibaba", title=title,
                        subject_key="codearena-webdev", source_ids=[str(i + 1)])
            for i, title in enumerate(wordings)]}]
        doc = assemble_extraction([cand(str(i + 1)) for i in range(4)], batches, meta())
        self.assertEqual(len(doc["events"]), 1)
        self.assertEqual({s["source_id"] for s in doc["events"][0]["sources"]}, {"1", "2", "3", "4"})
        self.assertEqual(doc["events"][0]["identity_confidence"], "high")

    def test_subject_key_is_canonicalised_before_comparison(self):
        batches = [{"events": [model_event(subject_key="Wan 3.0", source_ids=["1"]),
                               model_event(subject_key="wan-3.0", source_ids=["2"])]}]
        doc = assemble_extraction([cand("1"), cand("2")], batches, meta())
        self.assertEqual(len(doc["events"]), 1)
        self.assertEqual(doc["events"][0]["subject_key"], "wan-3-0")

    def test_different_kind_is_a_different_event(self):
        batches = [{"events": [model_event(kind="product_launch", source_ids=["1"]),
                               model_event(kind="availability_change", source_ids=["2"])]}]
        doc = assemble_extraction([cand("1"), cand("2")], batches, meta())
        self.assertEqual(len(doc["events"]), 2)

    def test_missing_subject_key_falls_back_to_the_title_slug(self):
        for missing in (None, "", "   "):
            with self.subTest(missing=missing):
                batches = [{"events": [model_event(subject_key=missing, title="GPT-X ships")]}]
                event = assemble_extraction([cand("1")], batches, meta())["events"][0]
                self.assertIsNone(event["subject_key"])
                self.assertEqual(event["identity_confidence"], "low")
                self.assertEqual(event["dedup_key"], title_dedup_key("org:openai", "GPT-X ships"))
                self.assertEqual(event["event_id"], event_id_for(event["dedup_key"]))


class OrganisationTests(unittest.TestCase):
    """A company is an id. Two spellings of xAI used to be two companies."""

    def test_xai_spellings_resolve_to_one_id(self):
        self.assertEqual(resolve_org("xAI"), "org:xai")
        self.assertEqual(resolve_org("xAI / SpaceXAI"), "org:xai")
        self.assertEqual(resolve_org("xai/spacexai"), "org:xai")

    def test_the_thirteen_companies_resolve(self):
        observed = ["Google", "Google DeepMind", "Alibaba", "Microsoft", "OpenAI", "Tencent",
                    "MiniMax", "Anthropic", "Meta", "xAI", "xAI / SpaceXAI", "ByteDance",
                    "Zhipu / Z.ai", "DeepSeek", "Moonshot / Kimi"]
        for name in observed:
            with self.subTest(name=name):
                self.assertIn(resolve_org(name), ORGANIZATIONS)
        self.assertEqual(len(ORGANIZATIONS), 13)
        self.assertEqual(resolve_org("Google DeepMind"), resolve_org("Google"))

    def test_two_spellings_of_one_company_make_one_event(self):
        batches = [{"events": [
            model_event(primary_org="xAI", subject_key="grok-5", source_ids=["1"]),
            model_event(primary_org="xAI / SpaceXAI", subject_key="grok-5", source_ids=["2"])]}]
        doc = assemble_extraction([cand("1"), cand("2")], batches, meta())
        self.assertEqual(len(doc["events"]), 1)
        self.assertEqual(doc["events"][0]["primary_org_id"], "org:xai")

    def test_unknown_org_is_dropped_and_counted(self):
        batches = [{"events": [model_event(primary_org="Acme Robotics"),
                               model_event(primary_org="OpenAI", source_ids=["2"])]}]
        doc = assemble_extraction([cand("1"), cand("2")], batches, meta())
        self.assertIsNone(resolve_org("Acme Robotics"))
        self.assertEqual([e["primary_org_id"] for e in doc["events"]], ["org:openai"])
        self.assertEqual(doc["dropped"]["unresolved_org"], 1)
        self.assertEqual(doc["unresolved_orgs"], ["Acme Robotics"])  # name to add an alias for

    def test_missing_org_is_dropped_and_counted(self):
        batches = [{"events": [model_event(primary_org=None)]}]
        doc = assemble_extraction([cand("1")], batches, meta())
        self.assertEqual(doc["events"], [])
        self.assertEqual(doc["dropped"]["missing_org"], 1)
        self.assertEqual(doc["unresolved_orgs"], [])


class BuildRowsTests(unittest.TestCase):
    def doc(self, **overrides):
        event = model_event(source_ids=["1", "2"], categories=[
            {"taxonomy": "platform", "taxonomy_version": "v1.0.0", "category_id": "coding",
             "confidence": 0.8, "rationale": "code"}], **overrides)
        return assemble_extraction([cand("1"), cand("2")], [{"events": [event]}], meta())

    def test_builds_event_layer_rows(self):
        run, events, sources, relations, categories = build_extraction_rows(self.doc(), "extract-1")
        self.assertEqual(run["event_count"], 1)
        self.assertEqual(len(events), 1)
        self.assertEqual(len(sources), 2)
        self.assertEqual(len(categories), 1)
        self.assertEqual(events[0]["first_extraction_run_id"], "extract-1")
        self.assertEqual(len(events[0]["record_sha256"]), 64)
        self.assertTrue(isinstance(events[0]["occurred_at"], datetime))
        self.assertEqual(categories[0]["method"], "ai_deepseek")

    def test_rows_carry_the_semantic_columns(self):
        events = build_extraction_rows(self.doc(), "r")[1]
        self.assertEqual(events[0]["kind_vocabulary"], EVENT_KIND_VOCABULARY)
        self.assertEqual(events[0]["primary_org_id"], "org:openai")
        self.assertEqual(events[0]["subject_key"], "gpt-x")
        self.assertEqual(events[0]["identity_confidence"], "high")
        self.assertIsNone(events[0]["unresolved_reason"])

    def test_unresolved_kind_row_keeps_a_reason(self):
        # extracted_events_kind_check: a null kind is only legal with a reason.
        events = build_extraction_rows(self.doc(kind="launch"), "r")[1]
        self.assertIsNone(events[0]["kind"])
        self.assertTrue(events[0]["unresolved_reason"].strip())

    def test_run_sha256_deterministic(self):
        a = build_extraction_rows(self.doc(), "r")[0]["run_sha256"]
        b = build_extraction_rows(self.doc(), "r")[0]["run_sha256"]
        self.assertEqual(a, b)
        self.assertEqual(len(a), 64)

    def test_event_id_is_deterministic_from_dedup_key(self):
        events = build_extraction_rows(self.doc(), "r")[1]
        self.assertEqual(events[0]["event_id"], event_id_for(events[0]["dedup_key"]))

    def test_rejects_non_extraction_doc(self):
        with self.assertRaises(ValueError):
            build_extraction_rows({"version": "something-else", "status": "completed", "events": []}, "r")

    def test_rejects_previous_extraction_version(self):
        doc = self.doc()
        doc["version"] = "event-extraction-1"
        with self.assertRaises(ValueError):
            build_extraction_rows(doc, "r")

    def test_rejects_hand_edited_event_without_an_actor(self):
        doc = self.doc()
        doc["events"][0]["actor_account_key"] = None
        with self.assertRaises(ValueError):
            build_extraction_rows(doc, "r")

    def test_an_earlier_vocabulary_row_still_needs_its_company(self):
        doc = self.doc()
        doc["events"][0]["kind_vocabulary"] = "event_kind-2.0.0"
        doc["events"][0]["primary_org_id"] = None
        with self.assertRaises(ValueError):
            build_extraction_rows(doc, "r")


class DeepSeekResilienceTests(unittest.TestCase):
    def setUp(self):
        self._chat, self._sleep = deepseek.chat, deepseek.time.sleep
        deepseek.time.sleep = lambda *_: None  # no backoff wait in tests
        self.addCleanup(self._restore)

    def _restore(self):
        deepseek.chat, deepseek.time.sleep = self._chat, self._sleep

    def test_batch_retried_then_succeeds(self):
        calls = {"n": 0}
        def flaky(messages, cfg, timeout=120):
            calls["n"] += 1
            if calls["n"] < 3:
                raise deepseek.DeepSeekError("transient")
            return {"events": [{"title": "T"}]}
        deepseek.chat = flaky
        batches, failures = deepseek.extract_events([cand("1")], cfg={"model": "m"}, batch_size=25)
        self.assertEqual(failures, [])
        self.assertEqual(len(batches[0]["events"]), 1)
        self.assertEqual(calls["n"], 3)

    def test_persistent_failure_skips_batch_not_run(self):
        def always_fail(messages, cfg, timeout=120):
            raise deepseek.DeepSeekError("down")
        deepseek.chat = always_fail
        batches, failures = deepseek.extract_events([cand("1"), cand("2")], cfg={"model": "m"}, batch_size=1)
        self.assertEqual(len(batches), 2)
        self.assertEqual(len(failures), 2)  # both skipped, recorded, not raised
        self.assertTrue(all(b["events"] == [] for b in batches))


class DeepSeekPromptTests(unittest.TestCase):
    def test_prompt_carries_the_rubric_not_a_word_list(self):
        prompt = deepseek.system_prompt()
        for kind in CURRENT_EVENT_KINDS:
            self.assertIn(kind, prompt)
        self.assertNotIn("event_announcement  (", prompt)  # retired: read on old rows, never offered
        self.assertIn("definition", prompt)
        self.assertIn("discriminator", prompt)
        self.assertIn("subject_key", prompt)
        self.assertIn("primary_org", prompt)

    def test_prompt_forbids_an_other_bucket_and_asks_for_a_reason(self):
        prompt = deepseek.system_prompt()
        self.assertIn("unresolved_reason", prompt)
        self.assertIn("null", prompt)
        self.assertIn('There is no "other" bucket', prompt)

    def test_prompt_sha256_stable_and_hex(self):
        h = deepseek.prompt_sha256()
        self.assertEqual(len(h), 64)
        self.assertEqual(h, deepseek.prompt_sha256())

    def test_prompt_sha256_covers_the_rubric(self):
        before = deepseek.prompt_sha256()
        original = deepseek.ontology_schema.rubric_sha256
        deepseek.ontology_schema.rubric_sha256 = lambda *a, **k: "0" * 64
        try:
            self.assertNotEqual(deepseek.prompt_sha256(), before)
        finally:
            deepseek.ontology_schema.rubric_sha256 = original
        self.assertEqual(deepseek.prompt_sha256(), before)

    def test_version_tag_moves_when_the_model_input_does(self):
        self.assertEqual(deepseek.EXTRACTION_VERSION_TAG, "deepseek-events-5")

    def test_config_from_env_requires_key(self):
        import os
        saved = os.environ.pop("DEEPSEEK_API_KEY", None)
        try:
            with self.assertRaises(RuntimeError):
                deepseek.config_from_env()
        finally:
            if saved is not None:
                os.environ["DEEPSEEK_API_KEY"] = saved


if __name__ == "__main__":
    unittest.main()
