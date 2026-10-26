#!/usr/bin/env python3
"""SurviAGI from the command line, for a Skill without MCP. Standard library only.

Reading needs nothing. Submitting reads the key from the environment variable SURVIAGI_API_KEY and
never prints it. Every answer is printed as JSON; an error answer exits with status 1.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = os.environ.get("SURVIAGI_BASE_URL", "https://surviagi.com").rstrip("/")


def call(method: str, path: str, query: dict | None = None, body: dict | None = None, key: bool = False) -> int:
    url = f"{BASE}{path}"
    if query:
        url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
    headers = {"Accept": "application/json", "User-Agent": "surviagi-skill/1.0"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps({k: v for k, v in body.items() if v is not None}).encode()
    if key:
        secret = os.environ.get("SURVIAGI_API_KEY", "").strip()
        if not secret:
            print(json.dumps({"error": "missing_key", "message": "Set SURVIAGI_API_KEY to a key made at https://surviagi.com/agents#keys"}))
            return 1
        headers["Authorization"] = f"Bearer {secret}"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            print(response.read().decode())
            return 0
    except urllib.error.HTTPError as error:
        print(error.read().decode() or json.dumps({"error": f"http_{error.code}"}))
        return 1
    except urllib.error.URLError as error:
        print(json.dumps({"error": "network", "message": str(error.reason)}))
        return 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    search = commands.add_parser("search")
    search.add_argument("query")
    search.add_argument("--limit", type=int)
    search.add_argument("--types")
    search.add_argument("--from", dest="date_from")
    search.add_argument("--to", dest="date_to")
    search.add_argument("--language", choices=("en", "zh-CN"))
    record = commands.add_parser("record")
    record.add_argument("id")
    record.add_argument("--language", choices=("en", "zh-CN"))
    question = commands.add_parser("question")
    question.add_argument("--question", required=True)
    question.add_argument("--why", required=True)
    question.add_argument("--gap", required=True)
    question.add_argument("--leads")
    question.add_argument("--related")
    question.add_argument("--language", choices=("en", "zh-CN"))
    question.add_argument("--request-id")
    account = commands.add_parser("account")
    account.add_argument("account")
    account.add_argument("--kind", choices=("person", "organization"), required=True)
    account.add_argument("--reason", required=True)
    account.add_argument("--field")
    account.add_argument("--request-id")
    commands.add_parser("mine")
    args = parser.parse_args(argv)

    if args.command == "search":
        return call("GET", "/api/agent/search", {"query": args.query, "limit": args.limit, "types": args.types,
                                                  "from": args.date_from, "to": args.date_to, "language": args.language})
    if args.command == "record":
        return call("GET", "/api/agent/record", {"id": args.id, "language": args.language})
    if args.command in ("question", "account") and not args.request_id:
        args.request_id = str(uuid.uuid4())
        print(f"request_id: {args.request_id} (pass --request-id {args.request_id} to retry safely)", file=sys.stderr)
    if args.command == "question":
        related = [item.strip() for item in args.related.split(",") if item.strip()] if args.related else None
        return call("POST", "/api/agent/questions", body={
            "question": args.question, "why_it_matters": args.why, "evidence_gap": args.gap, "leads": args.leads,
            "related_record_ids": related, "language": args.language, "request_id": args.request_id,
        }, key=True)
    if args.command == "account":
        return call("POST", "/api/agent/accounts", body={
            "account": args.account, "kind": args.kind, "reason": args.reason, "field": args.field,
            "request_id": args.request_id,
        }, key=True)
    return call("GET", "/api/agent/submissions", key=True)


if __name__ == "__main__":
    sys.exit(main())
