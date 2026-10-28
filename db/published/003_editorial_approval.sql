-- Controlled bridge from private human reviews to the public approved-version pointer.
-- This migration is run by the database superuser after db/app migrations exist.
\set ON_ERROR_STOP on
BEGIN;

GRANT USAGE ON SCHEMA editorial TO oaw_app;
ALTER FUNCTION editorial.require_bilingual_version() SECURITY DEFINER;
ALTER FUNCTION editorial.require_bilingual_version() SET search_path = pg_catalog, editorial;

CREATE OR REPLACE VIEW editorial.review_approval_evidence AS
SELECT DISTINCT ON (article_id, version, language)
       article_id, version, language, content_sha256, decision, review_scope
  FROM app.editorial_reviews
 WHERE actor_kind = 'human'
 ORDER BY article_id, version, language, review_id DESC;
ALTER VIEW editorial.review_approval_evidence OWNER TO postgres;
REVOKE ALL ON editorial.review_approval_evidence FROM PUBLIC, oaw_app, oaw_site;
GRANT SELECT ON editorial.review_approval_evidence TO oaw_kg_writer;

CREATE OR REPLACE FUNCTION editorial.approve_public_preview(
    p_article_id text,
    p_version integer,
    p_en_sha256 text,
    p_zh_sha256 text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, editorial
AS $$
DECLARE
    current_preview integer;
    current_approved integer;
    was_withdrawn timestamptz;
    en_sha256 text;
    zh_sha256 text;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended(format('editorial-review:%s:v%s', p_article_id, p_version), 0)
    );

    SELECT p.preview_version, p.approved_version, a.withdrawn_at
      INTO current_preview, current_approved, was_withdrawn
      FROM editorial.publications p
      JOIN editorial.articles a USING (article_id)
     WHERE p.article_id = p_article_id
     FOR UPDATE OF p, a;
    IF NOT FOUND OR was_withdrawn IS NOT NULL THEN
        RAISE EXCEPTION 'article is unavailable' USING ERRCODE = 'P0002';
    END IF;
    IF current_preview IS DISTINCT FROM p_version THEN
        RAISE EXCEPTION 'preview version changed' USING ERRCODE = '40001';
    END IF;
    IF current_approved IS NOT NULL AND current_approved > p_version THEN
        RAISE EXCEPTION 'an older version cannot replace the approved version' USING ERRCODE = '40001';
    END IF;

    SELECT l.content_sha256 INTO en_sha256
      FROM editorial.localizations l
     WHERE l.article_id = p_article_id AND l.version = p_version AND l.language = 'en';
    SELECT l.content_sha256 INTO zh_sha256
      FROM editorial.localizations l
     WHERE l.article_id = p_article_id AND l.version = p_version AND l.language = 'zh-CN';
    IF en_sha256 IS NULL OR zh_sha256 IS NULL
       OR en_sha256 IS DISTINCT FROM p_en_sha256
       OR zh_sha256 IS DISTINCT FROM p_zh_sha256 THEN
        RAISE EXCEPTION 'article content changed' USING ERRCODE = '40001';
    END IF;

    -- A repeated call is safe and does not add duplicate publication history.
    IF current_approved = p_version THEN
        RETURN false;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM editorial.review_approval_evidence e
         WHERE e.article_id = p_article_id AND e.version = p_version
           AND e.language = 'en' AND e.content_sha256 = en_sha256 AND e.decision = 'approve'
    ) OR NOT EXISTS (
        SELECT 1 FROM editorial.review_approval_evidence e
         WHERE e.article_id = p_article_id AND e.version = p_version
           AND e.language = 'zh-CN' AND e.content_sha256 = zh_sha256 AND e.decision = 'approve'
    ) THEN
        RAISE EXCEPTION 'latest human approval is required for both languages' USING ERRCODE = 'P0001';
    END IF;

    UPDATE editorial.publications
       SET approved_version = p_version, updated_at = now()
     WHERE article_id = p_article_id;
    INSERT INTO editorial.publication_history (article_id, version, action)
    VALUES (p_article_id, p_version, 'approve');
    RETURN true;
END;
$$;
ALTER FUNCTION editorial.approve_public_preview(text, integer, text, text) OWNER TO oaw_kg_writer;
REVOKE ALL ON FUNCTION editorial.approve_public_preview(text, integer, text, text) FROM PUBLIC, oaw_site;
GRANT EXECUTE ON FUNCTION editorial.approve_public_preview(text, integer, text, text) TO oaw_app;

COMMIT;
