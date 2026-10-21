# infra — local infrastructure (Docker)

All local infrastructure for openaiwill, in one Compose file: `docker-compose.yml`
(PostgreSQL, MLflow, the embedding server and Meilisearch). Everything binds to `127.0.0.1` only and keeps its data under
the gitignored `data/` tree; nothing leaves the machine. Managed by
`scripts/data-local.py`:

```sh
pnpm data:models    # download the embedding model once (310 MB, checked against its digest)
pnpm data:up        # start everything (first run builds the MLflow image)
pnpm data:status    # Postgres status
pnpm data:down      # stop both (never removes volumes)
```

All persistence is bind-mounted under `infra/data/` (gitignored) so the data is a
visible, portable directory you control — not an opaque Docker-managed volume:
`infra/data/postgres` (PGDATA) and `infra/data/mlflow/` (MLflow sqlite + artifacts).
The PostgreSQL password secret stays at the repo-root `data/postgres/password`.

- **PostgreSQL** — `127.0.0.1:7543`, db `openaiwill_local`; data at `infra/data/postgres`.
- **MLflow** — experiment tracking for the scoring / progress method. Dashboard at
  **http://127.0.0.1:7545**; sqlite + artifacts under `infra/data/mlflow/`.
  Each scoring iteration logs one run (params = method config, note = what changed,
  metrics = loss + supporting), so progress is watchable without reading code changes.
  Clients log with `MLFLOW_TRACKING_URI=http://127.0.0.1:7545`. Telemetry disabled; no account.

- **Embeddings** — `127.0.0.1:7546`, llama.cpp serving EmbeddingGemma 2 (768 dimensions) with the
  OpenAI-compatible `/v1/embeddings`. The model file lives at `infra/data/models/`.
- **Meilisearch** — `127.0.0.1:7547`; data at `infra/data/meilisearch`, master key generated into
  `data/meilisearch/env` (0600). It calls the embedding server itself, so it is allowed to reach
  private addresses on the Compose network. It holds a copy that `pnpm data:search:index` refills.

`mlflow/Dockerfile` pins the MLflow server build.
