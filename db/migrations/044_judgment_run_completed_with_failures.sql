-- A judgment run that finished but left some batches or subjects undecided.
--
-- Five passes (route-events, map-activities, map-markets, map-gates and
-- topic-evidence) already close such a run as 'completed_with_failures', but the
-- CHECK from 006 knew only running/completed/failed: the closing UPDATE was
-- refused, the command failed after its work was written, and the run stayed
-- 'running'. The undecided subjects are not checkpointed and are asked again on
-- the next run; the counts are in params.
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

ALTER TABLE public.judgment_runs DROP CONSTRAINT judgment_runs_status_check;
ALTER TABLE public.judgment_runs ADD CONSTRAINT judgment_runs_status_check
    CHECK (status IN ('running', 'completed', 'completed_with_failures', 'failed'));
