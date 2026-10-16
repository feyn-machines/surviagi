import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import site_release as release  # noqa: E402

TARGET = {"DEPLOY_HOST": "h.example", "DEPLOY_USER": "u", "DEPLOY_SSH_KEY": "/k/key", "DEPLOY_ROOT": "/opt/openaiwill"}

class UploadTest(unittest.TestCase):
    def test_unchanged_files_are_linked_from_the_previous_release(self):
        argv = release.upload_argv(TARGET, "20261004T150523Z-c7f1d16", "20261003T102912Z-e2d4005")
        self.assertIn("--link-dest=/opt/openaiwill/releases/20261003T102912Z-e2d4005", argv)
        self.assertEqual(argv[-1], "u@h.example:/opt/openaiwill/releases/20261004T150523Z-c7f1d16/")
        self.assertTrue(argv[-2].endswith("/20261004T150523Z-c7f1d16/"))

    def test_first_release_and_a_repeat_of_the_live_one_upload_in_full(self):
        for previous in ("", "20261004T150523Z-c7f1d16"):
            argv = release.upload_argv(TARGET, "20261004T150523Z-c7f1d16", previous)
            self.assertFalse([a for a in argv if a.startswith("--link-dest")])


    def test_a_release_links_unchanged_files_from_the_production_release(self):
        """The reference is the id in the server's `current` file; a name the server does not keep
        would leave every release uploading in full."""
        current = "20261011T163859Z-8cb85a4"
        state = {"current": current, "previous": "20261011T162414Z-8cb85a4"}
        uploads = []

        def run(argv, **_):
            if argv[0] == "rsync":
                uploads.append(argv)

        with mock.patch.object(release, "load_target", return_value=TARGET), \
                mock.patch.object(release, "build", return_value="20261016T084255Z-c3724a8"), \
                mock.patch.object(release, "remote"), \
                mock.patch.object(release, "remote_id", side_effect=lambda _t, name: state.get(name, "")), \
                mock.patch.object(release, "run", side_effect=run), \
                mock.patch.object(release, "start_candidate"), \
                mock.patch.object(release, "candidate_failures", return_value=([], "20261016T042031Z-7eca3cca")), \
                mock.patch("sys.stdout"):
            release.release_command()
        self.assertEqual(len(uploads), 1)
        self.assertIn(f"--link-dest=/opt/openaiwill/releases/{current}", uploads[0])


class ReleaseIdTest(unittest.TestCase):
    def test_id_is_build_time_and_commit(self):
        built = datetime(2026, 10, 3, 10, 29, 12, 430661, tzinfo=timezone.utc)
        self.assertEqual(release.release_id(built, "e2d4005", False), "20261003T102912Z-e2d4005")

    def test_time_is_converted_to_utc(self):
        built = datetime(2026, 10, 3, 18, 29, 12, tzinfo=timezone(timedelta(hours=8)))
        self.assertEqual(release.release_id(built, "e2d4005", False), "20261003T102912Z-e2d4005")

    def test_uncommitted_work_is_marked(self):
        built = datetime(2026, 10, 3, 10, 29, 12, tzinfo=timezone.utc)
        self.assertTrue(release.release_id(built, "e2d4005", True).endswith("-dirty"))

    def test_every_id_passes_the_validation_that_guards_remote_commands(self):
        built = datetime.now(timezone.utc)
        for dirty in (False, True):
            self.assertEqual(release.checked_id(release.release_id(built, "abcdef0", dirty)),
                             release.release_id(built, "abcdef0", dirty))


class ForbiddenEntriesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def put(self, relative, text="x"):
        path = self.dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_a_clean_release_has_none(self):
        self.put("app/server.js")
        self.put("app/.next/static/chunk.js")
        self.put("app/public/og/en.png")
        self.put("release.json", "{}")
        self.assertEqual(release.forbidden_entries(self.dir), [])

    def test_snapshot_secrets_and_local_data_are_caught(self):
        for relative in ["app/datasets/published/latest/events.json", "app/.env.local", "app/.env.deploy",
                         "app/data/runtime/x.db", "app/local/x-crawler/crawler/a.py", "app/key.pem",
                         "app/docs/whitepaper.md", "app/cookies.json"]:
            self.put(relative)
        found = release.forbidden_entries(self.dir)
        self.assertEqual(len(found), 8, found)


class PruneTest(unittest.TestCase):
    def test_keeps_the_newest_and_whatever_is_live(self):
        ids = [f"2026100{n}T000000Z-aaaaaaa" for n in range(1, 8)]
        self.assertEqual(release.to_prune(ids, keep=5, protected={ids[0]}), [ids[1]])

    def test_nothing_to_prune_below_the_limit(self):
        self.assertEqual(release.to_prune(["a", "b"], keep=5, protected=set()), [])


class CheckedIdTest(unittest.TestCase):
    def test_valid_ids_pass(self):
        for value in ["20261003T102912Z-e2d4005", "20261003T102912Z-e2d4005-dirty", " 20261003T102912Z-e2d4005\n"]:
            self.assertEqual(release.checked_id(value), value.strip())

    def test_anything_else_is_refused(self):
        for value in ["", "   ", "*", "../x", "a b", "20261003T102912Z-e2d4005;rm -rf /", "20261003T102912Z-e2d4005 x"]:
            with self.assertRaisesRegex(release.ReleaseError, "not a release id"):
                release.checked_id(value)

    def test_a_trailing_newline_is_not_part_of_an_id(self):
        self.assertIsNone(release.RELEASE_ID.fullmatch("20261003T102912Z-e2d4005\n"))
        self.assertEqual(release.valid_ids(["20261003T102912Z-e2d4005\n"]), [])

    def test_prune_never_returns_junk(self):
        ids = [f"2026100{n}T000000Z-aaaaaaa" for n in range(1, 8)]
        junk = ["*", "../x", "a b", "x;y", ".", ""]
        found = release.to_prune(junk + ids, keep=5, protected=set())
        self.assertEqual(found, ids[:2])
        self.assertEqual(release.to_prune(junk, keep=0, protected=set()), [])


class ForeignBinariesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_a_release_without_the_image_optimizer_has_none(self):
        (self.dir / "app" / "node_modules" / "next").mkdir(parents=True)
        self.assertEqual(release.foreign_binaries(self.dir), [])

    def test_sharp_and_its_binaries_are_found(self):
        for relative in ["app/node_modules/.pnpm/@img+sharp-darwin-arm64@0.34.5/node_modules/@img/sharp-darwin-arm64",
                         "app/node_modules/sharp", "app/node_modules/@img"]:
            (self.dir / relative).mkdir(parents=True)
        found = release.foreign_binaries(self.dir)
        self.assertIn("app/node_modules/sharp", found)
        self.assertIn("app/node_modules/@img", found)
        self.assertTrue(any("@img+sharp-darwin-arm64" in path for path in found), found)


class ForwardTest(unittest.TestCase):
    target = {"DEPLOY_HOST": "h.example", "DEPLOY_USER": "u", "DEPLOY_SSH_KEY": "/k/key"}

    def test_the_free_port_is_a_usable_port(self):
        port = release.free_port()
        self.assertTrue(1024 <= port <= 65535)

    def test_the_forward_can_reach_any_remote_port(self):
        argv = release.forward_argv(self.target, 51234, 5434)
        self.assertEqual(argv[argv.index("-L") + 1], "51234:127.0.0.1:5434")
        self.assertIn("ExitOnForwardFailure=yes", argv)

    def test_the_forward_reaches_the_candidate_slot_and_fails_loudly(self):
        argv = release.forward_argv(self.target, 51234)
        self.assertEqual(argv[0], "ssh")
        self.assertIn("ExitOnForwardFailure=yes", argv)
        self.assertIn("-N", argv)
        self.assertEqual(argv[argv.index("-L") + 1], "51234:127.0.0.1:8321")
        self.assertEqual(argv[-1], "u@h.example")
        self.assertEqual(argv[argv.index("-i") + 1], "/k/key")
        self.assertIn("BatchMode=yes", argv)

    def test_the_plain_ssh_command_is_unchanged(self):
        self.assertEqual(release.ssh_base(self.target)[-1], "u@h.example")
        self.assertNotIn("-L", release.ssh_base(self.target))


class FetchAndSmokeTest(unittest.TestCase):
    def test_the_default_user_agent_names_the_release_script(self):
        seen = {}

        class Opener:
            def open(self, request, timeout):
                seen.update(request.header_items())
                raise OSError("stop")

        original = release.urllib.request.build_opener
        release.urllib.request.build_opener = lambda *a: Opener()
        try:
            with self.assertRaises(release.ReleaseError):
                release.fetch("http://x.invalid/", headers={"RSC": "1"})
        finally:
            release.urllib.request.build_opener = original
        self.assertTrue(seen["User-agent"].startswith("surviagi-release/1.0"))
        self.assertEqual(seen["Rsc"], "1")

    def test_an_unreachable_host_is_one_listed_failure(self):
        failures = release.smoke("http://127.0.0.1:1", None)
        self.assertEqual(len(failures), 1)
        self.assertIn("http://127.0.0.1:1 is not reachable", failures[0])


def sitemap(entries):
    """A sitemap as Next writes it: each address, with a lastmod when it has one."""
    urls = "".join(f"<url>\n<loc>{url}</loc>\n" + (f"<lastmod>{mod}</lastmod>\n" if mod else "") +
                   "<changefreq>daily</changefreq>\n</url>\n" for url, mod in entries.items())
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n'


class IndexNowChangesTest(unittest.TestCase):
    def test_the_sitemap_is_read_as_address_and_lastmod(self):
        xml = sitemap({"https://surviagi.com/markets": "2026-10-16T04:20:31.000Z",
                       "https://surviagi.com/work/a?x=1&amp;y=2": ""})
        self.assertEqual(release.sitemap_entries(xml), {"https://surviagi.com/markets": "2026-10-16T04:20:31.000Z",
                                                        "https://surviagi.com/work/a?x=1&y=2": ""})

    def test_new_moved_and_gone_addresses_are_sent_and_unchanged_ones_are_not(self):
        previous = {"/same": "2026-10-13", "/undated": "", "/moved": "2026-10-13", "/gone": "2026-10-10"}
        current = {"/same": "2026-10-13", "/undated": "", "/moved": "2026-10-16", "/new": ""}
        self.assertEqual(release.changed_addresses(previous, current), ["/gone", "/moved", "/new"])

    def test_a_page_that_gains_its_first_dated_evidence_is_sent(self):
        self.assertEqual(release.changed_addresses({"/work/a": ""}, {"/work/a": "2026-10-16"}), ["/work/a"])

    def test_without_a_baseline_every_address_is_sent(self):
        self.assertEqual(release.changed_addresses(None, {"/b": "", "/a": "x"}), ["/a", "/b"])


class NotifyIndexNowTest(unittest.TestCase):
    """notify_indexnow against a fake sitemap and a fake IndexNow; nothing leaves the machine."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name) / "indexnow" / "sitemap.json"
        self.sent = []
        self.accept = True

    def notify(self, entries, only_changed=True, status=200):
        def submit(key, urls):
            self.sent.append(urls)
            return self.accept
        with mock.patch.object(release, "indexnow_key", return_value="a" * 32), \
                mock.patch.object(release, "fetch", return_value=(status, {}, sitemap(entries))), \
                mock.patch.object(release, "submit_indexnow", side_effect=submit), \
                mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            release.notify_indexnow(only_changed=only_changed, state=self.state)

    def test_a_data_release_sends_only_what_changed_since_the_last_accepted_sitemap(self):
        self.notify({"/a": "1", "/b": "1"})
        self.assertEqual(self.sent, [["/a", "/b"]])  # no baseline yet: everything
        self.notify({"/a": "1", "/b": "2", "/c": ""})
        self.assertEqual(self.sent[-1], ["/b", "/c"])
        self.notify({"/a": "1", "/b": "2", "/c": ""})
        self.assertEqual(len(self.sent), 2)  # nothing changed, nothing sent

    def test_a_refused_submission_keeps_the_old_baseline(self):
        self.notify({"/a": "1"})
        self.accept = False
        self.notify({"/a": "2"})
        self.accept = True
        self.notify({"/a": "2"})
        self.assertEqual(self.sent, [["/a"], ["/a"], ["/a"]])

    def test_a_code_release_sends_everything_and_records_the_baseline(self):
        self.notify({"/a": "1"})
        self.notify({"/a": "1", "/b": ""}, only_changed=False)
        self.assertEqual(self.sent[-1], ["/a", "/b"])
        self.notify({"/a": "1", "/b": ""})
        self.assertEqual(len(self.sent), 2)

    def test_a_broken_sitemap_sends_nothing_and_keeps_the_baseline(self):
        self.notify({"/a": "1"})
        self.notify({}, status=200)
        self.notify({"/a": "2"}, status=503)
        self.assertEqual(self.sent, [["/a"]])
        self.assertEqual(json.loads(self.state.read_text())["entries"], {"/a": "1"})

    def test_an_unreadable_sitemap_does_not_fail_the_release(self):
        with mock.patch.object(release, "indexnow_key", return_value="a" * 32), \
                mock.patch.object(release, "fetch", side_effect=release.ReleaseError("no answer")), \
                mock.patch.object(release, "submit_indexnow") as submit, mock.patch("sys.stderr"):
            release.notify_indexnow(only_changed=True, state=self.state)
        submit.assert_not_called()

    def test_submissions_are_split_at_the_protocol_limit(self):
        seen = []

        class Answer:
            status = 202
            def __enter__(self):
                return self
            def __exit__(self, *exc):
                return False

        def urlopen(request, timeout):
            seen.append(len(json.loads(request.data)["urlList"]))
            return Answer()
        with mock.patch.object(release.urllib.request, "urlopen", side_effect=urlopen), mock.patch("sys.stdout"):
            self.assertTrue(release.submit_indexnow("a" * 32, [f"/{i}" for i in range(release.INDEXNOW_BATCH + 1)]))
        self.assertEqual(seen, [release.INDEXNOW_BATCH, 1])

    def test_the_baseline_lives_under_the_ignored_data_directory(self):
        self.assertEqual(release.INDEXNOW_STATE.relative_to(release.ROOT).parts[0], "data")


class RscRequestTest(unittest.TestCase):
    def test_the_request_is_the_one_the_router_sends(self):
        path, headers = release.rsc_request("/markets")
        # The hash Next 16 expects for exactly these headers (taken from its own 307 Location).
        self.assertEqual(path, "/markets?_rsc=OxBCQ2sR9P8GlKR3")
        self.assertEqual(headers["RSC"], "1")
        self.assertEqual(headers["Sec-Fetch-Dest"], "empty")


class PublicCheckMessageTest(unittest.TestCase):
    new = "20261003T102912Z-aaaaaaa"

    def test_a_reachability_failure_does_not_tell_the_operator_to_roll_back(self):
        message = release.public_check_message(self.new, ["https://surviagi.com is not reachable: no answer (dns)"])
        self.assertIn("production IS switched", message)
        self.assertIn("pnpm site:indexnow", message)
        self.assertIn("Tunnel/DNS", message)
        self.assertNotIn("pnpm site:rollback", message)

    def test_a_page_failure_names_the_rollback(self):
        message = release.public_check_message(self.new, ["/markets: status 500, expected 200"])
        self.assertIn("pnpm site:rollback", message)
        self.assertIn("production IS switched", message)


class SmokeAskedForTest(unittest.TestCase):
    def run_smoke(self, me_body):
        asked = []

        def fake_fetch(url, cookie=None, headers=None):
            path = url.removeprefix("http://smoke.invalid")
            asked.append(path)
            if path == "/admin":
                return 404, {}, ""
            if path == "/api/me":
                return 200, {}, me_body
            return 200, {}, "lang=\"en\" lang=\"zh-CN\" Sitemap: # SurviAGI <urlset"

        original = release.fetch
        release.fetch = fake_fetch
        try:
            failures = release.smoke("http://smoke.invalid", None, with_data=False)
        finally:
            release.fetch = original
        return asked, failures

    def test_the_legal_pages_the_admin_and_the_session_endpoint_are_asked_for(self):
        asked, _ = self.run_smoke('{"enabled": false, "user": null}')
        for path in ("/privacy", "/zh-CN/privacy", "/terms", "/zh-CN/terms", "/admin", "/api/me"):
            self.assertIn(path, asked)

    def test_a_session_answer_without_the_enabled_key_is_a_failure(self):
        _, failures = self.run_smoke('{"user": null}')
        self.assertTrue(any(f.startswith("/api/me") for f in failures), failures)
        _, failures = self.run_smoke("not json")
        self.assertTrue(any(f.startswith("/api/me") for f in failures), failures)

    def test_a_good_answer_adds_no_failure_of_its_own(self):
        _, failures = self.run_smoke('{"enabled": true}')
        self.assertFalse(any(f.startswith("/api/me") for f in failures), failures)


class SmokeSelectionTest(unittest.TestCase):
    def test_without_data_no_detail_page_is_asked_for(self):
        self.assertEqual(release.detail_patterns(False), {})

    def test_with_data_every_kind_of_detail_page_is_asked_for(self):
        self.assertEqual(set(release.detail_patterns(True)),
                         {"market", "dotted occupation", "occupation group", "update", "work",
                          "Chinese dotted occupation"})

    def test_the_selection_is_a_copy(self):
        release.detail_patterns(True).clear()
        self.assertTrue(release.detail_patterns(True))


class LocalServerEnvTest(unittest.TestCase):
    base = {"PATH": "/bin", "DATABASE_URL": "postgres://x", "SITE_REQUIRE_DATABASE": "1", "SNAPSHOT_DIR": "/old"}

    def test_a_database_never_leaks_into_the_smoke_server(self):
        env = release.local_server_env("preview", None, self.base)
        for name in ("DATABASE_URL", "SITE_REQUIRE_DATABASE", "SNAPSHOT_DIR"):
            self.assertNotIn(name, env)
        self.assertEqual((env["SITE_ENV"], env["PATH"], env["PORT"]), ("preview", "/bin", str(release.LOCAL_PORT)))

    def test_the_release_id_reaches_healthz_and_is_validated(self):
        self.assertEqual(release.local_server_env("preview", None, self.base, "20261003T102912Z-aaaaaaa")["RELEASE_ID"],
                         "20261003T102912Z-aaaaaaa")
        with self.assertRaises(release.ReleaseError):
            release.local_server_env("preview", None, self.base, "x;y")

    def test_files_mode_points_at_the_snapshot_directory(self):
        env = release.local_server_env("production", Path("/snap"), self.base)
        self.assertEqual(env["SNAPSHOT_DIR"], "/snap")
        self.assertNotIn("SITE_REQUIRE_DATABASE", env)


class SnapshotChoiceTest(unittest.TestCase):
    def test_only_a_directory_with_a_manifest_selects_files_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = release.SNAPSHOT
            try:
                release.SNAPSHOT = Path(tmp)
                self.assertIsNone(release.snapshot_dir_for_smoke())
                (Path(tmp) / "manifest.json").write_text("{}")
                self.assertEqual(release.snapshot_dir_for_smoke(), Path(tmp))
            finally:
                release.SNAPSHOT = original


class HealthTest(unittest.TestCase):
    loaded = json.dumps({"ok": True, "release": "R1", "data": {"releaseId": "D1", "source": "database", "loadedAt": "t"}})
    empty = json.dumps({"ok": False, "release": "R1", "data": {"releaseId": None, "source": "none", "loadedAt": None}})

    def test_a_database_release_passes(self):
        self.assertEqual(release.data_release_failures(self.loaded), [])

    def test_no_release_says_to_publish_data_first(self):
        for body in (self.empty, "", "not json", "[]", json.dumps({"data": None}),
                     json.dumps({"data": {"releaseId": "D1", "source": "files"}})):
            failures = release.data_release_failures(body)
            self.assertEqual(len(failures), 1, body)
            self.assertIn("publish data first: pnpm data:release && pnpm data:promote", failures[0])

    def test_status_line(self):
        self.assertEqual(release.describe_health(self.loaded), "code R1, data D1 (database)")
        self.assertEqual(release.describe_health(self.empty), "code R1, no data release loaded")
        self.assertEqual(release.describe_health(""), "not running")
        self.assertEqual(release.describe_health(None), "not running")
        self.assertIn("not with a /healthz body", release.describe_health("<html>"))

    def test_probe_output_is_parsed_by_slot(self):
        out = f"PRODUCTION:{self.loaded}\nCANDIDATE:\n"
        found = release.parse_probe(out)
        self.assertEqual(found["PRODUCTION"], self.loaded)
        self.assertEqual(found["CANDIDATE"], "")
        self.assertEqual(release.describe_health(found["CANDIDATE"]), "not running")


class CandidateScriptTest(unittest.TestCase):
    target = {"DEPLOY_ROOT": "/opt/openaiwill", "DEPLOY_USER": "u"}
    new = "20261003T102912Z-aaaaaaa"

    def test_the_script_starts_only_the_candidate_slot_with_the_site_env_file_and_a_bounded_wait(self):
        script = release.candidate_script(self.target, self.new)
        self.assertIn("-p openaiwill-next up -d --build --wait --wait-timeout 180", script)
        self.assertIn("SITE_ENV_FILE=/opt/openaiwill/site.env", script)
        self.assertNotIn("-p openaiwill up", script)

    def test_every_wait_in_every_script_is_bounded(self):
        scripts = [release.candidate_script(self.target, self.new),
                   release.switch_script(self.target, self.new, "20261002T102912Z-bbbbbbb"),
                   release.switch_script(self.target, self.new, self.new)]
        for script in scripts:
            ups = [line for line in script.splitlines() if " up -d" in line]
            self.assertTrue(ups)
            for line in ups:
                for part in line.split("docker compose")[1:]:
                    if " up -d" in part:
                        self.assertIn("--wait-timeout 180", part)

    def test_the_diagnosis_prints_the_body_and_40_log_lines(self):
        script = release.candidate_diagnosis_script()
        self.assertIn("curl -s --max-time 5 http://127.0.0.1:8321/healthz", script)
        self.assertIn("docker logs --tail 40", script)
        self.assertIn("label=com.docker.compose.project=openaiwill-next", script)
        subprocess_check = __import__("subprocess").run(["bash", "-n"], input=script, text=True, capture_output=True)
        self.assertEqual(subprocess_check.returncode, 0, subprocess_check.stderr)

    def test_publish_data_first_only_for_database_mode_without_a_release(self):
        publish = "publish data first: pnpm data:release && pnpm data:promote"
        none_loaded = json.dumps({"ok": False, "release": "R", "data": {"releaseId": None, "source": "database"}})
        loaded = json.dumps({"ok": True, "release": "R", "data": {"releaseId": "D1", "source": "database"}})
        self.assertIn(publish, release.candidate_start_failure(none_loaded))
        self.assertNotIn(publish, release.candidate_start_failure(loaded))
        self.assertNotIn(publish, release.candidate_start_failure(""))
        self.assertNotIn(publish, release.candidate_start_failure("<html>502</html>"))
        self.assertNotIn(publish, release.candidate_start_failure(json.dumps({"data": {"source": "files", "releaseId": None}})))
        self.assertEqual(release.candidate_start_failure(""), "the candidate did not become healthy; see the output above")

    def test_every_compose_call_names_the_env_file(self):
        command = release.compose(self.target, release.PRODUCTION, self.new, "up -d --wait")
        self.assertIn("SITE_ENV_FILE=/opt/openaiwill/site.env", command)
        self.assertIn("HOST_PORT=8320", command)

    def test_the_env_file_path_is_quoted(self):
        command = release.compose({"DEPLOY_ROOT": "/opt/my site"}, release.CANDIDATE, self.new, "down")
        self.assertIn("SITE_ENV_FILE='/opt/my site/site.env'", command)

    def test_production_switch_uses_the_env_file_too(self):
        script = release.switch_script(self.target, self.new, "20261002T102912Z-bbbbbbb")
        self.assertEqual(script.count("SITE_ENV_FILE=/opt/openaiwill/site.env"), 2)


class DatabasePrecheckTest(unittest.TestCase):
    target = {"DEPLOY_ROOT": "/opt/openaiwill", "DEPLOY_USER": "u"}
    new = "20261003T102912Z-aaaaaaa"
    old = "20261002T102912Z-bbbbbbb"

    def test_production_is_touched_only_after_the_database_and_an_active_release_are_confirmed(self):
        for live in (self.old, "", self.new):
            script = release.switch_script(self.target, self.new, live)
            check = script.index("kg.active")
            self.assertLess(check, script.index("docker compose"))
            self.assertLess(script.index("production was not touched"), script.index("docker compose"))
            self.assertLess(script.index("no active data release") if "no active data release" in script
                            else script.index("has no active data release"), script.index("docker compose"))

    def test_the_check_runs_as_the_site_role_over_the_container_address(self):
        script = release.database_precheck(self.target)
        self.assertIn("-U oaw_site", script)
        self.assertIn('pg_isready -q -h "$ip"', script)
        self.assertIn('PGPASSWORD="$OAW_SITE_PASSWORD"', script)
        self.assertIn("SELECT release_id FROM kg.active", script)
        self.assertIn("--env-file /opt/openaiwill/db/db.env", script)
        self.assertNotIn("127.0.0.1", script)
        self.assertIn("</dev/null", script)

    def test_both_failures_stop_with_one_line_and_exit_1(self):
        script = release.database_precheck(self.target)
        self.assertIn("the database does not accept connections as oaw_site; production was not touched", script)
        self.assertIn("the database has no active data release (pnpm data:promote); production was not touched", script)
        self.assertEqual(script.count("exit 1"), 2)

    def test_the_precheck_is_valid_shell(self):
        done = __import__("subprocess").run(["bash", "-n"], input=release.switch_script(self.target, self.new, self.old),
                                            text=True, capture_output=True)
        self.assertEqual(done.returncode, 0, done.stderr)


class SwitchScriptTest(unittest.TestCase):
    target = {"DEPLOY_ROOT": "/opt/openaiwill", "DEPLOY_USER": "u"}
    new = "20261003T102912Z-aaaaaaa"
    old = "20261002T102912Z-bbbbbbb"

    def test_failure_restores_the_live_release_and_does_not_record_state_first(self):
        script = release.switch_script(self.target, self.new, self.old)
        self.assertIn(f"production restored to {self.old}", script)
        self.assertLess(script.index("production restored"), script.index("/previous"))
        self.assertLess(script.index("production restored"), script.rindex("/current"))

    def test_a_first_promote_stops_the_failed_release(self):
        script = release.switch_script(self.target, self.new, "")
        self.assertIn("no earlier release to restore; production slot stopped", script)
        self.assertIn("-p openaiwill down", script)
        self.assertLess(script.index("-p openaiwill down"), script.index("no earlier release to restore"))
        self.assertNotIn("production restored", script)
        self.assertNotIn("/previous", script)

    def test_a_failed_restore_says_production_is_down(self):
        script = release.switch_script(self.target, self.new, self.old)
        self.assertIn("|| { echo 'RESTORE FAILED: production is down' >&2; exit 1; }", script)
        self.assertIn(f"RESTORE FAILED: production is down; {self.old} is gone", script)

    def test_switching_to_the_live_release_does_not_claim_a_restore(self):
        script = release.switch_script(self.target, self.old, self.old)
        self.assertNotIn("production restored", script)
        self.assertIn(f"{self.old} did not become healthy; it is still the current release", script)

class SiteEnvTest(unittest.TestCase):
    ID = "123456-abc.apps.example.invalid"
    SECRET = "GOCSPX-test_secret-value"

    def run_script(self, initial, values=None):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve() / "deploy"
            root.mkdir()
            target = {**TARGET, "DEPLOY_ROOT": str(root)}
            site = root / "site.env"
            if initial is not None:
                site.write_text(initial)
            script = release.site_env_script(target, values or {"GOOGLE_CLIENT_ID": self.ID, "GOOGLE_CLIENT_SECRET": self.SECRET})
            done = subprocess.run(["bash", "-euo", "pipefail", "-s"], input=script, text=True, capture_output=True)
            leftovers = [p.name for p in root.iterdir() if p.name != "site.env"]
            text = site.read_text() if site.exists() else None
            mode = oct(site.stat().st_mode & 0o777) if site.exists() else None
            return done, text, mode, leftovers, script

    def test_the_two_keys_are_added_to_an_existing_file_and_other_lines_stay(self):
        done, text, mode, leftovers, _ = self.run_script("DATABASE_URL=postgres://x\nBETTER_AUTH_URL=https://openaiwill.com\n")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(text.startswith("DATABASE_URL=postgres://x\nBETTER_AUTH_URL=https://openaiwill.com\n"))
        self.assertIn(f"GOOGLE_CLIENT_ID={self.ID}\n", text)
        self.assertIn(f"GOOGLE_CLIENT_SECRET={self.SECRET}\n", text)
        self.assertEqual((mode, leftovers), ("0o600", []))

    def test_existing_values_are_replaced_not_duplicated(self):
        done, text, _, _, _ = self.run_script("GOOGLE_CLIENT_ID=old\nA=1\nGOOGLE_CLIENT_SECRET=old\n")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(text.count("GOOGLE_CLIENT_ID="), 1)
        self.assertEqual(text.count("GOOGLE_CLIENT_SECRET="), 1)
        self.assertNotIn("old", text)
        self.assertIn("A=1\n", text)

    def test_a_file_without_a_final_newline_is_not_glued_to_the_new_key(self):
        done, text, _, _, _ = self.run_script("A=1")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(text.splitlines()[0], "A=1")

    def test_running_it_twice_changes_nothing(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            target = {**TARGET, "DEPLOY_ROOT": str(root)}
            (root / "site.env").write_text("A=1\n")
            script = release.site_env_script(target, {"GOOGLE_CLIENT_ID": self.ID, "GOOGLE_CLIENT_SECRET": self.SECRET})
            subprocess.run(["bash", "-euo", "pipefail", "-s"], input=script, text=True, check=True)
            first = (root / "site.env").read_text()
            subprocess.run(["bash", "-euo", "pipefail", "-s"], input=script, text=True, check=True)
            self.assertEqual((root / "site.env").read_text(), first)

    def test_an_unreadable_site_env_is_a_failure_and_leaves_no_temp_file(self):
        import os
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            site = root / "site.env"
            site.write_text("A=1\n")
            site.chmod(0)
            if os.access(site, os.R_OK):
                self.skipTest("running as a user who can read mode 000 files")
            script = release.site_env_script({**TARGET, "DEPLOY_ROOT": str(root)},
                                             {"GOOGLE_CLIENT_ID": self.ID, "GOOGLE_CLIENT_SECRET": self.SECRET})
            done = subprocess.run(["bash", "-euo", "pipefail", "-s"], input=script, text=True, capture_output=True)
            self.assertNotEqual(done.returncode, 0)
            leftovers = [p.name for p in root.iterdir()]
            site.chmod(0o600)
            self.assertEqual(leftovers, ["site.env"])
        self.assertNotIn("|| true", script)

    def test_a_missing_site_env_is_an_error_not_a_new_file(self):
        done, text, _, _, _ = self.run_script(None)
        self.assertEqual(done.returncode, 1)
        self.assertIsNone(text)
        self.assertIn("pnpm db:setup", done.stderr)

    def test_the_output_names_keys_and_never_values(self):
        done, _, _, _, _ = self.run_script("A=1\n")
        self.assertIn("GOOGLE_CLIENT_ID", done.stdout)
        self.assertNotIn(self.ID, done.stdout + done.stderr)
        self.assertNotIn(self.SECRET, done.stdout + done.stderr)

    def test_unsafe_values_are_refused_without_echoing_them(self):
        for bad in ("a\nb", "it's", "a b", "a$b", "a#b", 'a"b', "a\\b", "a`b", "a\rb", ""):
            with self.subTest(bad=bad), self.assertRaises(release.ReleaseError) as raised:
                release.site_env_script(TARGET, {"GOOGLE_CLIENT_ID": bad, "GOOGLE_CLIENT_SECRET": self.SECRET})
            self.assertIn("GOOGLE_CLIENT_ID", str(raised.exception))
            if bad.strip():
                self.assertNotIn(bad, str(raised.exception))

    def test_only_the_two_google_keys_can_be_set(self):
        with self.assertRaises(release.ReleaseError):
            release.site_env_script(TARGET, {"GOOGLE_CLIENT_ID": self.ID, "GOOGLE_CLIENT_SECRET": self.SECRET, "ADMIN_EMAILS": "a@example.com"})
        with self.assertRaises(release.ReleaseError):
            release.site_env_script(TARGET, {"GOOGLE_CLIENT_ID": self.ID})

    def test_values_travel_inside_the_script_only(self):
        script = release.site_env_script(TARGET, {"GOOGLE_CLIENT_ID": self.ID, "GOOGLE_CLIENT_SECRET": self.SECRET})
        self.assertTrue(script.startswith("umask 077\n"))
        for line in script.splitlines():
            if self.SECRET in line:
                self.assertTrue(line.startswith("printf '%s=%s\\n' GOOGLE_CLIENT_SECRET"), line)
        self.assertNotIn("sudo", script)
        self.assertNotIn("ADMIN_EMAILS", script)


class LocalGoogleSettingsTest(unittest.TestCase):
    def read(self, env="", env_local=None):
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for name, text in ((".env", env), (".env.local", env_local)):
                if text is not None:
                    (Path(tmp) / name).write_text(text)
                paths.append(Path(tmp) / name)
            return release.read_google_settings(tuple(paths))

    def test_both_values_are_read_and_the_later_file_wins(self):
        values = self.read("GOOGLE_CLIENT_ID=a\nGOOGLE_CLIENT_SECRET=b\nADMIN_EMAILS=x@example.com\n", "GOOGLE_CLIENT_ID=c\n")
        self.assertEqual(values, {"GOOGLE_CLIENT_ID": "c", "GOOGLE_CLIENT_SECRET": "b"})

    def test_a_missing_value_is_refused_naming_the_key_only(self):
        for env in ("", "GOOGLE_CLIENT_ID=a\n", "GOOGLE_CLIENT_SECRET=b\n", "GOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=b\n"):
            with self.subTest(env=env), self.assertRaises(release.ReleaseError) as raised:
                self.read(env)
            self.assertIn("GOOGLE_CLIENT_", str(raised.exception))
            self.assertNotIn("=b", str(raised.exception))

    def test_admin_emails_are_not_required_and_not_returned(self):
        self.assertNotIn("ADMIN_EMAILS", self.read("GOOGLE_CLIENT_ID=a\nGOOGLE_CLIENT_SECRET=b\n"))


class SignInCandidateTest(unittest.TestCase):
    ALL = list(release.APP_SETTINGS)

    def test_a_candidate_without_the_settings_is_not_asked_and_not_failed(self):
        calls = []
        self.assertEqual(release.sign_in_failures(["DATABASE_URL"], lambda: calls.append(1) or "{}"), [])
        self.assertEqual(release.sign_in_failures(self.ALL[:4], lambda: calls.append(1) or "{}"), [])
        self.assertEqual(calls, [])

    def test_configured_and_answering_passes(self):
        self.assertEqual(release.sign_in_failures(self.ALL, lambda: '{"enabled": true, "user": null}'), [])

    def test_configured_but_disabled_or_broken_is_a_failed_candidate(self):
        def broken():
            raise release.ReleaseError("status 500")

        for read in (lambda: '{"enabled": false}', lambda: "not json", lambda: "[]", broken):
            self.assertEqual(release.sign_in_failures(self.ALL, read), ["sign-in is configured but not answering"])

    def test_keys_are_listed_by_name_only_without_sudo(self):
        script = release.site_env_keys_script(TARGET)
        self.assertIn("/opt/openaiwill/site.env", script)
        self.assertNotIn("sudo", script)
        self.assertNotRegex(script, r"\bcat\b")

    def test_the_keys_script_prints_names_only(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / "site.env").write_text("A_B=secret1\n# c=d\nGOOGLE_CLIENT_SECRET=secret2\n\nBAD LINE\n")
            out = subprocess.run(["bash", "-c", release.site_env_keys_script({**TARGET, "DEPLOY_ROOT": str(root)})],
                                 capture_output=True, text=True).stdout
        self.assertEqual(out.split(), ["A_B", "GOOGLE_CLIENT_SECRET"])


class AppDatabaseCandidateTest(unittest.TestCase):
    ALL = list(release.APP_SETTINGS)
    MESSAGE = ["sign-in is configured but its database is not answering"]

    def test_without_the_settings_nothing_is_asked(self):
        self.assertEqual(release.app_database_failures(["DATABASE_URL"], "{}"), [])
        self.assertEqual(release.app_database_failures(self.ALL[:4], '{"app": {"enabled": false}}'), [])

    def test_configured_and_ok_passes(self):
        self.assertEqual(release.app_database_failures(self.ALL, '{"ok": true, "app": {"enabled": true, "ok": true}}'), [])

    def test_configured_but_not_ok_or_not_reported_fails(self):
        for body in ('{"app": {"enabled": true, "ok": false}}', '{"app": {"enabled": false}}', '{"ok": true}',
                     "not json", "[]", '{"app": "ok"}'):
            self.assertEqual(release.app_database_failures(self.ALL, body), self.MESSAGE, body)


class WwwRedirectTest(unittest.TestCase):
    def check(self, code, location):
        return release.www_redirect_failures(lambda url: (code, {"Location": location} if location else {}, ""))

    def test_a_redirect_to_the_apex_passes(self):
        self.assertEqual(self.check(308, "https://surviagi.com/"), [])
        self.assertEqual(self.check(308, "https://surviagi.com"), [])
        self.assertEqual(self.check(301, "https://surviagi.com/"), [])

    def test_serving_the_site_or_redirecting_elsewhere_fails(self):
        self.assertEqual(len(self.check(200, None)), 1)
        self.assertEqual(len(self.check(308, "https://evil.example/")), 1)

    def test_a_www_address_that_does_not_answer_is_not_a_failure(self):
        def down(url):
            raise release.ReleaseError("no answer")
        self.assertEqual(release.www_redirect_failures(down), [])

    def test_it_asks_the_www_address(self):
        asked = []
        release.www_redirect_failures(lambda url: asked.append(url) or (308, {"Location": "https://surviagi.com/"}, ""))
        self.assertEqual(asked, ["https://www.surviagi.com/"])


class StaticSignInTest(unittest.TestCase):
    def pages(self, tmp, en, zh):
        for language, text in (("en", en), ("zh-CN", zh)):
            page = Path(tmp) / "server" / "app" / language / "whitepaper.html"
            page.parent.mkdir(parents=True, exist_ok=True)
            if text is not None:
                page.write_text(text)

    def test_both_pages_with_the_menu_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.pages(tmp, "<div data-account-menu></div>", "<div data-account-menu></div>")
            self.assertEqual(release.static_sign_in_failures(Path(tmp)), [])

    def test_an_article_page_built_without_the_menu_fails_too(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.pages(tmp, "<div data-account-menu></div>", "<div data-account-menu></div>")
            article = Path(tmp) / "server" / "app" / "en" / "articles" / "some-article.html"
            article.parent.mkdir(parents=True)
            article.write_text("<div data-account-menu></div>")
            self.assertEqual(release.static_sign_in_failures(Path(tmp)), [])
            article.write_text("<p>x</p>")
            self.assertEqual(release.static_sign_in_failures(Path(tmp)), [release.NO_SIGN_IN_AT_BUILD])

    def test_a_page_without_the_menu_or_missing_fails_with_one_line(self):
        for en, zh in (("<p>x</p>", "<div data-account-menu></div>"), ("<div data-account-menu></div>", "<p>x</p>"), (None, None)):
            with tempfile.TemporaryDirectory() as tmp:
                self.pages(tmp, en, zh)
                failures = release.static_sign_in_failures(Path(tmp))
                self.assertEqual(failures, [release.NO_SIGN_IN_AT_BUILD])
                self.assertIn("pnpm app:setup", failures[0])
                self.assertNotIn("\n", failures[0])


class CommandsTest(unittest.TestCase):
    def test_env_is_a_command_and_a_package_script(self):
        import subprocess
        done = subprocess.run([sys.executable, str(Path(release.__file__)), "--help"], capture_output=True, text=True)
        self.assertIn("env", done.stdout)
        package = json.loads((release.ROOT / "package.json").read_text())["scripts"]
        self.assertEqual(package["site:env"], "python3 scripts/site_release.py env")
        self.assertEqual(package["admins:sync"], "data/runtime/venv/bin/python scripts/app-db.py admins --target server")
        self.assertEqual(package["submissions:pull"], "data/runtime/venv/bin/python scripts/app-db.py pull --target server")



if __name__ == "__main__":
    unittest.main()
