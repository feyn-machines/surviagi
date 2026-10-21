-- Ontology schema v2.2.0: an update says who did it, about what, and on what
-- basis; some kinds also say what work was done and how it came out. Posts by
-- people can make an update or attach to one that already exists.
--
-- Everything here takes effect forward (rule:definitions-take-effect-forward):
-- the new columns are nullable, the rows already stored keep their
-- 'event_kind-2.0.0' marker and their values, and a row written from now on
-- carries 'event_kind-2.1.0' and the schema version it was extracted under.
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

ALTER TABLE public.extracted_events
    ADD COLUMN IF NOT EXISTS actor_account_key text REFERENCES public.source_accounts(account_key),
    ADD COLUMN IF NOT EXISTS subject text,
    ADD COLUMN IF NOT EXISTS basis text,
    ADD COLUMN IF NOT EXISTS task text,
    ADD COLUMN IF NOT EXISTS result text,
    ADD COLUMN IF NOT EXISTS quote text,
    ADD COLUMN IF NOT EXISTS schema_version text
        CHECK (schema_version IS NULL OR schema_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$');

-- event_kind 2.1.0 adds three kinds for evidence that does not come from the
-- vendor. The 2.0.0 branch keeps the fifteen terms of its day.
ALTER TABLE public.extracted_events DROP CONSTRAINT extracted_events_kind_check;
ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_kind_check CHECK (
    (kind_vocabulary = 'legacy-freeform'
        AND kind IS NOT NULL AND kind IN ('launch', 'release', 'update', 'pricing', 'availability', 'benchmark', 'partnership', 'deprecation', 'research', 'other'))
    OR (kind_vocabulary = 'event_kind-2.0.0' AND (
        (kind IS NOT NULL AND kind IN ('product_launch', 'version_release', 'availability_change', 'capability_update', 'pricing_change', 'benchmark_result', 'third_party_recognition', 'production_adoption', 'partnership', 'research_result', 'deprecation', 'personnel', 'event_announcement', 'incident', 'policy_statement'))
        OR (kind IS NULL AND unresolved_reason IS NOT NULL AND unresolved_reason <> '')
    ))
    OR (kind_vocabulary = 'event_kind-2.1.0' AND (
        (kind IS NOT NULL AND kind IN ('product_launch', 'version_release', 'availability_change', 'capability_update', 'pricing_change', 'benchmark_result', 'third_party_recognition', 'production_adoption', 'partnership', 'research_result', 'deprecation', 'personnel', 'event_announcement', 'incident', 'policy_statement', 'usage_report', 'independent_evaluation', 'failure_report'))
        OR (kind IS NULL AND unresolved_reason IS NOT NULL AND unresolved_reason <> '')
    ))
);

-- An update used to need a company. From 2.1.0 it needs the account that did
-- it; the company is filled only when that account belongs to a registered one.
ALTER TABLE public.extracted_events DROP CONSTRAINT extracted_events_new_vocabulary_needs_org;
ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_new_vocabulary_needs_org CHECK (
    (kind_vocabulary <> 'event_kind-2.0.0' OR primary_org_id IS NOT NULL)
    AND (kind_vocabulary <> 'event_kind-2.1.0' OR actor_account_key IS NOT NULL)
);

ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_basis_check
    CHECK (basis IS NULL OR basis IN ('vendor_claim', 'demonstration', 'own_use', 'measurement', 'production_use'));
ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_result_check
    CHECK (result IS NULL OR result IN ('succeeded', 'partly', 'failed', 'not_stated'));
-- The work and its outcome belong to the kinds that describe a use; on any
-- other kind they would only restate the title.
ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_task_only_on_use_kinds CHECK (
    (task IS NULL AND result IS NULL)
    OR kind = ANY (ARRAY['usage_report', 'independent_evaluation', 'failure_report', 'production_adoption'])
);
CREATE INDEX IF NOT EXISTS extracted_events_actor ON public.extracted_events (actor_account_key);

-- A number, price, limit, score, date or scope a post states, with the exact
-- words it came from. The extractor stores a fact only when those words are
-- found in the post text.
CREATE TABLE IF NOT EXISTS public.extracted_event_facts (
    fact_id            text PRIMARY KEY,
    event_id           text NOT NULL REFERENCES public.extracted_events(event_id) ON DELETE CASCADE,
    source_id          text NOT NULL REFERENCES public.collected_sources(source_id),
    value              text NOT NULL CHECK (value <> ''),
    unit               text,
    what               text NOT NULL CHECK (what <> ''),
    quote              text NOT NULL CHECK (quote <> ''),
    extraction_run_id  text NOT NULL REFERENCES public.extraction_runs(run_id)
);
CREATE INDEX IF NOT EXISTS extracted_event_facts_by_event ON public.extracted_event_facts (event_id);

-- A post the extractor read and found to say something of substance about an
-- update that already exists. Kept apart from event_posts, which is rebuilt in
-- full from the raw links and would lose it.
CREATE TABLE IF NOT EXISTS public.extracted_event_attachments (
    event_id           text NOT NULL REFERENCES public.extracted_events(event_id) ON DELETE CASCADE,
    source_id          text NOT NULL REFERENCES public.collected_sources(source_id),
    says               text NOT NULL CHECK (says <> ''),
    quote              text,
    extraction_run_id  text NOT NULL REFERENCES public.extraction_runs(run_id),
    PRIMARY KEY (event_id, source_id)
);
CREATE INDEX IF NOT EXISTS extracted_event_attachments_by_source ON public.extracted_event_attachments (source_id);

ALTER TABLE public.event_posts DROP CONSTRAINT event_posts_link_check;
ALTER TABLE public.event_posts ADD CONSTRAINT event_posts_link_check
    CHECK (link IN ('source', 'reply', 'quote', 'repost', 'mention', 'attached'));
