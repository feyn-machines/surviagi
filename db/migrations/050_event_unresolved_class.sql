-- Ontology schema v2.8.0: why an update has no kind, as a controlled class over
-- the free-text reason extraction wrote (Issue #28). The reason explains one row;
-- the class makes them countable.
--
-- Only new tables: extracted_events is not touched, and a row that later gets a
-- kind simply stops being read here (rule:definitions-take-effect-forward).
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

-- One pass of classing unresolved updates.
CREATE TABLE IF NOT EXISTS public.event_unresolved_runs (
    run_id         text PRIMARY KEY,
    model          text,
    prompt_sha256  text NOT NULL,
    counts         jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- The class of one unresolved update. A row means it has been read: an empty class
-- is a model that named no term, which is a finding and is not asked again.
CREATE TABLE IF NOT EXISTS public.event_unresolved_classes (
    event_id          text PRIMARY KEY REFERENCES public.extracted_events(event_id) ON DELETE CASCADE,
    unresolved_class  text
        CHECK (unresolved_class IN ('no_readable_content', 'teaser', 'not_an_update', 'kind_undecided', 'extractor_fault')),
    run_id            text NOT NULL REFERENCES public.event_unresolved_runs(run_id)
);
