"""Offline tests for the server side of the data release line: the setup script, env-file parsing,
the forward and the production poll. Nothing here contacts a server.

Dependency-free (no psycopg): runs under `pnpm data:test:unit` with the system python.
"""
import contextlib
import io
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server_db  # noqa: E402
import site_release  # noqa: E402

TARGET = {"DEPLOY_HOST": "h.example", "DEPLOY_USER": "u", "DEPLOY_SSH_KEY": "/k/key", "DEPLOY_ROOT": "/opt/openaiwill"}
GOOD = "a" * 48


def build(target=TARGET, compose="services: {}\n", roles="SELECT 1;\n", schema="SELECT 2;\n", grants="SELECT 3;\n",
          app=None):
    return server_db.setup_script(target, compose, roles, schema, grants, {"001_app.sql": "SELECT 4;\n"} if app is None else app)


class DatabaseForwardTest(unittest.TestCase):
    def test_the_database_forward_is_compressed_and_reaches_the_database_port(self):
        target = {"DEPLOY_HOST": "h.example", "DEPLOY_USER": "u", "DEPLOY_SSH_KEY": "/k/key", "DEPLOY_ROOT": "/opt/x"}
        argv = server_db.db_forward_argv(target, 40000)
        self.assertEqual(argv[:3], ["ssh", "-o", "Compression=yes"])
        self.assertIn(f"40000:127.0.0.1:{server_db.DB_PORT}", argv)
        self.assertIn("ExitOnForwardFailure=yes", argv)
        self.assertEqual(argv[-1], "u@h.example")


class SessionOptionsTest(unittest.TestCase):
    """2026-10-16: a release whose SSH forward dropped left its session idle in a transaction holding the
    release lock; the retry waited 26 minutes behind it. Both roles' sessions now time out instead."""

    def test_a_dead_clients_transaction_is_ended_and_a_lock_wait_gives_up(self):
        for role in (server_db.WRITER, server_db.APP_ROLE):
            options = server_db.session_options(role)
            self.assertIn("-c idle_in_transaction_session_timeout=10min", options)
            self.assertIn("-c lock_timeout=15min", options)
            self.assertIn("-c timezone=UTC", options)

    def test_only_the_writer_is_pointed_at_public(self):
        self.assertIn("search_path=public", server_db.session_options(server_db.WRITER))
        self.assertNotIn("search_path", server_db.session_options(server_db.APP_ROLE))


class EnvFileTest(unittest.TestCase):
    def test_parse_skips_comments_and_blank_lines(self):
        self.assertEqual(server_db.parse_env("# c\n\nA=1\n B = x=y \nnoequals\n"), {"A": "1", "B": "x=y"})

    def test_the_writer_password_is_read(self):
        text = f"POSTGRES_PASSWORD={'b' * 48}\nOAW_KG_WRITER_PASSWORD={GOOD}\nOAW_SITE_PASSWORD={'c' * 48}\n"
        self.assertEqual(server_db.writer_password(text), GOOD)

    def test_a_missing_or_malformed_password_is_refused_without_echoing_anything(self):
        for text in ("", "OAW_KG_WRITER_PASSWORD=\n", "OAW_KG_WRITER_PASSWORD=short\n",
                     "OAW_KG_WRITER_PASSWORD=" + "a b" * 20 + "\n", "OAW_KG_WRITER_PASSWORD=" + "x;" * 30 + "\n"):
            with self.assertRaises(site_release.ReleaseError) as raised:
                server_db.writer_password(text)
            self.assertNotIn("short", str(raised.exception))
            self.assertNotIn("x;", str(raised.exception))


class ForwardTest(unittest.TestCase):
    def test_the_forward_targets_the_database_loopback_port(self):
        argv = server_db.db_forward_argv(TARGET, 50111)
        self.assertEqual(argv[argv.index("-L") + 1], "50111:127.0.0.1:5434")
        self.assertIn("ExitOnForwardFailure=yes", argv)
        self.assertEqual(argv[-1], "u@h.example")

    def test_the_probe_checks_only_the_given_loopback_port(self):
        script = server_db.port_probe_script(8320)
        self.assertIn("/dev/tcp/127.0.0.1/8320", script)
        self.assertEqual(subprocess.run(["bash", "-c", server_db.port_probe_script(1)],
                                        capture_output=True, text=True).stdout.strip(), "none")


class OrphanReleaseSessionTest(unittest.TestCase):
    """2026-10-20: one dropped stream left a release session alive, holding the release advisory lock; the
    next two attempts only waited on that lock and the daily run stopped. A later attempt now ends it first."""

    class Conn:
        def __init__(self, rows):
            self.rows = rows
            self.calls = []

        def execute(self, sql, params=None):
            self.calls.append((sql, params))
            rows, self.rows = self.rows, []

            class Cursor:
                def fetchall(self_inner):
                    return rows
            return Cursor()

    def test_only_this_role_s_own_old_locked_sessions_are_ended(self):
        conn = self.Conn([{"pid": 11}, {"pid": 12}])
        self.assertEqual(server_db.clear_orphan_release_sessions(conn), [11, 12])
        sql, params = conn.calls[0]
        for guard in ("usename = current_user", "application_name = %s", "pid <> pg_backend_pid()",
                      "locktype = 'advisory'", "datname = current_database()"):
            self.assertIn(guard, sql)
        self.assertEqual(params, (server_db.RELEASE_APPLICATION, server_db.ORPHAN_AFTER))
        self.assertEqual([call[1] for call in conn.calls[1:]], [(11,), (12,)])
        self.assertTrue(all("pg_terminate_backend" in call[0] for call in conn.calls[1:]))

    def test_nothing_is_ended_when_no_session_qualifies(self):
        conn = self.Conn([])
        self.assertEqual(server_db.clear_orphan_release_sessions(conn), [])
        self.assertEqual(len(conn.calls), 1)

    def test_the_release_sessions_are_named_so_they_can_be_told_apart(self):
        self.assertNotEqual(server_db.RELEASE_APPLICATION, server_db.APP_ADMIN_APPLICATION)
        self.assertIn("application_name=RELEASE_APPLICATION", Path(server_db.__file__).read_text())


class HeredocTest(unittest.TestCase):
    def test_the_text_is_written_byte_for_byte(self):
        script = server_db.heredoc("/x/f", "a $b `c` 'd'\n", "TAG_EOF")
        done = subprocess.run(["bash", "-c", script.replace("/x/f", "/dev/stdout")], capture_output=True, text=True)
        self.assertEqual(done.stdout, "a $b `c` 'd'\n")

    def test_a_text_containing_the_tag_is_refused(self):
        with self.assertRaises(site_release.ReleaseError):
            server_db.heredoc("/x/f", "a\nTAG_EOF\nb\n", "TAG_EOF")


class SetupScriptTest(unittest.TestCase):
    def test_it_is_valid_shell(self):
        done = subprocess.run(["bash", "-n"], input=build(schema=server_db.SCHEMA_SQL.read_text(),
                                                           compose=(server_db.DEPLOY_DB / "compose.yml").read_text(),
                                                           roles=(server_db.DEPLOY_DB / "roles.sql").read_text(),
                                                           grants=(server_db.DEPLOY_DB / "grants.sql").read_text(),
                                                           app=server_db.app_sql_files()),
                              text=True, capture_output=True)
        self.assertEqual((done.returncode, done.stderr), (0, ""))

    def test_passwords_are_generated_only_when_db_env_is_absent(self):
        script = build()
        guard = script.index("if [ ! -f /opt/openaiwill/db/db.env ]; then")
        self.assertLess(guard, script.index("a=$(newpw)"))
        self.assertLess(script.index("a=$(newpw)"), script.index("fi\nchmod 600 /opt/openaiwill/db/db.env"))
        # a, b, c, d at creation; e when an older db.env lacks the app password
        self.assertEqual(script.count("newpw)"), 5)
        self.assertEqual(script.count("openssl rand -hex 24"), 1)
        self.assertEqual(script.count("openssl rand -hex 32"), 1)

    def test_secret_files_are_written_with_umask_077_and_mode_600(self):
        script = build()
        self.assertTrue(script.startswith("umask 077\n"))
        self.assertIn("chmod 600 /opt/openaiwill/db/db.env", script)
        self.assertIn("chmod 600 /opt/openaiwill/site.env", script)

    def test_site_env_holds_the_site_roles_url_on_the_docker_name(self):
        self.assertIn("DATABASE_URL=postgres://oaw_site:%s@openaiwill-db:5432/openaiwill", build())

    def test_site_env_is_never_rewritten_and_never_made_without_db_env(self):
        script = build()
        self.assertIn("if [ ! -f /opt/openaiwill/site.env ]; then", script)
        self.assertIn("site.env exists but db/db.env does not", script)

    def test_no_password_is_ever_printed_or_put_on_a_command_line(self):
        script = build()
        for name in ("$a", "$b", "$c", "$d", "$e", "$pw", "$apw", "$want", "$cur", "$secret"):
            for line in script.splitlines():
                if name in line:
                    self.assertTrue(line.lstrip().startswith(("a=", "printf", "pw=", "[ -n", "apw=", "e=", "want=", "cur=",
                                                              "secret=", "elif", "if [ -z", "if [ \"$cur\"")) or ">> " in line
                                    or "> /opt" in line, line)
        self.assertNotIn("echo \"$", script.replace('echo "$p"', ""))
        self.assertNotRegex(script, r"PGPASSWORD=[^\"]")
        self.assertNotIn("set -x", script)
        self.assertNotIn(" -e PGPASSWORD", script)
        self.assertEqual(script.count("--env-file"), 11)  # 3 psql steps + app psql + 4 checks + superuser privilege check + restart + up

    def test_every_remote_value_is_quoted_from_the_deploy_root(self):
        script = build({**TARGET, "DEPLOY_ROOT": "/opt/my site"})
        self.assertIn("'/opt/my site/db/db.env'", script)
        self.assertNotRegex(script, r"(?<!')/opt/my site")

    def test_the_network_is_created_only_when_absent(self):
        self.assertIn("docker network inspect openaiwill >/dev/null 2>&1 </dev/null || sudo docker network create openaiwill",
                      build())

    def test_the_schema_is_applied_as_the_writer_and_grants_follow(self):
        script = build()
        tail = script[script.index("up -d --wait"):]
        steps = re.findall(r"-U (\w+) -d (\w+) < (\S+)", tail)
        self.assertEqual(steps, [("postgres", "postgres", "roles.sql"), ("oaw_kg_writer", "openaiwill", "001_kg.sql"),
                                 ("oaw_kg_writer", "openaiwill", "grants.sql"), ("oaw_app", "openaiwill", "001_app.sql")])

    def test_the_four_files_are_uploaded_before_the_database_starts(self):
        script = build()
        for name in ("compose.yml", "roles.sql", "001_kg.sql", "grants.sql", "001_app.sql"):
            self.assertLess(script.index(f"cat > /opt/openaiwill/db/{name} <<"), script.index("up -d --wait"))

    def test_the_password_checks_connect_over_the_container_address_where_scram_applies(self):
        script = build()
        tail = script[script.index("up -d --wait"):]
        for who, role in (("KG_WRITER", "oaw_kg_writer"), ("SITE", "oaw_site"), ("APP", "oaw_app")):
            self.assertIn(f'PGPASSWORD="$OAW_{who}_PASSWORD" psql -X -h "$ip" -U {role} -d openaiwill', tail)
        self.assertIn("ip=$(hostname -i); ip=${ip%% *};", tail)
        # Never the loopback address or the socket: the stock image trusts those.
        for line in tail.splitlines():
            if "PGPASSWORD" in line:
                self.assertNotIn("127.0.0.1", line)
                self.assertNotIn(" -h 127", line)
        self.assertEqual(tail.count('-tAc "SELECT count(*) FROM kg.releases"'), 2)
        self.assertEqual(tail.count('-tAc "SELECT count(*) FROM app.submissions"'), 1)

    def test_a_wrong_password_must_be_refused_or_setup_aborts(self):
        script = build()
        negative = [line for line in script.splitlines() if "not-the-password" in line]
        self.assertEqual(len(negative), 1)
        self.assertIn("-U oaw_site", negative[0])
        self.assertIn('-h "$ip"', negative[0])
        self.assertTrue(negative[0].startswith("if sudo docker exec"))
        self.assertIn("password authentication is not being enforced on the container network", negative[0])
        self.assertIn("exit 1", negative[0])

    def test_the_final_messages_say_only_what_is_proven(self):
        script = build()
        self.assertIn("the three roles authenticate with their passwords over the container network, a wrong "
                      "password is refused and neither the app role nor the site role reaches the other's schema", script)
        self.assertNotIn("connect with their passwords", script)
        self.assertTrue(script.rstrip().splitlines()[-1].startswith("echo 'database ready"))

    def test_the_database_wait_is_bounded(self):
        self.assertIn("up -d --wait --wait-timeout 180", build())

    def test_every_sudo_command_has_its_own_stdin(self):
        # `bash -s` reads this script from stdin; a command that does too would swallow the rest of it.
        in_heredoc = None
        checked = 0
        for line in build().splitlines():
            if in_heredoc:
                in_heredoc = None if line == in_heredoc else in_heredoc
                continue
            heredoc = re.search(r"<<'([A-Z_]+)'", line)
            if heredoc:
                in_heredoc = heredoc.group(1)
                continue
            if "sudo " in line:
                checked += 1
                redirects = len(re.findall(r"</dev/null|< [\w./]+\.sql", line))
                self.assertGreaterEqual(redirects, line.count("sudo "), line)
        self.assertGreaterEqual(checked, 12)

    def test_a_lost_db_env_is_recovered_without_the_old_superuser_password(self):
        script = build()
        # Setup reaches PostgreSQL only through the local socket (no -h) as the superuser, and roles.sql resyncs all
        # three passwords from the regenerated file.
        for line in script.splitlines():
            if "-U postgres" in line:
                self.assertNotIn(" -h ", line)
        roles = (server_db.DEPLOY_DB / "roles.sql").read_text()
        self.assertIn("ALTER ROLE postgres PASSWORD", roles)
        self.assertIn("\\getenv superuser_password POSTGRES_PASSWORD", roles)
        self.assertNotIn("down -v", script)


class DeployRootTest(unittest.TestCase):
    def test_safe_roots_pass(self):
        for value in ("/opt/openaiwill", "/srv/a-b_c.d/x", "/opt/openaiwill/deep/er"):
            self.assertTrue(site_release.valid_deploy_root(value), value)

    def test_everything_else_is_refused(self):
        for value in ("/opt", "opt/x", "/opt/open aiwill", "/", "", "/opt/../etc", "/opt/.", "/opt/./x", "/opt/x/.", "/opt/..", "/opt//x", "/opt/x/", "/opt/x;y",
                      "/opt/$(id)", "/opt/'x", "~/x"):
            self.assertFalse(site_release.valid_deploy_root(value), value)

    def test_loading_a_target_with_a_bad_root_fails_before_anything_runs(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / ".env.deploy"
            env.write_text("DEPLOY_HOST=h\nDEPLOY_USER=u\nDEPLOY_SSH_KEY=/k\nDEPLOY_ROOT=/opt\n")
            original = site_release.ROOT
            try:
                site_release.ROOT = Path(tmp)
                with self.assertRaisesRegex(site_release.ReleaseError, "DEPLOY_ROOT"):
                    site_release.load_target()
                env.write_text(env.read_text().replace("/opt\n", "/opt/openaiwill\n"))
                self.assertEqual(site_release.load_target()["DEPLOY_ROOT"], "/opt/openaiwill")
            finally:
                site_release.ROOT = original


class WriterPasswordFetchTest(unittest.TestCase):
    def test_a_fetched_value_is_checked_and_a_bad_one_is_not_echoed(self):
        self.assertEqual(server_db.checked_password(GOOD + "\n"), GOOD)
        for value in ("", "short-secret", "a b" * 20):
            with self.assertRaises(site_release.ReleaseError) as raised:
                server_db.checked_password(value)
            self.assertNotIn("short-secret", str(raised.exception))

    def test_only_the_writer_value_is_fetched_without_sudo(self):
        seen = []
        original = site_release.remote
        site_release.remote = lambda target, script, capture=False: seen.append(script) or GOOD
        try:
            self.assertEqual(server_db.read_writer_password(TARGET), GOOD)
        finally:
            site_release.remote = original
        self.assertEqual(seen, ["sed -n 's/^OAW_KG_WRITER_PASSWORD=//p' /opt/openaiwill/db/db.env"])
        self.assertNotIn("sudo", seen[0])


class AppPasswordFetchTest(unittest.TestCase):
    def test_only_the_app_value_is_fetched_without_sudo(self):
        seen = []
        original = site_release.remote
        site_release.remote = lambda target, script, capture=False: seen.append(script) or GOOD
        try:
            self.assertEqual(server_db.read_app_password(TARGET), GOOD)
        finally:
            site_release.remote = original
        self.assertEqual(seen, ["sed -n 's/^OAW_APP_PASSWORD=//p' /opt/openaiwill/db/db.env"])

    def test_a_bad_value_names_the_key_and_never_the_value(self):
        with self.assertRaises(site_release.ReleaseError) as raised:
            server_db.checked_password("short-secret", "OAW_APP_PASSWORD")
        self.assertIn("OAW_APP_PASSWORD", str(raised.exception))
        self.assertNotIn("short-secret", str(raised.exception))


class AdminSyncAfterSetupTest(unittest.TestCase):
    def run_sync(self, emails):
        import app_db
        calls = []

        class Conn:
            pass

        @contextlib.contextmanager
        def fake_connection(role):
            calls.append(("connect", role))
            yield Conn()

        originals = (server_db.server_connection, app_db.read_admin_emails, app_db.sync_admins)
        server_db.server_connection = fake_connection
        app_db.read_admin_emails = lambda: emails
        app_db.sync_admins = lambda conn, wanted: calls.append(("sync", list(wanted))) or (len(wanted), 0)
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                server_db.sync_server_admins()
        finally:
            server_db.server_connection, app_db.read_admin_emails, app_db.sync_admins = originals
        return calls, out.getvalue()

    def test_the_list_is_synced_as_the_app_role_and_only_counts_are_printed(self):
        calls, out = self.run_sync(["a@example.com", "b@example.com"])
        self.assertEqual(calls, [("connect", "oaw_app"), ("sync", ["a@example.com", "b@example.com"])])
        self.assertIn("2", out)
        self.assertNotIn("example.com", out)

    def test_an_empty_list_is_a_one_line_warning_and_no_connection(self):
        calls, out = self.run_sync([])
        self.assertEqual(calls, [])
        self.assertEqual(len(out.strip().splitlines()), 1)
        self.assertIn("ADMIN_EMAILS", out)


class OneLineErrorTest(unittest.TestCase):
    def test_only_the_first_line_of_a_database_error_is_shown(self):
        self.assertEqual(server_db.first_line(RuntimeError("duplicate key\nDETAIL: Key (x)=(secret) exists.")), "duplicate key")
        self.assertEqual(server_db.first_line(RuntimeError("")), "RuntimeError")

    def test_the_release_command_uses_it_for_database_errors(self):
        text = (server_db.ROOT / "scripts" / "data-release.py").read_text()
        self.assertIn("except psycopg.Error as error:", text)
        self.assertIn("server_db.first_line(error)", text)


class AppSchemaFileTest(unittest.TestCase):
    def test_the_trigger_is_replaced_in_place_never_dropped(self):
        text = (server_db.ROOT / "db" / "app" / "001_app.sql").read_text()
        self.assertIn("CREATE OR REPLACE TRIGGER submissions_decided_is_final", text)
        self.assertNotIn("DROP TRIGGER", text)


class ReportNeverFailsTest(unittest.TestCase):
    def test_every_probe_failure_is_a_note_not_an_error(self):
        original = server_db._report_production
        try:
            for error in (site_release.ReleaseError("no .env.deploy"), subprocess.CalledProcessError(255, "ssh"),
                          OSError("ssh missing")):
                def boom(expected, error=error):
                    raise error
                server_db._report_production = boom
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertFalse(server_db.report_production("D1"))  # must not raise
        finally:
            server_db._report_production = original


class DeployFilesTest(unittest.TestCase):
    compose = (server_db.DEPLOY_DB / "compose.yml").read_text()
    roles = (server_db.DEPLOY_DB / "roles.sql").read_text()
    grants = (server_db.DEPLOY_DB / "grants.sql").read_text()

    def test_the_database_binds_loopback_only_on_5434_and_joins_the_network(self):
        self.assertIn('"127.0.0.1:5434:5432"', self.compose)
        self.assertIn("postgres:16-alpine", self.compose)
        self.assertIn("container_name: openaiwill-db", self.compose)
        self.assertIn("restart: unless-stopped", self.compose)
        self.assertIn("pg_isready", self.compose)
        self.assertRegex(self.compose, r"networks:\n  openaiwill:\n    external: true")

    def test_no_credential_is_written_in_the_files(self):
        self.assertIn("${POSTGRES_PASSWORD:?", self.compose)
        self.assertNotRegex(self.compose + self.roles + self.grants, r"(?i)password\s*[:=]\s*['\"]?[a-z0-9]{16,}")

    def test_roles_are_created_idempotently_and_the_site_role_is_minimal(self):
        self.assertIn("WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'oaw_kg_writer')", self.roles)
        self.assertIn("WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openaiwill')", self.roles)
        self.assertIn("OWNER oaw_kg_writer", self.roles)
        self.assertIn("REVOKE ALL ON DATABASE openaiwill FROM PUBLIC", self.roles)
        self.assertIn("GRANT CONNECT ON DATABASE openaiwill TO oaw_site", self.roles)
        self.assertNotIn("SUPERUSER ", self.roles.replace("NOSUPERUSER ", ""))

    def test_site_role_may_only_read_kg_now_and_later(self):
        self.assertIn("GRANT USAGE ON SCHEMA kg TO oaw_site", self.grants)
        self.assertIn("GRANT SELECT ON ALL TABLES IN SCHEMA kg TO oaw_site", self.grants)
        self.assertIn("ALTER DEFAULT PRIVILEGES FOR ROLE oaw_kg_writer IN SCHEMA kg GRANT SELECT ON TABLES TO oaw_site",
                      self.grants)
        for verb in ("INSERT", "UPDATE", "DELETE", "ALL PRIVILEGES"):
            self.assertNotIn(verb, self.grants)

    def test_the_site_compose_requires_the_database_and_the_network(self):
        compose = (site_release.ROOT / "deploy" / "compose.yml").read_text()
        self.assertIn('SITE_REQUIRE_DATABASE: "1"', compose)
        self.assertIn("env_file: ${SITE_ENV_FILE", compose)
        self.assertIn("RELEASE_ID: ${RELEASE_ID}", compose)  # /healthz reports it at request time
        self.assertRegex(compose, r"networks:\n  openaiwill:\n    external: true")


class AppSetupScriptTest(unittest.TestCase):
    def test_the_app_files_are_uploaded_each_with_its_own_tag_and_a_name_that_cannot_break_the_path(self):
        script = build(app={"001_app.sql": "SELECT 1;\n", "002_more.sql": "SELECT 2;\n"})
        self.assertIn("cat > /opt/openaiwill/db/001_app.sql <<'", script)
        self.assertIn("cat > /opt/openaiwill/db/002_more.sql <<'", script)
        tags = re.findall(r"<<'([A-Z_]+)'", script)
        self.assertEqual(len(tags), len(set(tags)))
        steps = re.findall(r"-U oaw_app -d openaiwill < (\S+)", script)
        self.assertEqual(steps, ["001_app.sql", "002_more.sql"])
        with self.assertRaises(site_release.ReleaseError):
            build(app={"../x.sql": "SELECT 1;\n"})

    def test_the_real_app_sql_is_what_gets_uploaded(self):
        files = server_db.app_sql_files()
        self.assertEqual(sorted(files), [p.name for p in sorted((server_db.ROOT / "db" / "app").glob("*.sql"))])
        self.assertIn("CREATE TABLE IF NOT EXISTS app.admins", "".join(files.values()))

    def test_the_backup_directory_is_private_and_owned_by_the_deploy_user(self):
        self.assertIn('sudo install -d -m 700 -o "$(id -un)" -g "$(id -gn)" /opt/openaiwill/backups </dev/null', build())

    def test_the_app_password_is_added_to_an_old_db_env_without_touching_other_lines(self):
        script = build()
        self.assertIn("if ! grep -q '^OAW_APP_PASSWORD=' /opt/openaiwill/db/db.env; then", script)
        self.assertIn(">> /opt/openaiwill/db/db.env", script)
        self.assertNotRegex(script, r"sed -i")

    def test_site_env_gets_the_app_settings_only_when_absent_and_heals_the_url(self):
        script = build()
        self.assertIn('want="postgres://oaw_app:${apw}@openaiwill-db:5432/openaiwill"', script)
        self.assertIn("BETTER_AUTH_URL=https://surviagi.com", script)
        self.assertIn("grep -q '^BETTER_AUTH_SECRET=' /opt/openaiwill/site.env", script)
        self.assertIn("grep -q '^BETTER_AUTH_URL=' /opt/openaiwill/site.env", script)

    def test_isolation_is_asserted_positively_as_the_superuser(self):
        script = build()
        lines = [l for l in script.splitlines() if "has_schema_privilege" in l]
        self.assertEqual(len(lines), 1)
        line = lines[0]
        for part in ("-U postgres", "('oaw_app','kg','USAGE')", "('oaw_site','app','USAGE')",
                     "('oaw_kg_writer','app','USAGE')", "('oaw_app','public','CREATE')"):
            self.assertIn(part, line)
        self.assertNotIn(" -h ", line)
        self.assertIn("isolation broken:", script)
        # No longer "any failure counts as isolation".
        self.assertNotIn("SELECT 1 FROM kg.releases", script)
        self.assertNotIn("SELECT 1 FROM app.submissions", script)

    def test_existing_passwords_are_validated_before_anything_changes(self):
        script = build()
        check = script.index("^[0-9a-f]{48}$")
        self.assertLess(check, script.index("sudo install"))
        self.assertLess(check, script.index("a=$(newpw)"))
        self.assertLess(check, script.index(">> /opt/openaiwill/db/db.env"))

    def test_a_missing_final_newline_is_repaired_before_every_append(self):
        script = build()
        self.assertIn('[ -z "$(tail -c1 "$1")" ] || echo >> "$1"', script)
        self.assertLess(script.index("endnl /opt/openaiwill/db/db.env"), script.index(">> /opt/openaiwill/db/db.env"))
        self.assertLess(script.index("endnl /opt/openaiwill/site.env"), script.index(">> /opt/openaiwill/site.env"))

    def test_the_backup_service_is_restarted_after_the_schema_exists(self):
        script = build()
        restart = "sudo docker compose -p openaiwill-db --env-file db.env restart backup </dev/null"
        self.assertIn(restart, script)
        self.assertGreater(script.index(restart), script.index("-U oaw_app -d openaiwill < 001_app.sql"))
        self.assertLess(script.index(restart), script.index("echo 'database ready"))

    def test_a_failed_grep_is_not_hidden_and_the_temp_file_is_removed_on_exit(self):
        script = build()
        self.assertNotIn("|| true; }", script)
        self.assertIn("""> "$tmp" || [ $? -eq 1 ]""", script)
        self.assertIn("""trap 'rm -f "$tmp"' EXIT""", script)


class SetupScriptRunTest(unittest.TestCase):
    """Runs the generated script for real in a temporary deploy root, with `sudo` and `docker` replaced by stubs
    that record their arguments. Everything else (file writes, modes, openssl, sed, grep) is the real thing."""

    FAKE_DOCKER = """#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$1" in
  network|compose) exit 0;;
  exec)
    last=""; for a in "$@"; do last=$a; done
    case "$last" in
      *not-the-password*) exit 1;;
    esac
    case "$last" in
      *has_schema_privilege*)
        if [ -n "${FAKE_ISOLATION_BROKEN:-}" ]; then echo "oaw_app kg"; fi
        exit 0;;
    esac
    cat >/dev/null 2>&1 || true
    echo 0;;
esac
"""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.root = base / "deploy"
        self.bin = base / "bin"
        self.bin.mkdir()
        (self.bin / "sudo").write_text('#!/bin/sh\nexec "$@"\n')
        (self.bin / "docker").write_text(self.FAKE_DOCKER)
        for name in ("sudo", "docker"):
            (self.bin / name).chmod(0o755)
        self.log = base / "docker.log"
        self.target = {**TARGET, "DEPLOY_ROOT": str(self.root)}
        self.db_env = self.root / "db" / "db.env"
        self.site_env = self.root / "site.env"

    def run_script(self, **env):
        import os
        full = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_LOG": str(self.log), **env}
        return subprocess.run(["bash", "-euo", "pipefail", "-s"], input=build(self.target), text=True,
                              capture_output=True, env=full)

    @staticmethod
    def env(path):
        return server_db.parse_env(path.read_text())

    def test_a_fresh_server_gets_four_passwords_and_all_site_settings(self):
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stderr)
        db = self.env(self.db_env)
        self.assertEqual(sorted(db), ["OAW_APP_PASSWORD", "OAW_KG_WRITER_PASSWORD", "OAW_SITE_PASSWORD", "POSTGRES_PASSWORD"])
        self.assertEqual(len({v for v in db.values()}), 4)
        site = self.env(self.site_env)
        self.assertEqual(site["DATABASE_URL"], f"postgres://oaw_site:{db['OAW_SITE_PASSWORD']}@openaiwill-db:5432/openaiwill")
        self.assertEqual(site["APP_DATABASE_URL"], f"postgres://oaw_app:{db['OAW_APP_PASSWORD']}@openaiwill-db:5432/openaiwill")
        self.assertRegex(site["BETTER_AUTH_SECRET"], r"[0-9a-f]{64}")
        self.assertEqual(site["BETTER_AUTH_URL"], "https://surviagi.com")
        self.assertEqual(oct(self.db_env.stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct(self.site_env.stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct((self.root / "backups").stat().st_mode & 0o777), "0o700")
        for secret in (*db.values(), site["BETTER_AUTH_SECRET"]):
            self.assertNotIn(secret, done.stdout + done.stderr)
            self.assertNotIn(secret, self.log.read_text())
        self.assertTrue((self.root / "db" / "001_app.sql").is_file())

    def test_a_second_run_changes_nothing(self):
        self.run_script()
        before = (self.db_env.read_bytes(), self.site_env.read_bytes())
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.db_env.read_bytes(), self.site_env.read_bytes()), before)

    def test_an_older_server_is_upgraded_in_place(self):
        (self.root / "db").mkdir(parents=True)
        old_db = f"POSTGRES_PASSWORD={'a' * 48}\nOAW_KG_WRITER_PASSWORD={'b' * 48}\nOAW_SITE_PASSWORD={'c' * 48}\n"
        old_site = f"DATABASE_URL=postgres://oaw_site:{'c' * 48}@openaiwill-db:5432/openaiwill\nEXTRA=keep me\n"
        self.db_env.write_text(old_db)
        self.site_env.write_text(old_site)
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(self.db_env.read_text().startswith(old_db))
        self.assertTrue(self.site_env.read_text().startswith(old_site))
        self.assertEqual(set(self.env(self.site_env)) - {"DATABASE_URL", "EXTRA"},
                         {"APP_DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"})

    def test_a_changed_app_password_heals_the_url_and_nothing_else(self):
        self.run_script()
        before = self.env(self.site_env)
        db = self.db_env.read_text().replace(self.env(self.db_env)["OAW_APP_PASSWORD"], "f" * 48)
        self.db_env.write_text(db)
        self.assertEqual(self.run_script().returncode, 0)
        after = self.env(self.site_env)
        self.assertEqual(after["APP_DATABASE_URL"], f"postgres://oaw_app:{'f' * 48}@openaiwill-db:5432/openaiwill")
        self.assertEqual({k: v for k, v in after.items() if k != "APP_DATABASE_URL"},
                         {k: v for k, v in before.items() if k != "APP_DATABASE_URL"})
        self.assertEqual(oct(self.site_env.stat().st_mode & 0o777), "0o600")
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.startswith("site.env.")], [])

    def test_existing_site_settings_are_never_rewritten(self):
        self.run_script()
        text = self.site_env.read_text().replace("BETTER_AUTH_URL=https://surviagi.com", "BETTER_AUTH_URL=https://other.example")
        self.site_env.write_text(text + "GOOGLE_CLIENT_ID=kept\n")
        self.run_script()
        self.assertEqual(self.site_env.read_text(), text + "GOOGLE_CLIENT_ID=kept\n")

    def test_files_without_a_final_newline_are_not_glued(self):
        (self.root / "db").mkdir(parents=True)
        old_db = f"POSTGRES_PASSWORD={'a' * 48}\nOAW_KG_WRITER_PASSWORD={'b' * 48}\nOAW_SITE_PASSWORD={'c' * 48}"
        old_site = f"DATABASE_URL=postgres://oaw_site:{'c' * 48}@openaiwill-db:5432/openaiwill\nEXTRA=keep me"
        self.db_env.write_text(old_db)
        self.site_env.write_text(old_site)
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stderr)
        db_text, site_text = self.db_env.read_text(), self.site_env.read_text()
        self.assertTrue(db_text.startswith(old_db + "\n"))
        self.assertTrue(site_text.startswith(old_site + "\n"))
        db = self.env(self.db_env)
        self.assertEqual((db["POSTGRES_PASSWORD"], db["OAW_KG_WRITER_PASSWORD"], db["OAW_SITE_PASSWORD"]),
                         ("a" * 48, "b" * 48, "c" * 48))
        self.assertRegex(db["OAW_APP_PASSWORD"], r"[0-9a-f]{48}")
        site = self.env(self.site_env)
        self.assertEqual(site["EXTRA"], "keep me")
        self.assertEqual(set(site) - {"DATABASE_URL", "EXTRA"}, {"APP_DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"})
        for line in db_text.splitlines() + site_text.splitlines():
            self.assertEqual(len(re.findall(r"[A-Z_]+=", line.split("@")[0])), 1, line)

    def test_an_empty_app_password_line_is_refused_but_a_missing_one_is_added(self):
        (self.root / "db").mkdir(parents=True)
        base = f"POSTGRES_PASSWORD={'a' * 48}\nOAW_KG_WRITER_PASSWORD={'b' * 48}\nOAW_SITE_PASSWORD={'c' * 48}\n"
        for line in ("OAW_APP_PASSWORD=\n", "OAW_APP_PASSWORD=short\n"):
            with self.subTest(line=line):
                self.db_env.write_text(base + line)
                before = self.db_env.read_bytes()
                done = self.run_script()
                self.assertEqual(done.returncode, 1)
                self.assertEqual(len(done.stderr.strip().splitlines()), 1)
                self.assertIn("OAW_APP_PASSWORD", done.stderr)
                self.assertEqual(self.db_env.read_bytes(), before)
                self.assertFalse((self.root / "backups").exists())
        self.db_env.write_text(base)
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertRegex(self.env(self.db_env)["OAW_APP_PASSWORD"], r"[0-9a-f]{48}")

    def test_a_glued_or_malformed_password_is_refused_before_anything_changes(self):
        (self.root / "db").mkdir(parents=True)
        good = f"POSTGRES_PASSWORD={'a' * 48}\nOAW_KG_WRITER_PASSWORD={'b' * 48}\n"
        for bad in (f"OAW_SITE_PASSWORD={'c' * 48}OAW_APP_PASSWORD={'d' * 48}\n", "OAW_SITE_PASSWORD=\n",
                    "OAW_SITE_PASSWORD=short\n", f"OAW_SITE_PASSWORD={'g' * 48}\n", "",
                    f"OAW_SITE_PASSWORD={'c' * 48}\nOAW_SITE_PASSWORD={'c' * 48}\n"):
            with self.subTest(bad=bad[:30]):
                self.db_env.write_text(good + bad)
                before = self.db_env.read_bytes()
                done = self.run_script()
                self.assertEqual(done.returncode, 1)
                self.assertEqual(len(done.stderr.strip().splitlines()), 1)
                self.assertIn("OAW_SITE_PASSWORD", done.stderr)
                self.assertNotIn("c" * 48, done.stderr)
                self.assertEqual(self.db_env.read_bytes(), before)
                self.assertFalse((self.root / "backups").exists())
                self.assertFalse(self.site_env.exists())

    def test_a_broken_isolation_stops_setup_with_one_line(self):
        done = self.run_script(FAKE_ISOLATION_BROKEN="1")
        self.assertEqual(done.returncode, 1)
        self.assertIn("isolation broken: oaw_app kg", done.stderr)
        self.assertEqual(len(done.stderr.strip().splitlines()), 1)


class SiteRoleFilesTest(unittest.TestCase):
    roles = (server_db.DEPLOY_DB / "roles.sql").read_text()
    compose = (server_db.DEPLOY_DB / "compose.yml").read_text()

    def test_roles_sql_creates_the_app_role_and_schema(self):
        self.assertIn("\\getenv app_password OAW_APP_PASSWORD", self.roles)
        self.assertIn("WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'oaw_app')", self.roles)
        self.assertIn("ALTER ROLE oaw_app NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD", self.roles)
        self.assertIn("GRANT CONNECT ON DATABASE openaiwill TO oaw_app", self.roles)
        self.assertIn("CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION oaw_app", self.roles)
        self.assertIn("ALTER SCHEMA app OWNER TO oaw_app", self.roles)
        self.assertIn("ALTER ROLE oaw_app SET search_path = app", self.roles)
        self.assertLess(self.roles.index("\\connect openaiwill"), self.roles.index("CREATE SCHEMA IF NOT EXISTS app"))
        self.assertNotIn("oaw_site", self.roles[self.roles.index("CREATE SCHEMA IF NOT EXISTS app"):])

    def test_the_backup_service_dumps_schema_app_daily_and_keeps_14_days(self):
        import json
        done = subprocess.run(["docker", "compose", "-f", str(server_db.DEPLOY_DB / "compose.yml"), "config", "--format", "json"],
                              capture_output=True, text=True, env={**__import__("os").environ, "POSTGRES_PASSWORD": "pg", "OAW_APP_PASSWORD": "x"})
        if done.returncode != 0:
            self.skipTest("docker compose is not available")
        service = json.loads(done.stdout)["services"]["backup"]
        self.assertEqual(service["image"], "postgres:16-alpine")
        self.assertEqual(service["restart"], "unless-stopped")
        self.assertEqual(service["depends_on"]["db"]["condition"], "service_healthy")
        self.assertIn("openaiwill", service["networks"])
        volume = service["volumes"][0]
        self.assertEqual((volume["target"], Path(volume["source"]).name), ("/backups", "backups"))
        self.assertEqual(Path(volume["source"]).parent.name, "deploy")  # ../backups relative to deploy/db
        self.assertEqual(service["environment"], {"PGPASSWORD": "x"})  # the app password only, never the superuser's
        text = " ".join(service["command"])
        for part in ("set -o pipefail", "umask 077", "pg_dump -h openaiwill-db -U oaw_app -d openaiwill -n app", "gzip",
                     "sleep 86400", "sleep 300", "-mtime +14", "-delete", "app-*.sql.gz", "gzip -t", "rm -f /backups/app-*.sql.gz.tmp"):
            self.assertIn(part, text)
        self.assertLess(text.index(".tmp"), text.index("mv "))
        self.assertLess(text.index("gzip -t"), text.index("mv "))
        self.assertNotIn("-U postgres", text)
        # a failed dump is retried in five minutes, a good one in a day
        self.assertNotIn("[ -s ", text)

    def test_dollar_signs_are_escaped_for_compose(self):
        self.assertNotRegex(self.compose, r"(?<!\$)\$\((?!\$)")
        self.assertNotRegex(self.compose, r"(?<!\$)\$\{?(?:out|stamp)\b")


class PollTest(unittest.TestCase):
    def run_poll(self, bodies, expected="D2", seconds=9, interval=3):
        clock = {"t": 0.0}
        calls = iter(bodies)

        def read():
            item = next(calls)
            if item is None:
                raise site_release.ReleaseError("no answer")
            return item

        def sleep(n):
            clock["t"] += n

        result = server_db.poll_release(read, expected, seconds, interval, sleep, lambda: clock["t"])
        return result, clock["t"]

    @staticmethod
    def body(release):
        return '{"data": {"releaseId": "%s", "source": "database"}}' % release

    def test_it_stops_as_soon_as_the_site_serves_the_release(self):
        (matched, last), waited = self.run_poll([self.body("D1"), self.body("D2")])
        self.assertEqual((matched, last, waited), (True, "D2", 3))

    def test_it_gives_up_after_the_deadline_and_reports_what_it_saw(self):
        (matched, last), waited = self.run_poll([self.body("D1")] * 10)
        self.assertEqual((matched, last), (False, "D1"))
        self.assertGreaterEqual(waited, 9)

    def test_a_site_that_never_answers_is_reported_as_nothing_seen(self):
        (matched, last), _ = self.run_poll([None] * 10)
        self.assertEqual((matched, last), (False, ""))

    def test_a_failed_read_does_not_end_the_wait(self):
        (matched, _), _ = self.run_poll([None, self.body("D2")])
        self.assertTrue(matched)


if __name__ == "__main__":
    unittest.main()
