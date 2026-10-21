"""Offline unit tests for the typed judge: question shape, prompts, answer parsing.

Dependency-free on purpose (no psycopg, no network): this file runs under
`pnpm data:test:unit` with the system python. Every test that constructs a judge
patches `judge.load_env` (so the real `.env` is never read), sets a dummy key,
patches the module-level `judge._post`, and additionally breaks
`urllib.request.urlopen`, so a missed patch fails loudly instead of reaching the
network.

`scripts/data_pipeline/judge_runner.py` and `evidence_runner.py` import
`psycopg.types.json` at module level, so the run/persist half of this feature is
not reachable from here and is covered by the integration tests instead.
"""
import json
import os
import sys
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_pipeline import judge  # noqa: E402
from data_pipeline import ontology_schema  # noqa: E402

SCHEMA = json.loads(
    (Path(__file__).resolve().parents[2] / "datasets/ontology/schema/schema.json")
    .read_text(encoding="utf-8"))


def item(index=0, criteria=""):
    return judge.Item(
        work_id=f"oaw:work:{index}",
        work_text=f"work text {index}",
        capability_id=f"oaw:capability:{index}",
        capability_label=f"label {index}",
        capability_definition=f"definition {index}",
        capability_criteria=criteria)


def evidence_item(index=0, criteria=""):
    return judge.EvidenceItem(
        event_id=f"evt-{index}",
        event_text={"title": f"t{index}"},
        capability_id=f"oaw:capability:{index}",
        capability_label=f"label {index}",
        capability_definition=f"definition {index}",
        capability_criteria=criteria)


class QuestionShapeTests(unittest.TestCase):
    """The questions are the contract with the judge; their shape is load-bearing."""

    def test_one_noul_and_one_score_per_item(self):
        questions = judge.TypeSafeJudge.questions([item(0), item(1), item(2)])
        self.assertEqual(
            sorted(questions),
            ["centrality_0", "centrality_1", "centrality_2",
             "requires_0", "requires_1", "requires_2"])
        self.assertEqual(len(questions), 6)

    def test_questions_is_callable_without_an_api_key(self):
        # It is a @staticmethod precisely so the shape can be checked offline.
        self.assertIsInstance(
            judge.TypeSafeJudge.__dict__["questions"], staticmethod)
        self.assertEqual(len(judge.TypeSafeJudge.questions([item(0)])), 2)

    def test_noul_criteria_carry_both_branches(self):
        criteria = judge.TypeSafeJudge.questions([item(0)])["requires_0"]["criteria"]
        self.assertEqual(sorted(criteria), ["false", "true"])
        for branch in ("true", "false"):
            self.assertTrue(criteria[branch].strip(), f"{branch} branch is empty")
        # The false branch has to name the vocabulary trap, or the judge has no
        # licence to reject a word-overlap match.
        self.assertIn("shares vocabulary", criteria["false"])

    def test_noul_type_and_instructions(self):
        question = judge.TypeSafeJudge.questions([item(0)])["requires_0"]
        self.assertEqual(question["type"], "noul")
        self.assertEqual(question["instructions"]["question"], judge.INSTRUCTIONS)
        self.assertEqual(question["instructions"]["ability"],
                         {"name": "label 0", "definition": "definition 0"})

    def test_centrality_score_has_five_levels_within_typesafe_range(self):
        question = judge.TypeSafeJudge.questions([item(0)])["centrality_0"]
        self.assertEqual(question["type"], "score")
        levels = question["criteria"]
        self.assertIsInstance(levels, list)
        self.assertEqual(len(levels), 5)
        # TypeSafe accepts 2..10 levels on a score question.
        self.assertGreaterEqual(len(levels), 2)
        self.assertLessEqual(len(levels), 10)
        self.assertTrue(all(isinstance(text, str) and text.strip() for text in levels))
        self.assertEqual(levels, judge.CENTRALITY_LEVELS)

    def test_capability_criteria_are_passed_only_when_present(self):
        with_criteria = judge.TypeSafeJudge.questions([item(0, criteria="a named test")])
        self.assertEqual(
            with_criteria["requires_0"]["instructions"]["ability"]["what_counts_as_evidence"],
            "a named test")
        without = judge.TypeSafeJudge.questions([item(0)])
        self.assertNotIn("what_counts_as_evidence",
                         without["requires_0"]["instructions"]["ability"])

    def test_no_questions_for_no_items(self):
        self.assertEqual(judge.TypeSafeJudge.questions([]), {})


class EvidenceQuestionShapeTests(unittest.TestCase):
    def test_one_shared_tier_question_plus_three_per_item(self):
        questions = judge._DemonstratesMixin.evidence_questions(
            [evidence_item(0), evidence_item(1)])
        self.assertEqual(
            sorted(questions),
            ["autonomy_0", "autonomy_1", "demonstrates_0", "demonstrates_1",
             "positive_0", "positive_1", "tier"])
        self.assertEqual(len(questions), 1 + 3 * 2)

    def test_tier_question_covers_exactly_t1_to_t4(self):
        questions = judge._DemonstratesMixin.evidence_questions([evidence_item(0)])
        tier = questions["tier"]
        self.assertEqual(tier["type"], "choice")
        self.assertEqual(sorted(tier["criteria"]), ["T1", "T2", "T3", "T4"])
        self.assertEqual(tier["criteria"], judge.TIER_CRITERIA)
        for key, text in tier["criteria"].items():
            self.assertTrue(text.strip(), f"{key} has no criterion text")

    def test_tier_criteria_are_copied_not_shared(self):
        # _tier_questions() copies, so a caller mutating its questions cannot
        # silently redefine the tier rubric for the rest of the process.
        questions = judge._DemonstratesMixin.evidence_questions([evidence_item(0)])
        questions["tier"]["criteria"]["T1"] = "mutated"
        self.assertNotEqual(judge.TIER_CRITERIA["T1"], "mutated")

    def test_demonstrates_autonomy_and_positive_shapes(self):
        questions = judge._DemonstratesMixin.evidence_questions([evidence_item(0)])
        self.assertEqual(questions["demonstrates_0"]["type"], "noul")
        self.assertEqual(sorted(questions["demonstrates_0"]["criteria"]), ["false", "true"])
        self.assertEqual(questions["demonstrates_0"]["instructions"]["question"],
                         judge.DEMONSTRATES_INSTRUCTIONS)
        self.assertEqual(questions["autonomy_0"]["type"], "score")
        self.assertEqual(questions["autonomy_0"]["criteria"], judge.autonomy_levels())
        self.assertEqual(len(questions["autonomy_0"]["criteria"]), 5)
        self.assertEqual(questions["autonomy_0"]["instructions"]["question"],
                         judge.AUTONOMY_QUESTION)
        self.assertEqual(questions["positive_0"]["type"], "noul")
        self.assertEqual(sorted(questions["positive_0"]["criteria"]), ["false", "true"])

    def test_typesafe_evidence_judge_exposes_the_mixin_questions(self):
        self.assertEqual(
            judge.TypeSafeEvidenceJudge.evidence_questions([evidence_item(0)]),
            judge._DemonstratesMixin.evidence_questions([evidence_item(0)]))

    def test_tier_question_exists_even_with_no_items(self):
        self.assertEqual(list(judge._DemonstratesMixin.evidence_questions([])), ["tier"])


class AutonomyRubricTests(unittest.TestCase):
    """The rubric is read from the schema, never restated in the prompt."""

    def test_five_levels_in_stage_order_from_the_semantic_model(self):
        levels = judge.autonomy_levels()
        self.assertEqual(len(levels), 5)
        terms = SCHEMA["vocabularies"]["autonomy_stage"]["terms"]
        for stage in range(5):
            body = terms[str(stage)]
            self.assertIn(body["label"]["zh-CN"], levels[stage])
            self.assertIn(body["definition"]["zh-CN"], levels[stage])
            self.assertTrue(levels[stage].startswith(body["label"]["zh-CN"]))

    def test_levels_are_not_a_second_copy_of_the_vocabulary(self):
        # Proof that the text is read at call time: change the model, and the
        # rubric changes with it. A hard-coded copy would not move.
        original = ontology_schema.load_schema
        model = json.loads(json.dumps(SCHEMA))
        model["vocabularies"]["autonomy_stage"]["terms"]["4"]["label"]["zh-CN"] = "改过的标签"
        ontology_schema.load_schema = lambda *a, **k: model
        self.addCleanup(lambda: setattr(ontology_schema, "load_schema", original))
        self.assertIn("改过的标签", judge.autonomy_levels()[4])

    def test_rubric_labels_are_not_duplicated_in_judge_source(self):
        source = (Path(judge.__file__)).read_text(encoding="utf-8")
        terms = SCHEMA["vocabularies"]["autonomy_stage"]["terms"]
        for stage in range(5):
            definition = terms[str(stage)]["definition"]["zh-CN"]
            self.assertNotIn(definition, source,
                             f"stage {stage} definition is restated in judge.py")


class PromptGuardTests(unittest.TestCase):
    """These clauses exist because a measured failure mode produced them.

    Deleting one would not break any other test, so it is asserted directly.
    """

    def test_instructions_warn_that_word_overlap_is_not_evidence(self):
        # Keyword matching produced 100% false positives on the sampled
        # occupation, which is why the judge is told not to match words.
        self.assertIn("words shared with no requirement behind them", judge.INSTRUCTIONS)
        self.assertIn("'program' may mean a course of study", judge.INSTRUCTIONS)
        self.assertIn("'code' may mean a section of regulation", judge.INSTRUCTIONS)

    def test_instructions_also_guard_the_opposite_failure(self):
        """Over-correcting the overlap warning produced the reverse error.

        Told to distrust matching words, the judge began rejecting edges where
        the ability simply IS the work: 'Teach subjects and conduct classroom
        practice' scored 0.28 against instructional delivery while the same
        response scored its centrality 2.11 - the two answers contradicted each
        other. Both guards are pinned, because fixing either one alone reopens
        the other.
        """
        self.assertIn("the answer is plainly true", judge.INSTRUCTIONS)
        self.assertIn("not a coincidence of wording", judge.INSTRUCTIONS)
        self.assertIn("clearest true positive", judge.INSTRUCTIONS)

    def test_instructions_state_the_test_is_practical_not_logical(self):
        self.assertIn("practical, not logical", judge.INSTRUCTIONS)
        self.assertNotIn("would make autonomous completion impossible", judge.INSTRUCTIONS)
        self.assertIn("merely adjacent to the subject matter", judge.INSTRUCTIONS)

    def test_deepseek_system_prompt_inherits_the_overlap_warning(self):
        # Both backends must answer the same question, or their disagreement
        # measures the prompt rather than the judges.
        self.assertTrue(judge.DEEPSEEK_SYSTEM.startswith(judge.INSTRUCTIONS))
        self.assertIn("words shared with no requirement behind them", judge.DEEPSEEK_SYSTEM)
        self.assertIn("clearest true positive", judge.DEEPSEEK_SYSTEM)
        self.assertIn("There is no 'probably' bucket", judge.DEEPSEEK_SYSTEM)
        for level in judge.CENTRALITY_LEVELS:
            self.assertIn(level, judge.DEEPSEEK_SYSTEM)

    def test_demonstrates_accepts_production_use_without_a_measurement(self):
        # Requiring a metric discarded every production-adoption event, and
        # production_adoption is the only kind that can reach stage 3 or 4.
        text = judge.DEMONSTRATES_INSTRUCTIONS
        self.assertIn("This needs no number at all.", text)
        self.assertIn("Do not require (a) before accepting (b).", text)
        self.assertIn("IS evidence about the ability, even with no metrics", text)
        self.assertIn("a named organisation actually running this in its operations", text)

    def test_demonstrates_keeps_the_negative_and_the_exclusions(self):
        text = judge.DEMONSTRATES_INSTRUCTIONS
        self.assertIn("A documented failure or outage is also evidence", text)
        self.assertIn("evidence against", text)
        self.assertIn("What does NOT count", text)
        self.assertIn("Do not use what you know about the", text)

    def test_autonomy_question_rejects_production_as_proof_of_autonomy(self):
        self.assertIn("Being deployed in", judge.AUTONOMY_QUESTION)
        self.assertIn("production says nothing by itself", judge.AUTONOMY_QUESTION)
        self.assertIn("supervised use", judge.AUTONOMY_QUESTION)

    def test_prompt_digests_cover_the_prompt_text(self):
        # A changed clause must change the recorded provenance hash.
        original = judge.INSTRUCTIONS
        stub = object.__new__(judge.TypeSafeJudge)
        stub.model = "jev-latest"
        before = stub.prompt_sha256()
        judge.INSTRUCTIONS = original + " and one more clause"
        self.addCleanup(lambda: setattr(judge, "INSTRUCTIONS", original))
        self.assertNotEqual(before, stub.prompt_sha256())
        self.assertEqual(len(before), 64)


class _JudgeTestCase(unittest.TestCase):
    """Base: a judge that can be constructed offline and can never call out."""

    KEYS = ("TYPESAFE_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL")

    def setUp(self):
        saved = {key: os.environ.get(key) for key in self.KEYS}

        def restore_env():
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        self.addCleanup(restore_env)
        os.environ["TYPESAFE_API_KEY"] = "unit-test-key-not-real"
        os.environ["DEEPSEEK_API_KEY"] = "unit-test-key-not-real"
        os.environ["DEEPSEEK_MODEL"] = "deepseek-chat"
        os.environ["DEEPSEEK_BASE_URL"] = "https://example.invalid"

        # Never read the real .env from a unit test.
        original_load_env = judge.load_env
        judge.load_env = lambda: None
        self.addCleanup(lambda: setattr(judge, "load_env", original_load_env))

        # Every test must install its own canned response.
        original_post = judge._post
        judge._post = self._forbidden_post
        self.addCleanup(lambda: setattr(judge, "_post", original_post))

        # Belt and braces: if a code path ever bypassed _post, this fails loudly
        # rather than opening a socket.
        original_urlopen = urllib.request.urlopen

        def blocked(*args, **kwargs):
            raise AssertionError("a unit test attempted a real HTTP request")

        urllib.request.urlopen = blocked
        self.addCleanup(lambda: setattr(urllib.request, "urlopen", original_urlopen))

        self.posts = []

    @staticmethod
    def _forbidden_post(*args, **kwargs):
        raise AssertionError("_post was called before a canned response was installed")

    def stub_post(self, body):
        def fake_post(url, payload, api_key, timeout):
            self.posts.append({"url": url, "payload": payload,
                               "api_key": api_key, "timeout": timeout})
            return body

        judge._post = fake_post


class TypeSafeParsingTests(_JudgeTestCase):
    def test_noul_at_the_midpoint_is_unresolved_not_a_coin_flip(self):
        self.stub_post({"answers": {"requires_0": {"noul": 0.5},
                                    "centrality_0": {"score": 2}}})
        result = judge.TypeSafeJudge().judge("work", [item(0)])[0]
        self.assertIsNone(result.requires)
        self.assertNotEqual(result.requires, False)
        self.assertNotEqual(result.requires, True)
        self.assertEqual(result.unresolved_reason, "noul is at the undecided midpoint")

    def test_near_midpoint_band_is_also_unresolved(self):
        for value in (0.46, 0.54):
            with self.subTest(value=value):
                self.stub_post({"answers": {"requires_0": {"noul": value}}})
                result = judge.TypeSafeJudge().judge("work", [item(0)])[0]
                self.assertIsNone(result.requires)
                self.assertIsNotNone(result.unresolved_reason)

    def test_outside_the_band_resolves(self):
        # Kept clear of the 0.05 edge: abs(0.45 - 0.5) is 0.04999999999999999 in
        # binary floating point while abs(0.55 - 0.5) is 0.050000000000000044, so
        # the band is very slightly asymmetric right at its boundary.
        for value, expected in ((0.56, True), (0.44, False)):
            with self.subTest(value=value):
                self.stub_post({"answers": {"requires_0": {"noul": value}}})
                result = judge.TypeSafeJudge().judge("work", [item(0)])[0]
                self.assertIs(result.requires, expected)
                self.assertIsNone(result.unresolved_reason)

    def test_missing_answer_for_one_item_is_none_with_a_reason(self):
        self.stub_post({"answers": {"requires_0": {"noul": 0.9}}})
        results = judge.TypeSafeJudge().judge("work", [item(0), item(1)])
        self.assertEqual(len(results), 2)
        self.assertIs(results[0].requires, True)
        # The silent-False failure mode: an unanswered pair must not read as
        # "this work does not require this ability".
        self.assertIsNone(results[1].requires)
        self.assertNotEqual(results[1].requires, False)
        self.assertIsNone(results[1].confidence)
        self.assertEqual(results[1].unresolved_reason,
                         "typesafe returned no noul value for this pair")
        self.assertEqual(results[1].work_id, "oaw:work:1")
        self.assertEqual(results[1].capability_id, "oaw:capability:1")

    def test_absent_answers_block_entirely(self):
        self.stub_post({})
        results = judge.TypeSafeJudge().judge("work", [item(0), item(1)])
        self.assertEqual([r.requires for r in results], [None, None])
        self.assertTrue(all(r.unresolved_reason for r in results))

    def test_confidence_is_distance_from_the_midpoint_as_certainty(self):
        for value, expected_requires, expected_confidence in (
                (0.87, True, 0.87), (0.13, False, 0.87), (0.999, True, 0.999)):
            with self.subTest(value=value):
                self.stub_post({"answers": {"requires_0": {"noul": value}}})
                result = judge.TypeSafeJudge().judge("work", [item(0)])[0]
                self.assertIs(result.requires, expected_requires)
                self.assertAlmostEqual(result.confidence, expected_confidence, places=3)
                # certainty = 0.5 + |value - 0.5|
                self.assertAlmostEqual(result.confidence, 0.5 + abs(value - 0.5), places=3)

    def test_float_score_is_kept_as_a_float(self):
        self.stub_post({"answers": {"requires_0": {"noul": 0.91},
                                    "centrality_0": {"score": 3.81}}})
        result = judge.TypeSafeJudge().judge("work", [item(0)])[0]
        self.assertIsInstance(result.centrality, float)
        self.assertEqual(result.centrality, 3.81)
        self.assertNotEqual(result.centrality, 3)
        self.assertNotEqual(result.centrality, 4)
        self.assertIn("centrality=3.81", result.rationale)

    def test_integer_score_zero_survives(self):
        self.stub_post({"answers": {"requires_0": {"noul": 0.2},
                                    "centrality_0": {"score": 0}}})
        result = judge.TypeSafeJudge().judge("work", [item(0)])[0]
        self.assertEqual(result.centrality, 0.0)
        self.assertIsInstance(result.centrality, float)

    def test_missing_score_leaves_centrality_none(self):
        self.stub_post({"answers": {"requires_0": {"noul": 0.9}}})
        result = judge.TypeSafeJudge().judge("work", [item(0)])[0]
        self.assertIsNone(result.centrality)
        self.assertEqual(result.rationale, "jev noul=0.900")

    def test_raw_answers_are_preserved_for_provenance(self):
        noul = {"noul": 0.9, "explanation": "because"}
        score = {"score": 3}
        self.stub_post({"answers": {"requires_0": noul, "centrality_0": score}})
        result = judge.TypeSafeJudge().judge("work", [item(0)])[0]
        self.assertEqual(result.raw, {"noul": noul, "score": score})

    def test_request_carries_the_work_state_and_the_questions(self):
        self.stub_post({"answers": {"requires_0": {"noul": 0.9}}})
        judge.TypeSafeJudge().judge("the work text", [item(0)])
        self.assertEqual(len(self.posts), 1)
        sent = self.posts[0]
        self.assertEqual(sent["url"], judge.TYPESAFE_URL)
        self.assertEqual(sent["api_key"], "unit-test-key-not-real")
        self.assertEqual(sent["payload"]["state"], {"work": "the work text"})
        self.assertEqual(sent["payload"]["model"], judge.TYPESAFE_MODEL)
        self.assertEqual(sent["payload"]["questions"],
                         judge.TypeSafeJudge.questions([item(0)]))

    def test_missing_api_key_refuses_to_construct(self):
        os.environ.pop("TYPESAFE_API_KEY", None)
        with self.assertRaises(judge.JudgeError):
            judge.TypeSafeJudge()


class DeepSeekParsingTests(_JudgeTestCase):
    @staticmethod
    def _body(judgments):
        return {"choices": [{"message": {"content": json.dumps({"judgments": judgments})}}]}

    def test_omitted_index_is_none_with_a_reason_not_false(self):
        self.stub_post(self._body([
            {"index": 0, "requires": True, "confidence": 0.8, "centrality": 3,
             "rationale": "r"}]))
        results = judge.DeepSeekJudge().judge("work", [item(0), item(1)])
        self.assertIs(results[0].requires, True)
        self.assertIsNone(results[1].requires)
        self.assertNotEqual(results[1].requires, False)
        self.assertEqual(results[1].unresolved_reason,
                         "deepseek omitted this ability from its answer")
        self.assertIsNone(results[1].confidence)
        self.assertIsNone(results[1].centrality)

    def test_explicit_null_keeps_the_models_own_reason(self):
        self.stub_post(self._body([
            {"index": 0, "requires": None, "confidence": 0.4, "centrality": 2,
             "rationale": "r", "unresolved_reason": "the task text is ambiguous"}]))
        result = judge.DeepSeekJudge().judge("work", [item(0)])[0]
        self.assertIsNone(result.requires)
        self.assertEqual(result.unresolved_reason, "the task text is ambiguous")

    def test_non_boolean_decision_is_not_silently_truthy(self):
        self.stub_post(self._body([
            {"index": 0, "requires": "yes", "confidence": 0.9, "centrality": 4,
             "rationale": "r"}]))
        result = judge.DeepSeekJudge().judge("work", [item(0)])[0]
        self.assertIsNone(result.requires)
        self.assertEqual(result.unresolved_reason,
                         "model returned a non-boolean decision")

    def test_float_centrality_is_kept_as_a_float(self):
        self.stub_post(self._body([
            {"index": 0, "requires": True, "confidence": 0.77, "centrality": 3.81,
             "rationale": "r"}]))
        result = judge.DeepSeekJudge().judge("work", [item(0)])[0]
        self.assertIsInstance(result.centrality, float)
        self.assertEqual(result.centrality, 3.81)
        self.assertNotEqual(result.centrality, 3)
        self.assertEqual(result.confidence, 0.77)

    def test_out_of_range_values_are_clamped_not_dropped(self):
        self.stub_post(self._body([
            {"index": 0, "requires": False, "confidence": 2.5, "centrality": 9.5,
             "rationale": "r"}]))
        result = judge.DeepSeekJudge().judge("work", [item(0)])[0]
        self.assertEqual(result.confidence, 1.0)
        self.assertEqual(result.centrality, 4.0)

    def test_missing_rationale_is_labelled_rather_than_blank(self):
        self.stub_post(self._body([{"index": 0, "requires": True}]))
        result = judge.DeepSeekJudge().judge("work", [item(0)])[0]
        self.assertEqual(result.rationale, "no rationale given")
        self.assertIsNone(result.confidence)

    def test_non_json_content_raises_judge_error(self):
        self.stub_post({"choices": [{"message": {"content": "not json"}}]})
        with self.assertRaises(judge.JudgeError):
            judge.DeepSeekJudge().judge("work", [item(0)])

    def test_no_choices_raises_judge_error(self):
        self.stub_post({"choices": []})
        with self.assertRaises(judge.JudgeError):
            judge.DeepSeekJudge().judge("work", [item(0)])

    def test_retry_wrapper_records_the_failure_instead_of_raising(self):
        calls = []

        class AlwaysFails:
            name = "stub"

            def judge(self, work_text, items):
                calls.append(work_text)
                raise judge.JudgeError("boom")

        results = judge.judge_with_retry(AlwaysFails(), "work", [item(0)], attempts=1)
        self.assertEqual(calls, ["work"])
        self.assertEqual(len(results), 1)
        self.assertIsNone(results[0].requires)
        self.assertIn("stub failed after 1 attempts", results[0].unresolved_reason)


class EvidenceParsingTests(_JudgeTestCase):
    def _judge(self):
        return judge.TypeSafeEvidenceJudge()

    def test_observed_stage_rounds_to_the_nearest_half_step(self):
        for raw, expected in ((2.4, 2.5), (2.2, 2.0), (3.7, 3.5), (0.9, 1.0), (4.0, 4.0)):
            with self.subTest(raw=raw):
                self.stub_post({"answers": {
                    "tier": {"choice": "T1"},
                    "demonstrates_0": {"noul": 0.9},
                    "positive_0": {"noul": 0.9},
                    "autonomy_0": {"score": raw}}})
                result = self._judge().judge_evidence({"title": "t"}, [evidence_item(0)])[0]
                self.assertEqual(result.observed_stage, expected)

    def test_a_2_4_reading_does_not_become_stage_3(self):
        self.stub_post({"answers": {
            "tier": {"choice": "T1"},
            "demonstrates_0": {"noul": 0.9},
            "positive_0": {"noul": 0.9},
            "autonomy_0": {"score": 2.4}}})
        result = self._judge().judge_evidence({"title": "t"}, [evidence_item(0)])[0]
        self.assertNotEqual(result.observed_stage, 3)
        self.assertNotEqual(result.observed_stage, 3.0)
        self.assertLess(result.observed_stage, 3)
        self.assertIn("2.40", result.observed_stage_rationale)

    def test_missing_autonomy_reading_leaves_the_stage_unread(self):
        self.stub_post({"answers": {
            "tier": {"choice": "T3"},
            "demonstrates_0": {"noul": 0.9},
            "positive_0": {"noul": 0.9}}})
        result = self._judge().judge_evidence({"title": "t"}, [evidence_item(0)])[0]
        self.assertIsNone(result.observed_stage)
        self.assertIsNone(result.observed_stage_rationale)
        self.assertNotEqual(result.observed_stage, 0)

    def test_demonstrates_midpoint_is_unresolved(self):
        self.stub_post({"answers": {
            "tier": {"choice": "T1"},
            "demonstrates_0": {"noul": 0.5},
            "positive_0": {"noul": 0.9},
            "autonomy_0": {"score": 3}}})
        result = self._judge().judge_evidence({"title": "t"}, [evidence_item(0)])[0]
        self.assertIsNone(result.demonstrates)
        self.assertEqual(result.unresolved_reason,
                         "demonstrates is at the undecided midpoint")

    def test_missing_demonstrates_answer_is_unresolved_not_false(self):
        self.stub_post({"answers": {"tier": {"choice": "T1"}}})
        result = self._judge().judge_evidence({"title": "t"}, [evidence_item(0)])[0]
        self.assertIsNone(result.demonstrates)
        self.assertNotEqual(result.demonstrates, False)
        self.assertEqual(result.unresolved_reason,
                         "typesafe returned no demonstrates value for this pair")
        self.assertIsNone(result.evidence_tier)
        self.assertIsNone(result.observed_stage)

    def test_unknown_tier_is_dropped_and_flagged(self):
        self.stub_post({"answers": {
            "tier": {"choice": "T9"},
            "demonstrates_0": {"noul": 0.9},
            "positive_0": {"noul": 0.9},
            "autonomy_0": {"score": 2}}})
        result = self._judge().judge_evidence({"title": "t"}, [evidence_item(0)])[0]
        self.assertIsNone(result.evidence_tier)
        self.assertEqual(result.unresolved_reason, "tier could not be determined")

    def test_tier_applies_to_every_item_in_the_batch(self):
        self.stub_post({"answers": {
            "tier": {"choice": "T2"},
            "demonstrates_0": {"noul": 0.9}, "positive_0": {"noul": 0.9},
            "autonomy_0": {"score": 3},
            "demonstrates_1": {"noul": 0.8}, "positive_1": {"noul": 0.9},
            "autonomy_1": {"score": 1}}})
        results = self._judge().judge_evidence(
            {"title": "t"}, [evidence_item(0), evidence_item(1)])
        self.assertEqual([r.evidence_tier for r in results], ["T2", "T2"])
        self.assertEqual([r.event_id for r in results], ["evt-0", "evt-1"])

    def test_sign_follows_the_positive_noul(self):
        for value, expected in ((0.9, "positive"), (0.2, "negative")):
            with self.subTest(value=value):
                self.stub_post({"answers": {
                    "tier": {"choice": "T1"},
                    "demonstrates_0": {"noul": 0.9},
                    "positive_0": {"noul": value},
                    "autonomy_0": {"score": 3}}})
                result = self._judge().judge_evidence(
                    {"title": "t"}, [evidence_item(0)])[0]
                self.assertEqual(result.evidence_sign, expected)

    def test_confidence_is_certainty_about_demonstrates(self):
        for value, expected in ((0.88, 0.88), (0.12, 0.88)):
            with self.subTest(value=value):
                self.stub_post({"answers": {
                    "tier": {"choice": "T1"},
                    "demonstrates_0": {"noul": value},
                    "positive_0": {"noul": 0.9},
                    "autonomy_0": {"score": 3}}})
                result = self._judge().judge_evidence(
                    {"title": "t"}, [evidence_item(0)])[0]
                self.assertAlmostEqual(result.confidence, expected, places=3)

    def test_request_state_is_the_event_text(self):
        event_text = {"title": "GPT-X in production", "summary": "s"}
        self.stub_post({"answers": {"tier": {"choice": "T1"},
                                    "demonstrates_0": {"noul": 0.9}}})
        self._judge().judge_evidence(event_text, [evidence_item(0)])
        self.assertEqual(self.posts[0]["payload"]["state"], event_text)
        self.assertEqual(self.posts[0]["url"], judge.TYPESAFE_URL)

    def test_evidence_prompt_digest_tracks_the_autonomy_rubric(self):
        stub = object.__new__(judge.TypeSafeEvidenceJudge)
        stub.model = "jev-latest"
        before = stub.evidence_prompt_sha256()
        self.assertEqual(len(before), 64)
        original = ontology_schema.load_schema
        model = json.loads(json.dumps(SCHEMA))
        model["vocabularies"]["autonomy_stage"]["terms"]["3"]["definition"]["zh-CN"] = "改动"
        ontology_schema.load_schema = lambda *a, **k: model
        self.addCleanup(lambda: setattr(ontology_schema, "load_schema", original))
        self.assertNotEqual(before, stub.evidence_prompt_sha256())


class JudgeRegistryTests(unittest.TestCase):
    def test_known_judges(self):
        self.assertEqual(sorted(judge.JUDGES), ["deepseek", "typesafe"])

    def test_unknown_judge_is_refused(self):
        with self.assertRaises(judge.JudgeError):
            judge.build_judge("nope")


if __name__ == "__main__":
    unittest.main()


