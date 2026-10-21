# Login, Account Submissions, Subscriptions and Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Readers can sign in with Google, submit an X account to be monitored from the Voices page, subscribe to site updates and the weekly report, and an administrator can approve or reject submissions; privacy and terms pages exist so the Google sign-in app can be published.

**Architecture:** User data lives in a new PostgreSQL schema `app`, owned by a new role `oaw_app`, next to the read-only published data in `kg`. Better Auth (Google only, database sessions) serves `/api/auth/*`; our own route handlers under `/api/` read and write `app` through one small store module. Page HTML stays identical for every visitor: sign-in state, "my submissions" and subscription state are fetched by small client components after load. Approved submissions reach the local collection machine only through a pull command run locally.

**Tech Stack:** Next.js 16.3.4 App Router (read `node_modules/next/dist/docs/` before writing route handlers or client components), TypeScript, `pg`, `better-auth` (1.7.x — read its installed README/types and `node_modules/better-auth` docs before use; do not rely on remembered APIs), PostgreSQL 16, Python 3 (`psycopg`) for setup, pull and database tests, plain CSS with `--ah-*` tokens.

**Spec:** `docs/superpowers/specs/2026-10-04-login-submissions-subscriptions-admin-design.md`

## Global Constraints

- Both languages complete: English (unprefixed) and Simplified Chinese (`/zh-CN`). Every new string goes through `bilingual({...})` from `src/lib/i18n.ts`. UI copy is short labels and numbers; no method or caveat prose.
- Page HTML must not depend on the visitor: no `cookies()`/`headers()` session reads in any page except `/admin`. Sign-in state is rendered by client components.
- Without `APP_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` all set (five settings; `BETTER_AUTH_URL` was added during review), the site builds, starts and passes `pnpm check`; sign-in, submit and subscribe controls are not rendered and `/api/*` user endpoints answer 404.
- Secrets (`GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, database passwords, `ADMIN_EMAILS`) only in ignored env files or on the server; never printed, never in a tracked file, never with a `NEXT_PUBLIC_` prefix. Server address, login user and key path stay only in `.env.deploy`.
- `kg` stays read-only for the site (`oaw_site`). `oaw_app` has no access to `kg`; `oaw_kg_writer` has no access to `app`. Data releases never touch `app`.
- Account type values are exactly `person` and `organization` (the ontology's `owner_kind`). Submission status values are exactly `pending`, `approved`, `rejected`. Subscription topics are exactly `updates`, `weekly`.
- Handle rule: accepted inputs `@name`, `name`, `https://x.com/name`, `https://twitter.com/name` (also `http://`, `www.`, `mobile.`, trailing `/` or `?query`); normalized to 1–15 characters of `[A-Za-z0-9_]`, compared lower-case. Links to X are built from the normalized handle, never from user input.
- Limits: note ≤ 280 characters; rejection reason required, ≤ 280; at most 10 pending submissions per user; at most 20 submit requests per user per hour.
- Every user-data response carries `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
- `/admin` answers 404 to anyone who is not a signed-in administrator, is not in the sitemap, and is disallowed in `robots.txt`.
- Do not edit `scripts/check-public-files.py`. Do not touch the server: every task in this plan runs locally. Commit with explicit paths only (`git commit -- <paths>`), never `-a`. Do not stop processes you did not start; the owner's dev server may be on port 3456 — use another port for your own.
- Local dev port is 3456; the Google callback registered by the owner is `http://localhost:3456/api/auth/callback/google` and `https://openaiwill.com/api/auth/callback/google`.
- `pnpm check` passes at the end of every task.

## Review Focus

1. A request to `/api/...` reaching the language proxy and being rewritten to `/en/api/...` (404) — the proxy matcher must exclude `api/`; test: `/api/me` answers JSON, `/zh-CN/api/me` is 404.
2. A handle that differs only by case or by URL form from an existing one being accepted twice — unique on the lower-case handle; test with `@OpenAI`, `openai`, `https://x.com/OpenAI/`.
3. A non-administrator calling the admin endpoints directly — every admin handler checks the session server-side; test that a signed-in non-admin gets 404 from the page and the endpoints.
4. A decided submission being changed again (double click, two administrators) — database trigger refuses; the handler reports how many rows it changed.
5. A CSV cell beginning with `=`, `+`, `-` or `@` (a display name from Google) being executed by a spreadsheet — cells are prefixed with `'`; test.

---

## Amendment A (owner decision 2026-10-04): administrators live in the database

The owner asked for the administrator addresses to be written to the database and deployed automatically. This overrides every mention of an `ADMIN_EMAILS` environment variable **read by the site** in the tasks below.

- **Source of the list:** `ADMIN_EMAILS` in the local, ignored `.env` (comma separated). The addresses never enter a tracked file, a test, a log line or command output (print counts only). Tests use `@example.com` addresses.
- **Table (Task 2, in `db/app/001_app.sql`):**
  ```sql
  -- Who may review submissions. Synced from the owner's local ADMIN_EMAILS by setup; never edited by the site.
  CREATE TABLE IF NOT EXISTS app.admins (
      email    text        PRIMARY KEY CHECK (email = lower(btrim(email)) AND position('@' in email) > 1),
      added_at timestamptz NOT NULL DEFAULT now()
  );
  ```
- **Python (Task 2, `scripts/app_db.py`):** `read_admin_emails(paths=(ROOT/".env", ROOT/".env.local")) -> list[str]` (later file wins; trimmed, lower-cased, de-duplicated, entries without `@` dropped; only the `ADMIN_EMAILS` line is parsed, nothing else is read into memory beyond the line scan); `sync_admins(conn, emails: list[str]) -> tuple[int, int]` makes the table equal to the list in one transaction and returns `(added, removed)`; an empty list raises `AppError("ADMIN_EMAILS is empty; the administrator list was left unchanged")`. `setup_local()` calls it and prints `administrators: N on the list (+a, -r)`. Database tests: sync adds, removes, is a no-op when equal, refuses an empty list, stores lower-case.
- **Site (Task 1 code changes, done in Task 2's commit or Task 3's — whichever task first needs it; Task 2 does it):** in `src/lib/app-config.ts` remove `adminEmails` and change `isAdmin` to `isAdmin(user, admins: readonly string[]): boolean` (verified address, case-insensitive membership); update `scripts/tests/test_app_rules_unit.mjs` accordingly. In Task 3, `src/lib/auth.ts` adds `isAdminUser(user): Promise<boolean>` = `user?.emailVerified === true` and a row in `app.admins` for `lower(email)` (one indexed query per check, no cache — so a list change takes effect at once). `/api/me`, the admin page and the admin endpoints use `isAdminUser`.
- **Server (Task 8):** `pnpm db:setup`, after its setup script, opens the SSH forward as `oaw_app` and runs `sync_admins` with the local list (skipped with a one-line warning when the list is empty). `pnpm site:env` uploads only the two Google values. Add `"admins:sync"` package script (`scripts/app-db.py admins --target server|local`, default server) for changing the list later without a release.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/handles.ts` | `normalizeHandle` — pure, no imports |
| `src/lib/app-config.ts` | `appEnabled()`, `adminEmails()`, `isAdmin()` — pure over `process.env` |
| `db/app/001_app.sql` | schema `app`: Better Auth tables, `submissions`, `subscriptions`, trigger |
| `scripts/app_db.py` | apply `db/app/*.sql`; local setup; `submissions pull` |
| `scripts/app-db.py` | CLI entry for the above |
| `src/lib/auth.ts` | the Better Auth instance (server only), `currentUser(request)` |
| `src/lib/auth-client.ts` | Better Auth browser client |
| `src/lib/app-store.ts` | every SQL statement against `app` |
| `src/lib/api.ts` | `json()`, `sameOrigin()`, `rateLimit()` helpers for route handlers |
| `src/app/api/auth/[...all]/route.ts` | Better Auth handler |
| `src/app/api/me/route.ts` | who is signed in, admin flag, subscription state |
| `src/app/api/submissions/route.ts` | list mine, create |
| `src/app/api/subscriptions/route.ts` | set my subscriptions |
| `src/app/api/admin/submissions/route.ts` | decide |
| `src/app/api/admin/subscribers/route.ts` | CSV |
| `src/components/account/*.tsx`, `account.module.css` | header menu, submit dialog, my submissions, subscribe control |
| `src/app/[lang]/admin/page.tsx`, `admin.module.css`, `decide.tsx` | admin page |
| `src/app/[lang]/privacy/page.tsx`, `src/app/[lang]/terms/page.tsx`, `src/lib/legal.ts` | legal pages |
| `deploy/db/roles.sql`, `deploy/db/compose.yml`, `scripts/server_db.py`, `scripts/site_release.py` | server role, backup, env, smoke |

---

### Task 1: Pure rules — handles, administrators, feature switch

**Files:**
- Create: `src/lib/handles.ts`, `src/lib/app-config.ts`
- Test: `scripts/tests/test_app_rules_unit.mjs`
- Modify: `package.json` (`i18n:test` runs the new file too)

**Interfaces:**
- Produces: `normalizeHandle(input: string): { handle: string; key: string } | null` (`handle` keeps the typed case, `key` is lower-case); `OWNER_KINDS = ["person","organization"] as const`, `type OwnerKind`; `appEnabled(env?: NodeJS.ProcessEnv): boolean`; `adminEmails(env?): string[]`; `isAdmin(user: { email?: string | null; emailVerified?: boolean | null } | null, env?): boolean`.

- [ ] **Step 1: Write the failing test** — `scripts/tests/test_app_rules_unit.mjs`, loading both sources the way `scripts/tests/test_i18n_unit.mjs` does (TypeScript `transpileModule`, `data:` import; neither file may import anything):

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = async (relative) => {
  const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(js)}`);
};
const { normalizeHandle } = await load("../../src/lib/handles.ts");
const { appEnabled, adminEmails, isAdmin } = await load("../../src/lib/app-config.ts");

test("every accepted way of writing an account gives the same handle", () => {
  for (const input of ["OpenAI", "@OpenAI", " @OpenAI ", "https://x.com/OpenAI", "https://x.com/OpenAI/", "http://twitter.com/OpenAI",
    "https://www.x.com/OpenAI?s=20", "https://mobile.twitter.com/OpenAI/", "x.com/OpenAI", "https://x.com/@OpenAI"]) {
    assert.deepEqual(normalizeHandle(input), { handle: "OpenAI", key: "openai" }, input);
  }
});

test("what is not one X account is refused", () => {
  for (const input of ["", " ", "@", "a".repeat(16), "has space", "名字", "a-b", "https://x.com/", "https://x.com/OpenAI/status/1",
    "https://example.com/OpenAI", "https://x.com.evil.com/OpenAI", "javascript:alert(1)", "https://x.com/home/../OpenAI", "a/b", "@@a"]) {
    assert.equal(normalizeHandle(input), null, JSON.stringify(input));
  }
  assert.equal(normalizeHandle(undefined), null);
  assert.equal(normalizeHandle(42), null);
});

test("X's own pages are not accounts", () => {
  for (const name of ["home", "explore", "search", "settings", "i", "intent", "share", "hashtag", "messages", "notifications", "login", "signup"]) {
    assert.equal(normalizeHandle(`https://x.com/${name}`), null, name);
  }
});

const full = { APP_DATABASE_URL: "postgres://x", BETTER_AUTH_SECRET: "s", GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "k" };

test("the user features are on only when all four settings are present", () => {
  assert.equal(appEnabled(full), true);
  for (const key of Object.keys(full)) assert.equal(appEnabled({ ...full, [key]: "" }), false, key);
  assert.equal(appEnabled({}), false);
});

test("an administrator is a verified address on the list, whatever its case", () => {
  const env = { ADMIN_EMAILS: " Owner@Example.com, second@example.com ,, " };
  assert.deepEqual(adminEmails(env), ["owner@example.com", "second@example.com"]);
  assert.equal(isAdmin({ email: "owner@example.COM", emailVerified: true }, env), true);
  assert.equal(isAdmin({ email: "owner@example.com", emailVerified: false }, env), false);
  assert.equal(isAdmin({ email: "other@example.com", emailVerified: true }, env), false);
  assert.equal(isAdmin(null, env), false);
  assert.equal(isAdmin({ email: "owner@example.com", emailVerified: true }, {}), false);
  assert.equal(isAdmin({ email: "", emailVerified: true }, { ADMIN_EMAILS: "," }), false);
});
```

- [ ] **Step 2: Run it and see it fail** — `node --test scripts/tests/test_app_rules_unit.mjs` → fails: files do not exist.

- [ ] **Step 3: Implement**

`src/lib/handles.ts`:

```ts
/**
 * One X account, however the reader wrote it. Kept free of imports so the unit
 * tests can load the source directly.
 */
export const OWNER_KINDS = ["person", "organization"] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];

const HOSTS = new Set(["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.x.com", "mobile.twitter.com"]);
/** Paths on x.com that are the site's own pages, not accounts. */
const RESERVED = new Set(["home", "explore", "search", "settings", "i", "intent", "share", "hashtag", "messages", "notifications", "login", "signup", "compose", "tos", "privacy"]);
const NAME = /^[A-Za-z0-9_]{1,15}$/;

/** `handle` as typed (for display), `key` lower-case (for comparison); null when the input is not one account. */
export function normalizeHandle(input: unknown): { handle: string; key: string } | null {
  if (typeof input !== "string") return null;
  let text = input.trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || /^(www\.|mobile\.)?(x|twitter)\.com\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    } catch {
      return null;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !HOSTS.has(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null;
    text = parts[0];
  }
  if (text.startsWith("@")) text = text.slice(1);
  if (!NAME.test(text) || RESERVED.has(text.toLowerCase())) return null;
  return { handle: text, key: text.toLowerCase() };
}
```

`src/lib/app-config.ts`:

```ts
/**
 * Whether the signed-in features exist in this process, and who administers them.
 * No imports: the unit tests load this source directly.
 */
type Env = Record<string, string | undefined>;

const REQUIRED = ["APP_DATABASE_URL", "BETTER_AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

/** Sign-in, submissions and subscriptions need all four; without them the site is the public pages only. */
export function appEnabled(env: Env = process.env): boolean {
  return REQUIRED.every((key) => Boolean(env[key]));
}

export function adminEmails(env: Env = process.env): string[] {
  return (env.ADMIN_EMAILS ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

/** A Google address that Google reports as verified and that is on the list. */
export function isAdmin(user: { email?: string | null; emailVerified?: boolean | null } | null | undefined, env: Env = process.env): boolean {
  if (!user?.email || user.emailVerified !== true) return false;
  return adminEmails(env).includes(user.email.trim().toLowerCase());
}
```

- [ ] **Step 4: Run** — `node --test scripts/tests/test_app_rules_unit.mjs` → all pass.
- [ ] **Step 5: Wire into the suite** — in `package.json` append ` scripts/tests/test_app_rules_unit.mjs` to the `i18n:test` command. Run `pnpm i18n:test && pnpm lint && pnpm typecheck`.
- [ ] **Step 6: Commit** — `git add` the four paths; `git commit -m "Add the handle, administrator and feature-switch rules" -- <paths>`.

---

### Task 2: Schema `app`, role `oaw_app`, local setup, database tests

**Files:**
- Create: `db/app/001_app.sql`, `scripts/app_db.py`, `scripts/app-db.py`, `scripts/tests/test_data_app.py`, `scripts/tests/test_data_app_unit.py`
- Modify: `package.json` (add `better-auth` exact version, scripts `app:setup`), `pnpm-lock.yaml`
- Read first: `scripts/data_pipeline/db.py` (local connection, port 7543, user `openaiwill`, password file), `scripts/tests/test_data_kg.py` (scratch-database pattern), `db/published/001_kg.sql` (style), the installed `better-auth` docs for its core schema and CLI.

**Interfaces:**
- Produces (SQL): `app."user"`, `app.session`, `app.account`, `app.verification` exactly as Better Auth 1.7.x expects for PostgreSQL (generate them, do not write from memory); `app.submissions`, `app.subscriptions` as below.
- Produces (Python, `scripts/app_db.py`): `APP_ROLE = "oaw_app"`, `APP_SQL = sorted((ROOT / "db/app").glob("*.sql"))`, `apply_schema(conn) -> None` (conn is a psycopg connection **as `oaw_app`**), `role_sql(password: str) -> str` is not exposed — passwords never go into SQL text; see step 4. `setup_local() -> None`.
- Produces (`package.json`): `"app:setup": "data/runtime/venv/bin/python scripts/app-db.py setup-local"`.

- [ ] **Step 1: Install the library** — `pnpm add better-auth@1.7.7 --save-exact`. Confirm `pg` stays the only database driver added.

- [ ] **Step 2: Generate the Better Auth tables** — write a throwaway config under the scratchpad (not in the repo) with `database: new Pool(...)`, `socialProviders.google`, no plugins, and run the Better Auth CLI's SQL generation against it. Take the four `CREATE TABLE` statements, qualify every table as `app.<name>`, add `IF NOT EXISTS`, and keep column names exactly as generated (they are camelCase and quoted). If the CLI cannot produce SQL without a live database, run it against a scratch database created the way `test_data_kg.py` creates one, then `pg_dump --schema-only` the four tables. Record in the task report which command produced them.

- [ ] **Step 3: Write `db/app/001_app.sql`** — header comment, the four generated tables, then:

```sql
-- Run as oaw_app (the owner of schema app). Repeatable: every statement is IF NOT EXISTS or OR REPLACE.
-- User data. Data releases (schema kg) never read or write anything here.

-- <the four Better Auth tables generated in step 2, qualified with app.>

-- A reader's request to monitor one X account. One row per reader and account.
CREATE TABLE IF NOT EXISTS app.submissions (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         text        NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
    platform        text        NOT NULL DEFAULT 'x' CHECK (platform = 'x'),
    handle          text        NOT NULL CHECK (handle ~ '^[a-z0-9_]{1,15}$'),
    display_handle  text        NOT NULL,
    owner_kind      text        NOT NULL CHECK (owner_kind IN ('person', 'organization')),
    note            text        CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 280),
    status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    decided_by      text        REFERENCES app."user"(id) ON DELETE SET NULL,
    decision_reason text        CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 280),
    decided_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    imported_at     timestamptz,
    CONSTRAINT submissions_one_per_user UNIQUE (user_id, platform, handle),
    CONSTRAINT submissions_display_matches CHECK (lower(display_handle) = handle),
    CONSTRAINT submissions_pending_is_undecided CHECK ((status = 'pending') = (decided_at IS NULL)),
    CONSTRAINT submissions_rejection_has_reason CHECK (status <> 'rejected' OR decision_reason IS NOT NULL),
    CONSTRAINT submissions_only_approved_imported CHECK (imported_at IS NULL OR status = 'approved')
);
CREATE INDEX IF NOT EXISTS submissions_by_account ON app.submissions (platform, handle, owner_kind);
CREATE INDEX IF NOT EXISTS submissions_by_status ON app.submissions (status, created_at);

-- A decision is final: once decided, only imported_at may change (set once, by the local pull).
CREATE OR REPLACE FUNCTION app.submissions_decided_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'pending' AND (
        NEW.status IS DISTINCT FROM OLD.status OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
        OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
        OR NEW.handle IS DISTINCT FROM OLD.handle OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
        OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.note IS DISTINCT FROM OLD.note
        OR (OLD.imported_at IS NOT NULL AND NEW.imported_at IS DISTINCT FROM OLD.imported_at)
    ) THEN
        RAISE EXCEPTION 'a decided submission cannot be changed';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS submissions_decided_is_final ON app.submissions;
CREATE TRIGGER submissions_decided_is_final BEFORE UPDATE ON app.submissions
    FOR EACH ROW EXECUTE FUNCTION app.submissions_decided_is_final();

-- What a reader asked to be told about. Unsubscribing keeps the row and dates it.
CREATE TABLE IF NOT EXISTS app.subscriptions (
    user_id         text        NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
    topic           text        NOT NULL CHECK (topic IN ('updates', 'weekly')),
    language        text        NOT NULL CHECK (language IN ('en', 'zh-CN')),
    subscribed_at   timestamptz NOT NULL DEFAULT now(),
    unsubscribed_at timestamptz,
    PRIMARY KEY (user_id, topic)
);
```

Note the `decided_by ... ON DELETE SET NULL` update must pass the trigger: `SET NULL` changes `decided_by` on a decided row. Make the trigger allow `NEW.decided_by IS NULL` (replace that comparison with `(NEW.decided_by IS DISTINCT FROM OLD.decided_by AND NEW.decided_by IS NOT NULL)`), and cover it with a test (delete the deciding user; the submission stays, `decided_by` null).

- [ ] **Step 4: Write `scripts/app_db.py`**

```python
"""Schema `app` (user data): applying it, setting it up locally, pulling approved submissions.

The schema belongs to role oaw_app. The role and the schema itself are created by a superuser
(here for the local database; by deploy/db/roles.sql on the server); the tables are created by oaw_app.
Passwords are passed as query parameters or through the environment, never formatted into SQL text."""
```

Functions (write them fully; signatures are binding):

- `apply_schema(conn) -> None`: for each file in `APP_SQL`, `conn.execute(path.read_text())`, inside one transaction.
- `ensure_role_and_schema(admin_conn, password: str) -> None`: creates role `oaw_app` if absent, then `ALTER ROLE oaw_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %s` using `psycopg.sql.SQL(...).format(sql.Literal(password))` (ALTER ROLE takes no bind parameters; `sql.Literal` quotes safely), `ALTER ROLE oaw_app SET search_path = app`, `GRANT CONNECT ON DATABASE <current database> TO oaw_app`, `CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION oaw_app`.
- `local_password() -> str`: reads `data/postgres/app-password` (mode 0600), creating it with `secrets.token_hex(24)` when absent (write with `os.open(..., 0o600)`).
- `connect_app(database=None)`: psycopg connection to `127.0.0.1:7543` as `oaw_app` with `local_password()`, `autocommit=True`, `row_factory=dict_row`, `options="-c timezone=UTC"`.
- `write_env_local(values: dict[str, str]) -> None`: updates `ROOT/.env.local` — replaces existing `KEY=` lines for the given keys, appends missing ones, leaves every other line untouched, file mode 0600. Never prints values.
- `setup_local() -> None`: `admin = data_pipeline.db.connect()`; `ensure_role_and_schema`; `apply_schema(connect_app())`; `write_env_local({"APP_DATABASE_URL": f"postgres://oaw_app:{pw}@127.0.0.1:7543/openaiwill_local", "BETTER_AUTH_URL": "http://localhost:3456"})` and, only when `.env.local` has no `BETTER_AUTH_SECRET`, adds one (`secrets.token_hex(32)`); prints `app schema ready in the local database; .env.local updated (values not shown)`.

`scripts/app-db.py`: argparse with subcommands `setup-local` (Task 2) and `pull` (Task 8 adds it); errors print one line and exit 1.

- [ ] **Step 5: Unit test** — `scripts/tests/test_data_app_unit.py` (runs under `pnpm data:test:unit`, no database, no psycopg import at module level of the test): `write_env_local` against a temp file — replaces a key in place, appends a missing key, preserves unrelated lines and comments, result mode is 0600, a value containing `=` or `#` round-trips. Make `write_env_local` take an optional `path` argument for this. Import `app_db` in a way that does not require psycopg at import time (import psycopg inside the functions that connect, as `scripts/server_db.py` does).

- [ ] **Step 6: Real database tests** — `scripts/tests/test_data_app.py` (runs under `pnpm data:test`), scratch database per test like `KgBase` in `test_data_kg.py`; in `setUp` create the scratch database, call `ensure_role_and_schema` with a random password, connect as `oaw_app`, `apply_schema`. Tests:
  - `apply_schema` twice leaves one set of tables and raises nothing.
  - inserting a user row (minimal columns per the generated schema) then two submissions with the same `(user_id, 'x', handle)` → `UniqueViolation`.
  - `handle = 'OpenAI'` (upper case) → `CheckViolation`; `display_handle = 'Other'` with `handle = 'openai'` → `CheckViolation`; a 281-character note → `CheckViolation`; `status = 'rejected'` without a reason → `CheckViolation`; `imported_at` set on a pending row → `CheckViolation`.
  - approving a pending row works; changing it again to rejected raises; setting `imported_at` once on the approved row works; setting it a second time to another value raises.
  - deleting the deciding user leaves the submission with `decided_by` null.
  - deleting the submitting user removes their submissions and subscriptions.
  - isolation: as `oaw_app`, `SELECT 1 FROM kg.releases` raises `InsufficientPrivilege` (create schema `kg` with `kg.ensure_schema` as the admin first); a role without grants on `app` (create a scratch role in the test) cannot `SELECT` from `app.submissions`.
  - a second subscription row for the same `(user_id, topic)` → `UniqueViolation`; topic `daily` → `CheckViolation`.

- [ ] **Step 7: Run** — `pnpm data:test:unit` and `pnpm data:test` (needs `pnpm data:up`); then `pnpm app:setup` once and confirm with `git status` that `.env.local` and `data/postgres/app-password` are ignored. Then `pnpm check`.
- [ ] **Step 8: Commit** — explicit paths: `db/app/001_app.sql scripts/app_db.py scripts/app-db.py scripts/tests/test_data_app.py scripts/tests/test_data_app_unit.py package.json pnpm-lock.yaml`.

---

### Task 3: Sign-in — Better Auth, `/api/auth`, `/api/me`, header menu

**Files:**
- Create: `src/lib/auth.ts`, `src/lib/auth-client.ts`, `src/lib/api.ts`, `src/app/api/auth/[...all]/route.ts`, `src/app/api/me/route.ts`, `src/components/account/account-menu.tsx`, `src/components/account/account.module.css`
- Modify: `src/proxy.ts` (matcher), `src/app/[lang]/layout.tsx` (menu in header), `next.config.ts` (`serverExternalPackages` if Better Auth needs it — decide from its docs), `scripts/tests/site-output.test.mjs`, `scripts/tests/test_i18n_unit.mjs` only if a matcher test lives there
- Read first: Next's route-handler and `use client` guides under `node_modules/next/dist/docs/`; Better Auth's Next.js integration, Google provider, `getSession`, cookie and `trustedOrigins`/`baseURL` docs in the installed package.

**Interfaces:**
- Consumes: `appEnabled`, `isAdmin` (Task 1); schema `app` (Task 2).
- Produces:
  - `src/lib/auth.ts`: `getAuth()` — lazily built singleton (kept on `globalThis` like the snapshot store), throws if `!appEnabled()`; `currentUser(request: Request): Promise<{ id: string; email: string; name: string; image: string | null; emailVerified: boolean } | null>` — null when not enabled or not signed in.
  - `src/lib/app-store.ts` is created in Task 4; in this task `auth.ts` owns the one `pg` Pool for `APP_DATABASE_URL` and exports `appPool(): Pool` for Task 4 to reuse (max 5 connections, `application_name: "openaiwill-app"`, an `error` listener like the one in `snapshot-source.ts`).
  - `src/lib/api.ts`: `json(body: unknown, status = 200): Response` (adds `Cache-Control: no-store`, `X-Robots-Tag: noindex`); `notFound(): Response` (404 JSON `{error:"not_found"}`); `sameOrigin(request: Request): boolean` — true when the `Origin` header is present and its origin equals `new URL(process.env.BETTER_AUTH_URL ?? request.url).origin`; `rateLimit(key: string, limit: number, windowMs: number): boolean` — in-memory, per process, returns false when over the limit, prunes old entries.
  - `GET /api/me` → `{ enabled: boolean, user: { name, email, image } | null, admin: boolean, subscriptions: { updates: boolean, weekly: boolean } }`. In this task `subscriptions` is always both false; Task 5 fills it. When `!appEnabled()` it answers 200 `{ enabled: false, user: null, admin: false, subscriptions: {updates:false, weekly:false} }` (the only user endpoint that answers when disabled).
  - `<AccountMenu language enabled />` client component.

- [ ] **Step 1: Failing tests** — in `scripts/tests/site-output.test.mjs` add (the default test server has no app settings):

```js
test("without sign-in settings the site says so and offers no sign-in", async () => {
  const response = await fetch(`${base}/api/me`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { enabled: false, user: null, admin: false, subscriptions: { updates: false, weekly: false } });
  assert.equal((await fetch(`${base}/zh-CN/api/me`)).status, 404);
  assert.equal((await fetch(`${base}/api/auth/get-session`)).status, 404);
  assert.ok(!pages.get("/").includes("data-account-menu"));
});
```

Use the file's existing names for the base URL and the cached page HTML (read the top of the file; adapt `base`/`pages` to what it actually calls them). Run `pnpm build && pnpm site:test` → the new test fails.

- [ ] **Step 2: Proxy** — in `src/proxy.ts` add `api/` to the matcher's exclusions: `"/((?!_next/|api/|og/|healthz$|...).*)"`, and extend the comment: route handlers under `/api/` have no language.

- [ ] **Step 3: `src/lib/auth.ts`** — build the instance from the installed docs. Binding requirements:
  - `database`: the `pg` Pool from `appPool()`; the role's `search_path` is `app`, so no schema option is needed — verify with a query in step 6.
  - `baseURL: process.env.BETTER_AUTH_URL`, `secret: process.env.BETTER_AUTH_SECRET`.
  - `socialProviders.google` with the two env values; no email/password; no other provider; no plugins.
  - Database sessions (the default), 30-day expiry.
  - `trustedOrigins`: `[new URL(BETTER_AUTH_URL).origin]`.
  - If Better Auth offers its own rate limiting for `/api/auth/*`, leave its default on.
  - `currentUser` calls `getAuth().api.getSession({ headers: request.headers })` and maps the user; any thrown error is logged with `console.error("[auth] ...")` (message only, no headers or cookies) and returns null.

- [ ] **Step 4: Routes** — `src/app/api/auth/[...all]/route.ts`: `export const dynamic = "force-dynamic"`; when `!appEnabled()` both `GET` and `POST` return `notFound()`; otherwise delegate to Better Auth's Next handler. `src/app/api/me/route.ts` as specified.

- [ ] **Step 5: Header menu** — `src/components/account/account-menu.tsx` (`"use client"`):
  - Props: `language: Language`, `enabled: boolean`. Renders nothing when `!enabled`.
  - Root element carries `data-account-menu`.
  - On mount fetches `/api/me` (`cache: "no-store"`). Until it answers, renders a fixed-width empty box so the header does not shift.
  - Signed out: a button "Sign in" / "登录" → Better Auth client `signIn.social({ provider: "google", callbackURL: window.location.pathname + window.location.search })`.
  - Signed in: a button showing the avatar (`<img>` with `referrerPolicy="no-referrer"`, 28px, alt = name; initials fallback when no image) opening a small menu (`<details>` is enough; closes on outside click and Escape): name, "Subscribe" / "订阅" (rendered in Task 5), "Admin" / "后台" (only when `admin`, link to `href(language, "/admin")` — Task 6 creates the route; until then leave the item out and add it in Task 6), "Sign out" / "退出" → `signOut()` then reload.
  - Exposes the loaded state to siblings through a tiny module-level store in `src/components/account/me.ts`: `useMe(): { state: "loading" | "ready"; me: Me }` backed by one shared fetch (so the Voices page and footer do not fetch `/api/me` again) and `refreshMe()`.
  - Styles in `account.module.css` with `--ah-*` tokens; focus-visible outlines; the menu must not overflow at 360px width.
  - In `src/app/[lang]/layout.tsx` render `<AccountMenu language={language} enabled={appEnabled()} />` after `<LanguageSwitch />` inside `.header-end`. `appEnabled()` is read at request time (the layout is already dynamic); it is the same for every visitor.

- [ ] **Step 6: Verify by hand, locally** — with `.env.local` from `pnpm app:setup` and the Google values in `.env`, run `pnpm dev` on a port of your own if 3456 is taken (sign-in itself only completes on 3456, the registered callback). Check: `/api/me` → `enabled: true, user: null`; `/api/auth/get-session` answers 200; the sign-in button redirects to `accounts.google.com` with `redirect_uri=http://localhost:3456/api/auth/callback/google`. You cannot complete Google's consent yourself — stop there and say so in the report. Check the header at 1280, 760, 600 and 360px in both languages (screenshots to the scratchpad).

- [ ] **Step 7: Tests for the enabled mode** — add to `site-output.test.mjs` a test that starts the built server with `APP_DATABASE_URL` pointing at the local database (skip when `data/postgres/app-password` is absent, as the existing database tests skip), a throwaway `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://127.0.0.1:<port>`, dummy Google values: `/api/me` → `enabled: true`, `user: null`; the home page HTML contains `data-account-menu`; `/api/auth/get-session` → 200; a `POST /api/auth/sign-out` with `Origin: https://evil.example` is refused (status ≥ 400).

- [ ] **Step 8: `pnpm check`, commit** with explicit paths.

---

### Task 4: Submissions — store, API, Voices page

**Files:**
- Create: `src/lib/app-store.ts`, `src/app/api/submissions/route.ts`, `src/components/account/submit-account.tsx`, `src/components/account/my-submissions.tsx`, `scripts/tests/app-store.test.mjs`
- Modify: `src/app/[lang]/voices/page.tsx`, `src/components/account/account.module.css`, `package.json` (`site:test` also runs `app-store.test.mjs`)

**Interfaces:**
- Consumes: `appPool()`, `currentUser`, `json`, `notFound`, `sameOrigin`, `rateLimit`, `normalizeHandle`, `OWNER_KINDS`, `sources()` from `@/lib/snapshot`, `useMe`.
- Produces (`src/lib/app-store.ts`, every function takes the pool first so tests can pass their own):

```ts
export type Submission = { id: string; handle: string; ownerKind: OwnerKind; note: string | null;
  status: "pending" | "approved" | "rejected"; reason: string | null; createdAt: string; decidedAt: string | null };
export type CreateResult =
  | { result: "created"; submission: Submission }
  | { result: "duplicate"; submission: Submission }
  | { result: "limit" };
export const PENDING_LIMIT = 10;
export async function listSubmissions(db: Pool, userId: string): Promise<Submission[]>;       // newest first
export async function createSubmission(db: Pool, input: { userId: string; handle: string; key: string; ownerKind: OwnerKind; note: string | null }): Promise<CreateResult>;
```

`createSubmission` runs in one transaction: `SELECT ... FOR UPDATE` on the user's row in `app."user"` (serialises this user's submits), return `duplicate` if `(user_id,'x',key)` exists, return `limit` if the user has ≥ 10 pending, else insert and return `created`. `id` is returned as a string (bigint).

- `POST /api/submissions` body `{ handle: string, ownerKind: "person" | "organization", note?: string }` →
  - 404 when `!appEnabled()`; 403 `{error:"origin"}` when `!sameOrigin`; 401 `{error:"signed_out"}`; 429 `{error:"rate"}` when `!rateLimit("submit:" + user.id, 20, 3600_000)`;
  - 400 `{error:"invalid_handle"}`, `{error:"invalid_kind"}`, `{error:"invalid_note"}` (note trimmed; empty → null; > 280 → invalid; body not JSON or > 4 KB → `{error:"invalid"}`);
  - 200 `{ result: "monitored", handle }` when a row of `sources()` has `platform === "x"` (or no platform field — read the `Source` type) and `handle.toLowerCase() === key`;
  - 200 `{ result: "created" | "duplicate", submission }`; 200 `{ result: "limit", limit: 10 }`.
- `GET /api/submissions` → 401 when signed out, else `{ submissions: Submission[] }`.

- [ ] **Step 1: Store tests first** — `scripts/tests/app-store.test.mjs`: loads `src/lib/app-store.ts` by transpiling it (it may import only `pg` types and `./handles` types — keep its imports type-only so the transpiled module has none; if it needs `OwnerKind`, use `import type`). Connects with `pg` to a scratch database created through the local admin connection (read `data/postgres/password`; skip the whole file when it is absent), applies `db/app/001_app.sql` after creating the role and schema with plain SQL in the test. Cases: create → `created`; same handle again → `duplicate` with the first row; same handle with different case in `key` is impossible by construction (assert the caller contract: pass `key` lower-case) ; 10 pending then an 11th → `limit`; after one is approved (direct SQL), an 11th succeeds; two concurrent creates of the same handle by one user → one `created`, one `duplicate` (run with `Promise.all`); `listSubmissions` returns only that user's rows, newest first, with ISO timestamps.
- [ ] **Step 2: Run, see them fail; implement `app-store.ts`; run, pass.**
- [ ] **Step 3: Route handler** — as specified. Add route tests to `site-output.test.mjs` in the enabled-mode block: `POST /api/submissions` without a session → 401; with `Origin` of another site → 403; `GET` → 401. (Signed-in behaviour is covered by the store tests; a real Google session cannot be created in tests.)
- [ ] **Step 4: Voices page** —
  - `Section` for people and for companies each get an action: read `Section` in `src/components/data-page.tsx`; if it has no slot for an action beside the title, add an optional `action?: React.ReactNode` prop rendered at the end of the title row (keep existing callers unchanged).
  - `<SubmitAccount language ownerKind enabled />` (client): a button "Submit an account" / "提交帐号". Signed out → `signIn.social` with `callbackURL` = current path + `#people` or `#companies`. Signed in → opens a native `<dialog>`: field "X account" / "X 帐号" (placeholder `@name`), field "Why" / "理由" (optional, `maxLength={280}`, live count `n/280`), buttons "Submit" / "提交", "Cancel" / "取消". Client-side it runs `normalizeHandle` for an immediate error; the server decides. Result line, short: created → "Submitted" / "已提交"; duplicate → status of the earlier one; monitored → "Already monitored" / "已在监控"; limit → "10 pending. Wait for review." / "已有 10 条待审核"; rate → "Too many attempts" / "操作太频繁"; invalid → "Not an X account" / "不是有效的 X 帐号". After `created` it calls `refreshSubmissions()` and closes after a moment.
  - When a section is empty the page currently hides it; keep the two sections rendered whenever `enabled` so the buttons exist even with no data (show the existing empty note inside).
  - `<MySubmissions language enabled />` (client), placed directly under the page header: renders nothing when signed out or when the list is empty; otherwise a `Section`-styled block "My submissions" / "我的提交" with rows: `@handle` (link to `https://x.com/<handle>`, `rel="noreferrer"`, `target="_blank"`), type label (People/Company — reuse the page's titles), status label (Pending/Approved/Rejected — 待审核/已通过/已拒绝), reason when rejected, date (`isoDate`).
  - The server-rendered HTML of `/voices` must be byte-identical for signed-in and signed-out visitors (the page does not read the session).
- [ ] **Step 5: Check both languages at 1280 and 360px**, screenshots to the scratchpad; keyboard: dialog opens focused on the first field, Escape closes, focus returns to the button.
- [ ] **Step 6: `pnpm check`, commit** with explicit paths.

---

### Task 5: Subscriptions

**Files:**
- Create: `src/app/api/subscriptions/route.ts`, `src/components/account/subscribe.tsx`
- Modify: `src/lib/app-store.ts`, `src/app/api/me/route.ts`, `src/components/account/account-menu.tsx`, `src/app/[lang]/layout.tsx` (footer), `scripts/tests/app-store.test.mjs`, `src/components/account/account.module.css`

**Interfaces:**
- Produces: `TOPICS = ["updates","weekly"] as const`; `getSubscriptions(db, userId): Promise<{ updates: boolean; weekly: boolean }>`; `setSubscriptions(db, { userId, language, updates, weekly }): Promise<{ updates: boolean; weekly: boolean }>` — per topic: on → upsert with `unsubscribed_at = NULL`, `language` = given, `subscribed_at` kept when already active and reset to `now()` when re-subscribing after an unsubscribe; off → set `unsubscribed_at = now()` only where it is null (no row is created for a topic never subscribed).
- `PUT /api/subscriptions` body `{ updates: boolean, weekly: boolean, language: "en" | "zh-CN" }` → 404 disabled, 403 origin, 401 signed out, 400 `{error:"invalid"}` unless both are booleans and language is one of the two, 200 `{ subscriptions }`.
- `GET /api/me` now returns the real `subscriptions` for a signed-in user.

- [ ] **Step 1: Store tests** — subscribe both → two active rows; unsubscribe one → row kept, `unsubscribed_at` set, `getSubscriptions` reports false; unsubscribing a topic never subscribed creates no row; re-subscribe → `unsubscribed_at` null and `subscribed_at` newer; language is updated on change.
- [ ] **Step 2: Implement store functions and the route; run tests.**
- [ ] **Step 3: UI** — `<Subscribe language enabled />` (client), used in two places: the footer (a button "Subscribe" / "订阅" placed before `.footer-links`) and the account menu item. Signed out → sign-in with `callbackURL` = current path. Signed in → `<dialog>` with two checkboxes "Site updates" / "网站更新" and "Weekly report" / "周报", prefilled from `useMe()`, and "Save" / "保存". Saving sends the page's language. After saving shows "Saved" / "已保存" and calls `refreshMe()`. When at least one topic is active the footer button reads "Subscribed" / "已订阅".
- [ ] **Step 4: Check footer and menu in both languages at 1280 and 360px; `pnpm check`; commit.**

---

### Task 6: Admin page

**Files:**
- Create: `src/app/[lang]/admin/page.tsx`, `src/app/[lang]/admin/admin.module.css`, `src/app/[lang]/admin/decide.tsx`, `src/app/api/admin/submissions/route.ts`, `src/app/api/admin/subscribers/route.ts`, `src/lib/csv.ts`
- Modify: `src/lib/app-store.ts`, `src/app/robots.ts`, `src/components/account/account-menu.tsx` (the Admin item), `scripts/tests/app-store.test.mjs`, `scripts/tests/test_app_rules_unit.mjs`, `scripts/tests/site-output.test.mjs`

**Interfaces:**
- Produces (`app-store.ts`):

```ts
export type AdminGroup = { handle: string; displayHandle: string; ownerKind: OwnerKind; status: "pending" | "approved" | "rejected";
  count: number; firstAt: string; decidedAt: string | null; decidedBy: string | null; reason: string | null; importedAt: string | null;
  requests: { name: string; email: string; note: string | null; createdAt: string }[] };
export async function adminGroups(db: Pool, view: "pending" | "decided"): Promise<AdminGroup[]>;
export async function decide(db: Pool, input: { handle: string; ownerKind: OwnerKind; decision: "approved" | "rejected"; reason: string | null; adminId: string }): Promise<number>; // rows changed
export async function subscriberCounts(db: Pool): Promise<{ total: number; updates: number; weekly: number }>;   // active only; total = distinct users
export async function subscriberRows(db: Pool): Promise<{ email: string; name: string; language: string; topics: string; subscribedAt: string }[]>; // one row per user, topics joined with "+"
```

`adminGroups("pending")`: groups pending rows by `(handle, owner_kind)`, oldest group first. `adminGroups("decided")`: groups decided rows by `(handle, owner_kind, status, decided_at)`, newest decision first, at most 200 groups; `decidedBy` is the deciding user's email. `decide` updates only rows with `status = 'pending'` for that `(platform 'x', handle, owner_kind)` and returns the count; 0 means someone else already decided.

- `src/lib/csv.ts`: `csv(rows: string[][]): string` — RFC 4180 quoting, `\r\n` line ends, UTF-8 BOM first, and any cell starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with `'`. No imports. Unit-tested in `test_app_rules_unit.mjs`: quotes and commas, a newline inside a cell, `=HYPERLINK(...)` becomes `'=HYPERLINK(...)`, the BOM.
- `POST /api/admin/submissions` body `{ handle: string, ownerKind, decision: "approve" | "reject", reason?: string }` → 404 unless enabled **and** `isAdmin(user)` (signed out and non-admin both get 404); 403 origin; 400 `{error:"invalid"}` (handle not matching `^[a-z0-9_]{1,15}$`, kind, decision, or reject without a 1–280 character trimmed reason; a reason sent with approve is ignored); 200 `{ changed: number }`.
- `GET /api/admin/subscribers` → 404 unless admin; `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="openaiwill-subscribers-<YYYYMMDD>.csv"`, header row `email,name,language,topics,subscribed_at`.

- [ ] **Step 1: Store tests** — three users submit the same handle as `person`, one also submits it as `organization`: pending view has two groups, the person group `count` 3 with three requests; `decide(approve)` on the person group returns 3 and leaves the organization group pending; `decide` again returns 0; reject stores the reason on every row; decided view shows `decidedBy` email; counts: a user with both topics counts once in `total`; an unsubscribed user is in neither.
- [ ] **Step 2: Implement; run.**
- [ ] **Step 3: Page** — `src/app/[lang]/admin/page.tsx`: `export const dynamic = "force-dynamic"`; `generateMetadata` returns title "Admin" / "后台" with `robots: { index: false, follow: false }`; the page builds a `Request`-like header set with `headers()` from `next/headers`, calls `currentUser`, and calls `notFound()` unless `appEnabled() && isAdmin(user)`. This is the one page allowed to read the session. Content:
  - Tabs as plain links: `?view=pending` (default) and `?view=decided`.
  - Subscribers line: `Subscribers 12 · Updates 10 · Weekly 9` / `订阅 12 · 网站更新 10 · 周报 9` and a link "Download CSV" / "下载名单" to `/api/admin/subscribers`.
  - One row per group: `@displayHandle` (link to `https://x.com/<handle>`, new tab, `noreferrer`), type, count ("3 requests" / "3 人提交"), first date, and an expandable list of requests (name, email, note as plain text, date). Pending rows carry `<Decide>`; decided rows show status, reason, decider, date, and "Imported" / "已导入" with its date when `importedAt` is set.
  - `<Decide handle ownerKind language />` (client): "Approve" / "通过" and "Reject" / "拒绝"; reject reveals a required reason field (`maxLength={280}`). On success `router.refresh()`. When `changed` is 0 shows "Already decided" / "已被处理" and refreshes.
  - Empty state: "Nothing to review" / "没有待审核的申请".
- [ ] **Step 4: robots** — in `src/app/robots.ts` add `disallow: ["/admin", "/zh-CN/admin", "/api/"]` to every rule (wildcard and each named crawler). Update the existing robots test in `site-output.test.mjs` (its name says "allows everything") to assert the three disallow lines appear and that `/` is still allowed for every named crawler.
- [ ] **Step 5: Output tests** — `/admin` and `/zh-CN/admin` answer 404 in both the disabled and the enabled test servers (no session); `POST /api/admin/submissions` and `GET /api/admin/subscribers` without a session answer 404; the sitemap contains no `/admin`.
- [ ] **Step 6: Account menu** — add the Admin item for administrators.
- [ ] **Step 7: Report honestly, check, commit** — a Google session cannot be created in tests, so the signed-in admin page is exercised only through the store tests and the 404 checks; say in the report exactly what was and was not exercised. `pnpm check`; commit with explicit paths.

---

### Task 7: Privacy and terms pages

**Files:**
- Create: `src/lib/legal.ts`, `src/app/[lang]/privacy/page.tsx`, `src/app/[lang]/terms/page.tsx`, `src/app/[lang]/legal.module.css`
- Modify: `src/lib/site-pages.ts` (`FIXED_PATHS` gains `"/privacy"`, `"/terms"`), `src/app/[lang]/layout.tsx` (footer links), `scripts/tests/site-output.test.mjs` (`FIXED` list), `scripts/site_release.py` (smoke: the two pages in both languages), `scripts/tests/test_site_release_unit.py` if it pins the smoke list, `src/app/llms.txt/route.ts` only if it enumerates fixed pages by hand

**Interfaces:**
- Produces: `legalCopy` in `src/lib/legal.ts` — `bilingual({ en: { privacy: Doc, terms: Doc }, "zh-CN": {...} })` with `type Doc = { title: string; updated: string; sections: { heading: string; body: string[] }[] }`; `updated` is `2026-10-04`.
- Pages: `export const dynamic = "force-dynamic"` is not needed (no data) — follow whatever `whitepaper` does so the build stays consistent; `generateMetadata` through `pageMetadata({ language, path, title, description })`.
- Footer: links "Privacy" / "隐私" and "Terms" / "条款" via `href(language, "/privacy")`, `href(language, "/terms")`, inside `.footer-links` before the social links.

- [ ] **Step 1: Tests first** — add `/privacy` and `/terms` to `FIXED` in `site-output.test.mjs`; add a test that both pages, in both languages, contain the words for what is stored (`email`/`邮箱`) and how to ask for deletion, and contain none of the claims the existing "no page claims…" test forbids. Run → fail.
- [ ] **Step 2: Copy** (the owner reviews it before launch; write it exactly, plain and short):

English — Privacy:
  - **What we store** — When you sign in with Google: your email address, name and profile picture, as Google gives them to us. When you submit an account: the X handle, whether it is a person or a company, and your note. When you subscribe: which topics, your language, and when.
  - **What we use it for** — To show you your own submissions and their status, to let an administrator review them, and to send the updates you subscribed to. Nothing else.
  - **What we do not do** — We do not sell or share your information. We do not use it for advertising. Reading the site needs no account and sets no tracking cookie; signing in sets a session cookie, and choosing a language saves that choice.
  - **Where it is kept** — On our server, in a database separate from the published data. Backups are kept for 14 days.
  - **Your choices** — Unsubscribe at any time from the Subscribe control. To have your account and everything tied to it deleted, contact us on X at @openaiwill or in our Discord; we delete it within 30 days.
  - **Changes** — We change this page when what we store changes, and date it.

English — Terms:
  - **What this is** — openaiwill is an initiative to make progress toward AI independently completing major work more transparent. The site is provided as is, without warranty.
  - **The data** — Levels, links and readings on this site are proposed by machine and have not been reviewed. Check the original source before relying on any of it.
  - **Submitting accounts** — Submit only public X accounts that publish about AI. Do not submit accounts to harass someone or to impersonate them. A submission is a request: we may decline it, and approval does not mean the account's identity has been confirmed.
  - **Your account** — You sign in with Google. We may remove submissions or close accounts that abuse the site.
  - **Contact** — X @openaiwill, or our Discord.

Chinese: a faithful translation of each section, same headings (存储什么 / 用来做什么 / 不做什么 / 保存在哪 / 你的选择 / 变更；这是什么 / 关于数据 / 提交帐号 / 你的帐号 / 联系方式). Use `SOCIAL_LINKS` for the X and Discord links rather than typing the addresses again. Do not call openaiwill a platform in either language.

- [ ] **Step 3: Implement pages, footer links, `FIXED_PATHS`; run the tests; check both pages at 1280 and 360px.**
- [ ] **Step 4: Smoke** — in `scripts/site_release.py`'s `smoke`, add: `/privacy`, `/zh-CN/privacy`, `/terms`, `/zh-CN/terms` → 200; `/admin` → 404; `/api/me` → 200 with a JSON body that has an `enabled` key. Update its unit tests accordingly.
- [ ] **Step 5: `pnpm check`; commit.**

---

### Task 8: Server setup, backups, environment, pull command, documentation

**Files:**
- Modify: `deploy/db/roles.sql`, `deploy/db/compose.yml`, `scripts/server_db.py`, `scripts/site_release.py`, `scripts/app_db.py`, `scripts/app-db.py`, `scripts/tests/test_data_server_unit.py`, `scripts/tests/test_site_release_unit.py`, `scripts/tests/test_data_app.py`, `package.json`, `docs/development/deployment.md`, `docs/seo-geo-strategy.md` (one line: subscriptions collect the weekly list), `deploy/deploy.env.example` only if a new local key is needed (none expected)
- Read first: all of `scripts/server_db.py` and the functions it uses from `scripts/site_release.py`; the existing unit tests for `setup_script`.

**Interfaces:**
- Produces: `pnpm db:setup` additionally creates `oaw_app`, schema `app`, applies `db/app/*.sql`, writes app settings into `site.env`, starts the backup service. `pnpm site:env` uploads the Google values and the administrator list. `pnpm submissions:pull` writes the local list.

- [ ] **Step 1: `deploy/db/roles.sql`** — add `\getenv app_password OAW_APP_PASSWORD`; create/alter role `oaw_app` exactly like the other two; `GRANT CONNECT ON DATABASE openaiwill TO oaw_app`; after `\connect openaiwill`: `CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION oaw_app;` and `ALTER ROLE oaw_app SET search_path = app;`. `oaw_site` gets nothing on `app`; `oaw_app` gets nothing on `kg`.

- [ ] **Step 2: `setup_script` in `scripts/server_db.py`** — changes, each covered by a unit test on the generated script text (as the existing tests do):
  - `db.env` gains `OAW_APP_PASSWORD`. A `db.env` that exists without it gets the line appended with a newly generated password (existing lines untouched).
  - `site.env`: after the existing `DATABASE_URL` logic, append — only when the key is absent — `APP_DATABASE_URL=postgres://oaw_app:<pw>@openaiwill-db:5432/openaiwill`, `BETTER_AUTH_SECRET=<64 hex>`, `BETTER_AUTH_URL=https://openaiwill.com`. Existing keys are never rewritten, except `APP_DATABASE_URL`, which is rewritten when `db.env`'s app password does not match it (so a regenerated `db.env` heals).
  - Upload `db/app/*.sql` beside `001_kg.sql` (each through `heredoc` with its own tag) and apply them with `psql -U oaw_app -d openaiwill` after `roles.sql`.
  - Password checks: add `oaw_app` to the over-the-network authentication check (`SELECT count(*) FROM app.submissions`), and assert isolation: as `oaw_app`, `SELECT 1 FROM kg.releases` must fail; as `oaw_site`, `SELECT 1 FROM app.submissions` must fail. A unexpected success exits 1 with a one-line message.
  - Create `<DEPLOY_ROOT>/backups` (mode 700, owned by the deploy user).
  - No password appears in the script text, in an argument list, or in output.

- [ ] **Step 3: Backup service in `deploy/db/compose.yml`** — a second service `backup` in the same project: image `postgres:16-alpine`, `restart: unless-stopped`, `depends_on: db (service_healthy)`, network `openaiwill`, volume `../backups:/backups`, environment `PGPASSWORD: ${POSTGRES_PASSWORD}`, and a shell loop: `umask 077`; every 24 h run `pg_dump -h openaiwill-db -U postgres -d openaiwill -n app | gzip` into `/backups/app-<UTC stamp>.sql.gz.tmp`, rename to `.sql.gz` only when the dump succeeded (`set -o pipefail`) and the file is non-empty, otherwise delete the temp file and write one line to stderr; delete `app-*.sql.gz` older than 14 days. The first dump runs at start. In Compose, `$` in the command must be written `$$`. Verify the loop locally with `docker compose` against the local database container or a scratch one (not the server) and record what you ran.

- [ ] **Step 4: `pnpm site:env`** — new subcommand `env` in `scripts/site_release.py`: reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAILS` from the local `.env` then `.env.local` (later wins); refuses (one line, exit 1) when either Google value is missing or `ADMIN_EMAILS` has no address containing `@`; sends a script on stdin that sets those three keys in `site.env` (replace or append, other lines untouched, mode 600) — the values travel inside the stdin script, never on a command line; values containing a newline or a single quote are refused. Prints only the key names it set and `restart the site for this to take effect: pnpm site:release && pnpm site:promote`. Unit tests on the generated script and on the refusals. Add `"site:env": "python3 scripts/site_release.py env"`.

- [ ] **Step 5: Candidate checks** — where the release script diagnoses a candidate, add: `/api/me` reports `enabled: true` when `site.env` contains `APP_DATABASE_URL` (probe through the same forward the smoke uses). A candidate with app settings whose `/api/me` says `enabled: false` or fails is a failed candidate with the message `sign-in is configured but not answering`.

- [ ] **Step 6: `pnpm submissions:pull`** — `scripts/app_db.py: pull(target: str) -> None` and CLI `pull --target server|local` (package script uses `server`):
  - server: open an SSH forward with the existing `server_db` helpers and connect as `oaw_app` (add `read_app_password(target)` next to `read_writer_password`, same no-sudo `sed` approach, same `checked_password`).
  - In one transaction: `SELECT ... FROM app.submissions WHERE status = 'approved' AND imported_at IS NULL FOR UPDATE`, group by `(handle, owner_kind)` → `{handle (display form of the earliest row), account_kind, requests, notes[], approved_at}`; write `data/submissions/approved-<UTC stamp>.json` (`{"pulled_at", "accounts": [...]}`, directory created, file mode 600) **before** committing; then `UPDATE ... SET imported_at = now()` for exactly those ids; commit. If writing the file fails, roll back. No requester email or name is written to the file.
  - Nothing to pull → prints `no approved submissions waiting` and writes no file.
  - Prints the file path and the count, and: `add name and role for each person, then import with pnpm data:panel:import`.
  - Real-database test in `test_data_app.py` (local target, scratch database, temp output directory): two users approve-pending for one handle and one for another → one file with two accounts, `requests` 2 and 1; second run writes nothing; a pending and a rejected row are never included; the file has no `@` email in it.

- [ ] **Step 7: Runbook** — `docs/development/deployment.md`: replace the stale "尚未执行首次发布" statement with the facts (first release executed 2026-10-04; do not copy release ids); add a section "用户数据（`app`）" covering: what is stored, the three roles and what each can reach, where the passwords and settings live, `pnpm db:setup` now also creating `app`, `pnpm site:env`, backups (where, how long, how to restore: `gunzip -c <file> | docker exec -i openaiwill-db psql -U postgres -d openaiwill` into an emptied `app` schema — write the exact commands), `pnpm submissions:pull`, the Google console steps (redirect URIs with port 3456 locally; branding page needs home, privacy and terms links before publishing; no logo upload), and the order for this launch: `db:setup` → `site:env` → `site:release` → `site:promote` → sign in on production → fill the branding links → publish the Google app.
- [ ] **Step 8: `pnpm check` and `pnpm data:test`; commit** with explicit paths.

---

## After the last task (controller, not a subagent)

1. Whole-branch review of the commits of this plan.
2. Update `CLAUDE.md` (local, ignored): authentication purposes now include submissions, subscriptions and an administrator list; `app` schema exists; new commands.
3. Ask the owner to: add `ADMIN_EMAILS=<their Google address>` to the local `.env`; sign in once on `http://localhost:3456` to confirm Google's side; read the privacy and terms copy.
4. Launch, on the owner's word: `pnpm db:setup` → `pnpm site:env` → `pnpm site:release` → `pnpm site:promote` → public checks → `pnpm site:indexnow`.
