-- Run as oaw_kg_writer (the owner of schema kg) after db/published/001_kg.sql.
-- The site's role reads kg and nothing else; tables the writer adds later are readable too.
\set ON_ERROR_STOP on
GRANT USAGE ON SCHEMA kg TO oaw_site;
GRANT SELECT ON ALL TABLES IN SCHEMA kg TO oaw_site;
ALTER DEFAULT PRIVILEGES FOR ROLE oaw_kg_writer IN SCHEMA kg GRANT SELECT ON TABLES TO oaw_site;

-- Public article versions contain no private review data. The site can read these records;
-- only the writer can create versions or move the publication pointers.
GRANT USAGE ON SCHEMA editorial TO oaw_site;
GRANT SELECT ON ALL TABLES IN SCHEMA editorial TO oaw_site;
ALTER DEFAULT PRIVILEGES FOR ROLE oaw_kg_writer IN SCHEMA editorial GRANT SELECT ON TABLES TO oaw_site;
