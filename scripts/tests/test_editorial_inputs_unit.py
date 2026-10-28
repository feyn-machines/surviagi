"""Dependency-free tests for completed collection input manifests."""
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import editorial_inputs


class EditorialInputsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "data" / "collection" / "official-x").mkdir(parents=True)
        (self.root / "data" / "collection" / "panel").mkdir(parents=True)

    def _record(self, role, *, status="queries_exhausted", ok=True,
                synthetic=False, window_start="2026-10-26T12:00:00+00:00",
                window_end="2026-10-27T00:00:00+00:00", job_status="search_ended"):
        posts = [{"id": f"{role}-post", "text": "private captured source text"}]
        return {
            "version": "crawler-run-1",
            "source": "x",
            "synthetic": synthetic,
            "ok": ok,
            "status": status,
            "coverage_status": "provider_search",
            "coverage_note": "bounded sample",
            "started_at": "2026-10-27T00:00:00+00:00",
            "finished_at": "2026-10-27T00:15:00+00:00",
            "publication_window": {"start": window_start, "end": window_end},
            "total": len(posts),
            "jobs": [{"status": job_status, "posts": posts}],
        }

    def _write(self, role, value=None):
        folder = "official-x" if role == "official" else "panel"
        path = self.root / "data" / "collection" / folder / f"{role}.json"
        path.write_text(json.dumps(value or self._record(role)), encoding="utf-8")
        path.chmod(0o600)
        return path

    def _prepare(self, official=None, panel=None):
        official = official or self._write("official")
        panel = panel or self._write("panel")
        return editorial_inputs.prepare_inputs(official, panel, root=self.root)

    def test_prepare_is_deterministic_private_and_excludes_source_text(self):
        manifest, created = self._prepare()
        again, created_again = self._prepare(
            self.root / "data/collection/official-x/official.json",
            self.root / "data/collection/panel/panel.json",
        )
        manifest_file = self.root / "data/editorial/inputs" / f"{manifest['input_id']}.json"
        self.assertTrue(created)
        self.assertFalse(created_again)
        self.assertEqual(manifest["input_sha256"], again["input_sha256"])
        self.assertEqual(manifest["window"]["start"], "2026-10-26T12:00:00+00:00")
        self.assertEqual(stat.S_IMODE(manifest_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(manifest_file.parent.stat().st_mode), 0o700)
        self.assertNotIn(b"private captured source text", manifest_file.read_bytes())

    def test_verify_rehashes_the_sources_and_detects_mutation(self):
        manifest, _ = self._prepare()
        verified = editorial_inputs.verify_inputs(manifest["input_id"], root=self.root)
        self.assertEqual(verified["input_sha256"], manifest["input_sha256"])
        official = self.root / "data/collection/official-x/official.json"
        record = json.loads(official.read_text())
        record["jobs"][0]["posts"][0]["text"] = "changed source"
        official.write_text(json.dumps(record), encoding="utf-8")
        official.chmod(0o600)
        with self.assertRaisesRegex(editorial_inputs.EditorialInputError, "changed after"):
            editorial_inputs.verify_inputs(manifest["input_id"], root=self.root)

    def test_incomplete_or_synthetic_batches_are_refused(self):
        for record, message in (
            (self._record("panel", status="needs_attention", ok=False), "not complete"),
            (self._record("panel", synthetic=True), "not synthetic"),
            (self._record("panel", job_status="running"), "unfinished job"),
        ):
            with self.subTest(message=message):
                self._write("official")
                self._write("panel", record)
                with self.assertRaisesRegex(editorial_inputs.EditorialInputError, message):
                    self._prepare(
                        self.root / "data/collection/official-x/official.json",
                        self.root / "data/collection/panel/panel.json",
                    )

    def test_different_windows_are_refused_and_empty_complete_batch_can_be_pinned(self):
        official = self._write("official")
        panel_record = self._record("panel", window_start="2026-10-25T12:00:00+00:00")
        panel = self._write("panel", panel_record)
        with self.assertRaisesRegex(editorial_inputs.EditorialInputError, "same window"):
            self._prepare(official, panel)
        empty = self._record("panel")
        empty["total"] = 0
        empty["jobs"][0]["posts"] = []
        self._write("panel", empty)
        manifest, _ = self._prepare(official, self.root / "data/collection/panel/panel.json")
        self.assertEqual(manifest["sources"][1]["post_count"], 0)
        empty["total"] = 1
        self._write("panel", empty)
        with self.assertRaisesRegex(editorial_inputs.EditorialInputError, "post count is inconsistent"):
            self._prepare(official, self.root / "data/collection/panel/panel.json")

    def test_inputs_must_be_private_and_under_the_collection_root(self):
        official = self._write("official")
        panel = self._write("panel")
        panel.chmod(0o644)
        with self.assertRaisesRegex(editorial_inputs.EditorialInputError, "must be private"):
            self._prepare(official, panel)
        outside = self.root / "outside.json"
        outside.write_text(json.dumps(self._record("panel")))
        outside.chmod(0o600)
        with self.assertRaisesRegex(editorial_inputs.EditorialInputError, "under data/collection"):
            self._prepare(official, outside)

    def test_collection_symlinks_are_refused(self):
        official = self._write("official")
        real_panel = self._write("panel")
        alias = self.root / "data/collection/panel/alias.json"
        alias.symlink_to(real_panel)
        with self.assertRaisesRegex(editorial_inputs.EditorialInputError, "symbolic links"):
            self._prepare(official, alias)

    def test_official_and_panel_roles_cannot_be_swapped(self):
        official = self._write("official")
        panel = self._write("panel")
        with self.assertRaisesRegex(editorial_inputs.EditorialInputError, "does not match"):
            self._prepare(panel, official)

    def test_legacy_official_collection_schema_is_supported(self):
        legacy = self._record("official")
        legacy["version"] = "official-x-collection-1"
        legacy["queries"] = legacy.pop("jobs")
        legacy["posts"] = legacy["queries"][0].pop("posts")
        path = self._write("official", legacy)
        manifest, _ = self._prepare(path, self._write("panel"))
        self.assertEqual(manifest["sources"][0]["version"], "official-x-collection-1")
        self.assertEqual(manifest["sources"][0]["post_count"], 1)

    def test_manifest_symlink_is_refused(self):
        manifest, _ = self._prepare()
        directory = self.root / "data/editorial/inputs"
        path = directory / f"{manifest['input_id']}.json"
        path.unlink()
        outside = self.root / "elsewhere.json"
        outside.write_text("{}")
        outside.chmod(0o600)
        path.symlink_to(outside)
        with self.assertRaisesRegex(editorial_inputs.EditorialInputError, "missing or unsafe"):
            editorial_inputs.verify_inputs(manifest["input_id"], root=self.root)

    def test_manifest_metadata_and_source_path_types_are_checked(self):
        manifest, _ = self._prepare()
        path = self.root / "data/editorial/inputs" / f"{manifest['input_id']}.json"
        changed = json.loads(path.read_text())
        changed["sources"][0]["post_count"] = 99
        path.write_text(json.dumps(changed), encoding="utf-8")
        path.chmod(0o600)
        with self.assertRaisesRegex(editorial_inputs.EditorialInputError, "metadata was changed"):
            editorial_inputs.verify_inputs(manifest["input_id"], root=self.root)

        changed["sources"][0]["path"] = 1
        path.write_text(json.dumps(changed), encoding="utf-8")
        path.chmod(0o600)
        with self.assertRaisesRegex(editorial_inputs.EditorialInputError, "source paths are malformed"):
            editorial_inputs.verify_inputs(manifest["input_id"], root=self.root)


if __name__ == "__main__":
    unittest.main()
