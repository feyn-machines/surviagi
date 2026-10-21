"""Offline unit tests for the Python view of the schema.

Dependency-free (no psycopg, no network): the schema is a local JSON file
and everything here is pure rendering and hashing.
"""
import copy
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_pipeline import ontology_schema  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PROJECTIONS = ROOT / "scripts" / "build-ontology-projections.mjs"


def altered(mutate):
    """A private copy of the model with one edit applied."""
    model = copy.deepcopy(ontology_schema.load_schema())
    mutate(model)
    return model


class LoaderTests(unittest.TestCase):
    def test_model_path_and_version(self):
        self.assertTrue(ontology_schema.SCHEMA_PATH.exists())
        self.assertEqual(ontology_schema.SCHEMA_PATH.name, "schema.json")
        self.assertEqual(ontology_schema.SCHEMA_VERSION, "2.4.0")
        self.assertEqual(ontology_schema.load_schema()["version"], ontology_schema.SCHEMA_VERSION)

    def test_load_schema_is_cached(self):
        self.assertIs(ontology_schema.load_schema(), ontology_schema.load_schema())

    def test_term_ids_are_in_declaration_order(self):
        ids = ontology_schema.term_ids("event_kind")
        self.assertEqual(len(ids), 19)
        self.assertEqual(ids[0], "product_launch")
        self.assertEqual(ids, list(ontology_schema.load_schema()["vocabularies"]["event_kind"]["terms"]))

    def test_term_ids_handles_a_list_shaped_vocabulary(self):
        model = altered(lambda m: m["vocabularies"].__setitem__(
            "toy", {"terms": ["alpha", "beta"]}))
        self.assertEqual(ontology_schema.term_ids("toy", model), ["alpha", "beta"])
        self.assertEqual(ontology_schema.term("toy", "alpha", model), {})
        self.assertIsNone(ontology_schema.term("toy", "gamma", model))

    def test_term_returns_the_body(self):
        body = ontology_schema.term("event_kind", "benchmark_result")
        self.assertIn("discriminator", body)
        self.assertIsNone(ontology_schema.term("event_kind", "other"))

    def test_unknown_vocabulary_is_an_error(self):
        with self.assertRaises(KeyError):
            ontology_schema.term_ids("not_a_vocabulary")

    def test_no_other_bucket_in_any_vocabulary(self):
        for name in ontology_schema.load_schema()["vocabularies"]:
            with self.subTest(vocabulary=name):
                self.assertNotIn("other", ontology_schema.term_ids(name))


class VocabularyMarkerTests(unittest.TestCase):
    """The markers are half of a SQL CHECK; the other half lives in the projector."""

    def test_markers_match_the_projection_script(self):
        source = PROJECTIONS.read_text(encoding="utf-8")
        # The projector renders the migrations that have already run, so its
        # marker is the first of the lineage, not the one written today.
        for constant, value in (("EVENT_KIND_VOCABULARY", ontology_schema.EVENT_KIND_VOCABULARIES[0]),
                                ("LEGACY_VOCABULARY", ontology_schema.LEGACY_VOCABULARY)):
            with self.subTest(constant=constant):
                found = re.search(rf'export const {constant} = "([^"]+)"', source)
                self.assertIsNotNone(found, f"{constant} not found in {PROJECTIONS.name}")
                self.assertEqual(found.group(1), value)

    def test_marker_names_the_event_kind_version(self):
        self.assertEqual(ontology_schema.EVENT_KIND_VOCABULARY, f"event_kind-{ontology_schema.EVENT_KIND_VERSION}")

    def test_a_retired_term_is_still_known_but_no_longer_offered(self):
        # rule:definitions-take-effect-forward: old rows keep it, new ones cannot take it.
        self.assertIn("event_announcement", ontology_schema.term_ids("event_kind"))
        self.assertNotIn("event_announcement", ontology_schema.current_term_ids("event_kind"))
        self.assertNotIn("[zh-CN]: 会议、直播、比赛", ontology_schema.event_kind_rubric())
        self.assertEqual(ontology_schema.current_term_ids("post_link"), ontology_schema.term_ids("post_link"))

    def test_a_reader_accepts_every_version_of_the_lineage(self):
        # Rows written under 2.0.0 keep that marker; reading by the current
        # marker alone would drop them all from links, routing and the snapshot.
        self.assertEqual(ontology_schema.EVENT_KIND_VOCABULARIES, ["event_kind-2.0.0", "event_kind-2.1.0", "event_kind-2.2.0"])
        self.assertEqual(ontology_schema.EVENT_KIND_VOCABULARIES[-1], ontology_schema.EVENT_KIND_VOCABULARY)
        self.assertEqual(ontology_schema.event_kind_markers(), ontology_schema.EVENT_KIND_VOCABULARIES)
        self.assertEqual(ontology_schema.event_kind_markers("event_kind-2.0.0"), ["event_kind-2.0.0"])
        self.assertNotIn(ontology_schema.LEGACY_VOCABULARY, ontology_schema.EVENT_KIND_VOCABULARIES)


class RubricRenderingTests(unittest.TestCase):
    def test_every_term_is_rendered_with_its_discriminator(self):
        rubric = ontology_schema.event_kind_rubric()
        ids = ontology_schema.current_term_ids("event_kind")
        self.assertEqual(len(ids), 18)
        for term_id in ids:
            with self.subTest(term=term_id):
                body = ontology_schema.term("event_kind", term_id)
                self.assertIn(term_id, rubric)
                for language, text in body["discriminator"].items():
                    self.assertIn(text, rubric, f"{term_id} discriminator [{language}] missing")

    def test_every_term_renders_definition_and_both_examples(self):
        rubric = ontology_schema.event_kind_rubric()
        for term_id in ontology_schema.current_term_ids("event_kind"):
            with self.subTest(term=term_id):
                body = ontology_schema.term("event_kind", term_id)
                self.assertIn(body["definition"]["zh-CN"], rubric)
                self.assertIn(body["definition"]["en"], rubric)
                self.assertIn(body["positive_example"], rubric)
                self.assertIn(body["negative_example"], rubric)

    def test_rubric_states_the_closed_set_and_the_null_rule(self):
        rubric = ontology_schema.event_kind_rubric()
        self.assertIn("closed", rubric)
        self.assertIn("unresolved_reason", rubric)
        self.assertNotIn("[3/15] other", rubric)

    def test_identity_rule_carries_triple_subject_and_window(self):
        rendered = ontology_schema.event_identity_rule()
        identity = ontology_schema.event_identity()
        for field in identity["identity_fields"]:
            self.assertIn(field, rendered)
        self.assertIn("title is display only", rendered)
        self.assertIn(identity["subject_key"]["zh-CN"], rendered)
        self.assertIn(identity["occurrence_window"]["zh-CN"], rendered)  # the 14-day window
        self.assertIn("14", rendered)

    def test_rendering_a_modified_model_does_not_touch_the_real_one(self):
        # "personnel" is named by no other term's discriminator, so its heading is a
        # clean marker for whether the rendered rubric came from the edited copy.
        model = altered(lambda m: m["vocabularies"]["event_kind"]["terms"].pop("personnel"))
        self.assertNotIn("personnel  (", ontology_schema.event_kind_rubric(model))
        self.assertIn("17 terms", ontology_schema.event_kind_rubric(model))
        self.assertIn("personnel  (", ontology_schema.event_kind_rubric())
        self.assertEqual(len(ontology_schema.term_ids("event_kind")), 19)


class RubricHashTests(unittest.TestCase):
    def test_stable_when_nothing_changes(self):
        first = ontology_schema.rubric_sha256()
        self.assertEqual(len(first), 64)
        self.assertEqual(first, ontology_schema.rubric_sha256())
        self.assertEqual(first, ontology_schema.rubric_sha256(copy.deepcopy(ontology_schema.load_schema())))

    def test_changes_when_a_discriminator_changes(self):
        def move_the_boundary(model):
            term = model["vocabularies"]["event_kind"]["terms"]["availability_change"]
            term["discriminator"]["zh-CN"] += "（改过的判别依据）"
        self.assertNotEqual(ontology_schema.rubric_sha256(altered(move_the_boundary)),
                            ontology_schema.rubric_sha256())

    def test_changes_when_a_term_is_added_or_removed(self):
        removed = altered(lambda m: m["vocabularies"]["event_kind"]["terms"].pop("deprecation"))
        self.assertNotEqual(ontology_schema.rubric_sha256(removed), ontology_schema.rubric_sha256())

    def test_changes_when_the_identity_rule_changes(self):
        def widen_window(model):
            model["classes"]["Event"]["identity"]["occurrence_window"]["zh-CN"] = "30 天"
        self.assertNotEqual(ontology_schema.rubric_sha256(altered(widen_window)), ontology_schema.rubric_sha256())

    def test_changes_when_the_event_kind_version_changes(self):
        bumped = altered(lambda m: m["vocabularies"]["event_kind"].__setitem__("version", "2.9.0"))
        self.assertNotEqual(ontology_schema.rubric_sha256(bumped), ontology_schema.rubric_sha256())

    def test_a_model_version_that_adds_unrelated_types_keeps_runs_comparable(self):
        bumped = altered(lambda m: m.__setitem__("version", "9.9.9"))
        self.assertEqual(ontology_schema.rubric_sha256(bumped), ontology_schema.rubric_sha256())

    def test_ignores_what_does_not_decide_a_classification(self):
        # The hash answers "was this classified under the same rubric?", so an edit
        # elsewhere in the model must not invalidate comparisons between runs.
        def unrelated(model):
            model["note"] = "editorial note"
            model["vocabularies"]["lifecycle"]["terms"] = {"active": {}, "deprecated": {}}
        self.assertEqual(ontology_schema.rubric_sha256(altered(unrelated)), ontology_schema.rubric_sha256())

    def test_hash_is_order_independent(self):
        def reorder(model):
            terms = model["vocabularies"]["event_kind"]["terms"]
            model["vocabularies"]["event_kind"]["terms"] = dict(reversed(list(terms.items())))
        self.assertEqual(ontology_schema.rubric_sha256(altered(reorder)), ontology_schema.rubric_sha256())


class TypeLayerHasNoInstancesTests(unittest.TestCase):
    """The model declares itself a sealable type layer; these hold it to that.

    It used to carry `derived_content`: five capability definitions, twelve
    candidate edges, a dated method journal and a measurement of judge agreement -
    46% of the file, and a direct contradiction of its own
    rule:type-layer-has-no-state. The split moved definitions to the two
    capabilities files, state to PostgreSQL and the journal to docs/.
    """

    DATED_KEYS = {"on", "closed_on", "as_of", "generated_at", "measured_at",
                  "measured_over", "observed_at"}

    def test_the_model_carries_no_derived_content(self):
        self.assertNotIn("derived_content", ontology_schema.load_schema())

    def test_the_model_records_no_point_in_time(self):
        """A date in prose can be a naming example; a dated key is a record."""
        found = []

        def walk(node, path):
            if isinstance(node, list):
                for i, item in enumerate(node):
                    walk(item, f"{path}[{i}]")
                return
            if not isinstance(node, dict):
                return
            for key, value in node.items():
                if key in self.DATED_KEYS:
                    found.append(f"{path}.{key}")
                walk(value, f"{path}.{key}")

        walk(ontology_schema.load_schema(), "model")
        self.assertEqual(found, [])

    def test_gates_are_instances_and_live_outside_the_model(self):
        """Gates survived the capability layer; they are still instances.

        They used to share a file with capabilities, because the proposing pass
        asked what work requires and a model answers a gate: physical-presence
        reached fourteen occupation groups, the broadest thing proposed, and it
        is the most textbook gate there is.
        """
        gates = json.loads((ROOT / "datasets/ontology/data/gates.json").read_text())
        self.assertEqual(len(gates["gates"]), 11)
        self.assertEqual(gates["status"], "candidate")
        self.assertEqual(gates["method"], "ai_proposed")
        self.assertNotIn("capabilities", gates)
        for gate in gates["gates"]:
            with self.subTest(gate=gate["id"]):
                self.assertTrue(gate["id"].startswith("gate:"))
                self.assertIn("gate_type", gate)

    def test_the_journal_kept_what_the_model_gave_up(self):
        journal = (ROOT / "docs/data/ontology-journal.md").read_text()
        for correction in ("correction:production-use-needs-no-metric",
                           "correction:a-capability-that-reaches-everything-explains-nothing",
                           "correction:a-malformed-probe-almost-became-a-finding"):
            self.assertIn(correction, journal)

    def test_the_journal_counts_its_own_corrections_correctly(self):
        """The heading says how many; the file has to actually hold that many.

        This used to assert a hard-coded number, which fails the moment a
        correction is added - and passes forever if one is quietly dropped while
        the heading stays put. Comparing the two catches both.
        """
        journal = (ROOT / "docs/data/ontology-journal.md").read_text()
        declared = re.search(r"## 方法修正（(\d+) 条）", journal)
        self.assertIsNotNone(declared, "the corrections heading must declare a count")
        written = len(re.findall(r"^### correction:", journal, re.M))
        self.assertEqual(int(declared.group(1)), written)


class ActivityLevelTests(unittest.TestCase):
    """The ladder the activity layer is measured on, and the caps over it.

    These numbers used to live as literals in three Python files while the
    semantic layer carried a DIFFERENT set under evidence_tier.stage_cap - the
    caps for the retired 0-4 autonomy_stage. T3 capped at 2 on both scales,
    which is the single coincidence that kept the divergence out of sight.
    """

    def test_the_scale_is_contiguous_integers_from_zero(self):
        self.assertEqual(ontology_schema.level_ids(), [0, 1, 2, 3, 4, 5])

    def test_l5_stays_on_the_scale_while_empty(self):
        """An empty top rung is a finding; dropping it would erase the finding."""
        self.assertIn(5, ontology_schema.level_ids())
        self.assertTrue(ontology_schema.load_schema()["vocabularies"]["activity_level"]
                        .get("top_rung_is_permanent"))

    def test_caps_come_from_level_cap_not_stage_cap(self):
        tiers = ontology_schema.load_schema()["vocabularies"]["evidence_tier"]["terms"]
        self.assertEqual(ontology_schema.level_caps(),
                         {"T1": 5.0, "T2": 4.0, "T3": 2.0, "T4": 1.0})
        self.assertEqual({t: b["stage_cap"] for t, b in tiers.items()},
                         {"T1": 4, "T2": 3, "T3": 2, "T4": 1})
        # The two scales must not be quietly collapsed into one again.
        self.assertNotEqual({t: b["stage_cap"] for t, b in tiers.items()},
                            {t: int(c) for t, c in ontology_schema.level_caps().items()})

    def test_no_cap_exceeds_the_top_of_its_own_scale(self):
        top = max(ontology_schema.level_ids())
        for tier, cap in ontology_schema.level_caps().items():
            with self.subTest(tier=tier):
                self.assertLessEqual(cap, top)
                self.assertGreaterEqual(cap, 0)

    def test_a_judge_score_becomes_the_level_it_has_reached(self):
        """Levels are categories. 3.82 has not reached L4, so it is L3."""
        self.assertEqual(ontology_schema.level_of_score(3.82), 3)
        self.assertEqual(ontology_schema.level_of_score(2.0), 2)
        self.assertEqual(ontology_schema.level_of_score(0.43), 0)
        self.assertIsNone(ontology_schema.level_of_score(None))
        self.assertIsInstance(ontology_schema.level_of_score(3.82), int)

    def test_the_score_sql_rounds_down(self):
        self.assertEqual(ontology_schema.level_of_score_sql("ae.observed_level"),
                         "floor(ae.observed_level)")

    def test_a_barrier_caps_at_three_not_zero(self):
        """L0 means AI takes no part; a barrier only rules out delivery without a person."""
        self.assertEqual(ontology_schema.gate_level_cap(), 3)

    def test_scores_below_one_are_not_a_level(self):
        self.assertEqual(ontology_schema.min_level_score(), 1.0)

    def test_only_production_use_can_show_l4(self):
        """A demo, however good, is not running in real business."""
        sql = ontology_schema.nature_cap_sql()
        self.assertIn("WHEN 'hands_on_test' THEN 3", sql)
        self.assertIn("WHEN 'independent_evaluation' THEN 3", sql)
        self.assertIn("WHEN 'own_production_use' THEN 5", sql)
        self.assertNotIn("ELSE", sql)

    def test_cap_sql_names_every_tier_rather_than_defaulting(self):
        """An ELSE arm would cap an unknown tier at T4 instead of failing."""
        sql = ontology_schema.level_cap_sql()
        self.assertNotIn("ELSE", sql)
        for tier in ontology_schema.term_ids("evidence_tier"):
            self.assertIn(f"WHEN '{tier}'", sql)

    def test_the_judge_prompt_is_the_vocabulary(self):
        """The prompt must project the ladder, never carry a second copy."""
        scale = ontology_schema.level_scale()
        self.assertEqual(len(scale), 6)
        self.assertEqual(scale[0], "AI takes no part in this work.")
        for index, value in enumerate(ontology_schema.level_ids()):
            body = ontology_schema.term("activity_level", str(value))
            self.assertEqual(scale[index], body["definition"]["en"])

    def test_every_rung_is_bilingual(self):
        for value in ontology_schema.level_ids():
            body = ontology_schema.term("activity_level", str(value))
            with self.subTest(level=value):
                for field in ("label", "definition"):
                    self.assertTrue(body[field]["en"].strip())
                    self.assertTrue(body[field]["zh-CN"].strip())

    def test_the_retired_scale_says_so(self):
        """autonomy_stage stays in the model: migration 006's CHECK is applied
        and hash-verified, so the term list cannot be edited. It is marked
        instead, which is also what keeps the journal's references resolvable."""
        old = ontology_schema.load_schema()["vocabularies"]["autonomy_stage"]
        self.assertTrue(old["retired"])
        self.assertEqual(old["superseded_by"], "activity_level")
        self.assertEqual(ontology_schema.term_ids("autonomy_stage"), ["0", "1", "2", "3", "4"])

    def test_a_changed_rung_changes_the_question(self):
        def reword(model):
            model["vocabularies"]["activity_level"]["terms"]["2"]["definition"]["en"] = "changed"
        self.assertEqual(ontology_schema.level_scale(altered(reword))[2], "changed")
        self.assertNotEqual(ontology_schema.level_scale()[2], "changed")


class SemanticReadsNoDatabaseTests(unittest.TestCase):
    """The rubric and the ladder are read from files, with no psycopg installed.

    publish.py once reached for judge_runner's copy of the criteria reader and
    broke `pnpm check`, which runs these under the system python. The rule that
    came out of it is why the whole schema view lives in this module.
    """

    def test_it_imports_no_database_and_no_runner(self):
        source = Path(ontology_schema.__file__).read_text()
        imports = [line.strip() for line in source.splitlines()
                   if line.startswith(("import ", "from "))]
        self.assertTrue(imports)
        for line in imports:
            self.assertNotIn("psycopg", line)
            self.assertNotIn("_runner", line)


if __name__ == "__main__":
    unittest.main()
