"""Local sentence embeddings, used only to shortlist what a judge then reads.

A similarity score never decides anything here: it picks the few stored topics
or catalog entries worth showing the model, so the model does not have to be
shown all of them. The embedding model (EmbeddingGemma 2) runs on this machine,
served by llama.cpp from the local Compose project (`pnpm data:up`).
"""

import json
import math
import os
import urllib.error
import urllib.request

DEFAULT_MODEL = "embeddinggemma-2"
DEFAULT_URL = "http://127.0.0.1:7546"
# EmbeddingGemma is trained with the task written in front of the text. Two
# texts compared with each other both take the similarity form; a search query
# and the documents it is matched against take different ones.
FORMS = {
    "similarity": "task: sentence similarity | query: {text}",
    "query": "task: search result | query: {text}",
    "document": "title: none | text: {text}",
}


class EmbeddingError(RuntimeError):
    pass


def config_from_env():
    return {"model": os.environ.get("EMBEDDING_MODEL", "").strip() or DEFAULT_MODEL,
            "url": (os.environ.get("EMBEDDING_URL", "").strip() or DEFAULT_URL).rstrip("/")}


def embed(texts, cfg=None, form="similarity", batch_size=32):
    """Unit-length vectors for `texts`, in order."""
    cfg = cfg or config_from_env()
    vectors = []
    for start in range(0, len(texts), batch_size):
        chunk = texts[start:start + batch_size]
        payload = json.dumps({"model": cfg["model"],
                              "input": [FORMS[form].format(text=t) for t in chunk]}).encode()
        request = urllib.request.Request(f"{cfg['url']}/v1/embeddings", data=payload, method="POST",
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                body = json.loads(response.read().decode())
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            raise EmbeddingError(f"embedding request failed ({cfg['url']}): {error}. "
                                 "Is the local embedding server up (pnpm data:up)?") from None
        rows = body.get("data") if isinstance(body, dict) else None
        if not isinstance(rows, list) or len(rows) != len(chunk):
            raise EmbeddingError(f"embedding response malformed: {str(body)[:200]}")
        vectors += [_unit(row["embedding"]) for row in sorted(rows, key=lambda r: r.get("index", 0))]
    return vectors


def _unit(vector):
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]


def similarity(a, b):
    return sum(x * y for x, y in zip(a, b))


def nearest(vector, candidates, k, floor=0.0):
    """The `k` (key, score) pairs of `candidates` ({key: vector}) most like `vector`, best first."""
    scored = sorted(((similarity(vector, v), key) for key, v in candidates.items()), reverse=True)
    return [(key, score) for score, key in scored[:k] if score >= floor]
