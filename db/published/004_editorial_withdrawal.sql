-- Require bilingual, publication-scoped human withdrawal decisions before hiding a public article.
-- Run as postgres after db/app/004_editorial_publication_scope.sql.
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE VIEW editorial.review_approval_evidence AS
SELECT DISTINCT ON (article_id, version, language)
       article_id, version, language, content_sha256, decision, review_scope
  FROM app.editorial_reviews
 WHERE actor_kind = 'human'
 ORDER BY article_id, version, language, review_id DESC;
ALTER VIEW editorial.review_approval_evidence OWNER TO postgres;
REVOKE ALL ON editorial.review_approval_evidence FROM PUBLIC, oaw_app, oaw_site;
GRANT SELECT ON editorial.review_approval_evidence TO oaw_kg_writer;

CREATE OR REPLACE FUNCTION editorial.withdraw_public_article(
    p_article_id text,
    p_expected_preview_version integer,
    p_expected_approved_version integer,
    p_reason text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, editorial
AS $$
DECLARE
    seen_preview integer;
    seen_approved integer;
    current_preview integer;
    current_approved integer;
    head_version integer;
    was_withdrawn timestamptz;
    en_sha256 text;
    zh_sha256 text;
BEGIN
    IF p_reason IS NULL OR length(btrim(p_reason)) < 20 OR length(p_reason) > 1000 THEN
        RAISE EXCEPTION 'a withdrawal reason of 20 to 1000 characters is required' USING ERRCODE = '22023';
    END IF;

    SELECT preview_version, approved_version
      INTO seen_preview, seen_approved
      FROM editorial.publications
     WHERE article_id = p_article_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'article is unavailable' USING ERRCODE = 'P0002';
    END IF;

    head_version := COALESCE(seen_preview, seen_approved);
    IF head_version IS NULL THEN
        RAISE EXCEPTION 'article has no public version' USING ERRCODE = 'P0002';
    END IF;

    -- Match the lock used by review writes and approval, so a decision cannot race this action.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(format('editorial-review:%s:v%s', p_article_id, head_version), 0)
    );

    SELECT p.preview_version, p.approved_version, a.withdrawn_at
      INTO current_preview, current_approved, was_withdrawn
      FROM editorial.publications p
      JOIN editorial.articles a USING (article_id)
     WHERE p.article_id = p_article_id
     FOR UPDATE OF p, a;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'article is unavailable' USING ERRCODE = 'P0002';
    END IF;
    IF current_preview IS DISTINCT FROM p_expected_preview_version
       OR current_approved IS DISTINCT FROM p_expected_approved_version
       OR current_preview IS DISTINCT FROM seen_preview
       OR current_approved IS DISTINCT FROM seen_approved THEN
        RAISE EXCEPTION 'public article pointers changed' USING ERRCODE = '40001';
    END IF;
    IF was_withdrawn IS NOT NULL THEN
        RETURN false;
    END IF;

    head_version := COALESCE(current_preview, current_approved);
    SELECT content_sha256 INTO en_sha256
      FROM editorial.localizations
     WHERE article_id = p_article_id AND version = head_version AND language = 'en';
    SELECT content_sha256 INTO zh_sha256
      FROM editorial.localizations
     WHERE article_id = p_article_id AND version = head_version AND language = 'zh-CN';

    IF en_sha256 IS NULL OR zh_sha256 IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM editorial.review_approval_evidence e
             WHERE e.article_id = p_article_id AND e.version = head_version AND e.language = 'en'
               AND e.content_sha256 = en_sha256 AND e.review_scope = 'publication' AND e.decision = 'withdraw'
       )
       OR NOT EXISTS (
            SELECT 1 FROM editorial.review_approval_evidence e
             WHERE e.article_id = p_article_id AND e.version = head_version AND e.language = 'zh-CN'
               AND e.content_sha256 = zh_sha256 AND e.review_scope = 'publication' AND e.decision = 'withdraw'
       ) THEN
        RAISE EXCEPTION 'latest human publication withdrawal decisions are required for both languages' USING ERRCODE = 'P0001';
    END IF;

    UPDATE editorial.articles
       SET withdrawn_at = now(), withdrawal_reason = btrim(p_reason)
     WHERE article_id = p_article_id;
    INSERT INTO editorial.publication_history (article_id, version, action)
    VALUES (p_article_id, head_version, 'withdraw');
    RETURN true;
END;
$$;

ALTER FUNCTION editorial.withdraw_public_article(text, integer, integer, text) OWNER TO oaw_kg_writer;
REVOKE ALL ON FUNCTION editorial.withdraw_public_article(text, integer, integer, text) FROM PUBLIC, oaw_site;
GRANT EXECUTE ON FUNCTION editorial.withdraw_public_article(text, integer, integer, text) TO oaw_app;

COMMIT;
