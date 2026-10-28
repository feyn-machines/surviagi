"""Prepare and verify private, hash-pinned inputs from completed X collections."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUTS_VERSION = "editorial-inputs-1"
SAFE_INPUT_ID = re.compile(r"^editorial-input-[0-9a-f]{24}$")
MAX_SOURCE_BYTES = 100 * 1024 * 1024


class EditorialInputError(Exception):
    """A source collection is unsafe, incomplete or inconsistent."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical(data: dict) -> bytes:
    return json.dumps(data, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def _safe_path(value: str | Path, root: Path, role: str) -> tuple[Path, str]:
    root = root.resolve()
    collection_dir = root / "data" / "collection"
    if not isinstance(value, (str, Path)):
        raise EditorialInputError("collection input path must be a string")
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = root / candidate
    lexical = Path(os.path.abspath(candidate))
    try:
        lexical_rel = lexical.relative_to(collection_dir)
    except ValueError as exc:
        raise EditorialInputError("inputs must be files under data/collection") from exc
    current = collection_dir
    if (root / "data").is_symlink() or current.is_symlink():
        raise EditorialInputError("collection input paths must not use symbolic links")
    for part in lexical_rel.parts:
        current = current / part
        if current.is_symlink():
            raise EditorialInputError("collection input paths must not use symbolic links")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise EditorialInputError("collection input does not exist") from exc
    try:
        rel = resolved.relative_to(collection_dir.resolve(strict=True))
    except (ValueError, OSError) as exc:
        raise EditorialInputError("inputs must be files under data/collection") from exc
    if not resolved.is_file():
        raise EditorialInputError("collection input must be a regular file")
    # The role-specific directories are part of the collection-store contract;
    # do not let the caller label a panel run as an official-account run.
    expected_dir = "official-x" if role == "official" else "panel"
    if len(rel.parts) < 2 or rel.parts[0] != expected_dir:
        raise EditorialInputError("collection input does not match its official/panel role")
    mode = stat.S_IMODE(resolved.stat().st_mode)
    if mode & 0o077:
        raise EditorialInputError("collection input must be private (mode 0600 or stricter)")
    if resolved.stat().st_size > MAX_SOURCE_BYTES:
        raise EditorialInputError("collection input exceeds the 100 MiB limit")
    return resolved, (Path("data") / "collection" / rel).as_posix()


def _parse_time(value: object, name: str) -> datetime:
    if not isinstance(value, str):
        raise EditorialInputError(f"collection {name} timestamp is missing")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise EditorialInputError(f"collection {name} timestamp is invalid") from exc
    if result.utcoffset() is None:
        raise EditorialInputError(f"collection {name} timestamp must include a timezone")
    return result


def _read_collection(path: Path, relative: str, role: str) -> dict:
    raw = path.read_bytes()
    try:
        record = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise EditorialInputError(f"{role} collection is not valid UTF-8 JSON") from exc
    if not isinstance(record, dict):
        raise EditorialInputError(f"{role} collection root must be an object")
    expected_versions = {"official-x-collection-1", "crawler-run-1"} if role == "official" else {"crawler-run-1"}
    if record.get("version") not in expected_versions or record.get("source") != "x":
        raise EditorialInputError(f"{role} input is not a supported X collection record")
    if record.get("synthetic") is not False:
        raise EditorialInputError(f"{role} collection must be real, not synthetic")
    if record.get("ok") is not True or record.get("status") != "queries_exhausted":
        raise EditorialInputError(f"{role} collection is not complete")
    finished = _parse_time(record.get("finished_at"), "finished_at")
    started = _parse_time(record.get("started_at"), "started_at")
    if finished < started:
        raise EditorialInputError(f"{role} collection finished before it started")
    window = record.get("publication_window")
    if not isinstance(window, dict):
        raise EditorialInputError(f"{role} collection has no publication window")
    window_start = _parse_time(window.get("start"), "window start")
    window_end = _parse_time(window.get("end"), "window end")
    if window_end <= window_start:
        raise EditorialInputError(f"{role} collection publication window is invalid")
    jobs = record.get("jobs", record.get("queries"))
    if not isinstance(jobs, list) or not jobs:
        raise EditorialInputError(f"{role} collection has no completed jobs")
    if any(not isinstance(job, dict) or job.get("status") != "search_ended" for job in jobs):
        raise EditorialInputError(f"{role} collection contains an unfinished job")
    if role == "official" and record.get("version") == "official-x-collection-1":
        posts = record.get("posts")
        if not isinstance(posts, list):
            raise EditorialInputError("official collection posts are malformed")
        post_count = len(posts)
    else:
        if any(not isinstance(job.get("posts"), list) for job in jobs):
            raise EditorialInputError(f"{role} collection posts are malformed")
        post_count = sum(len(job["posts"]) for job in jobs)
    if (not isinstance(record.get("total"), int) or isinstance(record.get("total"), bool)
            or record["total"] != post_count):
        raise EditorialInputError(f"{role} collection post count is inconsistent")
    return {
        "role": role,
        "path": relative,
        "sha256": _sha256(raw),
        "version": record["version"],
        "finished_at": finished.isoformat(),
        "window": {
            "start": window_start.isoformat(),
            "end": window_end.isoformat(),
        },
        "coverage_status": record.get("coverage_status"),
        "coverage_note": record.get("coverage_note"),
        "post_count": post_count,
        "job_count": len(jobs),
    }


def _payload(sources: list[dict]) -> dict:
    return {"version": INPUTS_VERSION, "sources": sources}


def _manifest_bytes(manifest: dict) -> bytes:
    return (json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                       indent=2) + "\n").encode("utf-8")


def _manifest_root(root: Path) -> Path:
    root = root.resolve()
    data_dir = root / "data"
    editorial_dir = data_dir / "editorial"
    inputs_dir = editorial_dir / "inputs"
    for directory in (data_dir, editorial_dir, inputs_dir):
        if directory.exists() and directory.is_symlink():
            raise EditorialInputError("editorial input manifest path must not use symbolic links")
    inputs_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(editorial_dir, 0o700)
    os.chmod(inputs_dir, 0o700)
    return inputs_dir


def prepare_inputs(official_path: str | Path, panel_path: str | Path,
                   *, root: Path = ROOT) -> tuple[dict, bool]:
    root = Path(root).resolve()
    official, official_rel = _safe_path(official_path, root, "official")
    panel, panel_rel = _safe_path(panel_path, root, "panel")
    sources = [
        _read_collection(official, official_rel, "official"),
        _read_collection(panel, panel_rel, "panel"),
    ]
    if sources[0]["window"] != sources[1]["window"]:
        raise EditorialInputError("official and panel collections must cover the same window")
    payload = _payload(sources)
    digest = _sha256(_canonical(payload))
    manifest = {
        **payload,
        "input_id": f"editorial-input-{digest[:24]}",
        "input_sha256": digest,
        "window": sources[0]["window"],
    }
    directory = _manifest_root(root)
    target = directory / f"{manifest['input_id']}.json"
    encoded = _manifest_bytes(manifest)
    if target.exists():
        if target.is_symlink() or not target.is_file() or target.read_bytes() != encoded:
            raise EditorialInputError("existing input manifest does not match its content identity")
        if stat.S_IMODE(target.stat().st_mode) != 0o600:
            raise EditorialInputError("existing input manifest must have mode 0600")
        return manifest, False
    fd, temp_name = tempfile.mkstemp(prefix=".editorial-input-", dir=directory)
    temp_path = Path(temp_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temp_path, target)
            created = True
        except FileExistsError:
            if target.is_symlink() or not target.is_file() or target.read_bytes() != encoded:
                raise EditorialInputError("racing input manifest has conflicting content")
            created = False
    finally:
        temp_path.unlink(missing_ok=True)
    return manifest, created


def verify_inputs(input_id: str, *, root: Path = ROOT) -> dict:
    if not isinstance(input_id, str) or not SAFE_INPUT_ID.fullmatch(input_id):
        raise EditorialInputError("input id is invalid")
    root = Path(root).resolve()
    directory = root / "data" / "editorial" / "inputs"
    if directory.is_symlink():
        raise EditorialInputError("editorial input manifest path must not use symbolic links")
    path = directory / f"{input_id}.json"
    if path.is_symlink() or not path.is_file():
        raise EditorialInputError("input manifest is missing or unsafe")
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise EditorialInputError("input manifest must have mode 0600")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise EditorialInputError("input manifest is unreadable") from exc
    if not isinstance(manifest, dict) or manifest.get("version") != INPUTS_VERSION:
        raise EditorialInputError("input manifest version is unsupported")
    sources = manifest.get("sources")
    if (not isinstance(sources, list) or len(sources) != 2
            or any(not isinstance(x, dict) for x in sources)
            or [x.get("role") for x in sources] != ["official", "panel"]):
        raise EditorialInputError("input manifest sources are malformed")
    if any(not isinstance(x.get("path"), str) for x in sources):
        raise EditorialInputError("input manifest source paths are malformed")
    rebuilt = []
    for source in sources:
        source_path, relative = _safe_path(source.get("path", ""), root, source["role"])
        if relative != source["path"]:
            raise EditorialInputError("input source path is not canonical")
        rebuilt.append(_read_collection(source_path, relative, source["role"]))
    payload = _payload(rebuilt)
    digest = _sha256(_canonical(payload))
    if manifest.get("input_sha256") != digest or manifest.get("input_id") != f"editorial-input-{digest[:24]}":
        raise EditorialInputError("collection input changed after the manifest was prepared")
    if manifest.get("sources") != rebuilt:
        raise EditorialInputError("input manifest source metadata was changed")
    if manifest.get("window") != rebuilt[0]["window"] or rebuilt[0]["window"] != rebuilt[1]["window"]:
        raise EditorialInputError("input manifest window or sources do not match")
    return manifest
