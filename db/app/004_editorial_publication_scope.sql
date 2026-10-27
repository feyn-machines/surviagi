-- Add an explicit publication scope for decisions that move public article state.
\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE app.editorial_reviews
    DROP CONSTRAINT IF EXISTS editorial_reviews_review_scope_check;
ALTER TABLE app.editorial_reviews
    ADD CONSTRAINT editorial_reviews_review_scope_check
    CHECK (review_scope IN ('readability', 'language_quality', 'factual_accuracy', 'source_quality', 'publication'));

COMMIT;
