#!/usr/bin/env python3
"""Ask Tencent Yuanbao Search (腾讯云 元宝搜索, wsa SearchPro) what it finds, from the command line.

Yuanbao Search is the web search behind Tencent's Yuanbao assistant and is sold to developers as an
API. We use it to see whether surviagi.com is found for the questions we want to answer, and what
ranks instead: a Chinese-side view next to Google Search Console. It never touches the site.

Setup: activate the service at https://console.cloud.tencent.com/wsapi/index and put one kind of
credential in the ignored .env or .env.local. Either a service API key from the Yuanbao Search console
(sent as a Bearer token to api.wsa.cloud.tencent.com):
  TENCENT_WSA_API_KEY=sk-...        (TENCENTCLOUD_WSA_APIKEY, the name in Tencent's samples, also works)
or a Tencent Cloud API key pair (TC3-signed calls to wsa.tencentcloudapi.com), preferably of a
sub-user that may only call wsa:
  TENCENTCLOUD_SECRET_ID=...
  TENCENTCLOUD_SECRET_KEY=...
The service API key wins when both are set. Environment variables of the same names take precedence
over the files. Every query is one billed call.

Examples:
  python3 scripts/yuanbao-search.py search "AI 会计 能做什么"
  python3 scripts/yuanbao-search.py search "SurviAGI" --site surviagi.com
  python3 scripts/yuanbao-search.py rank "AI 取代 程序员" "AI 律师 进展" --save
  python3 scripts/yuanbao-search.py rank --file data/seo/yuanbao/queries.txt --save
"""

import argparse
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app_db import ROOT, read_env_value  # noqa: E402

HOST = "wsa.tencentcloudapi.com"
API_KEY_URL = "https://api.wsa.cloud.tencent.com/SearchPro"
API_KEY_NAMES = ("TENCENTCLOUD_WSA_APIKEY", "TENCENT_WSA_API_KEY")
SERVICE = "wsa"
ACTION = "SearchPro"
VERSION = "2025-05-08"
CONTENT_TYPE = "application/json"
DOMAIN = "surviagi.com"
REPORT_DIR = ROOT / "data" / "seo" / "yuanbao"
FRESHNESS_HELP = "d7, m1, y1, 2026-10-01, or 2026-10-01,2026-10-26"


class YuanbaoError(Exception):
    """A safe-to-display error: never carries a secret."""


def env_value(key):
    return os.environ.get(key) or read_env_value(key)


def credentials():
    """A service API key (a str) if one is set, else the (secret_id, secret_key) pair;
    each from the environment, else from .env / .env.local."""
    for key in API_KEY_NAMES:
        value = env_value(key)
        if value:
            return value
    pair = []
    for key in ("TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY"):
        value = env_value(key)
        if not value:
            raise YuanbaoError(f"neither TENCENT_WSA_API_KEY nor {key} is set; "
                               "put one in .env or .env.local (see the header of this script)")
        pair.append(value)
    return tuple(pair)


def _hmac(key, message):
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def sign(secret_id, secret_key, payload, timestamp):
    """Headers for one TC3-HMAC-SHA256 signed POST of `payload` (the exact body bytes as text).
    Signs content-type and host only, as Tencent's own SDK does."""
    day = datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d")
    signed_headers = "content-type;host"
    canonical = "\n".join([
        "POST", "/", "",
        f"content-type:{CONTENT_TYPE}\nhost:{HOST}\n",
        signed_headers,
        hashlib.sha256(payload.encode("utf-8")).hexdigest(),
    ])
    scope = f"{day}/{SERVICE}/tc3_request"
    to_sign = "\n".join([
        "TC3-HMAC-SHA256", str(timestamp), scope, hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    ])
    key = _hmac(_hmac(_hmac(("TC3" + secret_key).encode("utf-8"), day), SERVICE), "tc3_request")
    signature = hmac.new(key, to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    return {
        "Authorization": (f"TC3-HMAC-SHA256 Credential={secret_id}/{scope}, "
                          f"SignedHeaders={signed_headers}, Signature={signature}"),
        "Content-Type": CONTENT_TYPE,
        "Host": HOST,
        "X-TC-Action": ACTION,
        "X-TC-Timestamp": str(timestamp),
        "X-TC-Version": VERSION,
    }


def request_body(query, site=None, freshness=None, cnt=None, mode=None):
    body = {"Query": query}
    if site:
        body["Site"] = site
    if freshness:
        body["Freshness"] = freshness
    if cnt is not None:
        body["Cnt"] = cnt
    if mode is not None:
        body["Mode"] = mode
    return body


def endpoint(creds, payload, timestamp):
    """(url, headers) for one POST: Bearer to the API-key endpoint for a str, TC3 signed otherwise."""
    if isinstance(creds, str):
        return API_KEY_URL, {"Authorization": f"Bearer {creds}", "Content-Type": CONTENT_TYPE}
    return f"https://{HOST}/", sign(*creds, payload, timestamp)


def call(body, creds, timeout=30):
    """POST one SearchPro request and return its `Response` object."""
    payload = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    url, headers = endpoint(creds, payload, int(time.time()))
    request = urllib.request.Request(url, data=payload.encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            answer = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise YuanbaoError(f"Yuanbao Search answered HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError) as error:
        raise YuanbaoError(f"Yuanbao Search could not be reached: {getattr(error, 'reason', error)}") from None
    return response_of(answer)


def response_of(answer):
    reply = answer.get("Response") if isinstance(answer, dict) else None
    if not isinstance(reply, dict):
        raise YuanbaoError("Yuanbao Search returned an unexpected answer")
    error = reply.get("Error")
    if error:
        raise YuanbaoError(
            f"{error.get('Code', 'Error')}: {error.get('Message', '')} (RequestId {reply.get('RequestId', '?')})")
    return reply


def pages(reply):
    """The result pages in the order returned; each `Pages` entry is itself a JSON string."""
    found = []
    for entry in reply.get("Pages") or []:
        try:
            page = json.loads(entry) if isinstance(entry, str) else entry
        except json.JSONDecodeError:
            continue
        if isinstance(page, dict) and page.get("url"):
            found.append(page)
    return found


def host_of(url):
    return (urllib.parse.urlsplit(url).hostname or "").lower()


def on_domain(url, domain=DOMAIN):
    host = host_of(url)
    return host == domain or host.endswith("." + domain)


def rank(query, found, domain=DOMAIN):
    """Where `domain` appears among the results of one query."""
    hits = [index + 1 for index, page in enumerate(found) if on_domain(page["url"], domain)]
    return {
        "query": query,
        "results": len(found),
        "rank": hits[0] if hits else None,
        "our_urls": [found[index - 1]["url"] for index in hits],
        "top": [{"rank": index + 1, "site": page.get("site") or host_of(page["url"]), "title": page.get("title", ""),
                 "url": page["url"]} for index, page in enumerate(found[:5])],
    }


def read_queries(arguments):
    queries = list(arguments.queries)
    if arguments.file:
        text = Path(arguments.file).read_text(encoding="utf-8")
        queries += [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if not queries:
        raise YuanbaoError("Give at least one query, or --file with one query per line")
    return queries


def save_report(report, directory=None):
    directory = REPORT_DIR if directory is None else directory
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def command_search(arguments, creds):
    reply = call(request_body(arguments.query, arguments.site, arguments.freshness, arguments.cnt, arguments.mode), creds)
    found = pages(reply)
    if arguments.json:
        print(json.dumps({"version": reply.get("Version"), "request_id": reply.get("RequestId"), "pages": found},
                         ensure_ascii=False, indent=2))
        return
    print(f"{len(found)} results ({reply.get('Version', '?')} tier, RequestId {reply.get('RequestId', '?')})")
    for index, page in enumerate(found, 1):
        mark = "*" if on_domain(page["url"], arguments.domain) else " "
        print(f"{mark}{index:>3}. {page.get('title', '')}\n      {page['url']}  {page.get('date', '')}")


def command_rank(arguments, creds):
    queries = read_queries(arguments)
    rows = []
    for query in queries:
        found = pages(call(request_body(query, freshness=arguments.freshness, cnt=arguments.cnt, mode=arguments.mode), creds))
        rows.append(rank(query, found, arguments.domain))
    report = {"checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "domain": arguments.domain,
              "calls": len(queries), "queries": rows}
    if arguments.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for row in rows:
            where = f"#{row['rank']}" if row["rank"] else "-"
            leaders = ", ".join(entry["site"] for entry in row["top"][:3])
            print(f"{where:>4}  {row['query']}  (of {row['results']}; top: {leaders})")
    found = sum(1 for row in rows if row["rank"])
    print(f"{arguments.domain} found for {found} of {len(rows)} queries; {len(rows)} billed calls", file=sys.stderr)
    if arguments.save:
        print(f"saved {save_report(report)}", file=sys.stderr)


def parser():
    top = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = top.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--domain", default=DOMAIN, help="the site to look for (default %(default)s)")
    common.add_argument("--freshness", help=f"time range: {FRESHNESS_HELP}")
    common.add_argument("--cnt", type=int, choices=[10, 20, 30, 40, 50], help="results per query (not on the lite tier)")
    common.add_argument("--mode", type=int, choices=[0, 1, 2],
                        help="0 web, 1 authoritative vertical sources, 2 mixed (not on the lite tier)")
    common.add_argument("--json", action="store_true", help="print JSON")
    search = sub.add_parser("search", parents=[common], help="show the results for one query")
    search.add_argument("query")
    search.add_argument("--site", help="only this domain, or exclude:a.com|b.com")
    check = sub.add_parser("rank", parents=[common], help="where the domain ranks for each query")
    check.add_argument("queries", nargs="*")
    check.add_argument("--file", help="a text file with one query per line (# starts a comment)")
    check.add_argument("--save", action="store_true", help="also write the report under data/seo/yuanbao/")
    return top


def main(argv=None):
    arguments = parser().parse_args(argv)
    try:
        creds = credentials()
        {"search": command_search, "rank": command_rank}[arguments.command](arguments, creds)
    except YuanbaoError as error:
        print(f"yuanbao: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
