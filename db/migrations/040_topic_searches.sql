-- Ontology schema v2.3.0: a search made for a topic. The phrases come from the
-- topic (topic_queries); this records that a collection run searched for one
-- of them and how many posts came back, so a result can be traced to the
-- topic it was looked for, and a topic shows when it was last searched.
--
-- A search returns a sample, never a count of who said what.
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

CREATE TABLE IF NOT EXISTS public.topic_searches (
    collection_run_id  text NOT NULL REFERENCES public.collection_runs(run_id),
    topic_id           text NOT NULL REFERENCES public.topics(topic_id),
    query              text NOT NULL CHECK (query <> ''),
    posts_returned     integer NOT NULL CHECK (posts_returned >= 0),
    stop_reason        text,
    searched_at        timestamptz NOT NULL,
    PRIMARY KEY (collection_run_id, topic_id, query)
);
CREATE INDEX IF NOT EXISTS topic_searches_by_topic ON public.topic_searches (topic_id, searched_at);
