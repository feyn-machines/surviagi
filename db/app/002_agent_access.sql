-- Run as oaw_app after 001_app.sql. Repeatable: every statement is IF NOT EXISTS or OR REPLACE.
-- Access for AI agents (Issue #5): API keys that let a signed-in reader submit from an agent, and the
-- research questions readers submit. Reading the published data needs neither and is never recorded here.

-- A reader's API key. Only the SHA-256 of the secret is stored; the secret is shown once, when it is made.
-- A key belongs to one reader; revoking it is final. Quotas count per reader, never per key, so a new key
-- does not reset them.
CREATE TABLE IF NOT EXISTS app.api_keys (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      text        NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    prefix       text        NOT NULL CHECK (prefix ~ '^sag_[A-Za-z0-9_-]{8}$'),
    secret_hash  text        NOT NULL UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz,
    CONSTRAINT api_keys_used_after_made CHECK (last_used_at IS NULL OR last_used_at >= created_at),
    CONSTRAINT api_keys_revoked_after_made CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX IF NOT EXISTS api_keys_by_user ON app.api_keys (user_id, created_at);

-- Only last_used_at and (once) revoked_at may change.
CREATE OR REPLACE FUNCTION app.api_keys_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.name IS DISTINCT FROM OLD.name OR NEW.prefix IS DISTINCT FROM OLD.prefix
        OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
        RAISE EXCEPTION 'an API key cannot be changed, only used or revoked';
    END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER api_keys_fixed BEFORE UPDATE ON app.api_keys
    FOR EACH ROW EXECUTE FUNCTION app.api_keys_fixed();

-- Where a request came from. `request_id` is the caller's own name for one attempt: sending it again returns
-- the row the first attempt made instead of making another, so a retry never uses quota twice.
ALTER TABLE app.submissions ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'api'));
ALTER TABLE app.submissions ADD COLUMN IF NOT EXISTS api_key_id bigint REFERENCES app.api_keys(id) ON DELETE SET NULL;
ALTER TABLE app.submissions ADD COLUMN IF NOT EXISTS request_id text CHECK (request_id IS NULL OR request_id ~ '^[A-Za-z0-9._:-]{8,64}$');
ALTER TABLE app.submissions ADD COLUMN IF NOT EXISTS field text CHECK (field IS NULL OR char_length(field) BETWEEN 1 AND 80);
CREATE UNIQUE INDEX IF NOT EXISTS submissions_one_per_request ON app.submissions (user_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS submissions_by_user_day ON app.submissions (user_id, created_at);

-- The decided-is-final rule of 001, now also over the columns added here.
CREATE OR REPLACE FUNCTION app.submissions_decided_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'pending' AND (
        NEW.status IS DISTINCT FROM OLD.status
        OR (NEW.decided_by IS DISTINCT FROM OLD.decided_by AND NEW.decided_by IS NOT NULL)
        OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
        OR NEW.handle IS DISTINCT FROM OLD.handle OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
        OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.note IS DISTINCT FROM OLD.note
        OR NEW.display_handle IS DISTINCT FROM OLD.display_handle OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.id IS DISTINCT FROM OLD.id OR NEW.platform IS DISTINCT FROM OLD.platform
        OR NEW.via IS DISTINCT FROM OLD.via OR NEW.request_id IS DISTINCT FROM OLD.request_id
        OR NEW.field IS DISTINCT FROM OLD.field
        OR (NEW.api_key_id IS DISTINCT FROM OLD.api_key_id AND NEW.api_key_id IS NOT NULL)
        OR (OLD.imported_at IS NOT NULL AND NEW.imported_at IS DISTINCT FROM OLD.imported_at)
    ) THEN
        RAISE EXCEPTION 'a decided submission cannot be changed';
    END IF;
    RETURN NEW;
END $$;

-- A research question a reader asks the project to look into. Private to the reader and the administrators
-- until the project publishes something of its own; a question is never published as it was submitted.
-- `question_key` is the question folded for comparison (see questionKey in src/lib/agent-store.ts).
CREATE TABLE IF NOT EXISTS app.questions (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         text        NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
    question        text        NOT NULL CHECK (char_length(question) BETWEEN 8 AND 300),
    question_key    text        NOT NULL CHECK (char_length(question_key) BETWEEN 1 AND 300),
    why             text        NOT NULL CHECK (char_length(why) BETWEEN 20 AND 1000),
    gap             text        NOT NULL CHECK (char_length(gap) BETWEEN 10 AND 1000),
    leads           text        CHECK (leads IS NULL OR char_length(leads) BETWEEN 1 AND 1000),
    related         text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(related) <= 10),
    language        text        NOT NULL CHECK (language IN ('en', 'zh-CN')),
    status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    decided_by      text        REFERENCES app."user"(id) ON DELETE SET NULL,
    decision_reason text        CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 280),
    decided_at      timestamptz,
    via             text        NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'api')),
    api_key_id      bigint      REFERENCES app.api_keys(id) ON DELETE SET NULL,
    request_id      text        CHECK (request_id IS NULL OR request_id ~ '^[A-Za-z0-9._:-]{8,64}$'),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT questions_one_per_user UNIQUE (user_id, question_key),
    CONSTRAINT questions_pending_is_undecided CHECK ((status = 'pending') = (decided_at IS NULL)),
    CONSTRAINT questions_rejection_has_reason CHECK (status <> 'rejected' OR decision_reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS questions_one_per_request ON app.questions (user_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS questions_by_user_day ON app.questions (user_id, created_at);
CREATE INDEX IF NOT EXISTS questions_by_status ON app.questions (status, created_at);

CREATE OR REPLACE FUNCTION app.questions_decided_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.question IS DISTINCT FROM OLD.question OR NEW.question_key IS DISTINCT FROM OLD.question_key
        OR NEW.why IS DISTINCT FROM OLD.why OR NEW.gap IS DISTINCT FROM OLD.gap OR NEW.leads IS DISTINCT FROM OLD.leads
        OR NEW.related IS DISTINCT FROM OLD.related OR NEW.language IS DISTINCT FROM OLD.language
        OR NEW.via IS DISTINCT FROM OLD.via OR NEW.request_id IS DISTINCT FROM OLD.request_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR (NEW.api_key_id IS DISTINCT FROM OLD.api_key_id AND NEW.api_key_id IS NOT NULL)
        OR (OLD.status <> 'pending' AND (
            NEW.status IS DISTINCT FROM OLD.status
            OR (NEW.decided_by IS DISTINCT FROM OLD.decided_by AND NEW.decided_by IS NOT NULL)
            OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason OR NEW.decided_at IS DISTINCT FROM OLD.decided_at)) THEN
        RAISE EXCEPTION 'a submitted question cannot be changed, and a decided one stays decided';
    END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER questions_decided_is_final BEFORE UPDATE ON app.questions
    FOR EACH ROW EXECUTE FUNCTION app.questions_decided_is_final();
