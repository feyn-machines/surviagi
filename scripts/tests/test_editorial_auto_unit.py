"""Dependency-free tests for the automatic article workflow; models, stores and the site are fakes."""
import copy
import fcntl
import hashlib
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import editorial_auto
import editorial_run

CUTOFF = datetime(2026, 10, 29, 13, 0, tzinfo=timezone.utc)
SELECTION = {
    "decision": "new_article", "topic_key": "model-region-rollouts", "article_id": "where-new-models-launch-first",
    "reader_question": "Where can teams use new models first?", "new_fact": "Region launches",
    "why_it_matters": "Access", "strongest_limitation": "Vendor statements only", "reason": "New and sourced",
    "existing_checked": ["ai-agent-computer"], "candidate_post_urls": ["https://x.com/a/status/1"], "rejected": [],
}
BRIEF = {
    "gate": "pass",
    "claims": [
        {"claim_id": "C1", "claim": "Model A launched in region X", "source_url": "https://example.com/a",
         "source_kind": "first_party", "article_use": "attributed_statement", "status": "verified"},
        {"claim_id": "C2", "claim": "Model B costs $1", "source_url": "https://example.com/b",
         "source_kind": "first_party", "article_use": "attributed_statement", "status": "attributed"},
        {"claim_id": "C3", "claim": "Unchecked rumour", "source_url": "https://example.com/held",
         "source_kind": "named_person", "article_use": "attributed_statement", "status": "hold"},
        {"claim_id": "C4", "claim": "Regional access shapes adoption", "source_url": None,
         "source_kind": "surviagi_analysis", "article_use": "editorial_inference", "status": "verified"},
    ],
    "outline": [{"point": "What launched", "claim_ids": ["C1", "C2"]}, {"point": "Why", "claim_ids": ["C4"]}],
    "conclusion": "Access is regional", "headline_limit": "Vendors announced regional availability",
}
BODY = "Model A is [available](https://example.com/a) and B costs $1 per [rate card](https://example.com/b).\n\n## Why\n\nOur view."
DRAFTS = {
    "en": {"title": "Where new models launch first", "description": "Regional launches.", "body_markdown": BODY,
           "claim_ids_used": ["C1", "C2", "C4"], "used_samples": [{"sample_id": "7", "note": "shorter opening"}]},
    "zh-CN": {"title": "新模型先在哪里上线", "description": "区域上线。", "body_markdown": BODY.replace("available", "已上线"),
              "claim_ids_used": ["C1", "C2", "C4"], "used_samples": []},
}
JUDGE = {"verdict": "pass", "findings": [{"check": "style", "severity": "minor", "detail": "fine"}]}


def body_sha(markdown: str) -> str:
    body = markdown.split("\n---\n", 1)[1].strip()
    return hashlib.sha256(body.encode()).hexdigest()


class FakeRunner:
    def __init__(self, responses=None, cost=1_000_000):
        self.responses = {"selection": SELECTION, "brief": BRIEF, "en": DRAFTS["en"], "zh-CN": DRAFTS["zh-CN"],
                          "judge": JUDGE, **(responses or {})}
        self.calls, self.cost = [], cost

    def run(self, *, prompt, schema, files, budget, web):
        kind = {id(editorial_auto.SELECTION_SCHEMA): "selection", id(editorial_auto.BRIEF_SCHEMA): "brief",
                id(editorial_auto.JUDGE_SCHEMA): "judge"}.get(id(schema))
        if kind is None:
            kind = "en" if "English version" in prompt else "zh-CN"
        self.calls.append(kind)
        assert "skill/SKILL.md" in files and budget > 0
        response = self.responses[kind]
        if isinstance(response, list):
            response = response.pop(0)
        if isinstance(response, BaseException):
            raise response
        return editorial_auto.ModelResult(copy.deepcopy(response), self.cost)


class FakeStore:
    def __init__(self):
        self.rows, self.pointer = [], {}

    def index(self):
        return list(self.rows)

    def pointers(self, article_id):
        return self.pointer.get(article_id)


class FakeSite:
    """Publisher plus Agent API over the same fake store, so read-back reflects what was written."""

    def __init__(self, store):
        self.store, self.published, self.failures = store, {}, []

    def publish(self, manifest_path, target):
        if self.failures:
            failure = self.failures.pop(0)
            if failure == "commit_then_crash":
                self._write(manifest_path)
                raise RuntimeError("process died after the database commit")
            raise failure
        return self._write(manifest_path)

    def _write(self, manifest_path):
        manifest = json.loads(Path(manifest_path).read_text())
        hashes = {lang: body_sha((Path(manifest_path).parent / f"{lang}.md").read_text()) for lang in ("en", "zh-CN")}
        article = manifest["articleId"]
        created = self.published.get(article) != hashes
        if created:
            self.published[article] = hashes
            self.store.pointer[article] = {"preview_version": 1, "approved_version": None, "withdrawn": False}
        return {"created": created, "articleId": article, "version": 1, "approvedVersion": None, "contentSha256": hashes}

    def fetch(self, url):
        article = "where-new-models-launch-first"
        hashes = self.published.get(article, {})
        if "/api/agent/record" in url:
            lang = "zh-CN" if "language=zh-CN" in url else "en"
            return {"revision_id": f"article:{article}:v1", "status": "preview", "review": "not_approved_public_preview",
                    "content_sha256": hashes.get(lang)}
        return {"results": [{"revision_id": f"article:{article}:v1"}] if hashes else []}


class AutoRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ledger = editorial_run.EditorialRunLedger(self.root / "data/editorial/runs.sqlite3")
        self.store = FakeStore()
        self.site = FakeSite(self.store)
        self.runner = FakeRunner()
        self.applied = []
        skill = self.root / "skill"
        (skill / "references").mkdir(parents=True)
        (skill / "SKILL.md").write_text("skill")
        (skill / "references/evidence.md").write_text("evidence")
        (self.root / "articles/ai-agent-computer").mkdir(parents=True)
        (self.root / "articles/ai-agent-computer/en.md").write_text("---\ntitle: Computer\ndate: 2026-10-26\n---\nx")
        self.manifests = {}
        self.add_input("editorial-input-" + "1" * 24, "2026-10-29T0000")

    def add_input(self, input_id, window):
        collection = {"jobs": [{"company": "OpenAI", "posts": [
            {"id": "1", "url": "https://x.com/a/status/1", "author": "a", "created_utc": 1793260000.0,
             "text": "Model A &amp; B now in region X", "metrics": {"views": 10}},
            {"id": "2", "url": "https://x.com/a/status/2", "is_repost": True, "text": "repost"}]}]}
        path = self.root / f"data/collection/official-x/official-{window}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(collection))
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        self.manifests[input_id] = {
            "input_id": input_id, "input_sha256": hashlib.sha256(input_id.encode()).hexdigest(),
            "window": {"start": "2026-10-29T00:00:00+00:00", "end": "2026-10-29T12:00:00+00:00"},
            "sources": [{"role": "official", "path": str(path.relative_to(self.root)), "sha256": sha}]}

    def auto(self, **changes):
        services = editorial_auto.Services(
            runner=self.runner, store=self.store, publish=self.site.publish, fetch=self.site.fetch,
            link=lambda url: "ok", samples=lambda lang: {"available": True, "samples": [{"sample_id": "7"}]},
            apply_sample=lambda *args: self.applied.append(args) or True)
        values = dict(ledger=self.ledger, services=services, model="claude-opus-5-5", confirm_publish=True,
                      root=self.root, skill_dir=self.root / "skill", articles_dir=self.root / "articles",
                      clock=lambda: CUTOFF)
        values.update(changes)
        return editorial_auto.AutoRun(**values)

    def run_input(self, input_id="editorial-input-" + "1" * 24, **changes):
        with mock.patch.object(editorial_auto.editorial_inputs, "verify_inputs",
                               side_effect=lambda i, root: self.manifests[i]):
            return self.auto(**changes).run(input_id)

    def test_full_run_publishes_once_and_rerun_is_idempotent(self):
        result = self.run_input()
        self.assertEqual(result["state"], "complete")
        self.assertEqual((result["article_id"], result["article_version"]), ("where-new-models-launch-first", 1))
        self.assertEqual(self.runner.calls, ["selection", "brief", "en", "zh-CN", "judge"])
        run_dir = self.root / "data/editorial/runs" / result["run_id"]
        package = run_dir / "package"
        en = (package / "en.md").read_text()
        self.assertTrue(en.startswith("---\ntitle: Oct 29, 2026 | Where new models launch first\n"))
        self.assertIn("date: 2026-10-29\n", en)
        self.assertIn("title: 2026 年 10 月 29 日｜新模型先在哪里上线", (package / "zh-CN.md").read_text())
        manifest = json.loads((package / "manifest.json").read_text())
        self.assertEqual(manifest["excludedClaims"], ["https://example.com/held"])
        self.assertEqual(manifest["createdBy"], f"editorial-run:{result['run_id']}")
        self.assertEqual(oct(package.joinpath("manifest.json").stat().st_mode & 0o777), "0o600")
        # The one sample the English writer used is recorded against the exact published hash.
        self.assertEqual(self.applied, [("7", "where-new-models-launch-first", 1, "en", body_sha(en), "shorter opening")])

        again = self.run_input()
        self.assertEqual(again["state"], "complete")
        self.assertEqual(len(self.runner.calls), 5)
        self.assertEqual(len(self.site.published), 1)

    def test_stops_before_public_preview_without_confirmation_then_resumes(self):
        held = self.run_input(confirm_publish=False)
        self.assertEqual(held["awaiting"], "confirm_public_preview")
        self.assertEqual(self.site.published, {})
        done = self.run_input()
        self.assertEqual(done["state"], "complete")
        self.assertEqual(len(self.runner.calls), 5)

    def test_no_qualifying_topic_ends_without_drafting(self):
        self.runner.responses["selection"] = {**SELECTION, "decision": "no_qualifying_topic",
                                              "topic_key": "quiet-window", "article_id": None}
        result = self.run_input()
        self.assertEqual((result["state"], result["reason"]), ("no_topic", "no_qualifying_topic"))
        self.assertEqual(self.runner.calls, ["selection"])
        self.assertEqual(self.run_input()["state"], "no_topic")
        self.assertEqual(self.runner.calls, ["selection"])

    def test_revision_and_evidence_hold_are_left_to_an_operator(self):
        self.runner.responses["selection"] = {**SELECTION, "decision": "revise_existing", "article_id": "ai-agent-computer"}
        result = self.run_input()
        self.assertEqual((result["state"], result["reason"]), ("held", "revision_needs_operator"))

    def test_insufficient_evidence_holds_privately(self):
        self.runner.responses["brief"] = {**BRIEF, "gate": "hold", "held_reason": "no primary source"}
        result = self.run_input()
        self.assertEqual((result["state"], result["held"]), ("held", "insufficient_evidence"))
        self.assertEqual(self.runner.calls, ["selection", "brief"])
        self.assertEqual(self.site.published, {})

    def test_budget_hold_stops_before_the_next_model_call(self):
        result = self.run_input(budget=4_000_000)
        self.assertEqual(result["state"], "budget_held")
        self.assertEqual(self.runner.calls, ["selection"])

    def test_overspend_reported_by_the_harness_holds_the_run(self):
        self.runner.cost = 3_900_000
        result = self.run_input(budget=7_000_000)
        self.assertEqual(result["state"], "budget_held")
        self.assertEqual(self.site.published, {})

    def test_concurrent_invocation_of_the_same_run_is_refused(self):
        row, _ = self.ledger.create_run(
            input_ref="editorial-input-" + "1" * 24, input_sha256=self.manifests["editorial-input-" + "1" * 24]["input_sha256"],
            topic_key="auto", skill_version=editorial_auto.skill_version(self.root / "skill"),
            policy_version=editorial_auto.POLICY_VERSION, model_version="claude-opus-5-5",
            budget_limit=editorial_auto.DEFAULT_BUDGET, max_attempts=2)
        lock_dir = self.root / "data/editorial/runs" / row["run_id"]
        lock_dir.mkdir(parents=True)
        with open(lock_dir / ".lock", "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(editorial_auto.AutoError):
                self.run_input()
        self.assertEqual(self.runner.calls, [])

    def test_existing_or_already_selected_article_is_not_written_twice(self):
        self.store.rows = [{"article_id": "where-new-models-launch-first", "store": "editorial"}]
        result = self.run_input()
        self.assertEqual((result["state"], result["reason"]), ("held", "duplicate_topic"))

        self.store.rows = []
        other = "editorial-input-" + "2" * 24
        self.add_input(other, "2026-10-29T1200")
        first = self.run_input(other)
        self.assertEqual(first["state"], "complete")
        third = "editorial-input-" + "3" * 24
        self.add_input(third, "2026-10-30T0000")
        self.store.rows = []
        repeat = self.run_input(third)
        self.assertEqual((repeat["state"], repeat["reason"]), ("held", "duplicate_topic"))
        self.assertEqual(len(self.site.published), 1)

    def test_invented_citation_fails_preflight_without_a_model_override(self):
        bad = {**DRAFTS["en"], "body_markdown": BODY + " See [blog](https://example.org/unlisted)."}
        self.runner.responses["en"] = bad
        result = self.run_input()
        self.assertEqual((result["state"], result["held"]), ("held", "preflight_failed"))
        checks = {f["check"] for f in result["failures"]}
        self.assertIn("uncited_source", checks)
        self.assertIn("language_source_mismatch", checks)
        self.assertNotIn("judge", self.runner.calls)
        self.assertEqual(self.site.published, {})

    def test_held_claim_and_dead_source_are_hard_failures(self):
        self.runner.responses["zh-CN"] = {**DRAFTS["zh-CN"], "claim_ids_used": ["C1", "C2", "C3", "C4"]}
        self.runner.responses["en"] = {**DRAFTS["en"], "used_samples": []}
        services = editorial_auto.Services(runner=self.runner, store=self.store, publish=self.site.publish,
                                           fetch=self.site.fetch, link=lambda url: "dead" if url.endswith("/b") else "ok",
                                           samples=lambda lang: {"available": False, "samples": []})
        result = self.run_input(services=services)
        checks = {f["check"] for f in result["failures"]}
        self.assertEqual(checks, {"held_claim_used", "dead_source"})

    def test_blocking_semantic_finding_keeps_the_package_private(self):
        self.runner.responses["judge"] = {"verdict": "fail", "findings": [
            {"check": "bilingual", "severity": "blocking", "detail": "price differs"}]}
        result = self.run_input()
        self.assertEqual(result["held"], "preflight_failed")
        self.assertEqual(self.site.published, {})

    def test_publish_failure_is_retried_and_a_crash_after_commit_reuses_the_version(self):
        self.site.failures = [editorial_auto.StageFail("publish_failed")]
        self.assertEqual(self.run_input()["state"], "complete")

        self.setUp()
        self.site.failures = ["commit_then_crash"]
        with self.assertRaises(RuntimeError):
            self.run_input()
        result = self.run_input()
        self.assertEqual(result["state"], "complete")
        self.assertEqual(result["article_version"], 1)
        self.assertEqual(len(self.site.published), 1)

    def test_rejected_publication_holds_instead_of_retrying(self):
        self.site.failures = [editorial_auto.StageHold("publish_rejected")]
        result = self.run_input()
        self.assertEqual((result["state"], result["held"]), ("held", "publish_rejected"))

    def test_harness_failures_stop_at_the_retry_cap(self):
        self.runner.responses["brief"] = [editorial_auto.StageFail("model_error", 10),
                                          editorial_auto.StageFail("model_error", 10)]
        result = self.run_input()
        self.assertEqual((result["state"], result["failed"]), ("failed", "model_error"))

    def test_interrupted_stage_is_recovered_and_retried(self):
        self.runner.responses["en"] = [KeyboardInterrupt(), DRAFTS["en"]]
        with self.assertRaises(KeyboardInterrupt):
            self.run_input()
        self.assertEqual(self.run_input()["state"], "complete")

    def test_agent_read_back_must_match_the_published_text(self):
        self.site.fetch = lambda url: {"revision_id": "article:where-new-models-launch-first:v1", "status": "preview",
                                       "content_sha256": "0" * 64}
        result = self.run_input()
        self.assertEqual((result["state"], result["failed"]), ("failed", "agent_record_mismatch"))

    def test_paused_run_does_nothing(self):
        result = self.run_input(confirm_publish=False)
        self.ledger.pause(result["run_id"])
        calls = len(self.runner.calls)
        self.assertEqual(self.run_input()["state"], "paused")
        self.assertEqual(len(self.runner.calls), calls)
        self.ledger.resume(result["run_id"])
        self.assertEqual(self.run_input()["state"], "complete")

    def test_withdrawal_or_newer_preview_before_review_is_held(self):
        original = self.site.publish

        def publish_then_withdraw(path, target):
            result = original(path, target)
            self.store.pointer[result["articleId"]] = {"preview_version": 1, "approved_version": None, "withdrawn": True}
            return result

        self.site.publish = publish_then_withdraw
        result = self.run_input()
        self.assertEqual((result["state"], result["held"]), ("held", "article_withdrawn"))

    def test_changed_private_output_is_refused(self):
        result = self.run_input(confirm_publish=False)
        brief = self.root / "data/editorial/runs" / result["run_id"] / "brief.json"
        brief.write_text(brief.read_text().replace("Model B costs $1", "Model B costs $2"))
        with self.assertRaises(editorial_auto.AutoError):
            self.run_input()


class DigestTests(unittest.TestCase):
    def test_digest_drops_reposts_and_rejects_changed_collections(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "data/collection/panel/panel-x.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"jobs": [{"company": "Lab", "posts": [
                {"id": "1", "url": "https://x.com/p/status/1", "text": "a &lt;b&gt;", "created_utc": 1.0},
                {"id": "2", "url": "https://x.com/p/status/2", "text": "rt", "is_repost": True}]}]}))
            manifest = {"input_id": "i", "window": {}, "sources": [
                {"role": "panel", "path": "data/collection/panel/panel-x.json",
                 "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}]}
            digest = editorial_auto.build_digest(manifest, root)
            self.assertEqual([p["text"] for p in digest["posts"]], ["a <b>"])
            path.write_text("{}")
            with self.assertRaises(editorial_auto.AutoError):
                editorial_auto.build_digest(manifest, root)


if __name__ == "__main__":
    unittest.main()
