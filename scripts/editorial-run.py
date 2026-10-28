#!/usr/bin/env python3
"""Operate the private, local-only article workflow run ledger.

Cost values are integer micro-USD (USD × 1,000,000). This command records
workflow state only; it does not call a model, publish an article or approve it.
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import editorial_run


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create", help="create or reuse an idempotent run")
    create.add_argument("--input-ref", required=True, help="completed collection run identifier")
    create.add_argument("--input-sha256", required=True)
    create.add_argument("--topic-key", help="stable topic identifier; omit with --no-topic")
    create.add_argument("--skill-version", required=True)
    create.add_argument("--policy-version", required=True)
    create.add_argument("--model-version", required=True)
    create.add_argument("--budget-microusd", required=True, type=int)
    create.add_argument("--max-attempts", type=int, default=3)
    create.add_argument("--no-topic", action="store_true", help="record a completed no-qualifying-topic outcome")

    start = commands.add_parser("stage-start", help="reserve budget and start the next workflow stage")
    start.add_argument("run_id")
    start.add_argument("stage", choices=editorial_run.STAGES)
    start.add_argument("--input-sha256", required=True)
    start.add_argument("--reserve-microusd", type=int, default=0)
    start.add_argument("--model-id", help="non-sensitive model identifier for model-assisted stages")

    finish = commands.add_parser("stage-finish", help="record a stage result without storing its text")
    finish.add_argument("run_id")
    finish.add_argument("stage", choices=editorial_run.STAGES)
    finish.add_argument("--outcome", choices=("succeeded", "failed", "held"), required=True)
    finish.add_argument("--actual-microusd", type=int, default=0)
    finish.add_argument("--output-sha256")
    finish.add_argument("--error-code")
    finish.add_argument("--article-id", help="required when prepublish succeeds")
    finish.add_argument("--article-version", type=int, help="required when prepublish succeeds")

    for name in ("pause", "resume", "show"):
        command = commands.add_parser(name)
        command.add_argument("run_id")

    args = parser.parse_args(argv)
    try:
        ledger = editorial_run.EditorialRunLedger()
        if args.command == "create":
            if args.no_topic and args.topic_key:
                parser.error("--no-topic cannot be combined with --topic-key")
            if not args.no_topic and not args.topic_key:
                parser.error("--topic-key is required unless --no-topic is set")
            row, created = ledger.create_run(
                input_ref=args.input_ref, input_sha256=args.input_sha256,
                topic_key=args.topic_key or "", skill_version=args.skill_version,
                policy_version=args.policy_version, model_version=args.model_version,
                budget_limit=args.budget_microusd,
                max_attempts=args.max_attempts, no_topic=args.no_topic,
            )
            output = {"created": created, "run": row}
        elif args.command == "stage-start":
            output = ledger.start_stage(args.run_id, args.stage,
                                        input_sha256=args.input_sha256,
                                        reserve_cost=args.reserve_microusd,
                                        model_id=args.model_id)
        elif args.command == "stage-finish":
            output = ledger.finish_stage(args.run_id, args.stage, outcome=args.outcome,
                                         actual_cost=args.actual_microusd,
                                         output_sha256=args.output_sha256,
                                         error_code=args.error_code,
                                         article_id=args.article_id,
                                         article_version=args.article_version)
        elif args.command == "pause":
            output = ledger.pause(args.run_id)
        elif args.command == "resume":
            output = ledger.resume(args.run_id)
        else:
            output = ledger.show(args.run_id)
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except (editorial_run.LedgerError, OSError, sqlite3.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
