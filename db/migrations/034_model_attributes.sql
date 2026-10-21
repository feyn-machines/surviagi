-- Two catalog attributes of a model, defined in the semantic model (node kind
-- `model`, v2.1.0): whether its weights are published, and what it produces.
--
-- Both come from the catalog and follow rule:catalog-disagreement-is-null: the
-- maker's own listing, or every listing agreeing; otherwise nothing is stored.
-- A missing value is not "closed weights" and not "produces nothing".
--
-- Input modalities, context size, price and knowledge cutoff are deliberately
-- left out: input modalities disagree between providers for most models, and
-- the rest say nothing about which work a model can complete.
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

ALTER TABLE public.models ADD COLUMN IF NOT EXISTS open_weights boolean;

CREATE TABLE IF NOT EXISTS public.model_output_modalities (
    model_id text NOT NULL REFERENCES public.models(model_id) ON DELETE CASCADE,
    modality text NOT NULL CHECK (modality IN ('text', 'image', 'audio', 'video')),
    PRIMARY KEY (model_id, modality)
);
