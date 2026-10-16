#!/usr/bin/env python3
"""Bring back the posts renamed accounts lost to the crawler's quarantine, without asking X again.

    pnpm data:recover:renamed                 every official and panel run under data/collection
    pnpm data:recover:renamed --dry-run       say what would come back; write nothing

Until 2026-10-16 the crawler quarantined a post whose author id matched the account but whose
handle had changed. This reads the kept run files, takes back each such post that falls inside its
job's window, and writes one run document, data/collection/official-x/renamed-recovery-<time>.json,
which it then ingests like any crawler run (`--no-ingest` keeps it on disk). Account ids come from
source_accounts. Nothing is sent to X; nothing already ingested is changed.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_pipeline import collection_store  # noqa: E402
from data_pipeline.db import connect  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RUNS = [ROOT / "data/collection/official-x", ROOT / "data/collection/panel"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-ingest", action="store_true")
    args = parser.parse_args(argv)
    runs = []
    for directory in RUNS:
        for path in sorted(directory.glob("*.json")):
            if path.name.startswith("renamed-recovery-"):
                continue
            try:
                runs.append((path.stem, json.loads(path.read_text())))
            except ValueError:
                print(f"skipped {path}: not JSON", file=sys.stderr)
    with connect() as conn:
        ids = {row["handle"].lower(): row["platform_account_id"] for row in conn.execute(
            "SELECT handle, platform_account_id FROM public.source_accounts WHERE platform_account_id IS NOT NULL")}
        now = datetime.now(timezone.utc)
        doc = collection_store.recover_renamed(runs, ids, now.isoformat())
        if doc is None:
            print("nothing to recover")
            return 0
        for change in doc["handle_changes"]:
            posts = sum(len(j["posts"]) for j in doc["jobs"] if j["handle"] == change["from"])
            print(f"@{change['from']} answered as @{change['to']} (first in {change['first_seen_in']}): {posts} posts")
        if args.dry_run:
            return 0
        output = RUNS[0] / f"renamed-recovery-{now:%Y%m%dT%H%M%SZ}.json"
        output.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
        print(f"wrote {output} ({doc['total']} posts in {len(doc['jobs'])} jobs)")
        if not args.no_ingest:
            print(json.dumps(collection_store.ingest_run(conn, output), default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
