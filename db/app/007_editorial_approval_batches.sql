-- Private immutable audit records for an explicitly selected batch of approvals.
CREATE TABLE IF NOT EXISTS app.editorial_approval_batches (
    batch_id uuid PRIMARY KEY,
    actor_id text NOT NULL,
    request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.editorial_approval_batch_items (
    batch_id uuid NOT NULL REFERENCES app.editorial_approval_batches(batch_id),
    item_index integer NOT NULL CHECK (item_index >= 0),
    article_id text NOT NULL CHECK (article_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    version integer NOT NULL CHECK (version > 0),
    en_sha256 text NOT NULL CHECK (en_sha256 ~ '^[0-9a-f]{64}$'),
    zh_sha256 text NOT NULL CHECK (zh_sha256 ~ '^[0-9a-f]{64}$'),
    result text NOT NULL CHECK (result IN ('approved', 'already_approved', 'conflict', 'needs_bilingual_approval', 'not_found', 'unavailable')),
    publication_changed boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (batch_id, article_id, version),
    UNIQUE (batch_id, item_index)
);

CREATE OR REPLACE FUNCTION app.reject_editorial_approval_batch_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'editorial approval batch records are append-only';
END
$$;

DROP TRIGGER IF EXISTS editorial_approval_batches_immutable ON app.editorial_approval_batches;
CREATE TRIGGER editorial_approval_batches_immutable BEFORE UPDATE OR DELETE ON app.editorial_approval_batches
    FOR EACH ROW EXECUTE FUNCTION app.reject_editorial_approval_batch_mutation();
DROP TRIGGER IF EXISTS editorial_approval_batch_items_immutable ON app.editorial_approval_batch_items;
CREATE TRIGGER editorial_approval_batch_items_immutable BEFORE UPDATE OR DELETE ON app.editorial_approval_batch_items
    FOR EACH ROW EXECUTE FUNCTION app.reject_editorial_approval_batch_mutation();

REVOKE ALL ON app.editorial_approval_batches, app.editorial_approval_batch_items FROM PUBLIC;
