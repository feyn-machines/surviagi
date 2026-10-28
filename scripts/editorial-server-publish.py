#!/usr/bin/env python3
"""Write one already preflighted public bilingual preview through the project's SSH DB tunnel."""
import json
import sys
from datetime import datetime

sys.path.insert(0, "scripts")
import server_db  # noqa: E402


def publish(conn, bundle):
    article_id = bundle["articleId"]
    expected = bundle["expected"]
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (article_id,))
        pointer = conn.execute(
            """SELECT p.preview_version, p.approved_version, a.withdrawn_at
                 FROM editorial.articles a JOIN editorial.publications p USING (article_id)
                WHERE a.article_id = %s FOR UPDATE OF p, a""", (article_id,)).fetchone()
        if pointer and pointer["withdrawn_at"]:
            raise ValueError("withdrawn articles cannot receive a new preview")
        if pointer and pointer["preview_version"] is not None:
            old = conn.execute(
                """SELECT l.language, l.title, l.summary, l.body_markdown, l.content_sha256
                     FROM editorial.localizations l
                    WHERE l.article_id = %s AND l.version = %s""",
                (article_id, pointer["preview_version"])).fetchall()
            old_version = conn.execute(
                "SELECT source_cutoff, created_by FROM editorial.versions WHERE article_id = %s AND version = %s",
                (article_id, pointer["preview_version"])).fetchone()
            current = {row["language"]: row for row in old}
            source_cutoff = datetime.fromisoformat(bundle["sourceCutoff"].replace("Z", "+00:00"))
            same = old_version and old_version["source_cutoff"] == source_cutoff and old_version["created_by"] == bundle["createdBy"]
            if same:
                for language in ("en", "zh-CN"):
                    item = bundle["localizations"][language]
                    row = current.get(language)
                    same = bool(row and row["title"] == item["title"] and row["summary"] == item["summary"]
                                and row["body_markdown"] == item["body"] and row["content_sha256"] == item["contentSha256"])
                    if not same:
                        break
            if same:
                return {"created": False, "articleId": article_id, "version": pointer["preview_version"],
                        "approvedVersion": pointer["approved_version"],
                        "contentSha256": {lang: bundle["localizations"][lang]["contentSha256"] for lang in ("en", "zh-CN")}}
        current_preview = pointer["preview_version"] if pointer else None
        current_approved = pointer["approved_version"] if pointer else None
        if expected["previewVersion"] != current_preview or expected["approvedVersion"] != current_approved:
            raise ValueError("article publication pointers changed; rebuild the package against the current versions")
        if not pointer:
            conn.execute("INSERT INTO editorial.articles(article_id) VALUES (%s)", (article_id,))
        version = conn.execute(
            "SELECT COALESCE(max(version), 0)::int + 1 AS version FROM editorial.versions WHERE article_id = %s",
            (article_id,)).fetchone()["version"]
        conn.execute(
            "INSERT INTO editorial.versions(article_id, version, source_cutoff, created_by) VALUES (%s, %s, %s, %s)",
            (article_id, version, bundle["sourceCutoff"], bundle["createdBy"]))
        for language in ("en", "zh-CN"):
            item = bundle["localizations"][language]
            conn.execute(
                """INSERT INTO editorial.localizations(article_id, version, language, title, summary, body_markdown, content_sha256)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (article_id, version, language, item["title"], item["summary"], item["body"], item["contentSha256"]))
        if pointer:
            conn.execute("UPDATE editorial.publications SET preview_version = %s, updated_at = now() WHERE article_id = %s",
                         (version, article_id))
        else:
            conn.execute("INSERT INTO editorial.publications(article_id, preview_version) VALUES (%s, %s)",
                         (article_id, version))
        conn.execute("INSERT INTO editorial.publication_history(article_id, version, action) VALUES (%s, %s, 'preview')",
                     (article_id, version))
        return {"created": True, "articleId": article_id, "version": version,
                "approvedVersion": current_approved,
                "contentSha256": {lang: bundle["localizations"][lang]["contentSha256"] for lang in ("en", "zh-CN")}}


def main():
    bundle = json.load(sys.stdin)
    with server_db.server_connection() as conn:
        result = publish(conn, bundle)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"server editorial publish failed: {server_db.first_line(error)}", file=sys.stderr)
        sys.exit(1)
