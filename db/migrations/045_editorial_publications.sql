-- Local editorial preview storage. Production installs the corresponding public schema
-- from db/published/002_editorial.sql; this keeps local authoring separate from kg snapshots.
CREATE SCHEMA IF NOT EXISTS editorial;

CREATE TABLE IF NOT EXISTS editorial.articles (
    article_id text PRIMARY KEY CHECK (article_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    withdrawn_at timestamptz,
    withdrawal_reason text,
    CHECK ((withdrawn_at IS NULL) = (withdrawal_reason IS NULL))
);

CREATE TABLE IF NOT EXISTS editorial.versions (
    article_id text NOT NULL REFERENCES editorial.articles(article_id),
    version integer NOT NULL CHECK (version > 0),
    source_cutoff timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text NOT NULL,
    PRIMARY KEY (article_id, version)
);

CREATE TABLE IF NOT EXISTS editorial.localizations (
    article_id text NOT NULL,
    version integer NOT NULL,
    language text NOT NULL CHECK (language IN ('en', 'zh-CN')),
    title text NOT NULL CHECK (length(btrim(title)) > 0),
    summary text NOT NULL CHECK (length(btrim(summary)) > 0),
    body_markdown text NOT NULL CHECK (length(btrim(body_markdown)) > 0),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (article_id, version, language),
    FOREIGN KEY (article_id, version) REFERENCES editorial.versions(article_id, version)
);

CREATE TABLE IF NOT EXISTS editorial.publications (
    article_id text PRIMARY KEY REFERENCES editorial.articles(article_id),
    preview_version integer,
    approved_version integer,
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (article_id, preview_version) REFERENCES editorial.versions(article_id, version),
    FOREIGN KEY (article_id, approved_version) REFERENCES editorial.versions(article_id, version)
);

CREATE TABLE IF NOT EXISTS editorial.publication_history (
    history_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    article_id text NOT NULL REFERENCES editorial.articles(article_id),
    version integer,
    action text NOT NULL CHECK (action IN ('preview', 'approve', 'withdraw', 'restore')),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (article_id, version) REFERENCES editorial.versions(article_id, version)
);

CREATE OR REPLACE FUNCTION editorial.require_bilingual_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, editorial AS $$
DECLARE
    candidate text := NEW.article_id;
    candidate_preview integer := NEW.preview_version;
    candidate_approved integer := NEW.approved_version;
BEGIN
    IF candidate_preview IS NOT NULL AND (
        SELECT count(*) FROM editorial.localizations
        WHERE article_id = candidate AND version = candidate_preview
          AND language IN ('en', 'zh-CN')
    ) <> 2 THEN
        RAISE EXCEPTION 'public article version must include en and zh-CN localizations';
    END IF;
    IF candidate_approved IS NOT NULL AND (
        SELECT count(*) FROM editorial.localizations
        WHERE article_id = candidate AND version = candidate_approved
          AND language IN ('en', 'zh-CN')
    ) <> 2 THEN
        RAISE EXCEPTION 'public article version must include en and zh-CN localizations';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS publications_require_bilingual ON editorial.publications;
CREATE CONSTRAINT TRIGGER publications_require_bilingual
AFTER INSERT OR UPDATE ON editorial.publications DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION editorial.require_bilingual_version();

CREATE OR REPLACE FUNCTION editorial.reject_public_content_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'published article versions and localizations are immutable';
END;
$$;

DROP TRIGGER IF EXISTS versions_immutable ON editorial.versions;
CREATE TRIGGER versions_immutable BEFORE UPDATE OR DELETE ON editorial.versions
FOR EACH ROW EXECUTE FUNCTION editorial.reject_public_content_mutation();
DROP TRIGGER IF EXISTS localizations_immutable ON editorial.localizations;
CREATE TRIGGER localizations_immutable BEFORE UPDATE OR DELETE ON editorial.localizations
FOR EACH ROW EXECUTE FUNCTION editorial.reject_public_content_mutation();
DROP TRIGGER IF EXISTS publication_history_immutable ON editorial.publication_history;
CREATE TRIGGER publication_history_immutable BEFORE UPDATE OR DELETE ON editorial.publication_history
FOR EACH ROW EXECUTE FUNCTION editorial.reject_public_content_mutation();
