-- Record when a curated private example informed a specific draft version.
-- This is separate from raw review applications: reusable preferences can
-- legitimately inform another article, while one-off edits cannot.
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS app.editorial_feedback_sample_applications (
    application_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sample_id bigint NOT NULL REFERENCES app.editorial_feedback_samples(sample_id),
    article_id text NOT NULL CHECK (article_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    applied_version integer NOT NULL CHECK (applied_version > 0),
    language text NOT NULL CHECK (language IN ('en', 'zh-CN')),
    applied_content_sha256 text NOT NULL CHECK (applied_content_sha256 ~ '^[0-9a-f]{64}$'),
    application_note text NOT NULL CHECK (length(btrim(application_note)) > 0),
    actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (sample_id, article_id, applied_version, language)
);
CREATE INDEX IF NOT EXISTS editorial_feedback_sample_applications_by_article
    ON app.editorial_feedback_sample_applications (article_id, language, applied_version);

CREATE OR REPLACE FUNCTION app.validate_editorial_feedback_sample_application() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    source_article_id text;
    source_version integer;
    source_language text;
    source_scope text;
BEGIN
    SELECT r.article_id, r.version, r.language, s.feedback_scope
      INTO source_article_id, source_version, source_language, source_scope
      FROM app.editorial_feedback_samples s
      JOIN app.editorial_reviews r ON r.review_id = s.source_review_id
     WHERE s.sample_id = NEW.sample_id;
    IF NOT FOUND OR source_language IS DISTINCT FROM NEW.language THEN
        RAISE EXCEPTION 'feedback sample application must preserve its source language';
    END IF;
    IF source_scope = 'single_article'
       AND (source_article_id IS DISTINCT FROM NEW.article_id OR NEW.applied_version <= source_version) THEN
        RAISE EXCEPTION 'single-article feedback must target a later version of its source article';
    END IF;
    IF source_article_id = NEW.article_id AND NEW.applied_version <= source_version THEN
        RAISE EXCEPTION 'feedback sample application must target a later version';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS editorial_feedback_sample_application_valid ON app.editorial_feedback_sample_applications;
CREATE TRIGGER editorial_feedback_sample_application_valid BEFORE INSERT ON app.editorial_feedback_sample_applications
    FOR EACH ROW EXECUTE FUNCTION app.validate_editorial_feedback_sample_application();

DROP TRIGGER IF EXISTS editorial_feedback_sample_applications_immutable ON app.editorial_feedback_sample_applications;
CREATE TRIGGER editorial_feedback_sample_applications_immutable BEFORE UPDATE OR DELETE ON app.editorial_feedback_sample_applications
    FOR EACH ROW EXECUTE FUNCTION app.reject_editorial_review_mutation();

REVOKE ALL ON app.editorial_feedback_sample_applications FROM PUBLIC;
COMMIT;
