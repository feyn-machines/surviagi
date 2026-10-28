#!/usr/bin/env python3
"""Prepare or verify private hash-pinned input manifests for editorial runs."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import editorial_inputs


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare", help="pin a matching completed official/panel collection window")
    prepare.add_argument("--official", required=True, help="completed official-X collection JSON under data/collection")
    prepare.add_argument("--panel", required=True, help="completed panel collection JSON under data/collection")
    verify = commands.add_parser("verify", help="rehash source collections for a prepared input manifest")
    verify.add_argument("input_id")
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            manifest, created = editorial_inputs.prepare_inputs(args.official, args.panel)
            output = {"created": created, "input": manifest}
        else:
            output = {"verified": True, "input": editorial_inputs.verify_inputs(args.input_id)}
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except (editorial_inputs.EditorialInputError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
