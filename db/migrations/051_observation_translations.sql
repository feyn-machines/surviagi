-- Ontology schema v2.9.0: the Chinese wording of an observation (Issue #78).
-- Machine translations for reading (rule:translation-is-a-reading-aid): they stay
-- out of the identity hash and of every judgment, and quotes are not translated.
--
-- Only nullable columns and one new table: nothing stored is changed, and a run of
-- older code that does not name these columns goes on writing rows as before. An
-- empty column means not translated yet, and the reader gets the original wording.
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

-- One pass of translating observations.
CREATE TABLE IF NOT EXISTS public.observation_translation_runs (
    run_id         text PRIMARY KEY,
    model          text,
    prompt_sha256  text NOT NULL,
    counts         jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.observations
    ADD COLUMN IF NOT EXISTS task_zh_cn        text CHECK (task_zh_cn <> ''),
    ADD COLUMN IF NOT EXISTS scale_zh_cn       text CHECK (scale_zh_cn <> ''),
    ADD COLUMN IF NOT EXISTS conditions_zh_cn  text CHECK (conditions_zh_cn <> ''),
    ADD COLUMN IF NOT EXISTS actor_name_zh_cn  text CHECK (actor_name_zh_cn <> ''),
    ADD COLUMN IF NOT EXISTS translation_run_id text REFERENCES public.observation_translation_runs(run_id);

ALTER TABLE public.observation_facts
    ADD COLUMN IF NOT EXISTS what_zh_cn  text CHECK (what_zh_cn <> ''),
    ADD COLUMN IF NOT EXISTS unit_zh_cn  text CHECK (unit_zh_cn <> ''),
    ADD COLUMN IF NOT EXISTS translation_run_id text REFERENCES public.observation_translation_runs(run_id);
