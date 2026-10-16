"""Ingest a standalone crawler run into the independent collection store.

This is the data-flow seam between the crawler (which only produces immutable
run archives on disk) and PostgreSQL. It lands normalized evidence — sources,
captures, and coverage gaps — keyed by collection run, idempotently and without
any market scope, weights, metrics or progress (those belong to a later
calculation batch that selects FROM this store). Credentials are never written;
raw response pages stay on disk and are referenced here by SHA-256.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .pipeline import digest  # psycopg is imported lazily inside ingest_run

RUN_VERSION_PREFIX = "crawler-run"
_GAP_STATUS = {"search_ended": "complete", "incomplete": "partial"}


def _epoch_utc(value):
    return datetime.fromtimestamp(value, timezone.utc)


def _iso(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _hashable(row):
    """A JSON-serializable view of a row for record hashing (datetimes -> ISO)."""
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in row.items()}


def build_rows(run_doc, run_id):
    """Pure: turn a crawler run document into collection-store rows. No I/O."""
    if not isinstance(run_doc, dict) or not str(run_doc.get("version", "")).startswith(RUN_VERSION_PREFIX):
        raise ValueError("Not a crawler run document")
    if run_doc.get("status") not in ("queries_exhausted", "needs_attention") or "jobs" not in run_doc:
        raise ValueError("Only a completed crawler run can be ingested")
    window = run_doc.get("publication_window") or {}
    if not window.get("start") or not window.get("end"):
        raise ValueError("Run is missing its publication window")

    sources, captures, gaps, raw_pages = [], [], [], []
    seen_sources = set()
    for job in run_doc["jobs"]:
        handle, author_id = job.get("handle"), job.get("author_id")
        for req in job.get("requests", []):
            if req.get("raw_file") and req.get("raw_sha256"):
                raw_pages.append({"job": job["id"], "file": f'{job["id"]}/{req["raw_file"]}',
                                  "sha256": req["raw_sha256"]})
        for post in job.get("posts", []):
            sid = post["id"]
            if sid in seen_sources:
                continue  # a post is unique within one run
            seen_sources.add(sid)
            source = {
                "source_id": sid, "platform": post.get("source_type", "x"),
                "account_handle": post["author"], "account_external_id": post["author_id"],
                "company": job.get("company"), "canonical_url": post["url"], "kind": "post",
                "is_reply": bool(post.get("is_reply")), "is_repost": bool(post.get("is_repost")),
                "quoted_source_id": post.get("quoted_post_id"),
                "published_at": _epoch_utc(post["created_utc"]),
            }
            source["record_sha256"] = digest(_hashable(source))
            # Upstream links (migration 029) are added after the hash so a post
            # already stored keeps the same record hash when they are backfilled.
            source.update(relations_of(post))
            sources.append(source)
            text = post.get("text") or ""
            capture = {
                "capture_id": sid, "source_id": sid,
                "captured_at": _iso(post["metrics_observed_at"]),
                "original_published_at": _epoch_utc(post["created_utc"]),
                "text_sha256": digest(text),
                "public_excerpt": text[:280] or None,
                "language": None,
                "metrics": post.get("metrics") or {},
            }
            capture["record_sha256"] = digest(_hashable(capture))
            capture["full_text"] = text or None
            captures.append(capture)
        gaps.append({
            "id": job["id"], "platform": "x",
            "account_handle": handle, "account_external_id": author_id,
            "window_start": _iso(job["window_start"]), "window_end": _iso(job["window_end"]),
            "checked_at": _iso(run_doc["finished_at"] or run_doc["started_at"]),
            "status": _GAP_STATUS.get(job.get("status"), "failed"),
            "retrieved_count": job.get("accepted_count"),
            "attempts": job.get("attempts"),
            "stop_reason": job.get("stop_reason"),
            "gap_note": None if job.get("status") == "search_ended" else job.get("stop_reason"),
        })

    run = {
        "run_id": run_id, "tool": run_doc.get("version"),
        "tool_sha256": run_doc.get("implementation_sha256"),
        "registry_sha256": run_doc.get("registry_sha256"),
        "window_start": _iso(window["start"]), "window_end": _iso(window["end"]),
        "started_at": _iso(run_doc["started_at"]),
        "finished_at": _iso(run_doc["finished_at"]) if run_doc.get("finished_at") else None,
        "status": run_doc["status"], "ok": bool(run_doc["ok"]),
        "concurrency": run_doc.get("concurrency"),
        "source_count": len(sources), "capture_count": len(captures),
        "raw_pages": raw_pages, "run_sha256": digest(run_doc),
    }
    return run, sources, captures, gaps


def ingest_run(conn, run_path):
    """Idempotently ingest one crawler run file into the collection store.

    Re-ingesting the same run (same run_id and identical content) is a no-op;
    the same run_id with different content is rejected.
    """
    from psycopg.types.json import Jsonb

    run_path = Path(run_path)
    run_doc = json.loads(run_path.read_text())
    run_id = run_path.stem
    run, sources, captures, gaps = build_rows(run_doc, run_id)

    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(7543004)")
        old = conn.execute("SELECT run_sha256 FROM collection_runs WHERE run_id=%s", (run_id,)).fetchone()
        if old:
            if old["run_sha256"] != run["run_sha256"]:
                raise ValueError(f"Collection run {run_id} already ingested with different content")
            return {"run_id": run_id, "reused": True,
                    "sources": run["source_count"], "captures": run["capture_count"], "gaps": len(gaps)}
        conn.execute(
            """INSERT INTO collection_runs
               (run_id,tool,tool_sha256,registry_sha256,window_start,window_end,started_at,
                finished_at,status,ok,concurrency,source_count,capture_count,raw_pages,run_sha256)
               VALUES (%(run_id)s,%(tool)s,%(tool_sha256)s,%(registry_sha256)s,%(window_start)s,
                %(window_end)s,%(started_at)s,%(finished_at)s,%(status)s,%(ok)s,%(concurrency)s,
                %(source_count)s,%(capture_count)s,%(raw_pages)s,%(run_sha256)s)""",
            {**run, "tool_sha256": Jsonb(run["tool_sha256"]) if run["tool_sha256"] else None,
             "raw_pages": Jsonb(run["raw_pages"])})
        # One row per post, not one per run that saw it. The key used to be
        # (run_id, source_id), so a post seen by seven runs was stored seven
        # times - and across all of those copies the number of posts whose
        # platform, URL, kind, handle or publication time differed was zero.
        # Captures stay per run: those genuinely change, because the metrics move.
        for s in sources:
            conn.execute(
                """INSERT INTO collected_sources
                   (run_id,source_id,platform,account_handle,account_external_id,company,
                    canonical_url,kind,is_reply,is_repost,quoted_source_id,published_at,record_sha256,
                    reply_to_source_id,reply_to_user_id,repost_of_source_id,conversation_id)
                   VALUES (%(run_id)s,%(source_id)s,%(platform)s,%(account_handle)s,%(account_external_id)s,
                    %(company)s,%(canonical_url)s,%(kind)s,%(is_reply)s,%(is_repost)s,%(quoted_source_id)s,
                    %(published_at)s,%(record_sha256)s,%(reply_to_source_id)s,%(reply_to_user_id)s,
                    %(repost_of_source_id)s,%(conversation_id)s)
                   ON CONFLICT (source_id) DO NOTHING""",
                {**s, "run_id": run_id})
        for c in captures:
            conn.execute(
                """INSERT INTO collected_captures
                   (run_id,capture_id,source_id,captured_at,original_published_at,text_sha256,
                    public_excerpt,language,metrics,record_sha256,full_text)
                   VALUES (%(run_id)s,%(capture_id)s,%(source_id)s,%(captured_at)s,%(original_published_at)s,
                    %(text_sha256)s,%(public_excerpt)s,%(language)s,%(metrics)s,%(record_sha256)s,%(full_text)s)""",
                {**c, "run_id": run_id, "metrics": Jsonb(c["metrics"])})
        for g in gaps:
            conn.execute(
                """INSERT INTO collection_gaps
                   (run_id,id,platform,account_handle,account_external_id,window_start,window_end,
                    checked_at,status,retrieved_count,attempts,stop_reason,gap_note)
                   VALUES (%(run_id)s,%(id)s,%(platform)s,%(account_handle)s,%(account_external_id)s,
                    %(window_start)s,%(window_end)s,%(checked_at)s,%(status)s,%(retrieved_count)s,
                    %(attempts)s,%(stop_reason)s,%(gap_note)s)""",
                {**g, "run_id": run_id})
    return {"run_id": run_id, "reused": False,
            "sources": run["source_count"], "captures": run["capture_count"], "gaps": len(gaps)}



def relations_of(post):
    """A parsed post's upstream links, in collected_sources column names."""
    return {"reply_to_source_id": post.get("reply_to_post_id"),
            "reply_to_user_id": post.get("reply_to_user_id"),
            "repost_of_source_id": post.get("repost_of_post_id"),
            "conversation_id": post.get("conversation_id")}


def backfill_relations(conn, run_path, parse_page):
    """Re-read a crawler run's raw pages and fill upstream links and full text.

    Only fills what is missing; never overwrites a stored value. `parse_page` is
    the crawler parser (passed in so this module keeps no crawler dependency).
    Returns counts; a page that no longer parses is counted, not fatal.
    """
    import json as _json
    run_path = Path(run_path)
    doc = _json.loads(run_path.read_text())
    pages_root = run_path.with_suffix(".pages")
    counts = {"pages": 0, "unparsed_pages": 0, "posts": 0, "sources_updated": 0, "texts_filled": 0}
    for job in doc.get("jobs", []):
        for req in job.get("requests", []):
            raw = req.get("raw_file")
            if not raw:
                continue
            path = pages_root / job["id"] / raw
            if not path.exists():
                continue
            counts["pages"] += 1
            try:
                posts, _ = parse_page(_json.loads(path.read_text()))
            except ValueError:
                counts["unparsed_pages"] += 1
                continue
            for post in posts:
                counts["posts"] += 1
                rel = relations_of(post)
                counts["sources_updated"] += conn.execute(
                    """UPDATE collected_sources SET
                         reply_to_source_id = coalesce(reply_to_source_id, %(reply_to_source_id)s::text),
                         reply_to_user_id = coalesce(reply_to_user_id, %(reply_to_user_id)s::text),
                         repost_of_source_id = coalesce(repost_of_source_id, %(repost_of_source_id)s::text),
                         conversation_id = coalesce(conversation_id, %(conversation_id)s::text)
                       WHERE source_id = %(source_id)s
                         AND (reply_to_source_id IS NULL AND %(reply_to_source_id)s::text IS NOT NULL
                           OR repost_of_source_id IS NULL AND %(repost_of_source_id)s::text IS NOT NULL
                           OR conversation_id IS NULL AND %(conversation_id)s::text IS NOT NULL)""",
                    {**rel, "source_id": post["id"]}).rowcount
                counts["texts_filled"] += conn.execute(
                    """UPDATE collected_captures SET full_text = %s
                        WHERE source_id = %s AND full_text IS NULL""",
                    (post.get("text") or None, post["id"])).rowcount
    return counts


def recover_renamed(runs, ids, now):
    """Pure: the posts renamed accounts lost to quarantine, as one run document to ingest.

    `runs` is [(run name, run document)], `ids` maps a registered handle (lower case)
    to its numeric account id. Until 2026-10-16 the crawler quarantined a post whose
    author id was the account's own but whose handle had changed, so a renamed
    account (@Microsoft365 -> @MSFTCopilot, @SpaceXAI -> @SpaceXSI) lost every post.
    A quarantined post comes back when its author id is the one registered for the
    job's handle and it falls inside that job's window, as the crawler now accepts
    it: under the registered handle, with the handle X showed kept beside it. Every
    other quarantined post stays where it is. Returns None when nothing comes back.
    """
    jobs, seen, changes = [], set(), {}
    for name, doc in runs:
        if doc.get("status") not in ("queries_exhausted", "needs_attention"):
            continue
        for job in doc.get("jobs") or []:
            expected = ids.get((job.get("handle") or "").lower())
            if not expected or not job.get("window_start") or not job.get("window_end"):
                continue
            start, end = _iso(job["window_start"]).timestamp(), _iso(job["window_end"]).timestamp()
            posts = []
            for held in job.get("quarantine") or []:
                post = held.get("post") or {}
                if (held.get("reason") != "author_identity_mismatch" or str(post.get("author_id")) != expected
                        or post.get("author", "").lower() == job["handle"].lower()
                        or not start <= post["created_utc"] < end or post["id"] in seen):
                    continue
                seen.add(post["id"])
                changes.setdefault((job["handle"], post["author"]), {
                    "from": job["handle"], "to": post["author"], "first_post_id": post["id"], "first_seen_in": name})
                posts.append({**post, "author": job["handle"], "author_handle_seen": post["author"]})
            if posts:
                jobs.append({
                    "id": f"{job['id']}-renamed", "handle": job["handle"], "author_id": expected,
                    "company": job.get("company"), "status": "search_ended", "stop_reason": job.get("stop_reason"),
                    "pages": 0, "accepted_count": len(posts), "attempts": 0, "account_label": None,
                    "window_start": job["window_start"], "window_end": job["window_end"],
                    "posts": posts, "quarantine": [], "requests": [], "next_cursor": None,
                    "recovered_from": name,
                })
    if not jobs:
        return None
    return {
        "version": "crawler-run-1", "source": "x", "synthetic": False, "ok": True, "status": "queries_exhausted",
        "coverage_status": "recovered_from_quarantine",
        "coverage_note": "Posts of renamed accounts that earlier runs quarantined; no request was made to X.",
        "started_at": now, "finished_at": now, "concurrency": 1, "budgets": {},
        "publication_window": {"start": min(j["window_start"] for j in jobs), "end": max(j["window_end"] for j in jobs)},
        "total": len(seen), "requests": 0, "schema_change": None, "jobs": jobs,
        "reconciliation": {"status": "not_configured", "expected_post_ids": [], "missing_post_ids": []},
        "handle_changes": list(changes.values()),
        "recovered_from": sorted({j["recovered_from"] for j in jobs}),
    }
