#!/usr/bin/env python3
"""Manage the workspace's loopback local infra (PostgreSQL, MLflow, embeddings, Meilisearch) and Python data runtime."""

import argparse
import hashlib
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = ROOT / "data/postgres/password"
PYTHON = ROOT / "data/runtime/venv/bin/python"
SEARCH_ENV = ROOT / "data/meilisearch/env"
# The embedding model llama.cpp serves; the digest is the file's own.
MODEL = ROOT / "infra/data/models/embeddinggemma-2-Q8_0.gguf"
MODEL_URL = "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-Q8_0.gguf"
MODEL_SHA256 = "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135"
COMPOSE = ["docker", "compose", "--project-name", "openaiwill-data-local",
           "--project-directory", str(ROOT / "infra"),
           "--file", str(ROOT / "infra/docker-compose.yml")]


def run(command, **kwargs):
    return subprocess.run(command, cwd=ROOT, check=True, **kwargs)


def private_password():
    run(["git", "check-ignore", "--quiet", str(PASSWORD)])
    if PASSWORD.is_symlink():
        raise RuntimeError("Refusing a password file symlink")
    PASSWORD.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    PASSWORD.parent.chmod(0o700)
    try:
        descriptor = os.open(PASSWORD, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if not PASSWORD.is_file() or not PASSWORD.read_text().strip():
            raise RuntimeError("Existing PostgreSQL password file is invalid") from None
        PASSWORD.chmod(0o600)
    else:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(secrets.token_urlsafe(48) + "\n")


def search_key():
    """The Meilisearch master key, generated once into an ignored file only Compose and the pipeline read."""
    run(["git", "check-ignore", "--quiet", str(SEARCH_ENV)])
    if SEARCH_ENV.is_symlink():
        raise RuntimeError("Refusing a search key file symlink")
    SEARCH_ENV.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        descriptor = os.open(SEARCH_ENV, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if not SEARCH_ENV.read_text().startswith("MEILI_MASTER_KEY="):
            raise RuntimeError("Existing search key file is invalid") from None
        SEARCH_ENV.chmod(0o600)
    else:
        with os.fdopen(descriptor, "w") as handle:
            handle.write("MEILI_MASTER_KEY=" + secrets.token_urlsafe(48) + "\n")


def model_digest():
    digest = hashlib.sha256()
    with MODEL.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def models():
    """Download the embedding model if it is not there, and check it is the file we expect."""
    run(["git", "check-ignore", "--quiet", str(MODEL)])
    if not MODEL.exists():
        MODEL.parent.mkdir(parents=True, exist_ok=True)
        run(["curl", "--location", "--fail", "--retry", "3", "--continue-at", "-",
             "--output", str(MODEL) + ".part", MODEL_URL])
        (MODEL.parent / (MODEL.name + ".part")).rename(MODEL)
    if model_digest() != MODEL_SHA256:
        raise RuntimeError(f"{MODEL.name} is not the expected file; remove it and run again")
    print(f"{MODEL.name} is in place")


def up():
    private_password()
    search_key()
    if not MODEL.exists():
        raise RuntimeError("The embedding model is missing; run `pnpm data:models` first")
    running = run(COMPOSE + ["ps", "--status", "running", "--quiet", "postgres"],
                  capture_output=True, text=True).stdout.strip()
    if not running:
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", 7543))
            except OSError:
                raise RuntimeError("127.0.0.1:7543 is occupied; no containers were changed") from None
    run(COMPOSE + ["up", "--detach", "--wait", "--wait-timeout", "180"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "up", "status", "down", "psql", "models"))
    parser.add_argument("psql_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.psql_args and args.command != "psql":
        parser.error("Additional arguments are accepted only for psql")
    if args.command == "setup":
        private_password()
        models()
        if not PYTHON.exists():
            venv.create(PYTHON.parents[1], with_pip=True)
        run([str(PYTHON), "-m", "pip", "install", "--disable-pip-version-check",
             "-r", str(ROOT / "requirements-data.txt")])
        up()
        run([str(PYTHON), "-c", "import sys; sys.path.insert(0, 'scripts'); "
             "from data_pipeline.db import connect, migrate; "
             "conn=connect(); print('Migrations applied:', migrate(conn)); conn.close()"])
    elif args.command == "up":
        up()
    elif args.command == "models":
        models()
    elif args.command == "status":
        run(COMPOSE + ["ps"])
    elif args.command == "down":
        run(COMPOSE + ["down"])
        print("Local services stopped; their data under infra/data was retained.")
    else:
        extra = args.psql_args
        if extra[:1] == ["--"]:
            extra = extra[1:]
        terminal = [] if sys.stdin.isatty() and sys.stdout.isatty() else ["-T"]
        run(COMPOSE + ["exec"] + terminal + ["postgres", "psql", "-U", "openaiwill",
                                            "-d", "openaiwill_local"] + extra)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print(f"Local data runtime: {error}", file=sys.stderr)
        sys.exit(1)
