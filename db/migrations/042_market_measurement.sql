-- event_kind 2.2.0 adds market_measurement: a third party's own measurement of
-- a market or of work - use, spending, ranking, employment. Rows written under
-- earlier versions keep their marker and their values
-- (rule:definitions-take-effect-forward).
--
-- A market measurement hangs on a market or an occupation (event_measures) and
-- is never routed to work (rule:market-measurement-moves-no-level).
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

ALTER TABLE public.extracted_events DROP CONSTRAINT extracted_events_kind_check;
ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_kind_check CHECK (
    (kind_vocabulary = 'legacy-freeform'
        AND kind IS NOT NULL AND kind IN ('launch', 'release', 'update', 'pricing', 'availability', 'benchmark', 'partnership', 'deprecation', 'research', 'other'))
    OR (kind_vocabulary = 'event_kind-2.0.0' AND (
        (kind IS NOT NULL AND kind IN ('product_launch', 'version_release', 'availability_change', 'capability_update', 'pricing_change', 'benchmark_result', 'third_party_recognition', 'production_adoption', 'partnership', 'research_result', 'deprecation', 'personnel', 'event_announcement', 'incident', 'policy_statement'))
        OR (kind IS NULL AND unresolved_reason IS NOT NULL AND unresolved_reason <> '')
    ))
    OR (kind_vocabulary = 'event_kind-2.1.0' AND (
        (kind IS NOT NULL AND kind IN ('product_launch', 'version_release', 'availability_change', 'capability_update', 'pricing_change', 'benchmark_result', 'third_party_recognition', 'production_adoption', 'partnership', 'research_result', 'deprecation', 'personnel', 'incident', 'policy_statement', 'usage_report', 'independent_evaluation', 'failure_report'))
        OR (kind IS NULL AND unresolved_reason IS NOT NULL AND unresolved_reason <> '')
    ))
    OR (kind_vocabulary = 'event_kind-2.2.0' AND (
        (kind IS NOT NULL AND kind IN ('product_launch', 'version_release', 'availability_change', 'capability_update', 'pricing_change', 'benchmark_result', 'third_party_recognition', 'production_adoption', 'partnership', 'research_result', 'deprecation', 'personnel', 'incident', 'policy_statement', 'usage_report', 'independent_evaluation', 'failure_report', 'market_measurement'))
        OR (kind IS NULL AND unresolved_reason IS NOT NULL AND unresolved_reason <> '')
    ))
);

ALTER TABLE public.extracted_events DROP CONSTRAINT extracted_events_new_vocabulary_needs_org;
ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_new_vocabulary_needs_org CHECK (
    (kind_vocabulary <> 'event_kind-2.0.0' OR primary_org_id IS NOT NULL)
    AND (kind_vocabulary NOT IN ('event_kind-2.1.0', 'event_kind-2.2.0') OR actor_account_key IS NOT NULL)
);

-- One pass of saying which market or occupation each market measurement is about.
CREATE TABLE IF NOT EXISTS public.event_measure_runs (
    run_id           text PRIMARY KEY,
    model            text NOT NULL,
    embedding_model  text NOT NULL,
    counts           jsonb NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- The market or occupation a market measurement is about. Proposed by a model
-- from a shortlist; it stays a candidate until a person confirms it.
CREATE TABLE IF NOT EXISTS public.event_measures (
    event_id    text NOT NULL REFERENCES public.extracted_events(event_id) ON DELETE CASCADE,
    concept_id  text NOT NULL,
    method      text NOT NULL
        CHECK (method IN ('source_id', 'ai_proposed', 'reviewed')),
    status      text NOT NULL
        CHECK (status IN ('source_reference', 'candidate', 'reviewed', 'rejected')),
    rationale   text NOT NULL DEFAULT '',
    run_id      text NOT NULL REFERENCES public.event_measure_runs(run_id),
    PRIMARY KEY (event_id, concept_id),
    CONSTRAINT event_measures_proposed_is_candidate CHECK (
        method IS DISTINCT FROM 'ai_proposed' OR status = ANY (ARRAY['candidate', 'rejected']))
);
CREATE INDEX IF NOT EXISTS event_measures_by_concept ON public.event_measures (concept_id);

-- A measurement a pass has looked at, whether or not the catalog had an entry for
-- it. Without this, "about nothing we keep" would be asked again on every pass.
CREATE TABLE IF NOT EXISTS public.event_measure_checked (
    event_id  text PRIMARY KEY REFERENCES public.extracted_events(event_id) ON DELETE CASCADE,
    run_id    text NOT NULL REFERENCES public.event_measure_runs(run_id)
);

-- Which updates stand under which topic (rule:updates-reach-topics-by-the-catalog):
-- a market measurement of the entry the topic is about or of an entry under it,
-- or an update that is evidence for a piece of work in the market the topic is
-- about. Derived; an update is never placed under one of a topic's answers.
CREATE OR REPLACE VIEW public.topic_events AS
WITH under AS (
    -- An entry and everything the catalog puts directly or one step below it.
    SELECT id AS top, id AS entry FROM public.ontology_concepts
    UNION
    SELECT parent_id, child_id FROM public.ontology_relations
    UNION
    SELECT a.parent_id, b.child_id FROM public.ontology_relations a
      JOIN public.ontology_relations b ON b.parent_id = a.child_id
)
SELECT DISTINCT t.topic_id, m.event_id, 'measures'::text AS via
  FROM public.topics t
  JOIN under u ON u.top = t.about_concept_id
  JOIN public.event_measures m ON m.concept_id = u.entry AND m.status <> 'rejected'
 WHERE t.state NOT IN ('merged', 'closed')
UNION
SELECT DISTINCT t.topic_id, ae.event_id, 'evidences'::text
  FROM public.topics t
  JOIN under u ON u.top = t.about_concept_id
  JOIN public.activity_evidence ae ON ae.activity_id = u.entry AND ae.status <> 'rejected'
 WHERE t.state NOT IN ('merged', 'closed') AND t.question_type = 'viability';
