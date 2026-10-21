-- The published dataset as versioned, immutable releases ("knowledge data").
--
-- Idempotent. Not a migration of the pipeline database: it is applied by
-- kg.ensure_schema to whichever database holds releases (local, or the server).
-- No entity attribute and no domain value list is defined here: documents are
-- stored whole and the ontology's schema.json is the only place they are typed.
CREATE SCHEMA IF NOT EXISTS kg;

-- One row per release. `loading` exists only inside the importing transaction
-- (or after a crash of an older importer); only `verified` can be activated.
CREATE TABLE IF NOT EXISTS kg.releases (
    seq            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    release_id     text NOT NULL UNIQUE,
    content_sha256 text NOT NULL UNIQUE,
    generated_at   timestamptz NOT NULL,
    manifest       jsonb NOT NULL,
    status         text NOT NULL CHECK (status IN ('loading', 'verified')),
    imported_at    timestamptz NOT NULL DEFAULT now(),
    verified_at    timestamptz
);

-- Content-addressed row bodies, append-only: identical rows are stored once
-- across every release, which is what makes a release incremental. `json`, not
-- `jsonb`: the text is kept exactly, so the content hash survives any number form.
CREATE TABLE IF NOT EXISTS kg.docs (
    sha256 text PRIMARY KEY,
    doc    json NOT NULL
);

-- Membership: which document sits at which position of which collection.
CREATE TABLE IF NOT EXISTS kg.release_rows (
    release_seq bigint NOT NULL REFERENCES kg.releases (seq) ON DELETE CASCADE,
    collection  text NOT NULL,
    ord         integer NOT NULL,
    entity_id   text,
    sha256      text NOT NULL REFERENCES kg.docs (sha256),
    PRIMARY KEY (release_seq, collection, ord)
);
CREATE INDEX IF NOT EXISTS release_rows_entity_idx
    ON kg.release_rows (collection, entity_id) WHERE entity_id IS NOT NULL;

-- Every identity that ever appeared; never deleted, so references to it from
-- user data stay valid across releases that drop it.
CREATE TABLE IF NOT EXISTS kg.entities (
    collection        text NOT NULL,
    entity_id         text NOT NULL,
    first_release_seq bigint NOT NULL REFERENCES kg.releases (seq),
    PRIMARY KEY (collection, entity_id)
);

-- Append-only activation log; the newest row is the live release.
CREATE TABLE IF NOT EXISTS kg.activations (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    release_seq  bigint NOT NULL REFERENCES kg.releases (seq),
    activated_at timestamptz NOT NULL DEFAULT now(),
    note         text
);

CREATE OR REPLACE VIEW kg.active AS
    SELECT r.*
      FROM kg.releases r
     WHERE r.seq = (SELECT release_seq FROM kg.activations ORDER BY id DESC LIMIT 1);
