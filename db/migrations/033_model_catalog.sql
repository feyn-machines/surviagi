-- A reference catalog beside the mention-grown model registry.
--
-- Migration 032 let a model enter only from a mention. A catalog (models.dev)
-- already knows the recent releases of the companies we follow, so its names go
-- into the alias table and a mention resolves to an existing model before a new
-- candidate is opened (model_catalog.apply).
--
-- Three things stay apart: the company that makes a model (org_registry), the
-- provider that serves it (model_providers) and the model (models). A catalog
-- entry is not a confirmation: status still moves only on the owner's own
-- release update, and the catalog's date is kept beside released_at, not in it.
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

ALTER TABLE public.models
    ADD COLUMN IF NOT EXISTS catalog_id          text UNIQUE,
    ADD COLUMN IF NOT EXISTS catalog_released_on date,
    ALTER COLUMN first_seen_event_id DROP NOT NULL;
-- A model comes from a mention, from the catalog, or both.
ALTER TABLE public.models ADD CONSTRAINT models_have_an_origin
    CHECK (first_seen_event_id IS NOT NULL OR catalog_id IS NOT NULL);

CREATE TABLE IF NOT EXISTS public.model_providers (
    provider_id text PRIMARY KEY CHECK (provider_id ~ '^provider:[a-z0-9-]+$'),
    name        text NOT NULL CHECK (name <> ''),
    -- first_party: the maker's own API. cloud: a platform serving several makers' models.
    kind        text NOT NULL CHECK (kind IN ('first_party', 'cloud')),
    -- The company that runs the provider, when it is one we follow.
    org_id      text REFERENCES public.org_registry(org_id)
);

-- Which provider lists which model, and since when.
CREATE TABLE IF NOT EXISTS public.model_offerings (
    model_id    text NOT NULL REFERENCES public.models(model_id) ON DELETE CASCADE,
    provider_id text NOT NULL REFERENCES public.model_providers(provider_id),
    listed_on   date NOT NULL,
    PRIMARY KEY (model_id, provider_id)
);
CREATE INDEX IF NOT EXISTS model_offerings_by_provider ON public.model_offerings (provider_id);

CREATE TABLE IF NOT EXISTS public.model_catalog_imports (
    import_id       text          PRIMARY KEY,
    source          text          NOT NULL,
    url             text          NOT NULL,
    fetched_at      timestamptz   NOT NULL,
    snapshot_sha256 public.sha256 NOT NULL,
    since           date          NOT NULL,
    counts          jsonb         NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
    imported_at     timestamptz   NOT NULL DEFAULT now()
);
