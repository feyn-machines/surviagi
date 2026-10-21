-- Run as oaw_app (the owner of schema app). Repeatable: every statement is IF NOT EXISTS or OR REPLACE.
-- User data. Data releases (schema kg) never read or write anything here.

-- Better Auth 1.7.7 core tables, generated with getMigrations(...).compileMigrations()
-- (the code behind the Better Auth CLI) against PostgreSQL; names qualified with app., IF NOT EXISTS added.
CREATE TABLE IF NOT EXISTS app."user" (
    "id" text NOT NULL PRIMARY KEY,
    "name" text NOT NULL,
    "email" text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL,
    "image" text,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS app."session" (
    "id" text NOT NULL PRIMARY KEY,
    "expiresAt" timestamptz NOT NULL,
    "token" text NOT NULL UNIQUE,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamptz NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app."account" (
    "id" text NOT NULL PRIMARY KEY,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamptz,
    "refreshTokenExpiresAt" timestamptz,
    "scope" text,
    "password" text,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app."verification" (
    "id" text NOT NULL PRIMARY KEY,
    "identifier" text NOT NULL,
    "value" text NOT NULL,
    "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON app."session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON app."account" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON app."verification" ("identifier");

-- Who may review submissions. Synced from the owner's local ADMIN_EMAILS by setup; never edited by the site.
CREATE TABLE IF NOT EXISTS app.admins (
    email    text        PRIMARY KEY CHECK (email = lower(btrim(email)) AND position('@' in email) > 1),
    added_at timestamptz NOT NULL DEFAULT now()
);

-- A reader's request to monitor one X account. One row per reader and account.
CREATE TABLE IF NOT EXISTS app.submissions (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         text        NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
    platform        text        NOT NULL DEFAULT 'x' CHECK (platform = 'x'),
    handle          text        NOT NULL CHECK (handle ~ '^[a-z0-9_]{1,15}$'),
    display_handle  text        NOT NULL,
    owner_kind      text        NOT NULL CHECK (owner_kind IN ('person', 'organization')),
    note            text        CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 280),
    status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    decided_by      text        REFERENCES app."user"(id) ON DELETE SET NULL,
    decision_reason text        CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 280),
    decided_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    imported_at     timestamptz,
    CONSTRAINT submissions_one_per_user UNIQUE (user_id, platform, handle),
    CONSTRAINT submissions_display_matches CHECK (lower(display_handle) = handle),
    CONSTRAINT submissions_pending_is_undecided CHECK ((status = 'pending') = (decided_at IS NULL)),
    CONSTRAINT submissions_rejection_has_reason CHECK (status <> 'rejected' OR decision_reason IS NOT NULL),
    CONSTRAINT submissions_only_approved_imported CHECK (imported_at IS NULL OR status = 'approved')
);
CREATE INDEX IF NOT EXISTS submissions_by_account ON app.submissions (platform, handle, owner_kind);
CREATE INDEX IF NOT EXISTS submissions_by_status ON app.submissions (status, created_at);

-- A decision is final: once decided, only imported_at may change (set once, by the local pull).
-- Deleting the deciding user sets decided_by to null; that is allowed.
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
        OR (OLD.imported_at IS NOT NULL AND NEW.imported_at IS DISTINCT FROM OLD.imported_at)
    ) THEN
        RAISE EXCEPTION 'a decided submission cannot be changed';
    END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER submissions_decided_is_final BEFORE UPDATE ON app.submissions
    FOR EACH ROW EXECUTE FUNCTION app.submissions_decided_is_final();

-- What a reader asked to be told about. Unsubscribing keeps the row and dates it.
CREATE TABLE IF NOT EXISTS app.subscriptions (
    user_id         text        NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
    topic           text        NOT NULL CHECK (topic IN ('updates', 'weekly')),
    language        text        NOT NULL CHECK (language IN ('en', 'zh-CN')),
    subscribed_at   timestamptz NOT NULL DEFAULT now(),
    unsubscribed_at timestamptz,
    PRIMARY KEY (user_id, topic)
);

-- A reader's answer to a topic's question, one per reader, topic and calendar quarter (UTC). A vote
-- may be changed or withdrawn while its quarter runs; when the quarter ends it stays as it was, and the
-- reader votes again in the next. Votes are readers' views, counted apart from the evidence; they
-- decide nothing (rule:topic-carries-no-answer). The topic and its answer are ids of the published
-- data release, which lives in schema kg and is replaced whole, so they are checked by the site when a
-- vote is cast and by shape here.
CREATE TABLE IF NOT EXISTS app.topic_votes (
    user_id    text        NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
    topic_id   text        NOT NULL CHECK (topic_id ~ '^topic:[a-z_]+:[a-z0-9-]*:[0-9a-f]{8}$'),
    quarter    text        NOT NULL CHECK (quarter ~ '^[0-9]{4}-Q[1-4]$'),
    option_id  text        NOT NULL,
    voted_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, topic_id, quarter),
    CONSTRAINT topic_votes_option_of_topic CHECK (option_id ~ '^topic:.*#[a-h]$' AND left(option_id, length(option_id) - 2) = topic_id)
);
CREATE INDEX IF NOT EXISTS topic_votes_by_topic ON app.topic_votes (topic_id, quarter, option_id);

-- The quarter a moment falls in, as the pipeline writes it: 2026-Q4.
CREATE OR REPLACE FUNCTION app.quarter_of(moment timestamptz) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT to_char(moment AT TIME ZONE 'UTC', 'YYYY') || '-Q' || to_char(moment AT TIME ZONE 'UTC', 'Q')
$$;

-- A vote is cast or changed only in the quarter that is running; an ended quarter is closed.
-- Deleting stays allowed for any quarter: removing a reader removes their votes.
CREATE OR REPLACE FUNCTION app.topic_votes_in_running_quarter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.quarter IS DISTINCT FROM app.quarter_of(now()) THEN
        RAISE EXCEPTION 'a vote is cast in the running quarter only';
    END IF;
    NEW.voted_at := now();
    RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER topic_votes_in_running_quarter BEFORE INSERT OR UPDATE ON app.topic_votes
    FOR EACH ROW EXECUTE FUNCTION app.topic_votes_in_running_quarter();
