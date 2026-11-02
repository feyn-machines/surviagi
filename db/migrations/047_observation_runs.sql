-- How observations were read (Issue #25): one row per extraction run, which
-- posts each extractor version has read, and what each run said about each
-- observation it wrote. Process records, like extraction_runs: they say how a
-- fact was obtained and are not classes of the ontology.
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

CREATE TABLE IF NOT EXISTS public.observation_runs (
    run_id             text        PRIMARY KEY CHECK (run_id <> ''),
    extractor          text        NOT NULL CHECK (extractor <> ''),
    model              text        NOT NULL CHECK (model <> ''),
    prompt_sha256      text        NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
    schema_version     text        NOT NULL CHECK (schema_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
    params             jsonb       NOT NULL,
    window_start       timestamptz,
    window_end         timestamptz,
    started_at         timestamptz NOT NULL,
    finished_at        timestamptz NOT NULL,
    candidate_count    integer     NOT NULL CHECK (candidate_count >= 0),
    read_count         integer     NOT NULL CHECK (read_count >= 0 AND read_count <= candidate_count),
    observation_count  integer     NOT NULL CHECK (observation_count >= 0),
    run_sha256         text        NOT NULL CHECK (run_sha256 ~ '^[0-9a-f]{64}$'),
    ingested_at        timestamptz NOT NULL DEFAULT now()
);

-- A post read under one extractor version, whether or not it gave an
-- observation. A post of a batch that failed is not here, so it is read again
-- by a later run. A new extractor version reads every post again.
CREATE TABLE IF NOT EXISTS public.observation_reads (
    source_id  text NOT NULL REFERENCES public.collected_sources(source_id),
    extractor  text NOT NULL CHECK (extractor <> ''),
    run_id     text NOT NULL REFERENCES public.observation_runs(run_id),
    PRIMARY KEY (source_id, extractor)
);
CREATE INDEX IF NOT EXISTS observation_reads_by_run ON public.observation_reads (run_id);

-- What one run said about an observation it wrote or found again: the work in
-- the model's own words, which the mapping pass to catalog entries reads
-- (rule:work-mapping-stays-a-candidate), and the actor and subject as written.
CREATE TABLE IF NOT EXISTS public.observation_readings (
    observation_id  text NOT NULL REFERENCES public.observations(observation_id) ON DELETE CASCADE,
    run_id          text NOT NULL REFERENCES public.observation_runs(run_id),
    work            text NOT NULL CHECK (work <> ''),
    actor           text NOT NULL CHECK (actor <> ''),
    subject         text,
    PRIMARY KEY (observation_id, run_id)
);
CREATE INDEX IF NOT EXISTS observation_readings_by_run ON public.observation_readings (run_id);
