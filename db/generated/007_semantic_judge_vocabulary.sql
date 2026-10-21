-- Bring judgment_runs.judge and judgment_runs.task under the controlled
-- vocabularies. 006 wrote both lists literally, which is exactly the duplication
-- the semantic layer exists to remove, and it omitted 'interactive_review' — the
-- source of every capability, gate and edge currently proposed.
-- Generated from datasets/semantic/semantic-model.v2.json.
-- Transaction controlled by the migration runner.

ALTER TABLE public.judgment_runs DROP CONSTRAINT judgment_runs_judge_check;
ALTER TABLE public.judgment_runs ADD CONSTRAINT judgment_runs_judge_check
    CHECK (judge IN ('deepseek', 'typesafe', 'interactive_review'));

ALTER TABLE public.judgment_runs DROP CONSTRAINT judgment_runs_task_check;
ALTER TABLE public.judgment_runs ADD CONSTRAINT judgment_runs_task_check
    CHECK (task IN ('requires', 'blocked_by', 'demonstrates', 'event_kind', 'gate_state', 'serves_market', 'verification', 'model_identification', 'answer_evidence'));
