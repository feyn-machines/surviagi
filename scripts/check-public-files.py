"""Check public Git candidates or the exact index; never print matched secrets."""
import argparse
import pathlib
import re
import subprocess
import sys


PRIVATE_PARTS = {
    ".agents", ".claude", ".codex", ".lawrence", ".opencode",
    "skills", ".venv", "venv", "__pycache__", ".cache", "cookies", "browser-state", ".ssh",
}
PRIVATE_ROOTS = {
    "data", "private", "tmp", "logs", "node_modules", ".next",
    "out", "build", "coverage", ".vercel",
    "datasets", "exports", "export", "backups", "captures", "raw", "snapshots",
}
PRIVATE_SUFFIXES = {
    ".pem", ".key", ".p12", ".pfx", ".db", ".sqlite", ".sqlite3",
    ".log", ".pyc", ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar",
    ".csv", ".tsv", ".jsonl", ".ndjson", ".parquet", ".arrow", ".feather", ".dump", ".kdbx",
}
REFERENCE_METADATA = {
    ".gitignore", "readme.md", "index.html", "manifest.json",
    "sources.json", "styles/tokens.original.json",
}
SECRET_PATTERNS = [
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    r"\bgh[pousr]_[A-Za-z0-9]{30,}",
    r"\bgithub_pat_[A-Za-z0-9_]{30,}",
    r"\bsk-[A-Za-z0-9_-]{24,}",
    r"https?://[^\s/:]+:[^\s/@]+@",
]


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def private_path(path):
    parts = tuple(part.lower() for part in path.parts)
    name = parts[-1]
    if parts[:2] == ("docs", "research"):
        return True  # Research stays local until intentionally rewritten as public documentation.
    if parts[:2] == ("docs", "data") and path.suffix.lower() != ".md":
        return True  # Data attachments remain private, including historical/reference data.
    if parts[:2] == ("design", "reference"):
        tail = "/".join(parts[3:]) if len(parts) > 3 else name
        if tail not in REFERENCE_METADATA:
            return True
    return (
        bool(PRIVATE_PARTS.intersection(parts))
        or parts[0] in PRIVATE_ROOTS
        or bool(re.fullmatch(r"(?:agents|claude)(?:\.[^.]+)?\.md", name))
        or name.startswith((".env", ".mcp", ".claude.json", "credentials"))
        or name in {"mcp.json", "auth.json", "storage-state.json", "storage_state.json", ".ds_store"}
        or name in {".netrc", ".pgpass", ".pypirc"}
        or (name in {"tokens.json", "tokens.local.json"} and parts[:2] != ("design", "system-v1"))
        or name.startswith(("id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "client_secret", "secrets"))
        or any(marker in name for marker in ("credentials", "service-account", "service_account"))
        or name.endswith(".sql.bak")
        or pathlib.PurePosixPath(name).suffix in PRIVATE_SUFFIXES
        or bool(re.search(r"\.(?:db|sqlite3?)-(?:wal|shm|journal)$", name))
        or "cookies" in name
    )


def check(root, staged=False):
    index = {}
    for record in git(root, "ls-files", "--stage", "-z").split(b"\0"):
        if not record:
            continue
        metadata, name = record.split(b"\t", 1)
        mode, object_id, stage = metadata.decode().split()
        index[name.decode()] = (mode, object_id, stage)
    names = set(index)
    if not staged:
        names.update(filter(None, git(
            root, "ls-files", "--others", "--exclude-standard", "-z"
        ).decode().split("\0")))
    failures = []
    checked = 0
    for name in sorted(names):
        relative = pathlib.PurePosixPath(name)
        path = root / name
        if not staged and not path.exists() and not path.is_symlink():
            continue  # A working-tree deletion has no uploadable content.
        checked += 1
        if private_path(relative):
            failures.append(f"{name}: private path")
            continue
        entry = index.get(name)
        if staged and entry[2] != "0":
            failures.append(f"{name}: unresolved index entry")
            continue
        if (staged and entry[0] not in {"100644", "100755"}) or (
            not staged and (path.is_symlink() or not path.is_file())
        ):
            failures.append(f"{name}: unsupported link or non-file entry")
            continue
        try:
            data = git(root, "cat-file", "blob", entry[1]) if staged else path.read_bytes()
        except (OSError, subprocess.CalledProcessError):
            failures.append(f"{name}: unreadable content")
            continue
        text = data.decode(errors="replace")
        if any(re.search(pattern, text) for pattern in SECRET_PATTERNS):
            failures.append(f"{name}: possible credential")
    return checked, failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--staged", action="store_true",
        help="Check all indexed blobs, including unchanged files, rather than working files.",
    )
    args = parser.parse_args()
    try:
        root = pathlib.Path(git(pathlib.Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())
        count, failures = check(root, staged=args.staged)
    except subprocess.CalledProcessError:
        print("Public-file check requires a readable Git worktree.")
        return 1
    if failures:
        print("\n".join(failures))
        return 1
    scope = "indexed" if args.staged else "working-tree and untracked, non-ignored"
    print(f"Public-file check passed ({count} {scope} files).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
