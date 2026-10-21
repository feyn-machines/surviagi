# Server Database and Data Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run openaiwill as a normal system: a PostgreSQL database on the server holding versioned published data, a website that reads it at runtime, and two independent release lines — code and data.

**Architecture:** The published dataset (what `publish.build()` produces) is stored row by row in a `kg` schema: immutable releases, content-addressed documents (so a release only writes rows that are new or changed), a membership table per release, an entity registry and an append-only activation log. The site loads the active release into memory at start and re-checks the pointer every 30 seconds; pages render per request. Code ships with the existing `site:release` / `site:promote`; data ships with `data:release` / `data:promote` through an SSH forward.

**Tech Stack:** PostgreSQL 16, Python 3 + psycopg 3 (the existing data runtime in `data/runtime/venv`), Next.js 16.3.4 (`instrumentation.ts`, `pg`), Docker Compose, SSH.

**Spec:** `docs/superpowers/specs/2026-10-03-server-database-and-data-releases-design.md`

## Global Constraints

- Read the relevant guide under `node_modules/next/dist/docs/01-app/` before writing Next.js code (`instrumentation`, route segment config, self-hosting).
- Published data only: nothing from raw captures, crawler state, `data/`, `local/` or `.env*` goes to the server. The server address, user and key path live only in the ignored `.env.deploy`; database passwords live only on the server. Nothing of the kind in tracked files.
- `kg` data is append-only. A release is immutable once `verified`. Activation is a new row in `kg.activations`, never an update. Imports never touch any schema other than `kg`.
- Entity attributes are not redefined as SQL columns or CHECK lists (the ontology's `schema.json` is the only definition); `kg.docs.doc` holds the published row as JSON.
- Hashing uses the existing `canonical` / `digest` in `scripts/data_pipeline/pipeline.py`; a release is `verified` only if the dataset reassembled from the database hashes to its manifest's `content_sha256`.
- Languages `en` and `zh-CN`; English unprefixed, Chinese under `/zh-CN`; every user-facing string in both; UI copy short. All existing SEO/GEO behaviour (canonical, hreflang, sitemap, robots, JSON-LD, `llms.txt`, header/footer links) stays as it is.
- Server names: Docker network `openaiwill`; database project `openaiwill-db`, container port 5432, host `127.0.0.1:5434`, database `openaiwill`, roles `oaw_kg_writer` and `oaw_site` (read-only on `kg`); site slots unchanged (`openaiwill` on 8320, `openaiwill-next` on 8321); server root `/opt/openaiwill`.
- Tasks 1–3 are local only: no ssh, no remote command, no `.env.deploy` edits. Task 4 is run by the controller.
- Kill only processes you started, by PID. Never `git add -A` at the repo root; never add `output/`. Commit per task; end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm check` passes at the end of each task, including with neither a database nor a snapshot file available to the site.

## Review Focus

1. **Re-running a data release** (same snapshot twice, or after a crash mid-import): expected no duplicate release, no orphaned `loading` release blocking the next run, no changed rows reported.
2. **A snapshot whose content does not match its manifest**, or an import that reassembles to a different hash: expected the release is not `verified`, cannot be activated, and the active release is unchanged.
3. **The database is unreachable**: at site start → the server fails to start (so a candidate cannot pass); while running → the site keeps serving the release it has; data commands fail with one clear line, not a traceback.
4. **A data promote while the site is serving**: expected no request sees a half-swapped dataset, and `/healthz` reports the new data release within the poll interval.
5. **An address that is not in the active release** (`/markets/nope`, an event removed by a newer release): expected HTTP 404 in both languages, and it is not in the sitemap.

## File Structure

| File | Responsibility |
| --- | --- |
| `db/published/001_kg.sql` (create) | The `kg` schema. Applied by the kg tooling to any target database. |
| `scripts/data_pipeline/kg.py` (create) | Pure packing (`pack`), and database operations: `ensure_schema`, `import_release`, `load_release`, `activate`, `rollback`, `status`, `diff`. |
| `scripts/data-release.py` (create) | CLI: `release`, `promote`, `rollback`, `status`, `setup-db`; `--target local|server`. Server access through an SSH forward. |
| `scripts/tests/test_data_kg_unit.py`, `scripts/tests/test_data_kg.py` (create) | Pure tests and real-PostgreSQL tests. |
| `src/lib/snapshot.ts` (modify) | The in-memory dataset: typed accessors over a store that can be replaced. |
| `src/lib/snapshot-source.ts` (create) | Loading a dataset from the database or from the snapshot files. |
| `src/instrumentation.ts` (create) | Load at start; poll the active pointer. |
| `deploy/db/compose.yml`, `deploy/compose.yml` (create / modify) | Database service; site joins the network and reads its env file. |
| `scripts/site_release.py` (modify) | Code release without data. |
| `docs/development/deployment.md` (rewrite sections) | Runbook for both release lines. |

---

### Task 1: The `kg` schema and the data-release library

**Files:** create `db/published/001_kg.sql`, `scripts/data_pipeline/kg.py`, `scripts/data-release.py`, `scripts/tests/test_data_kg_unit.py`, `scripts/tests/test_data_kg.py`; modify `package.json`.

**Interfaces — Produces:**

```sql
-- db/published/001_kg.sql (idempotent: CREATE … IF NOT EXISTS)
CREATE SCHEMA IF NOT EXISTS kg;
kg.releases(seq bigint identity PK, release_id text UNIQUE NOT NULL, content_sha256 text UNIQUE NOT NULL,
            generated_at timestamptz NOT NULL, manifest jsonb NOT NULL,
            status text NOT NULL CHECK (status IN ('loading','verified')),
            imported_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz)
kg.docs(sha256 text PK, doc jsonb NOT NULL)
kg.release_rows(release_seq bigint REFERENCES kg.releases(seq) ON DELETE CASCADE, collection text, ord integer,
                entity_id text, sha256 text REFERENCES kg.docs(sha256), PRIMARY KEY (release_seq, collection, ord))
  + index on (collection, entity_id) WHERE entity_id IS NOT NULL
kg.entities(collection text, entity_id text, first_release_seq bigint REFERENCES kg.releases(seq), PRIMARY KEY (collection, entity_id))
kg.activations(id bigint identity PK, release_seq bigint NOT NULL REFERENCES kg.releases(seq),
               activated_at timestamptz NOT NULL DEFAULT now(), note text)
kg.active  -- view: the release of the newest activation, or no row
```

```python
# scripts/data_pipeline/kg.py
COLLECTIONS: dict[str, str | None]   # collection name -> entity id field, in a fixed order
def read_snapshot(directory: Path) -> tuple[dict, dict]          # (payload, manifest); raises KgError if files are missing or hash/counts mismatch
def release_id(manifest: dict) -> str                             # "<generated_at UTC YYYYMMDDTHHMMSSZ>-<content_sha256[:8]>"
def pack(payload: dict) -> list[Row]                              # Row(collection, ord, entity_id, sha256, doc); list payloads -> one row per element; dict payloads -> one row, ord 0
def unpack(rows: Iterable[tuple[str, int, Any]]) -> dict          # inverse of pack: (collection, ord, doc) -> payload
def ensure_schema(conn) -> None
def import_release(conn, payload: dict, manifest: dict) -> ImportResult   # release_id, seq, created: bool, docs_written: int
def load_release(conn, seq: int) -> dict                          # payload reassembled from the database
def diff(conn, seq: int, against_seq: int | None) -> dict[str, dict[str, int]]   # per collection: added / changed / removed (by entity_id where present, else by sha multiset)
def activate(conn, release_id: str, note: str = "") -> None       # only a verified release; no-op if already active
def rollback(conn) -> str                                         # activates the previously active distinct release; raises KgError if none
def status(conn) -> dict                                          # releases (newest first), active release_id
class KgError(Exception)
```

CLI `scripts/data-release.py {release|promote|rollback|status} [--target local|server] [--snapshot DIR]`. In this task only `--target local` is implemented (the pipeline's `connect()`); `--target server` raises "server target arrives with the deployment task" so the interface is fixed. `package.json`: `data:release`, `data:promote`, `data:rollback`, `data:status` (all via `data/runtime/venv/bin/python`), defaulting to `--target server`; add `data:kg:test:unit` to `check` if it is dependency-free.

**Requirements:**

- `COLLECTIONS` covers every document in the snapshot: `chain.activities` (`activity_id`), `chain.gates` (`gate_id`), `chain.events` (`event_id`), `chain.evidence`, `chain.gate_edges`, `markets`, `tasks`, `events` (`event_id`), `models`, `sources`, `coverage`, `progress`. Read the real files in `datasets/published/latest/` and the types in `src/lib/snapshot.ts` to pick the id field of `models` and `sources`; a field is an entity id only if it is present and unique in the current data — assert that in a test.
- A document's `sha256` is `digest(doc)`. `pack` then `unpack` is the identity on the payload; `digest(unpack(pack(payload)))` equals the manifest's `content_sha256` for the current real snapshot (test with the real files when present, skip otherwise).
- `import_release` runs in one transaction: insert the release as `loading`; insert documents `ON CONFLICT DO NOTHING` (use `COPY` or batched inserts — about 20,000 rows must import in seconds); insert membership rows and new `kg.entities` rows; reassemble with `load_release` and compare `digest` to `manifest["content_sha256"]`; on equality set `verified`, otherwise raise `KgError` and roll back so nothing remains. If `jsonb` storage cannot reproduce the hash (number or key normalisation), store `doc` as `json` instead and say so — do not weaken the verification.
- Importing a snapshot whose `content_sha256` already exists as a verified release returns it with `created=False` and writes nothing. A leftover `loading` release (crash) with the same hash is removed and re-imported.
- `activate` appends to `kg.activations`; refuses a non-`verified` or unknown release with `KgError`. `rollback` re-activates the release that was active before the current one.
- `diff` drives the human-readable summary printed by `release`: per collection, rows added / changed / removed compared with the active release.
- Errors reach the terminal as one line (`error: …`), exit status 1; no tracebacks for `KgError` or connection failures.

**Tests:** pure tests need no database (`test_data_kg_unit.py`): pack/unpack identity, `release_id` format and UTC conversion, entity id extraction, `diff` logic on small payloads if factored purely. Database tests (`test_data_kg.py`, run by the existing `pnpm data:test` against local PostgreSQL in a scratch database or a rolled-back transaction — follow how the existing `test_data_*.py` real-database tests isolate themselves): import → verified and reassembles to the same hash; second import is a no-op; a second release sharing most rows writes only the new documents; a tampered payload (manifest hash kept) is rejected and leaves no release; activate / rollback / status; entities are never removed when a later release drops them; activation of a `loading` release is refused.

- [ ] Write the failing tests, then the schema and library, then the CLI.
- [ ] Run against the real snapshot: `data/runtime/venv/bin/python scripts/data-release.py release --target local`, then `status`, `promote`, a second `release` (must report nothing new), and report the printed output and the import time. If local PostgreSQL is not running, start it with `pnpm data:up`; if Docker itself is not running, report BLOCKED for the database steps only.
- [ ] `pnpm data:test:unit`, `pnpm data:test`, `pnpm ontology:check`, `pnpm security:check`, `pnpm check`.
- [ ] Commit — `Store published data as versioned releases in a kg schema`

---

### Task 2: The site reads the active release

**Files:** modify `src/lib/snapshot.ts`, every importer of it (17 files; `grep -rln "lib/snapshot" src`), `src/lib/site-pages.ts`, `src/lib/seo.ts`, `src/lib/home-data.ts`, `src/app/sitemap.ts`, `src/app/llms.txt/route.ts`, `src/app/healthz/route.ts`, `src/app/[lang]/layout.tsx` and the five detail pages, `next.config.ts`, `package.json`, `scripts/tests/site-output.test.mjs`; create `src/lib/snapshot-source.ts`, `src/instrumentation.ts`.

**Interfaces:**

- Consumes: the `kg` schema of Task 1. The dataset for release `seq` is `SELECT rr.collection, rr.ord, d.doc FROM kg.release_rows rr JOIN kg.docs d USING (sha256) WHERE rr.release_seq = $1 ORDER BY rr.collection, rr.ord`; the active release is `SELECT seq, release_id, manifest FROM kg.active`.
- Produces: `src/lib/snapshot.ts` keeps its types and its derived helpers, but every module-level value becomes a function reading the current store: `manifest()`, `activities()`, `gates()`, `evidence()`, `chainEvents()`, `gateEdges()`, `marketEdges()`, `taskEdges()`, `events()`, `coverage()`, `progress()`, `sources()`, `snapshotExists()`; plus `dataRelease(): { releaseId: string | null; source: "database" | "files" | "none"; loadedAt: string | null }` and `replaceSnapshot(payload | null, meta)`. Derived indexes (`chainEventById`, `activityIndex`, the folded `progress`) are computed once per replacement, not per call.
- `src/lib/snapshot-source.ts`: `loadFromDatabase(url): Promise<Loaded | null>` (null when there is no active release), `loadFromFiles(dir): Loaded | null`, `activeReleaseId(url): Promise<string | null>`.

**Requirements:**

- The store lives on `globalThis` so the instrumentation bundle and the route bundles share it. A replacement swaps one object reference; a render never observes a mix of two releases through a single accessor call.
- `src/instrumentation.ts` `register()` (Node.js runtime only): if `DATABASE_URL` is set, load the active release and fail (throw) if the database cannot be reached — a server that cannot load its data must not start; an empty database (no active release) is not an error and yields the no-data state. Otherwise, if `datasets/published/latest/manifest.json` exists, load from files; otherwise the no-data state. Then, in database mode, poll `activeReleaseId` every 30 seconds (`SNAPSHOT_POLL_SECONDS` overrides) and load + replace when it changes; a failed poll or load logs one line and keeps the current data; the timer is `unref()`ed.
- Use the `pg` package (add it and `@types/pg`); one small pool; `next.config.ts` must keep `pg` out of the bundle if the build asks for it (`serverExternalPackages`) and it must be present in the standalone output — verify by running the standalone server in database mode.
- Rendering: pages render per request. Set `export const dynamic = "force-dynamic"` where the installed docs say it takes effect for the whole `[lang]` subtree and for `sitemap.ts`, `llms.txt`, `healthz`. Remove `generateStaticParams` / `dynamicParams = false` from the five detail routes; each already looks its entity up and must call `notFound()` when it is absent (also when there is data but not this id). Keep the root layout's two-language `generateStaticParams` + `dynamicParams = false` if it still makes unknown language segments 404 under dynamic rendering; verify with a request, and if it does not, validate the segment in the layout.
- In the no-data state every page still renders (existing "no data" branches), detail routes are 404, the sitemap lists the fixed pages only.
- `/healthz` returns `{ ok, release, data: dataRelease() }` and is not cached.
- `site-output.test.mjs` no longer reads prerendered `.html` files. It starts the built server itself (`node .next/standalone/server.js` on a free port, files mode, `SITE_ENV=preview`), fetches pages over HTTP, and stops it by PID in an `after` hook. Keep every existing assertion's intent (languages, links, canonical/hreflang, titles, banned claims, account links, robots, sitemap, JSON-LD, `llms.txt`, figures as text). The sitemap test checks that every `<loc>` is unique and a sample (first, last and 20 evenly spaced) answers 200; add a test that an unknown detail address is 404 in both languages. Standalone needs `public/` and `.next/static` copied beside it as `site_release.py` does — do that in the test setup into a temp directory, not in `.next/standalone` itself.
- A database-mode test, skipped unless local PostgreSQL has an active `kg` release (`DATABASE_URL` for local: host 127.0.0.1, port 7543, database `openaiwill_local`, credentials as `scripts/data_pipeline/db.py` builds them): start the server with `DATABASE_URL`, assert `/healthz` reports `source: "database"` and the active `release_id`, and `/markets` is 200.
- `pnpm dev` keeps working in files mode with no configuration.

- [ ] Read the installed docs for `instrumentation`, `dynamic`, `serverExternalPackages`, `output`.
- [ ] Refactor the store and its importers; `pnpm typecheck` clean.
- [ ] Instrumentation + sources; run the standalone server in files mode and in database mode against local PostgreSQL; with the server running in database mode, run `data-release.py rollback --target local` (or promote another release) and show `/healthz` changing within the poll interval (use `SNAPSHOT_POLL_SECONDS=2`).
- [ ] Rework the output tests; `pnpm build && pnpm site:test`; then with the snapshot directory moved aside (and moved back) and no `DATABASE_URL`: build + tests pass in the no-data state.
- [ ] `pnpm check`. Report the build's route table (pages dynamic) and the size of `.next/standalone`.
- [ ] Commit — `Read the active data release at runtime instead of baking pages at build time`

---

### Task 3: Server database, data release over SSH, and code release without data

**Files:** create `deploy/db/compose.yml`, `deploy/db/init.sh` (or equivalent); modify `deploy/compose.yml`, `scripts/site_release.py`, `scripts/data-release.py`, `scripts/tests/test_site_release_unit.py`, `scripts/tests/test_data_kg_unit.py`, `package.json`, `docs/development/deployment.md`, `docs/development/local-data-pipeline.md` (pointer), local `CLAUDE.md`.

**Requirements:**

- `deploy/db/compose.yml`: project `openaiwill-db`; `postgres:16-alpine`; named volume; `127.0.0.1:5434:5432`; external network `openaiwill`; container name resolvable as `openaiwill-db` on that network; healthcheck `pg_isready`; `restart: unless-stopped`; credentials from `/opt/openaiwill/db/db.env` (not in Git).
- `data-release.py setup-db --target server` (`pnpm db:setup`), idempotent: create `/opt/openaiwill/db`; create the Docker network if absent; generate three passwords on the server (superuser, `oaw_kg_writer`, `oaw_site`) only if the env files do not exist, writing `/opt/openaiwill/db/db.env` and `/opt/openaiwill/site.env` (`DATABASE_URL=postgres://oaw_site:…@openaiwill-db:5432/openaiwill`) with mode 600; upload the compose file; `up -d --wait`; create roles and the database if absent; apply `db/published/001_kg.sql` as the writer's schema owner; grant `oaw_site` USAGE on `kg` and SELECT on all its tables including future ones (`ALTER DEFAULT PRIVILEGES`). Passwords are never printed and never written locally.
- `--target server` for `release|promote|rollback|status`: read `.env.deploy`; fetch the writer password over SSH (`sudo cat` of the env file, parsed locally, never logged); open `ssh -N -L <free port>:127.0.0.1:5434` (reuse the `free_port` / `forward_argv` approach from `site_release.py`, extended to take the remote port); connect with psycopg; run the same library functions as `--target local`; always close the forward. After `promote`/`rollback`, poll the production site's `/healthz` through the SSH forward to 8320 for up to 60 seconds and report whether it now serves the activated release; if no production site is running yet, say so and exit 0.
- `deploy/compose.yml`: the `web` service joins external network `openaiwill` and takes `env_file: ${SITE_ENV_FILE}` (the release script passes `/opt/openaiwill/site.env`); healthcheck unchanged.
- `scripts/site_release.py`: remove snapshot verification from `build()`; release id `<UTC build time YYYYMMDDTHHMMSSZ>-<git short sha>[-dirty]` (keep `RELEASE_ID` validation in step); local smoke runs in files mode when the snapshot directory exists, otherwise it runs the no-data subset (fixed pages, redirects, 404s, robots, `llms.txt`) — detail-page checks need data; the candidate smoke on the server requires `/healthz` to report `data.source == "database"` and a non-null `releaseId`, and fails with "publish data first: pnpm data:release && pnpm data:promote" otherwise. `status` also prints each slot's loaded data release. The forbidden-file scan, `foreign_binaries`, the production-indexability check, `switch` and its failure handling stay as they are.
- Unit tests for every new pure function (argument builders, env-file parsing, the no-data smoke subset selection, release id). No test contacts the server.
- Runbook `docs/development/deployment.md`: rewrite as two release lines — 发布代码 and 发布数据 — plus 首次上线顺序, 回滚（代码/数据各自）, 数据库（位置、角色、口令在哪、手动 `pg_dump`/恢复）, Cloudflare Tunnel 步骤 (unchanged), 上线后. State what is and is not on the server. Keep "尚未执行首次发布" until Task 4 is done. Update local `CLAUDE.md` (ignored): the user's 2026-10-03 decision (server database with versioned published data; code and data released separately; published data only, processing stays local), and the new commands; show before/after in the report.

- [ ] Tests first for the pure parts; implement; `pnpm site:test:unit`, `pnpm data:test:unit`, `pnpm data:test`, `pnpm security:check`.
- [ ] `pnpm site:build` (local only) green; report release id and release directory size.
- [ ] `pnpm check`.
- [ ] Commit — `Release code and data separately against a server database`

---

### Task 4: First launch (controller, on the user's instruction)

- [ ] `pnpm db:setup`; `pnpm data:status` (no releases).
- [ ] `pnpm data:release`; `pnpm data:promote`; `pnpm data:status`.
- [ ] `pnpm site:release`; preview through the SSH forward; `pnpm site:promote`.
- [ ] Public checks from the runbook; update the runbook's status line and `CLAUDE.md`.
