"""Resolving model mentions against the registry, without a database or a judge."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_pipeline import model_identification as mi
from data_pipeline import ontology_schema


def mention(text, name=None, family=None, version=None, variant=None, owner="Google", role="subject",
            confidence=0.9):
    return {"mention": text, "name": name or text, "family": family, "version": version,
            "variant": variant, "owner": owner, "role": role, "confidence": confidence}


FLASH = dict(family="Gemini", version="3.8", variant="Flash")


class AgreesWithTheSemanticModel(unittest.TestCase):
    """The schema defines the roles; the prompt and the code restate nothing else."""

    def test_roles_are_the_vocabulary(self):
        self.assertEqual(list(mi.ROLES), ontology_schema.term_ids("model_role"))

    def test_the_prompt_gives_each_role_its_definition(self):
        for role in mi.ROLES:
            self.assertIn(ontology_schema.term("model_role", role)["definition"]["en"], mi.SYSTEM)

    def test_release_kinds_are_event_kinds(self):
        self.assertLessEqual(set(mi.RELEASE_KINDS), set(ontology_schema.term_ids("event_kind")))
        rule = next(r for r in ontology_schema.load_schema()["constraints"] if r["id"] == "rule:model-confirmed-by-owner-release")
        self.assertEqual(rule["expression"]["event_kinds"], list(mi.RELEASE_KINDS))


class ShortNames(unittest.TestCase):
    @staticmethod
    def registry(*releases):
        rows = [{"model_id": "f:claude", "level": "family", "name": "Claude", "parent_model_id": None},
                {"model_id": "f:gemini", "level": "family", "name": "Gemini", "parent_model_id": None},
                {"model_id": "f:qwen", "level": "family", "name": "Qwen", "parent_model_id": None}]
        return rows + [{"model_id": f"r:{name}", "level": "release", "name": name, "parent_model_id": family}
                       for name, family in releases]

    def test_the_family_name_is_dropped(self):
        shorts = mi.short_names(self.registry(("Claude Opus 5.5", "f:claude")))
        self.assertEqual(shorts, {"opus 5 5": "r:Claude Opus 5.5"})

    def test_a_short_name_two_models_share_belongs_to_neither(self):
        shorts = mi.short_names(self.registry(("Gemini Flash 4", "f:gemini"), ("Qwen Flash 4", "f:qwen"),
                                              ("Claude Opus 5.5", "f:claude")))
        self.assertEqual(shorts, {"opus 5 5": "r:Claude Opus 5.5"})

    def test_a_short_name_starts_with_a_word(self):
        shorts = mi.short_names(self.registry(("Gemini 3.8 Flash", "f:gemini"), ("Qwen 3.7", "f:qwen")))
        self.assertEqual(shorts, {})

    def test_a_short_name_needs_a_version_and_more_than_one_word(self):
        shorts = mi.short_names(self.registry(("Claude Opus", "f:claude"), ("Claude 5", "f:claude"),
                                              ("Opus 5.5", "f:claude")))
        self.assertEqual(shorts, {})

    def test_a_family_and_a_release_without_one_have_no_short_name(self):
        rows = self.registry() + [{"model_id": "r:x", "level": "release", "name": "Claude Opus 5.5",
                                   "parent_model_id": None}]
        self.assertEqual(mi.short_names(rows), {})


class Normalising(unittest.TestCase):
    def test_spellings_of_one_name_meet(self):
        self.assertEqual(mi.normalize("Gemini 3.8-Flash"), mi.normalize("gemini-3.8 flash"))
        self.assertEqual(mi.normalize("  GPT-6  Astra "), "gpt 6 astra")

    def test_a_point_zero_version_is_the_whole_number(self):
        self.assertEqual(mi.normalize("Wan3.0"), mi.normalize("Wan 3"))
        self.assertNotEqual(mi.normalize("Gemini 3.05"), mi.normalize("Gemini 3.5"))
        self.assertNotEqual(mi.normalize("Qwen 3.8"), mi.normalize("Qwen 38"))

    def test_nothing_normalises_to_nothing(self):
        self.assertEqual(mi.normalize(None), "")
        self.assertEqual(mi.normalize("—"), "")


class CleaningTheJudgesAnswer(unittest.TestCase):
    def test_a_mention_without_a_known_role_is_dropped(self):
        self.assertEqual(mi.clean_mentions([{"mention": "Codex", "role": "product"}]), [])
        self.assertEqual(mi.clean_mentions([{"mention": "", "role": "subject"}]), [])
        self.assertEqual(mi.clean_mentions("nonsense"), [])

    def test_a_numeric_version_becomes_text_and_blanks_become_null(self):
        got = mi.clean_mentions([{"mention": "GPT-6", "family": "GPT", "version": 6, "variant": " ",
                                  "owner": "OpenAI", "role": "subject", "confidence": 7}])
        self.assertEqual(got[0]["version"], "6")
        self.assertIsNone(got[0]["variant"])
        self.assertEqual(got[0]["name"], "GPT-6")
        self.assertEqual(got[0]["confidence"], 1.0)


class Resolving(unittest.TestCase):
    def test_a_new_release_opens_a_candidate_under_its_family(self):
        reg = mi.Registry()
        model_id = reg.resolve(mention("Gemini 3.8 Flash", **FLASH), "ev-1")
        self.assertEqual(model_id, "model:google:gemini-3-8-flash")
        row = reg.models[model_id]
        self.assertEqual((row["level"], row["status"], row["parent_model_id"], row["org_id"]),
                         ("release", "candidate", "model:google:gemini", "org:google"))
        self.assertEqual(reg.models["model:google:gemini"]["level"], "family")

    def test_another_spelling_resolves_to_the_same_model(self):
        reg = mi.Registry()
        first = reg.resolve(mention("Gemini 3.8 Flash", **FLASH), "ev-1")
        again = reg.resolve(mention("gemini-3.8-flash", role="adopted", **FLASH), "ev-2")
        self.assertEqual(first, again)
        self.assertEqual(len([m for m in reg.models.values() if m["level"] == "release"]), 1)
        self.assertEqual(reg.models[first]["first_seen_event_id"], "ev-1")

    def test_a_dated_build_is_an_alias_of_its_release(self):
        reg = mi.Registry()
        release = reg.resolve(mention("Grok 4.6", family="Grok", version="4.6", owner="xAI"), "ev-1")
        build = reg.resolve(mention("grok-4.6-0903", name="Grok 4.6", family="Grok", version="4.6",
                                    owner="xAI"), "ev-2")
        self.assertEqual(release, build)
        self.assertEqual(reg.aliases[mi.normalize("grok-4.6-0903")], release)

    def test_a_variant_the_judge_folded_into_its_base_does_not_become_its_alias(self):
        reg = mi.Registry()
        base = reg.resolve(mention("Qwen3.8", family="Qwen", version="3.8", owner="Alibaba"), "ev-1")
        reg.resolve(mention("Qwen3.8-Max", name="Qwen3.8", family="Qwen", version="3.8",
                            owner="Alibaba"), "ev-2")
        self.assertNotIn(mi.normalize("Qwen3.8-Max"), reg.aliases)
        own = reg.resolve(mention("Qwen3.8-Max", family="Qwen", version="3.8", variant="Max",
                                  owner="Alibaba"), "ev-3")
        self.assertNotEqual(own, base)

    def test_a_family_only_mention_links_to_the_family_and_guesses_no_version(self):
        reg = mi.Registry()
        reg.resolve(mention("Gemini 3.8 Flash", **FLASH), "ev-1")
        family = reg.resolve(mention("Gemini", family="Gemini", role="adopted"), "ev-2")
        self.assertEqual(family, "model:google:gemini")
        self.assertIsNone(reg.models[family]["version"])

    def test_an_owner_outside_the_registry_keeps_its_name(self):
        reg = mi.Registry()
        model_id = reg.resolve(mention("Zebra 2", family="Zebra", version="2", owner="Zebra Labs",
                                       role="compared"), "ev-1")
        self.assertEqual(model_id, "model:zebra-labs:zebra-2")
        self.assertIsNone(reg.models[model_id]["org_id"])
        self.assertEqual(reg.models[model_id]["owner_name"], "Zebra Labs")

    def test_an_alias_already_taken_is_not_reassigned(self):
        reg = mi.Registry()
        first = reg.resolve(mention("Nova", family="Nova", owner="Amazon"), "ev-1")
        second = reg.resolve(mention("Nova", family="Nova", owner="Zebra Labs"), "ev-2")
        self.assertEqual(first, second)

    def test_a_name_that_does_not_split_keeps_version_and_variant_null(self):
        reg = mi.Registry()
        model_id = reg.resolve(mention("GPT Rosalind", family="GPT", owner="OpenAI"), "ev-1")
        row = reg.models[model_id]
        self.assertEqual((row["level"], row["name"], row["version"], row["variant"]),
                         ("release", "GPT Rosalind", None, None))


class LinksForOneUpdate(unittest.TestCase):
    def test_one_row_per_model_and_role(self):
        reg = mi.Registry()
        rows = mi.links_for(reg, "ev-1", [
            mention("Gemini 3.8 Flash", confidence=0.5, **FLASH),
            mention("gemini-3.8-flash", confidence=0.9, **FLASH),
            mention("Gemini 3.8 Flash", role="compared", **FLASH)])
        self.assertEqual(sorted((r["role"], r["mention"]) for r in rows),
                         [("compared", "Gemini 3.8 Flash"), ("subject", "gemini-3.8-flash")])

    def test_an_update_naming_no_model_has_no_rows(self):
        self.assertEqual(mi.links_for(mi.Registry(), "ev-1", []), [])


if __name__ == "__main__":
    unittest.main()
