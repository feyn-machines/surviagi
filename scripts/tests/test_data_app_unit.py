"""Pure tests for scripts/app_db.py: env-file editing and administrator parsing. No database."""
import os
import stat
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app_db


class WriteEnvLocal(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / ".env.local"

    def test_replaces_in_place_appends_and_keeps_other_lines(self):
        self.path.write_text("# comment\nA=1\n\nB=2\nC=3\n")
        app_db.write_env_local({"B": "new", "D": "4"}, path=self.path)
        self.assertEqual(self.path.read_text(), "# comment\nA=1\n\nB=new\nC=3\nD=4\n")

    def test_creates_file_with_mode_0600_and_fixes_loose_mode(self):
        app_db.write_env_local({"A": "1"}, path=self.path)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        os.chmod(self.path, 0o644)
        app_db.write_env_local({"A": "2"}, path=self.path)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_values_with_equals_and_hash_round_trip(self):
        value = "postgres://u:p=q#r@h/db?x=1"
        app_db.write_env_local({"URL": value}, path=self.path)
        app_db.write_env_local({"URL": value}, path=self.path)
        self.assertEqual(self.path.read_text(), f"URL={value}\n")
        self.assertEqual(app_db.read_env_value("URL", paths=(self.path,)), value)

    def test_file_without_trailing_newline(self):
        self.path.write_text("A=1")
        app_db.write_env_local({"B": "2"}, path=self.path)
        self.assertEqual(self.path.read_text(), "A=1\nB=2\n")


    def test_failed_write_leaves_the_original_and_no_temp_file(self):
        self.path.write_text("A=1\n")
        for target in ("os.fsync", "os.replace"):
            with self.subTest(target), mock.patch(f"app_db.{target}", side_effect=OSError("boom")):
                with self.assertRaises(OSError):
                    app_db.write_env_local({"A": "2"}, path=self.path)
            self.assertEqual(self.path.read_text(), "A=1\n")
            self.assertEqual(os.listdir(self.dir.name), [".env.local"])

    def test_export_prefix_is_kept(self):
        self.path.write_text("export A=1\nB=2\n")
        app_db.write_env_local({"A": "9"}, path=self.path)
        self.assertEqual(self.path.read_text(), "export A=9\nB=2\n")


class LocalPassword(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "app-password"

    def test_created_once_with_mode_0600(self):
        first = app_db.local_password(self.path)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(app_db.local_password(self.path), first)
        self.assertEqual(os.listdir(self.dir.name), ["app-password"])

    def test_refuses_a_symlink(self):
        target = Path(self.dir.name) / "target"
        target.write_text("secret")
        os.chmod(target, 0o600)
        self.path.symlink_to(target)
        with self.assertRaises(app_db.AppError):
            app_db.local_password(self.path)

    def test_refuses_loose_mode(self):
        self.path.write_text("secret")
        os.chmod(self.path, 0o644)
        with self.assertRaises(app_db.AppError):
            app_db.local_password(self.path)

    def test_refuses_empty_file(self):
        self.path.write_text("\n")
        os.chmod(self.path, 0o600)
        with self.assertRaises(app_db.AppError):
            app_db.local_password(self.path)


class ReadAdminEmails(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.one = Path(self.dir.name) / "one"
        self.two = Path(self.dir.name) / "two"

    def test_trims_lowercases_dedupes_and_drops_entries_without_at(self):
        self.one.write_text("OTHER=x\nADMIN_EMAILS= Owner@Example.com, second@example.com ,nobody,OWNER@example.com,,@\n")
        self.assertEqual(app_db.read_admin_emails((self.one,)), ["owner@example.com", "second@example.com"])

    def test_later_file_wins_and_missing_files_are_skipped(self):
        self.one.write_text("ADMIN_EMAILS=a@example.com\n")
        self.two.write_text("ADMIN_EMAILS=b@example.com\n")
        missing = Path(self.dir.name) / "missing"
        self.assertEqual(app_db.read_admin_emails((self.one, self.two, missing)), ["b@example.com"])

    def test_absent_line_gives_empty_list(self):
        self.one.write_text("OTHER=x\n")
        self.assertEqual(app_db.read_admin_emails((self.one,)), [])

    def test_quoted_value(self):
        self.one.write_text('ADMIN_EMAILS="a@example.com,b@example.com"\n')
        self.assertEqual(app_db.read_admin_emails((self.one,)), ["a@example.com", "b@example.com"])


if __name__ == "__main__":
    unittest.main()
