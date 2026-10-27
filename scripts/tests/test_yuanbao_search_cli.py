"""Offline contract tests for the Yuanbao Search CLI; no network, no real keys."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "yuanbao-search.py"
SPEC = importlib.util.spec_from_file_location("yuanbao_search_cli", SCRIPT)
yb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(yb)


def page(url, title="t", site=None):
    return json.dumps({"title": title, "url": url, "site": site or url.split("/")[2], "date": "2026-10-20"})


class YuanbaoSearchCliTest(unittest.TestCase):
    def test_signature_matches_tencent_sdk(self):
        # Reference value produced by tencentcloud-sdk-python-common for the same request and timestamp.
        payload = json.dumps({"Query": "AI 会计 能做什么", "Site": "surviagi.com"}, ensure_ascii=False, separators=(",", ":"))
        headers = yb.sign("AKIDtest", "test-secret-key", payload, 1761500000)
        self.assertEqual(headers["Authorization"],
                         "TC3-HMAC-SHA256 Credential=AKIDtest/2025-10-26/wsa/tc3_request, SignedHeaders=content-type;host, "
                         "Signature=16b3d3473d64dcf7babf520af804e49b2e188866cad7ae08a1b5fd384cc19edf")
        self.assertEqual((headers["X-TC-Action"], headers["X-TC-Version"], headers["X-TC-Timestamp"]),
                         ("SearchPro", "2025-05-08", "1761500000"))
        self.assertNotIn("test-secret-key", json.dumps(headers))

    def test_request_body_sends_only_given_options(self):
        self.assertEqual(yb.request_body("q"), {"Query": "q"})
        self.assertEqual(yb.request_body("q", "surviagi.com", "m1", 20, 0),
                         {"Query": "q", "Site": "surviagi.com", "Freshness": "m1", "Cnt": 20, "Mode": 0})

    def test_pages_decode_json_strings_and_skip_broken_entries(self):
        reply = {"Pages": [page("https://a.com/x"), "{not json", json.dumps({"title": "no url"}), {"url": "https://b.com/"}]}
        self.assertEqual([p["url"] for p in yb.pages(reply)], ["https://a.com/x", "https://b.com/"])
        self.assertEqual(yb.pages({}), [])

    def test_rank_matches_domain_and_subdomains_only(self):
        found = yb.pages({"Pages": [page("https://notsurviagi.com/a"), page("https://zhihu.com/q"),
                                     page("https://www.surviagi.com/zh-CN/markets"), page("https://surviagi.com/")]})
        row = yb.rank("AI 会计", found)
        self.assertEqual(row["rank"], 3)
        self.assertEqual(row["our_urls"], ["https://www.surviagi.com/zh-CN/markets", "https://surviagi.com/"])
        self.assertEqual(row["top"][0]["site"], "notsurviagi.com")
        self.assertIsNone(yb.rank("q", found[:2])["rank"])

    def test_api_errors_carry_code_and_request_id(self):
        with self.assertRaisesRegex(yb.YuanbaoError, r"ResourceNotFound: not activated \(RequestId r-1\)"):
            yb.response_of({"Response": {"Error": {"Code": "ResourceNotFound", "Message": "not activated"},
                                         "RequestId": "r-1"}})
        with self.assertRaises(yb.YuanbaoError):
            yb.response_of({"unexpected": True})

    def test_credentials_prefer_environment_and_name_the_missing_key(self):
        env = {"TENCENTCLOUD_SECRET_ID": "id-from-env", "TENCENTCLOUD_SECRET_KEY": "key-from-env"}
        with patch.dict(os.environ, env, clear=True), patch.object(yb, "read_env_value", return_value=None):
            self.assertEqual(yb.credentials(), ("id-from-env", "key-from-env"))
        with patch.dict(os.environ, {}, clear=True), patch.object(yb, "read_env_value", return_value=None):
            with self.assertRaisesRegex(yb.YuanbaoError, "TENCENT_WSA_API_KEY nor TENCENTCLOUD_SECRET_ID is set"):
                yb.credentials()

    def test_service_api_key_wins_over_the_secret_pair(self):
        files = {"TENCENT_WSA_API_KEY": "sk-from-file", "TENCENTCLOUD_SECRET_ID": "i", "TENCENTCLOUD_SECRET_KEY": "k"}
        with patch.dict(os.environ, {}, clear=True), patch.object(yb, "read_env_value", side_effect=files.get):
            self.assertEqual(yb.credentials(), "sk-from-file")
        with patch.dict(os.environ, {"TENCENTCLOUD_WSA_APIKEY": "sk-from-env"}, clear=True), \
                patch.object(yb, "read_env_value", side_effect=files.get):
            self.assertEqual(yb.credentials(), "sk-from-env")

    def test_api_key_is_sent_as_bearer_to_its_own_endpoint(self):
        url, headers = yb.endpoint("sk-test", '{"Query":"q"}', 1761500000)
        self.assertEqual(url, "https://api.wsa.cloud.tencent.com/SearchPro")
        self.assertEqual(headers, {"Authorization": "Bearer sk-test", "Content-Type": "application/json"})
        url, headers = yb.endpoint(("AKIDtest", "test-secret-key"), '{"Query":"q"}', 1761500000)
        self.assertEqual(url, "https://wsa.tencentcloudapi.com/")
        self.assertTrue(headers["Authorization"].startswith("TC3-HMAC-SHA256 Credential=AKIDtest/"))

    def test_rank_command_reports_and_saves(self):
        replies = {"AI 会计": {"Pages": [page("https://zhihu.com/q"), page("https://surviagi.com/zh-CN/x")]},
                   "AI 律师": {"Pages": [page("https://zhihu.com/q")]}}
        with tempfile.TemporaryDirectory() as folder:
            queries = Path(folder) / "queries.txt"
            queries.write_text("# comment\nAI 律师\n\n", encoding="utf-8")
            out, err = io.StringIO(), io.StringIO()
            with patch.object(yb, "call", side_effect=lambda body, creds: replies[body["Query"]]) as call, \
                    patch.object(yb, "credentials", return_value=("i", "k")), \
                    patch.object(yb, "REPORT_DIR", Path(folder) / "reports"), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = yb.main(["rank", "AI 会计", "--file", str(queries), "--save"])
            self.assertEqual(code, 0)
            self.assertEqual(call.call_count, 2)
            self.assertIn("#2  AI 会计", out.getvalue())
            self.assertIn("   -  AI 律师", out.getvalue())
            self.assertIn("found for 1 of 2 queries; 2 billed calls", err.getvalue())
            [saved] = (Path(folder) / "reports").glob("*.json")
            report = json.loads(saved.read_text(encoding="utf-8"))
            self.assertEqual([row["rank"] for row in report["queries"]], [2, None])

    def test_missing_keys_exit_without_a_call(self):
        err = io.StringIO()
        with patch.object(yb, "credentials", side_effect=yb.YuanbaoError("TENCENTCLOUD_SECRET_ID is not set")), \
                patch.object(yb, "call") as call, contextlib.redirect_stderr(err):
            self.assertEqual(yb.main(["search", "q"]), 1)
        call.assert_not_called()
        self.assertIn("yuanbao: TENCENTCLOUD_SECRET_ID is not set", err.getvalue())


if __name__ == "__main__":
    unittest.main()
