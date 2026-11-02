-- Ontology schema v2.5.0: the observation. One actor used one subject on one
-- piece of work, how it came out, on what basis, and where it is written.
-- Also the product (which is not a model), what it was on a given day, who
-- adopts it, and who invests in whom.
--
-- Only new tables, and one widened CHECK list: nothing already stored is
-- changed (rule:definitions-take-effect-forward). The level, stage and gate
-- tables stay as they are; they are no longer written once the pipeline
-- stops (Issue #35) and are not dropped.
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

-- event_basis gains 'statistic'. Rows already stored keep their value.
ALTER TABLE public.extracted_events DROP CONSTRAINT extracted_events_basis_check;
ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_basis_check
    CHECK (basis IS NULL OR basis IN ('vendor_claim', 'demonstration', 'own_use', 'measurement', 'production_use', 'statistic'));

-- A product is not a model (rule:product-is-not-model): the model registry
-- never holds one, even when it runs on a model or shares its brand.
CREATE TABLE IF NOT EXISTS public.products (
    product_id  text        PRIMARY KEY CHECK (product_id ~ '^product:[a-z0-9-]+:[a-z0-9-]+$'),
    org_id      text        REFERENCES public.org_registry(org_id),
    -- The maker as the source writes it, for a maker outside the registry.
    owner_name  text,
    name        text        NOT NULL CHECK (name <> ''),
    category    text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT products_has_a_maker CHECK (org_id IS NOT NULL OR owner_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS products_by_org ON public.products (org_id);

CREATE TABLE IF NOT EXISTS public.product_models (
    product_id  text NOT NULL REFERENCES public.products(product_id) ON DELETE CASCADE,
    model_id    text NOT NULL REFERENCES public.models(model_id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, model_id)
);
CREATE INDEX IF NOT EXISTS product_models_by_model ON public.product_models (model_id);

-- What a product was on one day. A later day is a new row; the earlier one is
-- never overwritten. Empty region, audience or price means the source does not
-- say, not that there is none.
CREATE TABLE IF NOT EXISTS public.product_availability (
    availability_id  text PRIMARY KEY,
    product_id       text NOT NULL REFERENCES public.products(product_id) ON DELETE CASCADE,
    as_of            date NOT NULL,
    stage            text NOT NULL CHECK (stage IN ('announced', 'preview', 'available', 'retired')),
    channel          text,
    region           text,
    audience         text,
    price            text,
    source_url       text NOT NULL CHECK (source_url <> ''),
    UNIQUE (product_id, as_of, channel)
);

-- The observation (rule:observation-is-one-actor-one-subject-one-work). The
-- id is 'obs-' and a hash of actor_key, subject_key, work_key and occurred_on.
CREATE TABLE IF NOT EXISTS public.observations (
    observation_id      text        PRIMARY KEY CHECK (observation_id ~ '^obs-[0-9a-f]{16}$'),
    actor_key           text        NOT NULL CHECK (actor_key <> ''),
    actor_org_id        text        REFERENCES public.org_registry(org_id),
    actor_person_id     text        REFERENCES public.people(person_id),
    actor_name          text,
    actor_role          text        NOT NULL
        CHECK (actor_role IN ('maker', 'adopter', 'practitioner', 'evaluator', 'researcher')),
    subject_key         text        NOT NULL CHECK (subject_key <> ''),
    subject_product_id  text        REFERENCES public.products(product_id),
    subject_model_id    text        REFERENCES public.models(model_id),
    work_key            text        NOT NULL CHECK (work_key <> ''),
    event_id            text        REFERENCES public.extracted_events(event_id),
    task                text        NOT NULL CHECK (task <> ''),
    evidence_type       text        NOT NULL
        CHECK (evidence_type IN ('vendor_claim', 'demonstration', 'own_use', 'measurement', 'production_use', 'statistic')),
    outcome             text        NOT NULL
        CHECK (outcome IN ('succeeded', 'partly', 'failed', 'not_stated')),
    direction           text        NOT NULL
        CHECK (direction IN ('ai_takes_on', 'human_still_needed', 'neutral')),
    scale               text,
    conditions          text,
    occurred_on         date,
    announced_at        timestamptz,
    observed_at         timestamptz,
    review_state        text        NOT NULL DEFAULT 'machine_proposed'
        CHECK (review_state IN ('machine_proposed', 'human_confirmed', 'human_rejected')),
    reviewed_at         timestamptz,
    extractor           text        NOT NULL CHECK (extractor <> ''),
    prompt_sha256       text,
    model               text,
    schema_version      text        NOT NULL CHECK (schema_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
    created_at          timestamptz NOT NULL DEFAULT now(),
    -- A person's decision carries its time; a machine's proposal carries none.
    CONSTRAINT observations_review_has_a_time CHECK ((review_state = 'machine_proposed') = (reviewed_at IS NULL)),
    -- The actor is a name, or an id that is on record, never neither.
    CONSTRAINT observations_actor_is_named CHECK (actor_org_id IS NOT NULL OR actor_person_id IS NOT NULL OR actor_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS observations_by_actor_org ON public.observations (actor_org_id);
CREATE INDEX IF NOT EXISTS observations_by_product ON public.observations (subject_product_id);
CREATE INDEX IF NOT EXISTS observations_by_model ON public.observations (subject_model_id);
CREATE INDEX IF NOT EXISTS observations_by_event ON public.observations (event_id);
CREATE INDEX IF NOT EXISTS observations_by_evidence ON public.observations (evidence_type, review_state);

-- Where an observation is written (rule:observation-quotes-are-found-in-the-source).
-- An observation without a source row is not stored; the extractor writes both
-- in one transaction. Not only X: source_id is set for an X post only.
CREATE TABLE IF NOT EXISTS public.observation_sources (
    source_ref       text PRIMARY KEY,
    observation_id   text NOT NULL REFERENCES public.observations(observation_id) ON DELETE CASCADE,
    source_type      text NOT NULL
        CHECK (source_type IN ('x_post', 'official_blog', 'case_page', 'report', 'paper')),
    url              text NOT NULL CHECK (url <> ''),
    source_id        text REFERENCES public.collected_sources(source_id),
    quote            text NOT NULL CHECK (quote <> ''),
    published_at     timestamptz,
    CONSTRAINT observation_sources_x_post_has_a_post CHECK ((source_type = 'x_post') = (source_id IS NOT NULL)),
    UNIQUE (observation_id, url)
);

-- A number, price, limit, score or date an observation rests on.
CREATE TABLE IF NOT EXISTS public.observation_facts (
    fact_id         text PRIMARY KEY,
    observation_id  text NOT NULL REFERENCES public.observations(observation_id) ON DELETE CASCADE,
    value           text NOT NULL CHECK (value <> ''),
    unit            text,
    what            text NOT NULL CHECK (what <> ''),
    baseline        text,
    method_note     text,
    quote           text NOT NULL CHECK (quote <> '')
);
CREATE INDEX IF NOT EXISTS observation_facts_by_observation ON public.observation_facts (observation_id);

-- The entries an observation is about (rule:work-mapping-stays-a-candidate).
-- A catalog entry is not a foreign key: the catalog is sealed with the ontology,
-- not stored in this database as rows of one table with a stable key set.
CREATE TABLE IF NOT EXISTS public.observation_concepts (
    observation_id  text NOT NULL REFERENCES public.observations(observation_id) ON DELETE CASCADE,
    concept_id      text NOT NULL CHECK (concept_id <> ''),
    method          text NOT NULL CHECK (method IN ('source_id', 'ai_proposed', 'reviewed')),
    status          text NOT NULL CHECK (status IN ('source_reference', 'candidate', 'reviewed', 'rejected')),
    rationale       text NOT NULL DEFAULT '',
    PRIMARY KEY (observation_id, concept_id),
    CONSTRAINT observation_concepts_proposed_is_candidate CHECK (
        method IS DISTINCT FROM 'ai_proposed' OR status = ANY (ARRAY['candidate', 'rejected']))
);
CREATE INDEX IF NOT EXISTS observation_concepts_by_concept ON public.observation_concepts (concept_id);

-- An organization uses a product or a model, at a stage, because an observation
-- says so (rule:adoption-needs-an-observation). Most adopters a source names are
-- not on the registry, so the name as written is kept when there is no id; a day
-- the source does not give stays null.
CREATE TABLE IF NOT EXISTS public.adoptions (
    adoption_id     text PRIMARY KEY,
    org_id          text REFERENCES public.org_registry(org_id),
    adopter_name    text,
    product_id      text REFERENCES public.products(product_id),
    model_id        text REFERENCES public.models(model_id),
    stage           text NOT NULL CHECK (stage IN ('in_use', 'planned', 'pilot', 'integrated', 'production')),
    adopted_on      date,
    scale           text,
    observation_id  text NOT NULL REFERENCES public.observations(observation_id),
    CONSTRAINT adoptions_adopter_is_named CHECK (org_id IS NOT NULL OR adopter_name IS NOT NULL),
    CONSTRAINT adoptions_one_subject CHECK ((product_id IS NULL) <> (model_id IS NULL))
);
CREATE INDEX IF NOT EXISTS adoptions_by_org ON public.adoptions (org_id);
CREATE INDEX IF NOT EXISTS adoptions_by_product ON public.adoptions (product_id);
CREATE INDEX IF NOT EXISTS adoptions_by_model ON public.adoptions (model_id);
CREATE INDEX IF NOT EXISTS adoptions_by_observation ON public.adoptions (observation_id);

-- Who holds a stake in whom, over a period. An unknown start stays null; an
-- open end means the stake is current.
CREATE TABLE IF NOT EXISTS public.org_investments (
    investment_id    text PRIMARY KEY,
    investor_org_id  text NOT NULL REFERENCES public.org_registry(org_id),
    investee_org_id  text NOT NULL REFERENCES public.org_registry(org_id),
    stake            text,
    started_on       date,
    ended_on         date,
    source_url       text NOT NULL CHECK (source_url <> ''),
    CONSTRAINT org_investments_not_self CHECK (investor_org_id <> investee_org_id),
    CONSTRAINT org_investments_period CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on)
);
CREATE INDEX IF NOT EXISTS org_investments_by_investee ON public.org_investments (investee_org_id);
