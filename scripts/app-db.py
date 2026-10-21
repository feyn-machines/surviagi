#!/usr/bin/env python3
"""Command line for schema app.

    setup-local                 create role oaw_app and schema app in the local database
    pull [--target ...]         write the approved, not yet imported submissions to data/submissions/ (default local)
    admins [--target ...]       make the administrator list equal to ADMIN_EMAILS in the local .env (default server)
    votes [--target ...]        write readers' votes on topics, as counts, to data/votes/ (default local)
"""
import argparse
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
