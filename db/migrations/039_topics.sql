-- Ontology schema v2.3.0: topics. A topic is a closed question about one job or
-- one kind of business, with two to four answers that exclude each other. It
-- stays open while posts argue its answers; it carries no answer of its own
-- and nothing here records an outcome (rule:topic-carries-no-answer).
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

-- One run of reading a window of posts for claims and placing them.
CREATE TABLE IF NOT EXISTS public.topic_mining_runs (
    run_id           text PRIMARY KEY,
    version          text NOT NULL,
    model            text NOT NULL,
    embedding_model  text NOT NULL,
    window_start     timestamptz NOT NULL,
    window_end       timestamptz NOT NULL,
    counts           jsonb NOT NULL,
    -- What became of every claim, including those left out and why (rule:claim-outcome).
    outcomes         jsonb NOT NULL,
    ingested_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.topics (
    topic_id          text PRIMARY KEY,
    question_type     text NOT NULL
        CHECK (question_type IN ('replacement', 'viability')),
    object_key        text NOT NULL CHECK (object_key <> ''),
    question_en       text NOT NULL CHECK (question_en <> ''),
    question_zh_cn    text NOT NULL CHECK (question_zh_cn <> ''),
    state             text NOT NULL DEFAULT 'proposed'
        CHECK (state IN ('proposed', 'researching', 'dormant', 'merged', 'closed')),
    origin            text NOT NULL
        CHECK (origin IN ('mined', 'reader', 'editor')),
    -- The catalog entry the question is about; empty when the catalog has none.
    about_concept_id  text,
    about_method      text
        CHECK (about_method IN ('source_id', 'ai_proposed', 'reviewed')),
    about_status      text
        CHECK (about_status IN ('source_reference', 'candidate', 'reviewed', 'rejected')),
    merged_into       text REFERENCES public.topics(topic_id),
    -- The standard a topic was checked against when it was written (rule:topic-is-a-closed-question).
    checks            jsonb NOT NULL DEFAULT '{}'::jsonb,
    opened_at         timestamptz NOT NULL,
    state_changed_at  timestamptz NOT NULL DEFAULT now(),
    mining_run_id     text REFERENCES public.topic_mining_runs(run_id),
    schema_version    text NOT NULL CHECK (schema_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
    CONSTRAINT topics_about_is_whole CHECK (
        (about_concept_id IS NULL AND about_method IS NULL AND about_status IS NULL)
        OR (about_concept_id IS NOT NULL AND about_method IS NOT NULL AND about_status IS NOT NULL)),
    -- A machine's match to the catalog stays a candidate until a person confirms it.
    CONSTRAINT topics_proposed_about_is_candidate CHECK (
        about_method IS DISTINCT FROM 'ai_proposed' OR about_status = ANY (ARRAY['candidate', 'rejected'])),
    CONSTRAINT topics_merged_points_somewhere CHECK ((state = 'merged') = (merged_into IS NOT NULL)),
    CONSTRAINT topics_mined_names_its_run CHECK (origin <> 'mined' OR mining_run_id IS NOT NULL)
);
-- One object and one kind of question make one topic (rule:one-topic-per-object-and-question).
-- A merged or closed topic keeps its row and its id but frees the place.
CREATE UNIQUE INDEX IF NOT EXISTS topics_one_per_object_and_question
    ON public.topics (question_type, object_key) WHERE state NOT IN ('merged', 'closed');
CREATE INDEX IF NOT EXISTS topics_by_concept ON public.topics (about_concept_id);

CREATE TABLE IF NOT EXISTS public.topic_options (
    option_id   text PRIMARY KEY,
    topic_id    text NOT NULL REFERENCES public.topics(topic_id),
    position    integer NOT NULL CHECK (position >= 1),
    text_en     text NOT NULL CHECK (text_en <> ''),
    text_zh_cn  text NOT NULL CHECK (text_zh_cn <> ''),
    retired     boolean NOT NULL DEFAULT false,
    UNIQUE (topic_id, position)
);

-- A post's author asserts one answer of a topic. It records that the account
-- said so, not that the account is right.
CREATE TABLE IF NOT EXISTS public.topic_claims (
    source_id      text NOT NULL REFERENCES public.collected_sources(source_id),
    topic_id       text NOT NULL REFERENCES public.topics(topic_id),
    option_id      text NOT NULL REFERENCES public.topic_options(option_id),
    says           text NOT NULL CHECK (says <> ''),
    -- The post's own words; kept only when they were found in the post text.
    quote          text,
    mining_run_id  text NOT NULL REFERENCES public.topic_mining_runs(run_id),
    PRIMARY KEY (source_id, topic_id)
);
CREATE INDEX IF NOT EXISTS topic_claims_by_option ON public.topic_claims (option_id);

-- Search phrases that would find posts arguing a topic; what a search goes looking for.
CREATE TABLE IF NOT EXISTS public.topic_queries (
    topic_id       text NOT NULL REFERENCES public.topics(topic_id),
    query          text NOT NULL CHECK (query <> ''),
    mining_run_id  text REFERENCES public.topic_mining_runs(run_id),
    PRIMARY KEY (topic_id, query)
);
