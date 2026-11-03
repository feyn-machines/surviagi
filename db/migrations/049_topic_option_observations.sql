-- Ontology schema v2.7.0: an observation stands under a topic only through one
-- of its answers, and a judge says which way it weighs
-- (rule:observations-weigh-on-answers-by-judgment). It replaces
-- topic_option_evidence, which did the same for updates (Issue #32, design §6).
--
-- Only new tables: the rows of 043 stay as they are and are no longer written
-- (rule:definitions-take-effect-forward).
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

-- An observation a judge found to weigh for or against one answer of a topic.
-- It says which way the observation weighs; no answer is declared right.
CREATE TABLE IF NOT EXISTS public.topic_option_observations (
    observation_id   text NOT NULL REFERENCES public.observations(observation_id) ON DELETE CASCADE,
    option_id        text NOT NULL REFERENCES public.topic_options(option_id),
    topic_id         text NOT NULL REFERENCES public.topics(topic_id),
    sign             text NOT NULL
        CHECK (sign IN ('supports', 'contradicts')),
    confidence       numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    judge            text NOT NULL,
    method           text NOT NULL
        CHECK (method IN ('source_id', 'ai_proposed', 'reviewed')),
    status           text NOT NULL
        CHECK (status IN ('source_reference', 'candidate', 'reviewed', 'rejected')),
    method_version   text NOT NULL,
    judgment_run_id  text NOT NULL REFERENCES public.judgment_runs(run_id),
    PRIMARY KEY (observation_id, option_id),
    CONSTRAINT topic_option_observations_proposed_is_candidate CHECK (
        method IS DISTINCT FROM 'ai_proposed' OR status = ANY (ARRAY['candidate', 'rejected']))
);
CREATE INDEX IF NOT EXISTS topic_option_observations_by_topic ON public.topic_option_observations (topic_id);

-- An observation that was judged against a topic, whatever the judge said. Most
-- observations weigh on no answer, and that is a finding: without this row the
-- same pair would be asked again on every pass.
CREATE TABLE IF NOT EXISTS public.topic_observation_checked (
    observation_id   text NOT NULL REFERENCES public.observations(observation_id) ON DELETE CASCADE,
    topic_id         text NOT NULL REFERENCES public.topics(topic_id),
    method_version   text NOT NULL,
    judgment_run_id  text NOT NULL REFERENCES public.judgment_runs(run_id),
    PRIMARY KEY (observation_id, topic_id, method_version)
);
