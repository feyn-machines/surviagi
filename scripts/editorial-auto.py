#!/usr/bin/env python3
"""Produce one article automatically from a verified collection window, resumably.

`run` takes a prepared input (or `--latest`, which prepares the newest complete
official/panel window) through selection, evidence, bilingual drafts and
preflight. It writes a public preview only with --confirm-public-preview, then
checks the Agent read-back and the review queue. Repeating the same command
resumes the same run; it never approves an article or creates a schedule.
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import editorial_auto  # noqa: E402
import editorial_inputs  # noqa: E402
import editorial_run  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="start or resume the run for one collection window")
    source = run.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", help="prepared editorial-input id")
    source.add_argument("--latest", action="store_true", help="prepare and use the newest complete window")
    run.add_argument("--target", choices=("local", "server"), default="local",
                     help="editorial store that receives the preview (server is the public site)")
    run.add_argument("--confirm-public-preview", action="store_true",
                     help="allow writing a reader-visible preview; without it the run stops after preflight")
    run.add_argument("--site-url", help="site to read back through the Agent API (default follows --target)")
    run.add_argument("--model", default=editorial_auto.DEFAULT_MODEL)
    run.add_argument("--budget-usd", type=float, default=editorial_auto.DEFAULT_BUDGET / 1_000_000)
    run.add_argument("--max-attempts", type=int, default=2)
    for name in ("show", "pause", "resume", "reopen"):
        commands.add_parser(name).add_argument("run_id")
    args = parser.parse_args(argv)
    try:
        ledger = editorial_run.EditorialRunLedger()
        if args.command == "show":
            output = ledger.show(args.run_id)
        elif args.command == "pause":
            output = ledger.pause(args.run_id)
        elif args.command == "resume":
            output = ledger.resume(args.run_id)
        elif args.command == "reopen":
            output = ledger.reopen(args.run_id)
        else:
            input_id = args.input
            if args.latest:
                pair = editorial_auto.latest_input_pair()
                if not pair:
                    raise editorial_auto.AutoError("no window has both an official and a panel collection record")
                input_id = editorial_inputs.prepare_inputs(*pair)[0]["input_id"]
            connect = editorial_auto.server_connect if args.target == "server" else editorial_auto.local_connect
            services = editorial_auto.Services(runner=editorial_auto.ClaudeRunner(args.model),
                                               store=editorial_auto.PgStore(connect))
            output = editorial_auto.AutoRun(
                ledger=ledger, services=services, model=args.model, target=args.target,
                site_url=args.site_url, confirm_publish=args.confirm_public_preview,
                budget=round(args.budget_usd * 1_000_000), max_attempts=args.max_attempts,
            ).run(input_id)
        print(json.dumps(output, ensure_ascii=False, indent=2, default=str))
        return 0
    except (editorial_auto.AutoError, editorial_run.LedgerError, editorial_inputs.EditorialInputError,
            OSError, sqlite3.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
