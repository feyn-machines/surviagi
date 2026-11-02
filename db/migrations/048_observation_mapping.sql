-- How observations were mapped to the catalog (Issue #25): one row per mapping
-- run, which observations each mapper version has looked at (also the ones that
-- fit no entry, so they are not asked again), and which observation was merged
-- into which once mapping showed them to be the same
-- (rule:observation-is-one-actor-one-subject-one-work). Process records, like
-- event_measure_runs: they say how a fact was obtained and are not classes of
-- the ontology. The entries themselves are observation_concepts (046).
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

CREATE TABLE IF NOT EXISTS public.observation_mapping_runs (
    run_id           text        PRIMARY KEY CHECK (run_id <> ''),
    mapper           text        NOT NULL CHECK (mapper <> ''),
    model            text        NOT NULL CHECK (model <> ''),
    embedding_model  text        NOT NULL CHECK (embedding_model <> ''),
    prompt_sha256    text        NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
    counts           jsonb       NOT NULL,
    started_at       timestamptz NOT NULL,
    finished_at      timestamptz NOT NULL DEFAULT now()
);

-- An observation looked at under one mapper version, whether or not an entry fit.
-- One whose call failed is not here, so a later run asks again.
CREATE TABLE IF NOT EXISTS public.observation_mapping_checked (
    observation_id  text NOT NULL REFERENCES public.observations(observation_id) ON DELETE CASCADE,
    mapper          text NOT NULL CHECK (mapper <> ''),
    run_id          text NOT NULL REFERENCES public.observation_mapping_runs(run_id),
    PRIMARY KEY (observation_id, mapper)
);
CREATE INDEX IF NOT EXISTS observation_mapping_checked_by_run ON public.observation_mapping_checked (run_id);

-- An observation found, after mapping, to be the same as an earlier one. It keeps
-- its id and its rows; its sources and facts are also written under the one it
-- was merged into, and its id is a redirect to that one. Nothing is deleted.
CREATE TABLE IF NOT EXISTS public.observation_merges (
    observation_id  text        PRIMARY KEY REFERENCES public.observations(observation_id) ON DELETE CASCADE,
    merged_into     text        NOT NULL REFERENCES public.observations(observation_id) ON DELETE CASCADE,
    run_id          text        NOT NULL REFERENCES public.observation_mapping_runs(run_id),
    merged_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT observation_merges_not_into_itself CHECK (observation_id <> merged_into)
);
CREATE INDEX IF NOT EXISTS observation_merges_by_head ON public.observation_merges (merged_into);
