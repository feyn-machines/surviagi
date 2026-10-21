"""Exercise the public-file gate through its CLI in isolated Git repositories."""
import pathlib
import subprocess
import sys
import tempfile
import unittest


CHECKER = pathlib.Path(__file__).resolve().parents[1] / "check-public-files.py"


class PublicFileGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.git("init", "-q")

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.root, check=True, capture_output=True
        )

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def scan(self, *args):
        return subprocess.run(
            [sys.executable, str(CHECKER), *args],
            cwd=self.root, text=True, capture_output=True,
        )

    def test_untracked_credential_is_rejected_without_disclosing_value(self):
        secret = "ghp_" + "a" * 36
        self.write("accidental-note.txt", secret)
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("accidental-note.txt", result.stdout)
        self.assertNotIn(secret, result.stdout + result.stderr)

    def test_public_data_docs_and_owned_design_resources_are_allowed(self):
        self.write("docs/data/method.md", "Documented source and evidence policy.\n")
        self.write("design/system-v1/assets/signal.svg", "<svg></svg>\n")
        self.write("design/system-v1/fonts/OFL.txt", "Font license.\n")
        self.write("design/system-v1/tokens.json", '{"color":"#ffffff"}\n')
        result = self.scan()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_forced_private_material_is_rejected_in_index(self):
        names = [
            "AGENTS.override.md", "CLAUDE.local.md", ".mcp.json",
            "data/collection/raw.json", "local.sqlite-wal", "trace.log",
            "design/reference/example/fonts/commercial.woff2",
            "design/reference/example/motion/reference.mp4",
            "datasets/ontology/schema/schema.json",
            "datasets/ontology/releases/v2.4.0/concepts.jsonl",
            "docs/research/internal-draft.md",
            "exports/snapshot.json", "measurements.csv",
            ".ssh/config", "id_ed25519", "client_secret_google.json",
            "service-account.json", ".pgpass",
        ]
        self.write(".gitignore", "*\n")
        for name in names:
            self.write(name, "private material")
            self.git("add", "-f", "--", name)
        result = self.scan("--staged")
        self.assertNotEqual(result.returncode, 0)
        for name in names:
            self.assertIn(name, result.stdout)

    def test_migrations_and_application_configuration_are_not_data_dumps(self):
        self.write("db/migrations/001_schema.sql", "CREATE TABLE example (id text);\n")
        self.write("package.json", '{"name":"public-code"}\n')
        result = self.scan()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_staged_secret_cannot_be_hidden_by_clean_working_copy(self):
        secret = "ghp_" + "b" * 36
        self.write("notes.txt", secret)
        self.git("add", "notes.txt")
        self.write("notes.txt", "clean working copy")
        self.assertEqual(self.scan().returncode, 0)
        staged = self.scan("--staged")
        self.assertNotEqual(staged.returncode, 0)
        self.assertNotIn(secret, staged.stdout + staged.stderr)

    def test_unstaged_secret_does_not_change_index_scan(self):
        self.write("notes.txt", "safe staged content")
        self.git("add", "notes.txt")
        self.write("notes.txt", "ghp_" + "c" * 36)
        self.assertEqual(self.scan("--staged").returncode, 0)
        self.assertNotEqual(self.scan().returncode, 0)

    def test_ignored_private_runtime_is_not_a_public_candidate(self):
        self.write(".gitignore", ".env*\n/data/\n")
        self.write(".env.local", "local secret")
        self.write("data/raw.json", "local archive")
        self.assertEqual(self.scan().returncode, 0)
        self.git("add", "-f", ".env.local")
        self.assertNotEqual(self.scan("--staged").returncode, 0)

    def test_reference_manifest_is_allowed_but_original_material_is_not(self):
        self.write("design/reference/example/manifest.json", "[]\n")
        self.write("design/reference/example/styles/tokens.original.json", "{}\n")
        self.assertEqual(self.scan().returncode, 0)
        self.write("design/reference/example/images/source.png", "reference image")
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("source.png", result.stdout)

    def test_symlink_is_rejected_without_reading_its_target(self):
        self.write(".gitignore", "/data/\n")
        self.write("data/private.txt", "ghp_" + "d" * 36)
        (self.root / "public.txt").symlink_to("data/private.txt")
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("ghp_" + "d" * 36, result.stdout + result.stderr)
        self.git("add", "public.txt")
        self.assertNotEqual(self.scan("--staged").returncode, 0)


if __name__ == "__main__":
    unittest.main()
