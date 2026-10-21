-- Add gate_state to the judgment task vocabulary. Generated from
-- datasets/semantic/semantic-model.v2.json.
-- Transaction controlled by the migration runner.

ALTER TABLE public.judgment_runs DROP CONSTRAINT judgment_runs_task_check;
ALTER TABLE public.judgment_runs ADD CONSTRAINT judgment_runs_task_check
    CHECK (task IN ('requires', 'blocked_by', 'demonstrates', 'event_kind', 'gate_state', 'serves_market', 'verification', 'model_identification', 'answer_evidence'));
