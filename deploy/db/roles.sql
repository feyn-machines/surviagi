-- Run as the superuser by `pnpm db:setup`. Repeatable: roles and the database are created
-- if absent, and the role passwords are brought in line with db.env every time.
-- The passwords arrive as environment variables of the psql process and are never printed.
\set ON_ERROR_STOP on
\getenv writer_password OAW_KG_WRITER_PASSWORD
\getenv site_password OAW_SITE_PASSWORD
\getenv app_password OAW_APP_PASSWORD
\getenv superuser_password POSTGRES_PASSWORD

SELECT format('CREATE ROLE oaw_kg_writer LOGIN PASSWORD %L', :'writer_password')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'oaw_kg_writer') \gexec
SELECT format('CREATE ROLE oaw_site LOGIN PASSWORD %L', :'site_password')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'oaw_site') \gexec
SELECT format('CREATE ROLE oaw_app LOGIN PASSWORD %L', :'app_password')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'oaw_app') \gexec
SELECT format('ALTER ROLE oaw_kg_writer NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'writer_password') \gexec
SELECT format('ALTER ROLE oaw_site NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'site_password') \gexec
SELECT format('ALTER ROLE oaw_app NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_password') \gexec

-- Also keeps the superuser's password equal to db.env after a regenerated db.env (the volume's original one is
-- only used when the data directory is first created); setup itself connects through the socket.
SELECT format('ALTER ROLE postgres PASSWORD %L', :'superuser_password') \gexec

SELECT 'CREATE DATABASE openaiwill OWNER oaw_kg_writer'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openaiwill') \gexec

REVOKE ALL ON DATABASE openaiwill FROM PUBLIC;
GRANT CONNECT ON DATABASE openaiwill TO oaw_site;
GRANT CONNECT ON DATABASE openaiwill TO oaw_app;

\connect openaiwill
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- User data (schema app) belongs to oaw_app alone: oaw_site and oaw_kg_writer get nothing on it, and oaw_app gets
-- nothing on kg. The tables are created by oaw_app from db/app/*.sql.
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION oaw_app;
ALTER SCHEMA app OWNER TO oaw_app;
ALTER ROLE oaw_app SET search_path = app;
