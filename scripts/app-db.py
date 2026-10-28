#!/usr/bin/env python3
"""Command line for schema app.

    setup-local                 create role oaw_app and schema app in the local database
    pull [--target ...]         write the approved, not yet imported submissions to data/submissions/ (default local)
    admins [--target ...]       make the administrator list equal to ADMIN_EMAILS in the local .env (default server)
    votes [--target ...]        write readers' votes on topics, as counts, to data/votes/ (default local)
    feedback retrieve ...       retrieve up to three private curated style examples (local only)
    feedback apply ...          record an example's use on an exact draft version (local only)
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import app_db


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("setup-local", help="create role oaw_app and schema app in the local database")
    pull = commands.add_parser("pull", help="write the approved submissions to data/submissions/ and mark them imported")
    pull.add_argument("--target", choices=("server", "local"), default="local")
    votes = commands.add_parser("votes", help="write readers' votes on topics, as counts, to data/votes/")
    votes.add_argument("--target", choices=("server", "local"), default="local")
    admins = commands.add_parser("admins", help="make app.admins equal to ADMIN_EMAILS in the local .env")
    admins.add_argument("--target", choices=("server", "local"), default="server")
    feedback = commands.add_parser("feedback", help="retrieve private examples or record their application locally")
    feedback_commands = feedback.add_subparsers(dest="feedback_command", required=True)
    retrieve = feedback_commands.add_parser("retrieve", help="retrieve up to three examples for a language and context")
    retrieve.add_argument("--language", choices=("en", "zh-CN"), required=True)
    retrieve.add_argument("--issue-type")
    retrieve.add_argument("--article-genre")
    retrieve.add_argument("--article-id")
    apply = feedback_commands.add_parser("apply", help="record use on a draft version by content hash")
    apply.add_argument("--sample-id", type=int, required=True)
    apply.add_argument("--article-id", required=True)
    apply.add_argument("--version", type=int, required=True)
    apply.add_argument("--language", choices=("en", "zh-CN"), required=True)
    apply.add_argument("--sha256", required=True)
    apply.add_argument("--note", required=True)
    apply.add_argument("--actor", default="local-editorial-skill")
    args = parser.parse_args(argv)
    try:
        if args.command == "setup-local":
            app_db.setup_local()
        elif args.command == "pull":
            app_db.pull(args.target)
        elif args.command == "votes":
            app_db.pull_votes(args.target)
        elif args.command == "admins":
            app_db.sync_admins_to(args.target)
        elif args.command == "feedback":
            with app_db.connect_app() as conn:
                if args.feedback_command == "retrieve":
                    rows = app_db.retrieve_feedback_samples(
                        conn, args.language, args.issue_type, args.article_genre, args.article_id)
                    print(json.dumps({"samples": rows}, ensure_ascii=False, default=str, indent=2))
                else:
                    application_id, created = app_db.apply_feedback_sample(
                        conn, args.sample_id, args.article_id, args.version, args.language,
                        args.sha256, args.note, args.actor)
                    print(json.dumps({"applicationId": application_id, "created": created}))
    except (app_db.AppError, RuntimeError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        print(f"error: a command on the server failed with status {error.returncode}", file=sys.stderr)
        return 1
    except Exception as error:  # psycopg errors never carry the password; keep one line
        first = str(error).splitlines()[0] if str(error) else ""
        print(f"error: {first if type(error).__name__ == 'ReleaseError' else f'{type(error).__name__}: {first}'}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
