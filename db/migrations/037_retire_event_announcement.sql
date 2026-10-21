-- event_kind 2.1.0 retires event_announcement: a conference, contest or workshop
-- is neither something an AI product can now do nor someone's account of using
-- one. The rows written under 2.0.0 keep the term and stay readable
-- (rule:definitions-take-effect-forward); a row written from now on cannot carry it.
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
);
