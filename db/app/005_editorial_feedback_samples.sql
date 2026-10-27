-- Manually curated, private writing examples. A review edit becomes reusable only
-- after an administrator records its issue, genre, applicability and explicit scope.
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS app.editorial_feedback_samples (
    sample_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_review_id bigint NOT NULL,
    source_edit_id bigint NOT NULL,
    feedback_scope text NOT NULL CHECK (feedback_scope IN ('single_article', 'reusable_preference')),
    issue_type text NOT NULL CHECK (issue_type IN (
        'evidence_boundary', 'structure', 'clarity', 'specificity', 'tone', 'redundancy', 'headline', 'natural_language', 'other'
    )),
    article_genre text NOT NULL CHECK (article_genre IN (
        'event_thread', 'product_comparison', 'capability_explainer', 'workflow', 'other'
    )),
    problem text NOT NULL CHECK (length(btrim(problem)) BETWEEN 10 AND 1200),
    before_excerpt text NOT NULL CHECK (length(btrim(before_excerpt)) BETWEEN 1 AND 3000),
    after_excerpt text NOT NULL CHECK (length(btrim(after_excerpt)) BETWEEN 1 AND 3000),
    applicability text NOT NULL CHECK (length(btrim(applicability)) BETWEEN 10 AND 1200),
    preference_evidence text,
    curator_id text NOT NULL CHECK (length(btrim(curator_id)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (source_review_id, source_edit_id)
        REFERENCES app.editorial_review_edits (review_id, edit_id),
    CHECK (
        (feedback_scope = 'single_article' AND preference_evidence IS NULL)
        OR (feedback_scope = 'reusable_preference' AND preference_evidence IS NOT NULL
            AND length(btrim(preference_evidence)) BETWEEN 10 AND 1200)
    ),
    UNIQUE (source_edit_id, issue_type, feedback_scope)
);

CREATE INDEX IF NOT EXISTS editorial_feedback_samples_retrieval
    ON app.editorial_feedback_samples (article_genre, issue_type, feedback_scope, created_at DESC);

CREATE OR REPLACE FUNCTION app.validate_editorial_feedback_sample() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    source_kind text;
    source_note text;
    source_before text;
    source_after text;
BEGIN
    SELECT r.actor_kind, r.note, e.before_markdown, e.after_markdown
      INTO source_kind, source_note, source_before, source_after
      FROM app.editorial_reviews r
      JOIN app.editorial_review_edits e ON e.review_id = r.review_id
     WHERE r.review_id = NEW.source_review_id AND e.edit_id = NEW.source_edit_id;
    IF NOT FOUND OR source_kind IS DISTINCT FROM 'human' THEN
        RAISE EXCEPTION 'feedback samples require an edit from a human review';
    END IF;
    IF position(btrim(NEW.before_excerpt) in source_before) = 0
       OR position(btrim(NEW.after_excerpt) in source_after) = 0 THEN
        RAISE EXCEPTION 'sample excerpts must be present in the source edit';
    END IF;
    IF NEW.feedback_scope = 'reusable_preference'
       AND position(btrim(NEW.preference_evidence) in source_note) = 0 THEN
        RAISE EXCEPTION 'reusable preferences must quote explicit evidence from the source review';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS editorial_feedback_sample_valid ON app.editorial_feedback_samples;
CREATE TRIGGER editorial_feedback_sample_valid BEFORE INSERT ON app.editorial_feedback_samples
    FOR EACH ROW EXECUTE FUNCTION app.validate_editorial_feedback_sample();

DROP TRIGGER IF EXISTS editorial_feedback_samples_immutable ON app.editorial_feedback_samples;
CREATE TRIGGER editorial_feedback_samples_immutable BEFORE UPDATE OR DELETE ON app.editorial_feedback_samples
    FOR EACH ROW EXECUTE FUNCTION app.reject_editorial_review_mutation();

REVOKE ALL ON app.editorial_feedback_samples FROM PUBLIC;

COMMIT;
