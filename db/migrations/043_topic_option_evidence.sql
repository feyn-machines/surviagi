-- Ontology schema v2.4.0: an update stands under a topic only through one of its
-- answers, and a judge says which way it weighs (rule:updates-weigh-on-answers-by-judgment).
--
-- The view of 042 listed every update of a market group under every topic that
-- hangs on that group: 2,547 rows under 17 topics, the same rows under each topic
-- of a group. Being in the same market is not being about the question.
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

DROP VIEW IF EXISTS public.topic_events;

ALTER TABLE public.judgment_runs DROP CONSTRAINT judgment_runs_task_check;
ALTER TABLE public.judgment_runs ADD CONSTRAINT judgment_runs_task_check
    CHECK (task IN ('requires', 'blocked_by', 'demonstrates', 'event_kind', 'gate_state', 'serves_market', 'verification', 'model_identification', 'answer_evidence'));

-- An update a judge found to weigh for or against one answer of a topic. It
-- says which way the update weighs; no answer is declared right.
CREATE TABLE IF NOT EXISTS public.topic_option_evidence (
    event_id         text NOT NULL REFERENCES public.extracted_events(event_id) ON DELETE CASCADE,
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
    PRIMARY KEY (event_id, option_id),
    CONSTRAINT topic_option_evidence_proposed_is_candidate CHECK (
        method IS DISTINCT FROM 'ai_proposed' OR status = ANY (ARRAY['candidate', 'rejected']))
);
CREATE INDEX IF NOT EXISTS topic_option_evidence_by_topic ON public.topic_option_evidence (topic_id);

-- An update that was judged against a topic, whatever the judge said. Most
-- updates weigh on no answer, and that is a finding: without this row the same
-- pair would be asked again on every pass, and a topic opened later could not
-- be told from one already looked at.
CREATE TABLE IF NOT EXISTS public.topic_evidence_checked (
    event_id         text NOT NULL REFERENCES public.extracted_events(event_id) ON DELETE CASCADE,
    topic_id         text NOT NULL REFERENCES public.topics(topic_id),
    method_version   text NOT NULL,
    judgment_run_id  text NOT NULL REFERENCES public.judgment_runs(run_id),
    PRIMARY KEY (event_id, topic_id, method_version)
);

-- The words an answer had before it was reworded. An answer keeps its id and
-- its place when its wording is revised (rule:topic-ids-are-stable); what it
-- used to say stays readable here.
CREATE TABLE IF NOT EXISTS public.topic_option_revisions (
    option_id    text NOT NULL REFERENCES public.topic_options(option_id),
    replaced_at  timestamptz NOT NULL DEFAULT now(),
    text_en      text NOT NULL,
    text_zh_cn   text NOT NULL,
    reason       text NOT NULL,
    PRIMARY KEY (option_id, replaced_at)
);
