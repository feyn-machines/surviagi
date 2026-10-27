-- Private, append-only records for article review. Run as oaw_app after 002_agent_access.sql.
-- Article ids, versions and hashes intentionally do not reference editorial: oaw_app has no
-- access to the public editorial schema. Approval events here are records, not publication actions.
\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS app.editorial_reviews (
    review_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    article_id text NOT NULL CHECK (article_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    version integer NOT NULL CHECK (version > 0),
    language text NOT NULL CHECK (language IN ('en', 'zh-CN')),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    review_scope text NOT NULL CHECK (review_scope IN ('readability', 'language_quality', 'factual_accuracy', 'source_quality')),
    decision text NOT NULL CHECK (decision IN ('comment', 'request_revision', 'hold', 'approve', 'withdraw')),
    actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'model', 'system')),
    actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
    note text NOT NULL CHECK (length(btrim(note)) > 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS editorial_reviews_by_version
    ON app.editorial_reviews (article_id, version, language, created_at, review_id);

CREATE TABLE IF NOT EXISTS app.editorial_review_annotations (
    annotation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    review_id bigint NOT NULL REFERENCES app.editorial_reviews(review_id),
    paragraph_key text NOT NULL CHECK (length(btrim(paragraph_key)) > 0),
    selected_text text NOT NULL,
    context_before text NOT NULL DEFAULT '',
    context_after text NOT NULL DEFAULT '',
    comment text NOT NULL CHECK (length(btrim(comment)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (review_id, annotation_id)
);
CREATE INDEX IF NOT EXISTS editorial_annotations_by_review
    ON app.editorial_review_annotations (review_id, annotation_id);

CREATE TABLE IF NOT EXISTS app.editorial_review_edits (
    edit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    review_id bigint NOT NULL REFERENCES app.editorial_reviews(review_id),
    before_markdown text NOT NULL CHECK (length(btrim(before_markdown)) > 0),
    after_markdown text NOT NULL CHECK (length(btrim(after_markdown)) > 0),
    unified_diff text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (before_markdown IS DISTINCT FROM after_markdown),
    UNIQUE (review_id, edit_id)
);
CREATE INDEX IF NOT EXISTS editorial_edits_by_review
    ON app.editorial_review_edits (review_id, edit_id);

-- Records which exact later version used a private comment or edit, without rewriting its source.
CREATE TABLE IF NOT EXISTS app.editorial_feedback_applications (
    application_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_review_id bigint NOT NULL REFERENCES app.editorial_reviews(review_id),
    source_annotation_id bigint REFERENCES app.editorial_review_annotations(annotation_id),
    source_edit_id bigint REFERENCES app.editorial_review_edits(edit_id),
    article_id text NOT NULL CHECK (article_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    applied_version integer NOT NULL CHECK (applied_version > 0),
    language text NOT NULL CHECK (language IN ('en', 'zh-CN')),
    applied_content_sha256 text NOT NULL CHECK (applied_content_sha256 ~ '^[0-9a-f]{64}$'),
    application_note text NOT NULL CHECK (length(btrim(application_note)) > 0),
    actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(source_annotation_id, source_edit_id) = 1),
    FOREIGN KEY (source_review_id, source_annotation_id)
        REFERENCES app.editorial_review_annotations (review_id, annotation_id),
    FOREIGN KEY (source_review_id, source_edit_id)
        REFERENCES app.editorial_review_edits (review_id, edit_id)
);
CREATE INDEX IF NOT EXISTS editorial_feedback_applications_by_article
    ON app.editorial_feedback_applications (article_id, language, applied_version);

CREATE OR REPLACE FUNCTION app.validate_editorial_feedback_application() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    source_article_id text;
    source_version integer;
    source_language text;
BEGIN
    SELECT article_id, version, language INTO source_article_id, source_version, source_language
      FROM app.editorial_reviews WHERE review_id = NEW.source_review_id;
    IF source_article_id IS DISTINCT FROM NEW.article_id
       OR source_language IS DISTINCT FROM NEW.language
       OR NEW.applied_version <= source_version THEN
        RAISE EXCEPTION 'feedback application must target a later version of the same article and language';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS editorial_feedback_application_valid ON app.editorial_feedback_applications;
CREATE TRIGGER editorial_feedback_application_valid BEFORE INSERT ON app.editorial_feedback_applications
    FOR EACH ROW EXECUTE FUNCTION app.validate_editorial_feedback_application();

CREATE OR REPLACE FUNCTION app.reject_editorial_review_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'editorial review records are append-only';
END;
$$;

DROP TRIGGER IF EXISTS editorial_reviews_immutable ON app.editorial_reviews;
CREATE TRIGGER editorial_reviews_immutable BEFORE UPDATE OR DELETE ON app.editorial_reviews
    FOR EACH ROW EXECUTE FUNCTION app.reject_editorial_review_mutation();
DROP TRIGGER IF EXISTS editorial_review_annotations_immutable ON app.editorial_review_annotations;
CREATE TRIGGER editorial_review_annotations_immutable BEFORE UPDATE OR DELETE ON app.editorial_review_annotations
    FOR EACH ROW EXECUTE FUNCTION app.reject_editorial_review_mutation();
DROP TRIGGER IF EXISTS editorial_review_edits_immutable ON app.editorial_review_edits;
CREATE TRIGGER editorial_review_edits_immutable BEFORE UPDATE OR DELETE ON app.editorial_review_edits
    FOR EACH ROW EXECUTE FUNCTION app.reject_editorial_review_mutation();
DROP TRIGGER IF EXISTS editorial_feedback_applications_immutable ON app.editorial_feedback_applications;
CREATE TRIGGER editorial_feedback_applications_immutable BEFORE UPDATE OR DELETE ON app.editorial_feedback_applications
    FOR EACH ROW EXECUTE FUNCTION app.reject_editorial_review_mutation();

REVOKE ALL ON app.editorial_reviews, app.editorial_review_annotations,
    app.editorial_review_edits, app.editorial_feedback_applications FROM PUBLIC;
