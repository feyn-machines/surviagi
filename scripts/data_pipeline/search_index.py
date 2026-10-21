"""The search index: keyword and vector search over what the pipeline produced.

Meilisearch holds a copy, never the record. Three indexes are filled from the
database and the topics document, and can be dropped and filled again at any
time:

- `topics`  - the open questions, in both languages, with their answers
- `updates` - what happened, as extracted from posts
- `catalog` - occupations and markets, in both languages

Meilisearch embeds documents and queries itself by calling the embedding
server beside it, so a search is one request and matches on words and on
meaning together.
"""

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KEY_FILE = ROOT / "data" / "meilisearch" / "env"
DEFAULT_URL = "http://127.0.0.1:7547"
# Where Meilisearch reaches the embedding server: the service name inside the Compose network.
EMBEDDER_URL = "http://embeddings:8080/v1/embeddings"
EMBEDDER = {
    "source": "rest", "url": EMBEDDER_URL, "dimensions": 768,
    "request": {"model": "embeddinggemma-2", "input": ["{{text}}", "{{..}}"]},
    "response": {"data": [{"embedding": "{{embedding}}"}, "{{..}}"]},
    # The form EmbeddingGemma expects of a document.
    "documentTemplate": "title: {{doc.title}} | text: {{doc.text}}",
    "documentTemplateMaxBytes": 4000,
}
INDEXES = {
    "topics": {"searchable": ["title", "title_zh", "text", "object", "options"],
               "filterable": ["status", "question_type", "anchor"], "sortable": ["accounts", "views"]},
    "updates": {"searchable": ["title", "text", "org", "subject"],
                "filterable": ["kind", "org", "routed"], "sortable": ["date"]},
    "catalog": {"searchable": ["title", "title_zh", "text"], "filterable": ["kind"], "sortable": []},
}


class SearchError(RuntimeError):
    pass


def config_from_env():
    key = os.environ.get("MEILI_MASTER_KEY", "").strip()
    if not key and KEY_FILE.exists():
        key = dict(line.split("=", 1) for line in KEY_FILE.read_text().splitlines()
                   if "=" in line).get("MEILI_MASTER_KEY", "").strip()
    if not key:
        raise SearchError("Meilisearch key not found; run `pnpm data:up` first")
    return {"url": (os.environ.get("MEILI_URL", "").strip() or DEFAULT_URL).rstrip("/"), "key": key}


def call(cfg, method, path, body=None):
    request = urllib.request.Request(
        cfg["url"] + path, method=method,
        data=None if body is None else json.dumps(body, ensure_ascii=False).encode(),
        headers={"Authorization": f"Bearer {cfg['key']}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode() or "null")
    except urllib.error.HTTPError as error:
        raise SearchError(f"{method} {path}: HTTP {error.code}: {error.read().decode()[:300]}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise SearchError(f"{method} {path}: {error}. Is Meilisearch up (pnpm data:up)?") from None


def wait(cfg, task, timeout=900):
    """Block until a queued task is done; a failed task is an error, not a result."""
    uid, deadline = task["taskUid"], time.time() + timeout
    while time.time() < deadline:
        state = call(cfg, "GET", f"/tasks/{uid}")
        if state["status"] == "succeeded":
            return state
        if state["status"] in ("failed", "canceled"):
            raise SearchError(f"task {uid} {state['status']}: {json.dumps(state.get('error'))[:300]}")
        time.sleep(0.5)
    raise SearchError(f"task {uid} did not finish in {timeout}s")


def doc_id(value):
    """Meilisearch ids allow letters, digits, - and _ only."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", value)


def topic_documents(topics):
    return [{
        "id": doc_id(t["id"]), "key": t["id"], "title": t["question"]["en"], "title_zh": t["question"]["zh-CN"],
        "text": f"{t['object']}. {t['question']['zh-CN']} " + " / ".join(o["en"] for o in t["options"]),
        "object": t["object"], "options": [f"{o['en']} | {o['zh-CN']}" for o in t["options"]],
        "question_type": t["question_type"], "status": t["status"], "anchor": t["anchor"],
        "anchor_name": t.get("anchor_name"), "accounts": t["accounts"], "views": t["views"],
        "opened_on": t.get("opened_on"), "queries": t.get("queries", []),
    } for t in topics]


def update_documents(conn):
    rows = conn.execute("""
        SELECT e.event_id, e.title, e.summary, e.kind, e.subject, e.primary_org_id,
               COALESCE(e.occurred_at, e.announced_at) AS at,
               EXISTS (SELECT 1 FROM activity_evidence ae WHERE ae.event_id = e.event_id) AS routed
        FROM extracted_events e ORDER BY e.event_id
    """).fetchall()
    return [{"id": doc_id(r["event_id"]), "key": r["event_id"], "title": r["title"], "text": r["summary"] or "",
             "kind": r["kind"], "subject": r["subject"], "org": r["primary_org_id"], "routed": r["routed"],
             "date": int(r["at"].timestamp()) if r["at"] else None,
             "day": r["at"].date().isoformat() if r["at"] else None} for r in rows]


def catalog_documents(conn):
    rows = conn.execute("""
        SELECT id, kind, label_en, label_zh_cn FROM ontology_concepts
        WHERE kind IN ('occupation', 'occupation_group', 'market', 'market_group')
          AND ontology_version = (SELECT max(ontology_version) FROM ontology_concepts)
        ORDER BY id
    """).fetchall()
    return [{"id": doc_id(r["id"]), "key": r["id"], "kind": r["kind"], "title": r["label_en"],
             "title_zh": r["label_zh_cn"], "text": r["label_zh_cn"] or ""} for r in rows]


def fill(cfg, name, documents):
    """Replace an index's contents with `documents`."""
    spec = INDEXES[name]
    try:
        wait(cfg, call(cfg, "POST", "/indexes", {"uid": name, "primaryKey": "id"}))
    except SearchError as error:
        if "index_already_exists" not in str(error):
            raise
    wait(cfg, call(cfg, "PATCH", f"/indexes/{name}/settings", {
        "searchableAttributes": spec["searchable"], "filterableAttributes": spec["filterable"],
        "sortableAttributes": spec["sortable"], "embedders": {"default": EMBEDDER}}))
    wait(cfg, call(cfg, "DELETE", f"/indexes/{name}/documents"))
    for start in range(0, len(documents), 500):
        wait(cfg, call(cfg, "POST", f"/indexes/{name}/documents", documents[start:start + 500]))
    return len(documents)


def fill_all(conn, topics, cfg=None, only=None):
    cfg = cfg or config_from_env()
    sources = {"topics": lambda: topic_documents(topics), "updates": lambda: update_documents(conn),
               "catalog": lambda: catalog_documents(conn)}
    return {name: fill(cfg, name, make()) for name, make in sources.items() if not only or name in only}


def search(index, query, cfg=None, limit=8, semantic=0.5, filter=None):
    """Words and meaning together; `semantic` is how much the meaning counts (0 words only, 1 meaning only)."""
    cfg = cfg or config_from_env()
    body = {"q": query, "limit": limit, "showRankingScore": True,
            "hybrid": {"embedder": "default", "semanticRatio": semantic}}
    if filter:
        body["filter"] = filter
    return call(cfg, "POST", f"/indexes/{index}/search", body)["hits"]
