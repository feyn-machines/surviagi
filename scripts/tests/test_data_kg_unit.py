"""Offline tests for the kg release library: packing, ids and diffing.

Dependency-free on purpose (no psycopg): runs under `pnpm data:test:unit` with the
system python. The database behaviour is in test_data_kg.py.
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_pipeline import kg  # noqa: E402
from data_pipeline.pipeline import digest  # noqa: E402

LATEST = Path(__file__).resolve().parents[2] / "datasets/published/latest"


def small_payload():
    return {
        "chain": {
            "events": [{"event_id": "e1", "n": 1}, {"event_id": "e2", "n": 2}],
            "evidence": [{"event_id": "e1", "activity_id": "a1"}],
            "activities": [{"activity_id": "a1", "level": 1.0}],
            "gates": [],
            "gate_edges": [{"gate_id": "g", "activity_id": "a1"}],
        },
        "markets": [{"market_id": "m", "occupation_id": "o1"}, {"market_id": "m", "occupation_id": "o2"}],
        "tasks": [],
        "events": [{"event_id": "e1", "title": "T"}],
        "models": [{"model_id": "x"}],
        "sources": [{"account_key": "k", "note": None}],
        "topics": [{"topic_id": "topic:replacement:accountant:00000000"}],
        "coverage": {"events_routed": 3},
        "progress": {"assessed": 0, "groups": []},
    }


class PackTest(unittest.TestCase):
    def test_pack_unpack_is_identity_including_empty_collections(self):
        payload = small_payload()
        rows = kg.pack(payload)
        back = kg.unpack((r.collection, r.ord, r.doc) for r in rows)
        self.assertEqual(back, payload)
        self.assertEqual(digest(back), digest(payload))

    def test_unpack_is_independent_of_row_order(self):
        payload = small_payload()
        rows = list(reversed(kg.pack(payload)))
        self.assertEqual(kg.unpack((r.collection, r.ord, r.doc) for r in rows), payload)

    def test_rows_carry_document_digest_and_entity_id(self):
        rows = {(r.collection, r.ord): r for r in kg.pack(small_payload())}
        e2 = rows[("chain.events", 1)]
        self.assertEqual((e2.entity_id, e2.sha256), ("e2", digest({"event_id": "e2", "n": 2})))
        self.assertIsNone(rows[("markets", 0)].entity_id)
        self.assertIsNone(rows[("chain.evidence", 0)].entity_id)
        self.assertEqual(rows[("coverage", 0)].doc, {"events_routed": 3})
        self.assertEqual(rows[("models", 0)].entity_id, "x")
        self.assertEqual(rows[("sources", 0)].entity_id, "k")

    def test_dict_collections_are_one_row(self):
        rows = [r for r in kg.pack(small_payload()) if r.collection in ("coverage", "progress")]
        self.assertEqual([(r.collection, r.ord) for r in rows], [("coverage", 0), ("progress", 0)])

    def test_unknown_or_missing_collection_is_refused(self):
        extra = small_payload()
        extra["surprise"] = []
        with self.assertRaises(kg.KgError):
            kg.pack(extra)
        missing = small_payload()
        del missing["models"]
        with self.assertRaises(kg.KgError):
            kg.pack(missing)
        chain = small_payload()
        chain["chain"]["new"] = []
        with self.assertRaises(kg.KgError):
            kg.pack(chain)

    def test_entity_id_must_be_a_string_when_present(self):
        payload = small_payload()
        payload["models"] = [{"model_id": 7}]
        with self.assertRaises(kg.KgError):
            kg.pack(payload)

    def test_duplicate_entity_id_is_refused_naming_collection_and_id(self):
        payload = small_payload()
        payload["models"] = [{"model_id": "x"}, {"model_id": "x", "n": 2}]
        with self.assertRaises(kg.KgError) as raised:
            kg.pack(payload)
        self.assertIn("models", str(raised.exception))
        self.assertIn("'x'", str(raised.exception))

    def test_malformed_payload_shapes_are_one_line_errors(self):
        for mutate in (lambda p: p.update(chain=[]), lambda p: p.update(markets={}),
                       lambda p: p.update(coverage=[]), lambda p: p["chain"].update(events={}),
                       lambda p: p.update(chain=None)):
            payload = small_payload()
            mutate(payload)
            with self.assertRaises(kg.KgError) as raised:
                kg.verify_payload(payload, {"counts": {}, "content_sha256": ""})
            self.assertNotIn("\n", str(raised.exception))
            with self.assertRaises(kg.KgError):
                kg.pack(payload)

    def test_missing_entity_id_field_in_a_document_is_refused(self):
        payload = small_payload()
        payload["models"] = [{"name": "no id"}]
        with self.assertRaises(kg.KgError):
            kg.pack(payload)


class ReleaseIdTest(unittest.TestCase):
    def test_format_and_utc_conversion(self):
        manifest = {"generated_at": "2026-10-03T10:29:12.430661+00:00", "content_sha256": "103a1c38" + "0" * 56}
        self.assertEqual(kg.release_id(manifest), "20261003T102912Z-103a1c38")
        shifted = {"generated_at": "2026-10-03T18:29:12+08:00", "content_sha256": "ab" * 32}
        self.assertEqual(kg.release_id(shifted), "20261003T102912Z-abababab")
        zulu = {"generated_at": "2026-10-03T10:29:12Z", "content_sha256": "ab" * 32}
        self.assertEqual(kg.release_id(zulu), "20261003T102912Z-abababab")

    def test_generated_at_needs_a_timezone(self):
        with self.assertRaises(kg.KgError):
            kg.release_id({"generated_at": "2026-10-03T10:29:12", "content_sha256": "ab" * 32})


class DiffTest(unittest.TestCase):
    def rows(self, payload):
        return [(r.collection, r.entity_id, r.sha256) for r in kg.pack(payload)]

    def test_added_changed_removed_by_entity_id(self):
        old, new = small_payload(), small_payload()
        new["chain"]["events"] = [{"event_id": "e1", "n": 99}, {"event_id": "e3", "n": 3}]
        result = kg.diff_rows(self.rows(new), self.rows(old))
        self.assertEqual(result["chain.events"], {"added": 1, "changed": 1, "removed": 1, "reordered": False})
        self.assertEqual(result["models"], {"added": 0, "changed": 0, "removed": 0, "reordered": False})

    def test_without_ids_rows_compare_as_a_multiset(self):
        old, new = small_payload(), small_payload()
        new["markets"] = [{"market_id": "m", "occupation_id": "o1"}, {"market_id": "m", "occupation_id": "o9"},
                          {"market_id": "m", "occupation_id": "o9"}]
        result = kg.diff_rows(self.rows(new), self.rows(old))
        self.assertEqual(result["markets"], {"added": 2, "changed": 0, "removed": 1, "reordered": False})

    def test_pure_reordering_of_an_id_collection_is_reported(self):
        old, new = small_payload(), small_payload()
        new["chain"]["events"].reverse()
        result = kg.diff_rows(self.rows(new), self.rows(old))
        self.assertEqual(result["chain.events"], {"added": 0, "changed": 0, "removed": 0, "reordered": True})
        self.assertFalse(result["models"]["reordered"])

    def test_pure_reordering_of_an_id_less_collection_is_reported(self):
        old, new = small_payload(), small_payload()
        new["markets"].reverse()
        result = kg.diff_rows(self.rows(new), self.rows(old))
        self.assertEqual(result["markets"], {"added": 0, "changed": 0, "removed": 0, "reordered": True})

    def test_against_nothing_everything_is_added(self):
        result = kg.diff_rows(self.rows(small_payload()), [])
        self.assertEqual(result["chain.events"]["added"], 2)
        self.assertEqual(result["coverage"]["added"], 1)
        self.assertEqual(set(result), set(kg.COLLECTIONS))


@unittest.skipUnless((LATEST / "manifest.json").is_file(), "no local published snapshot")
class RealSnapshotTest(unittest.TestCase):
    def test_round_trip_reproduces_the_manifest_hash(self):
        payload, manifest = kg.read_snapshot(LATEST)
        rows = kg.pack(payload)
        back = kg.unpack((r.collection, r.ord, r.doc) for r in rows)
        self.assertEqual(digest(back), manifest["content_sha256"])

    def test_declared_entity_ids_are_present_and_unique(self):
        payload, _ = kg.read_snapshot(LATEST)
        by_collection = {}
        for r in kg.pack(payload):
            by_collection.setdefault(r.collection, []).append(r.entity_id)
        for collection, field in kg.COLLECTIONS.items():
            ids = by_collection.get(collection, [])
            if field is None:
                self.assertTrue(all(i is None for i in ids), collection)
            else:
                self.assertTrue(all(i is not None for i in ids), collection)
                self.assertEqual(len(ids), len(set(ids)), f"{collection}.{field} is not unique")

    def test_markets_market_id_is_not_unique_so_it_is_not_an_entity_id(self):
        payload, _ = kg.read_snapshot(LATEST)
        ids = [m["market_id"] for m in payload["markets"]]
        self.assertLess(len(set(ids)), len(ids))
        self.assertIsNone(kg.COLLECTIONS["markets"])

    def test_read_snapshot_rejects_a_changed_file(self):
        import shutil, tempfile
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(LATEST, tmp, dirs_exist_ok=True)
            models = json.loads((Path(tmp) / "models.json").read_text())
            models[0]["name"] = "tampered"
            (Path(tmp) / "models.json").write_text(json.dumps(models))
            with self.assertRaises(kg.KgError):
                kg.read_snapshot(Path(tmp))

    def test_read_snapshot_reports_a_missing_file(self):
        import shutil, tempfile
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(LATEST, tmp, dirs_exist_ok=True)
            (Path(tmp) / "tasks.json").unlink()
            with self.assertRaises(kg.KgError):
                kg.read_snapshot(Path(tmp))


if __name__ == "__main__":
    unittest.main()
