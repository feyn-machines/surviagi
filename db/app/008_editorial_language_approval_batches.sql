-- Preserve the exact language approved by each private batch action.
ALTER TABLE app.editorial_approval_batch_items
    ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'both';

ALTER TABLE app.editorial_approval_batch_items
    DROP CONSTRAINT IF EXISTS editorial_approval_batch_items_language_check;
ALTER TABLE app.editorial_approval_batch_items
    ADD CONSTRAINT editorial_approval_batch_items_language_check
    CHECK (language IN ('both', 'en', 'zh-CN'));

ALTER TABLE app.editorial_approval_batch_items
    DROP CONSTRAINT IF EXISTS editorial_approval_batch_items_result_check;
ALTER TABLE app.editorial_approval_batch_items
    ADD CONSTRAINT editorial_approval_batch_items_result_check
    CHECK (result IN (
        'approved', 'already_approved', 'language_approved', 'already_language_approved',
        'conflict', 'needs_bilingual_approval', 'not_found', 'unavailable'
    ));

ALTER TABLE app.editorial_approval_batch_items
    DROP CONSTRAINT IF EXISTS editorial_approval_batch_items_pkey;
ALTER TABLE app.editorial_approval_batch_items
    DROP CONSTRAINT IF EXISTS editorial_approval_batch_items_batch_id_item_index_key;
ALTER TABLE app.editorial_approval_batch_items
    ADD CONSTRAINT editorial_approval_batch_items_pkey PRIMARY KEY (batch_id, item_index);
ALTER TABLE app.editorial_approval_batch_items
    DROP CONSTRAINT IF EXISTS editorial_approval_batch_items_batch_article_language_key;
ALTER TABLE app.editorial_approval_batch_items
    ADD CONSTRAINT editorial_approval_batch_items_batch_article_language_key
    UNIQUE (batch_id, article_id, version, language);
