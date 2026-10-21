"""Picking our companies' recent models out of a models.dev snapshot, without a database."""
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_pipeline import model_catalog as mc

MAPPING = {
    "since": "2026-01-01",
    "owners": {"anthropic": "org:anthropic", "alibaba": "org:alibaba"},
    "providers": [
        {"key": "anthropic", "name": "Anthropic", "kind": "first_party", "org_id": "org:anthropic"},
        {"key": "alibaba", "name": "Alibaba", "kind": "first_party", "org_id": "org:alibaba"},
        {"key": "amazon-bedrock", "name": "Amazon Bedrock", "kind": "cloud", "org_id": None},
    ],
}


def record(name, canonical, released, **extra):
    return {"id": canonical.split("/")[1] if canonical else name, "name": name,
            "canonical_model_id": canonical, "release_date": released, **extra}


def snapshot(**providers):
    return {key.replace("_", "-"): {"id": key, "name": key, "models": {str(i): m for i, m in enumerate(models)}}
            for key, models in providers.items()}


class Selecting(unittest.TestCase):
    def test_one_model_listed_by_many_providers_is_one_row(self):
        doc = snapshot(
            anthropic=[record("Claude Opus 5.5", "anthropic/claude-opus-5-5", "2026-09-18")],
            amazon_bedrock=[record("Claude Opus 5.5 (US)", "anthropic/claude-opus-5-5", "2026-09-26")],
            some_reseller=[record("claude opus", "anthropic/claude-opus-5-5", "2026-09-20")])
        (row,) = mc.select(doc, MAPPING)
        self.assertEqual(row["catalog_id"], "anthropic/claude-opus-5-5")
        self.assertEqual(row["org_id"], "org:anthropic")
        self.assertEqual(row["name"], "Claude Opus 5.5")  # the owner's own spelling
        self.assertEqual(row["released_on"], date(2026, 9, 18))  # earliest listing
        self.assertEqual(row["offerings"], [("amazon-bedrock", date(2026, 9, 26)),
                                            ("anthropic", date(2026, 9, 18))])

    def test_ownership_comes_from_the_canonical_id_not_the_provider(self):
        doc = snapshot(alibaba=[record("DeepSeek V4 Flash", "deepseek/deepseek-v4-flash", "2026-04-24"),
                                record("Qwen3.8 Max", "alibaba/qwen3.8-max", "2026-08-03")])
        self.assertEqual([r["catalog_id"] for r in mc.select(doc, MAPPING)], ["alibaba/qwen3.8-max"])

    def test_older_models_and_records_without_an_owner_are_left_out(self):
        doc = snapshot(anthropic=[record("Claude Opus 4.5", "anthropic/claude-opus-4-5", "2025-11-24"),
                                  record("Mystery", None, "2026-05-01")])
        self.assertEqual(mc.select(doc, MAPPING), [])

    def test_a_moving_latest_pointer_is_not_a_model(self):
        doc = snapshot(anthropic=[record("Claude Opus (latest)", "anthropic/claude-opus-latest", "2026-09-18")])
        self.assertEqual(mc.select(doc, MAPPING), [])

    def test_without_the_owners_listing_the_commonest_name_is_used(self):
        doc = snapshot(amazon_bedrock=[record("Qwen3.8 Max", "alibaba/qwen3.8-max", "2026-08-05")],
                       r1=[record("Qwen3.8 Max", "alibaba/qwen3.8-max", "2026-08-04")],
                       r2=[record("qwen-max-3.8", "alibaba/qwen3.8-max", "2026-08-03")])
        (row,) = mc.select(doc, MAPPING)
        self.assertEqual(row["name"], "Qwen3.8 Max")
        self.assertEqual(row["released_on"], date(2026, 8, 3))
        self.assertEqual(row["offerings"], [("amazon-bedrock", date(2026, 8, 5))])

    def test_a_name_that_spells_the_canonical_id_beats_the_owners_moving_alias(self):
        doc = snapshot(alibaba=[record("Qwen3.8 Max", "alibaba/qwen3.8-max-0902", "2026-09-02")],
                       r1=[record("Qwen3.8 Max 0902", "alibaba/qwen3.8-max-0902", "2026-09-02")])
        (row,) = mc.select(doc, MAPPING)
        self.assertEqual(row["name"], "Qwen3.8 Max 0902")
        self.assertEqual(row["aliases"], ["qwen 3 8 max 0902"])

    def test_aliases_are_the_name_and_the_catalog_slug(self):
        doc = snapshot(anthropic=[record("Claude Opus 5.5", "anthropic/claude-opus-5-5", "2026-09-18")])
        (row,) = mc.select(doc, MAPPING)
        self.assertEqual(row["aliases"], ["claude opus 5 5"])
        doc = snapshot(alibaba=[record("Qwen-Max 3.8", "alibaba/qwen3.8-max", "2026-08-03")])
        (row,) = mc.select(doc, MAPPING)
        self.assertEqual(row["aliases"], ["qwen 3 8 max", "qwen max 3 8"])


class CatalogAttributes(unittest.TestCase):
    OUT = {"modalities": {"input": ["text", "image"], "output": ["text"]}}

    def test_the_owners_own_listing_decides(self):
        doc = snapshot(
            anthropic=[record("Claude Opus 5.5", "anthropic/claude-opus-5-5", "2026-09-18",
                              open_weights=False, **self.OUT)],
            amazon_bedrock=[record("Claude Opus 5.5", "anthropic/claude-opus-5-5", "2026-09-26",
                                   open_weights=True, modalities={"output": ["text", "image"]})])
        (row,) = mc.select(doc, MAPPING)
        self.assertEqual((row["open_weights"], row["output_modalities"]), (False, ["text"]))

    def test_without_the_owner_listings_must_agree(self):
        agree = snapshot(r1=[record("Qwen-Image-2.1", "alibaba/qwen-image-2.1", "2026-09-14", open_weights=True,
                                    modalities={"output": ["image"]})],
                         r2=[record("Qwen-Image-2.1", "alibaba/qwen-image-2.1", "2026-09-14", open_weights=True,
                                    modalities={"output": ["image"]})])
        (row,) = mc.select(agree, MAPPING)
        self.assertEqual((row["open_weights"], row["output_modalities"]), (True, ["image"]))
        agree["r2"]["models"]["0"].update(open_weights=False, modalities={"output": ["image", "text"]})
        (row,) = mc.select(agree, MAPPING)
        self.assertEqual((row["open_weights"], row["output_modalities"]), (None, []))

    def test_a_catalog_that_does_not_say_leaves_them_empty(self):
        doc = snapshot(anthropic=[record("Claude Opus 5.5", "anthropic/claude-opus-5-5", "2026-09-18")])
        (row,) = mc.select(doc, MAPPING)
        self.assertEqual((row["open_weights"], row["output_modalities"]), (None, []))

    def test_a_modality_outside_the_vocabulary_is_dropped(self):
        doc = snapshot(anthropic=[record("Claude Opus 5.5", "anthropic/claude-opus-5-5", "2026-09-18",
                                         modalities={"output": ["text", "pdf"]})])
        (row,) = mc.select(doc, MAPPING)
        self.assertEqual(row["output_modalities"], ["text"])


class FindingTheFamily(unittest.TestCase):
    def test_the_longest_family_prefix_of_the_same_owner_wins(self):
        models = {"model:anthropic:claude": {"level": "family", "org_id": "org:anthropic"},
                  "model:anthropic:claude-opus": {"level": "family", "org_id": "org:anthropic"},
                  "model:google:claude": {"level": "family", "org_id": "org:google"}}
        aliases = {"claude": "model:anthropic:claude", "claude opus": "model:anthropic:claude-opus"}
        self.assertEqual(mc.family_of("Claude Opus 4.8", "org:anthropic", models, aliases),
                         "model:anthropic:claude-opus")
        self.assertEqual(mc.family_of("Claude Fable 5", "org:anthropic", models, aliases),
                         "model:anthropic:claude")
        self.assertIsNone(mc.family_of("Claude Opus 4.8", "org:google", models, aliases))
        self.assertIsNone(mc.family_of("Muse Spark 1.1", "org:anthropic", models, aliases))


if __name__ == "__main__":
    unittest.main()
