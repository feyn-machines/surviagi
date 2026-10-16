"""Real PostgreSQL tests for kg releases, in a scratch database created and dropped here.

The owner's working database is never touched: every test uses its own database.
"""
import copy
import importlib.util
import io
import subprocess
import sys
import unittest
import uuid
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psycopg
from psycopg import sql

from data_pipeline import kg
from data_pipeline.db import connect
from data_pipeline.pipeline import digest

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("data_release_cli", SCRIPTS / "data-release.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


def payload(extra_event=None, drop_event=None, tweak_model=False):
    events = [{"event_id": f"e{i}", "title": f"T{i}", "score": i / 3} for i in range(1, 6)]
    if extra_event:
        events.append({"event_id": extra_event, "title": "new"})
    events = [e for e in events if e["event_id"] != drop_event]
    models = [{"model_id": f"m{i}", "name": f"M{i}", "released_at": None} for i in range(3)]
    if tweak_model:
        models[0]["name"] = "renamed"
    return {
        "chain": {"events": events, "evidence": [{"event_id": "e1", "n": 1.0}], "activities": [{"activity_id": "a1"}],
                  "gates": [{"gate_id": "g1", "label": "ゲート 门"}], "gate_edges": []},
        "markets": [{"market_id": "m", "occupation_id": "o1"}, {"market_id": "m", "occupation_id": "o2"}],
        "tasks": [{"task_id": "t", "confidence": 0.1}],
        "events": [dict(e, summary="s") for e in events],
        "models": models,
        "sources": [{"account_key": "k", "followers": 0}],
        "topics": [{"topic_id": "topic:replacement:accountant:00000000", "accounts": 2}],
        "coverage": {"events_routed": 3},
        "progress": {"assessed": 0, "global": {"level": 1.5}},
    }


def manifest_for(p, generated_at="2026-10-03T10:00:00+00:00"):
    counts = {**{f"chain.{k}": len(v) for k, v in p["chain"].items()},
              **{k: len(v) for k, v in p.items() if isinstance(v, list)}, "coverage": 1, "progress": 1}
    return {"generated_at": generated_at, "counts": counts, "content_sha256": digest(p)}


class KgBase(unittest.TestCase):
    def setUp(self):
        self.database = "openaiwill_kg_test_" + uuid.uuid4().hex
        with connect() as admin:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(self.database)))
        self.addCleanup(self.drop)
        self.conn = connect(self.database)
        self.addCleanup(self.conn.close)
        kg.ensure_schema(self.conn)

    def drop(self):
        self.conn.close()
        with connect() as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.database)))

    def count(self, table, where="true"):
        return self.conn.execute(f"SELECT count(*) AS n FROM {table} WHERE {where}").fetchone()["n"]

    def release(self, p=None, generated_at="2026-10-03T10:00:00+00:00"):
        p = p or payload()
        return kg.import_release(self.conn, p, manifest_for(p, generated_at))


class ImportTest(KgBase):
    def test_import_verifies_and_reassembles_to_the_same_hash(self):
        p = payload()
        result = self.release(p)
        self.assertTrue(result.created)
        self.assertEqual(result.release_id, "20261003T100000Z-" + digest(p)[:8])
        row = self.conn.execute("SELECT status, verified_at FROM kg.releases WHERE seq=%s", (result.seq,)).fetchone()
        self.assertEqual(row["status"], "verified")
        self.assertIsNotNone(row["verified_at"])
        self.assertEqual(digest(kg.load_release(self.conn, result.seq)), digest(p))
        self.assertEqual(kg.load_release(self.conn, result.seq), p)

    def test_importing_the_same_snapshot_twice_is_a_no_op(self):
        first = self.release()
        docs, rows = self.count("kg.docs"), self.count("kg.release_rows")
        second = self.release()
        self.assertEqual((second.created, second.docs_written, second.seq, second.release_id),
                         (False, 0, first.seq, first.release_id))
        self.assertEqual((self.count("kg.releases"), self.count("kg.docs"), self.count("kg.release_rows")),
                         (1, docs, rows))

    def test_a_stale_loading_release_is_replaced_not_duplicated(self):
        p = payload()
        m = manifest_for(p)
        # What an importer that died after committing would leave behind.
        stale = self.conn.execute(
            "INSERT INTO kg.releases (release_id, content_sha256, generated_at, manifest, status) "
            "VALUES (%s,%s,%s,'{}','loading') RETURNING seq",
            (kg.release_id(m), m["content_sha256"], m["generated_at"])).fetchone()["seq"]
        self.conn.execute("INSERT INTO kg.entities VALUES ('models','m0',%s)", (stale,))
        result = kg.import_release(self.conn, p, m)
        self.assertTrue(result.created)
        self.assertNotEqual(result.seq, stale)
        self.assertEqual(self.count("kg.releases"), 1)
        self.assertEqual(self.count("kg.releases", "status='loading'"), 0)
        self.assertEqual(kg.load_release(self.conn, result.seq), p)
        again = kg.import_release(self.conn, p, m)
        self.assertEqual((again.created, again.seq), (False, result.seq))

    def test_a_second_release_writes_only_new_documents(self):
        first = self.release()
        docs_after_first = self.count("kg.docs")
        second = self.release(payload(extra_event="e9", tweak_model=True), "2026-10-04T10:00:00+00:00")
        # new chain event + new event + renamed model; the evidence-free coverage etc. is unchanged.
        self.assertEqual(second.docs_written, 3)
        self.assertEqual(self.count("kg.docs"), docs_after_first + 3)
        changes = kg.diff(self.conn, second.seq, first.seq)
        self.assertEqual(changes["chain.events"], {"added": 1, "changed": 0, "removed": 0, "reordered": False})
        self.assertEqual(changes["models"], {"added": 0, "changed": 1, "removed": 0, "reordered": False})
        self.assertEqual(changes["tasks"], {"added": 0, "changed": 0, "removed": 0, "reordered": False})
        self.assertEqual(kg.diff(self.conn, first.seq, None)["models"]["added"], 3)

    def test_payload_that_does_not_hash_to_its_manifest_leaves_nothing(self):
        p = payload()
        m = manifest_for(p)
        tampered = copy.deepcopy(p)
        tampered["models"][0]["name"] = "tampered"
        with self.assertRaises(kg.KgError):
            kg.import_release(self.conn, tampered, m)
        self.assertEqual((self.count("kg.releases"), self.count("kg.docs"), self.count("kg.release_rows"),
                          self.count("kg.entities")), (0, 0, 0, 0))

    def test_database_side_mismatch_rolls_everything_back(self):
        keep = self.release()
        kg.activate(self.conn, keep.release_id)
        docs, rows, ents = self.count("kg.docs"), self.count("kg.release_rows"), self.count("kg.entities")
        p = payload(extra_event="e9")
        m = manifest_for(p, "2026-10-05T10:00:00+00:00")
        wrong = payload(extra_event="e8")
        with mock.patch.object(kg, "load_release", return_value=wrong):
            with self.assertRaises(kg.KgError):
                kg.import_release(self.conn, p, m)
        self.assertEqual((self.count("kg.releases"), self.count("kg.docs"), self.count("kg.release_rows"),
                          self.count("kg.entities")), (1, docs, rows, ents))
        self.assertEqual(kg.status(self.conn)["active"], keep.release_id)

    def test_entities_are_never_removed_when_a_later_release_drops_them(self):
        first = self.release()
        self.assertEqual(self.count("kg.entities", "collection='chain.events' AND entity_id='e2'"), 1)
        second = self.release(payload(drop_event="e2"), "2026-10-04T10:00:00+00:00")
        self.assertEqual(kg.diff(self.conn, second.seq, first.seq)["chain.events"]["removed"], 1)
        kg.activate(self.conn, second.release_id)
        row = self.conn.execute("SELECT first_release_seq FROM kg.entities WHERE collection='chain.events' "
                                "AND entity_id='e2'").fetchone()
        self.assertEqual(row["first_release_seq"], first.seq)
        self.assertEqual(self.count("kg.release_rows", f"release_seq={second.seq} AND entity_id='e2'"), 0)
        self.assertEqual(self.count("kg.entities", "collection='chain.events'"), 5)


class ExactJsonTest(KgBase):
    def test_awkward_numbers_and_shapes_survive_byte_for_byte(self):
        p = payload()
        p["tasks"] = [
            {"task_id": "n", "big": 1e22, "huge": 1.5e300, "negzero": -0.0, "wide": 12345678901234567890,
             "tiny": 1e-7, "whole": 1.0, "nested": {"z": 1, "a": {"y": [1, {"b": 2, "a": 1}], "x": None}},
             "text": "日本語 العربية 🙂 \u2028", "none": None, "empty_list": [], "empty_obj": {}},
        ]
        result = self.release(p)
        back = kg.load_release(self.conn, result.seq)
        self.assertEqual(digest(back), digest(p))
        self.assertEqual(self.conn.execute("SELECT pg_typeof(doc)::text AS t FROM kg.docs LIMIT 1").fetchone()["t"], "json")
        self.assertEqual(self.conn.execute("SELECT status FROM kg.releases WHERE seq=%s", (result.seq,)).fetchone()["status"],
                         "verified")


class SchemaGuardTest(KgBase):
    def test_old_jsonb_schema_is_refused_with_the_fix_and_reset_repairs_it(self):
        self.release()
        self.conn.execute("ALTER TABLE kg.docs ALTER COLUMN doc TYPE jsonb")
        with self.assertRaises(kg.KgError) as raised:
            kg.ensure_schema(self.conn)
        self.assertIn("reset --target local", str(raised.exception))
        kg.reset(self.conn)
        self.assertEqual(self.count("kg.releases"), 0)
        self.assertEqual(self.release().created, True)

    def test_reset_command_only_works_for_local(self):
        done = subprocess.run([sys.executable, str(SCRIPTS / "data-release.py"), "reset", "--target", "server"],
                              capture_output=True, text=True)
        self.assertEqual((done.returncode, done.stderr), (1, "error: reset works only with --target local\n"))


class ReorderTest(KgBase):
    def test_a_release_that_only_reorders_is_not_summarised_as_no_change(self):
        first = self.release()
        p = payload()
        p["chain"]["events"].reverse()
        p["markets"].reverse()
        second = self.release(p, "2026-10-04T10:00:00+00:00")
        changes = kg.diff(self.conn, second.seq, first.seq)
        self.assertTrue(changes["chain.events"]["reordered"])
        self.assertTrue(changes["markets"]["reordered"])
        lines = cli.summarize(changes)
        self.assertIn("  chain.events: order changed", lines)
        self.assertNotIn("  no rows differ from the active release", lines)


class ActivationTest(KgBase):
    def test_activate_rollback_status(self):
        self.assertEqual(kg.status(self.conn), {"releases": [], "active": None})
        with self.assertRaises(kg.KgError):
            kg.rollback(self.conn)
        a = self.release()
        b = self.release(payload(extra_event="e9"), "2026-10-04T10:00:00+00:00")
        self.assertEqual(self.count("kg.active"), 0)
        kg.activate(self.conn, a.release_id)
        kg.activate(self.conn, a.release_id)  # no-op
        self.assertEqual(self.count("kg.activations"), 1)
        with self.assertRaises(kg.KgError):
            kg.rollback(self.conn)  # nothing earlier
        kg.activate(self.conn, b.release_id)
        info = kg.status(self.conn)
        self.assertEqual(info["active"], b.release_id)
        self.assertEqual([r["release_id"] for r in info["releases"]], [b.release_id, a.release_id])
        self.assertEqual(self.conn.execute("SELECT release_id FROM kg.active").fetchone()["release_id"], b.release_id)
        self.assertEqual(kg.rollback(self.conn), a.release_id)
        self.assertEqual(kg.status(self.conn)["active"], a.release_id)
        self.assertEqual(self.count("kg.activations"), 3)

    def test_unknown_and_loading_releases_cannot_be_activated(self):
        with self.assertRaises(kg.KgError):
            kg.activate(self.conn, "nope")
        self.conn.execute("INSERT INTO kg.releases (release_id, content_sha256, generated_at, manifest, status) "
                          "VALUES ('half','h','2026-10-03T00:00:00Z','{}','loading')")
        with self.assertRaises(kg.KgError):
            kg.activate(self.conn, "half")
        self.assertEqual(self.count("kg.activations"), 0)

    def test_ensure_schema_is_repeatable_and_keeps_data(self):
        self.release()
        kg.ensure_schema(self.conn)
        self.assertEqual(self.count("kg.releases"), 1)


class CliTest(KgBase):
    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(cli, "connect", lambda: connect(self.database)), \
                redirect_stdout(out), redirect_stderr(err):
            code = cli.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def snapshot_dir(self):
        import json, tempfile
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
        p = payload()
        for name in kg.SNAPSHOT_FILES:
            (tmp / f"{name}.json").write_text(json.dumps(p[name]))
        (tmp / "manifest.json").write_text(json.dumps(manifest_for(p)))
        return tmp

    def test_release_promote_release_again_status(self):
        snap = str(self.snapshot_dir())
        code, out, _ = self.run_cli("release", "--snapshot", snap)
        self.assertEqual(code, 0)
        self.assertIn("imported and verified", out)
        self.assertIn("models: +3 ~0 -0", out)
        code, out, _ = self.run_cli("promote")
        self.assertEqual((code, out.startswith("active release: 2026")), (0, True))
        code, out, _ = self.run_cli("release", "--snapshot", snap)
        self.assertIn("nothing new", out)
        code, out, _ = self.run_cli("status")
        self.assertEqual(code, 0)
        self.assertIn("* 2026", out)

    def test_kg_error_is_one_line_exit_1(self):
        code, out, err = self.run_cli("release", "--snapshot", "/nonexistent")
        self.assertEqual(code, 1)
        self.assertEqual(err.count("\n"), 1)
        self.assertTrue(err.startswith("error: "))
        code, _, err = self.run_cli("promote")
        self.assertEqual((code, err.count("\n")), (1, 1))

    def test_connection_failure_is_one_line_exit_1(self):
        err = io.StringIO()
        refused = psycopg.OperationalError("connection refused\nDETAIL: second line")
        with mock.patch.object(cli, "connect", side_effect=refused), redirect_stderr(err), redirect_stdout(io.StringIO()):
            code = cli.main(["status"])
        self.assertEqual(code, 1)
        self.assertEqual(err.getvalue(), "error: connection refused\n")

    def test_missing_password_file_is_one_line_exit_1(self):
        err = io.StringIO()
        with mock.patch.object(cli, "connect", side_effect=RuntimeError("Run setup first")), \
                redirect_stderr(err), redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["status"]), 1)
        self.assertEqual(err.getvalue(), "error: Run setup first\n")

    def test_server_target_errors_are_one_line_and_never_start_a_connection_here(self):
        err = io.StringIO()
        with mock.patch.object(cli.server_db, "server_connection",
                               side_effect=cli.ReleaseError("no .env.deploy; copy it")), \
                redirect_stderr(err), redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["status", "--target", "server"]), 1)
        self.assertEqual(err.getvalue(), "error: no .env.deploy; copy it\n")

    def test_setup_db_needs_the_server_target(self):
        err = io.StringIO()
        with mock.patch.object(cli.server_db, "setup_db") as setup, redirect_stderr(err):
            self.assertEqual(cli.main(["setup-db"]), 1)
        setup.assert_not_called()
        self.assertEqual(err.getvalue(), "error: setup-db works only with --target server\n")

    def test_promote_and_rollback_on_the_server_report_the_production_site(self):
        for command in ("promote", "rollback"):
            fake = mock.MagicMock()
            with mock.patch.object(cli.server_db, "server_connection", return_value=fake), \
                    mock.patch.object(cli, "COMMANDS", {**cli.COMMANDS, command: lambda conn, args: "D1"}), \
                    mock.patch.object(cli.server_db, "report_production") as report, \
                    mock.patch.object(cli.site_release, "notify_indexnow"), redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main([command, "--target", "server"]), 0)
            report.assert_called_once_with("D1")

    def test_indexnow_hears_of_a_server_release_only_once_the_site_serves_it(self):
        for command in ("promote", "rollback"):
            for serving in (True, False):
                with mock.patch.object(cli.server_db, "server_connection", return_value=mock.MagicMock()), \
                        mock.patch.object(cli, "COMMANDS", {**cli.COMMANDS, command: lambda conn, args: "D1"}), \
                        mock.patch.object(cli.server_db, "report_production", return_value=serving), \
                        mock.patch.object(cli.site_release, "notify_indexnow") as notify, redirect_stdout(io.StringIO()):
                    self.assertEqual(cli.main([command, "--target", "server"]), 0)
                if serving:
                    notify.assert_called_once_with(only_changed=True)
                else:
                    notify.assert_not_called()

    def test_local_promote_does_not_ask_the_production_site(self):
        with mock.patch.object(cli, "connect", return_value=mock.MagicMock()), \
                mock.patch.object(cli, "COMMANDS", {**cli.COMMANDS, "promote": lambda conn, args: "D1"}), \
                mock.patch.object(cli.server_db, "report_production") as report, \
                mock.patch.object(cli.site_release, "notify_indexnow") as notify, redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["promote"]), 0)
        report.assert_not_called()
        notify.assert_not_called()

if __name__ == "__main__":
    unittest.main()
