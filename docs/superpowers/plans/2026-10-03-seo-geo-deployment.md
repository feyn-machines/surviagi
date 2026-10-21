# SEO, GEO and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put openaiwill.com online from a local build pushed over SSH, with per-language URLs, complete search metadata, and content AI engines can read and cite.

**Architecture:** Pages move under `src/app/[lang]/` and are all prerendered at build time, so the snapshot is read only on the build machine and never uploaded. `src/proxy.ts` maps clean English URLs onto the `en` segment and handles `?lang=` and the saved choice. The build is a Next.js `standalone` server, shipped by `rsync` to `/opt/openaiwill/releases/<id>/` and run by Docker Compose on `127.0.0.1:8320` behind the server's existing Cloudflare Tunnel.

**Tech Stack:** Next.js 16.3.4 App Router (`next/root-params`, `proxy.ts`, metadata file conventions), TypeScript, Node 22, Python 3 stdlib for the release script, Docker Compose on Ubuntu 24.04, Cloudflare Tunnel.

**Spec:** `docs/superpowers/specs/2026-10-03-seo-geo-deployment-design.md`

## Global Constraints

- Read the relevant guide under `node_modules/next/dist/docs/01-app/` before writing Next.js code. This version differs from older ones: `proxy.ts` (not middleware), `next/root-params`, `global-not-found`.
- **Start from a clean working tree.** The repository currently has uncommitted work in `src/app/` and elsewhere. Task 2 moves those files; the user commits or stashes their work first. Do not commit unrelated changes on their behalf.
- Site address: `https://openaiwill.com`. English has no prefix (`/markets`); Chinese is `/zh-CN/markets`. Languages are exactly `en` and `zh-CN`. Browser language is never consulted.
- Every user-facing string exists in both languages. UI copy stays short: labels and numbers, no method or caveat prose.
- Titles, descriptions, structured data and `llms.txt` must not state or imply a replacement percentage, a failure probability, a verified or reviewed score, or call openaiwill a platform.
- Nothing from `datasets/published/`, `data/`, `local/`, `.env*` may appear in the release directory. Server address and user live in ignored `.env.deploy`.
- Server ports: `8320` production, `8321` candidate, both bound to `127.0.0.1`. Compose projects: `openaiwill`, `openaiwill-next`. Runtime image: `node:22-alpine`.
- Tasks 1–9 change local code only. Task 10 touches the server and **requires the user's explicit instruction to run**.
- After each task run the focused checks named in it; after Tasks 4, 7 and 9 run the full `pnpm check`.
- Do not commit unless the user has asked for commits in this execution; if they have, commit at the end of each task with the message given.

## Review Focus

1. **Occupation addresses contain a dot** (`/occupations/11-1011.00`). A proxy matcher that skips "anything with a file extension" would leave them unrouted. Expected: routed like any page. Pinned in Task 2 (matcher) and Task 9 (smoke).
2. **Wrong casing of the language tag** (`/ZH-cn/markets`). Expected: one permanent redirect to `/zh-CN/markets`, not a duplicate page and not a 404. Pinned in Task 1.
3. **Unknown or repeated `?lang=` values** (`?lang=fr`, `?lang=`). Expected: the parameter is dropped with one redirect and no loop; the language does not change and nothing is saved. Pinned in Task 1.
4. **An address that is not in the snapshot** (`/markets/nope`, `/zh-CN/updates/nope`). Expected: HTTP 404, never a 200 "no data" page, because the server has no snapshot to consult. Pinned in Task 4 and Task 9 (smoke).
5. **Redirects behind the tunnel.** The origin sees plain HTTP. Expected: redirect `Location` values are relative, so they can never point at `http://` or at an internal host. Pinned in Task 2 and Task 9 (smoke).

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/i18n.ts` (modify) | Pure language logic: `localizedPath`, `splitLanguagePath`, `languageRoute`. No `next/*` imports. |
| `src/lib/locale.ts` (create) | `getLocale()` for Server Components, from `next/root-params`. |
| `src/proxy.ts` (rewrite) | Thin adapter: runs `languageRoute`, sets cookie and `X-Robots-Tag`. |
| `src/app/[lang]/…` (moved) | Every page, the root layout, `error.tsx`, `not-found.tsx`. |
| `src/app/global-not-found.tsx` (create) | 404 for addresses that match no route. |
| `src/lib/routes.ts` (modify) | `href(language, path)` and the entity link helpers. |
| `src/lib/site-pages.ts` (create) | The single list of prerendered detail parameters; used by pages and the sitemap. |
| `src/lib/seo.ts` (create) | `SITE_URL`, default copy, `pageMetadata`, JSON-LD builders. |
| `src/components/json-ld.tsx` (create) | Renders one JSON-LD script. |
| `src/app/sitemap.ts`, `src/app/robots.ts` (create) | Metadata files. |
| `src/app/llms.txt/route.ts`, `src/app/healthz/route.ts` (create) | Static route handlers. |
| `public/og/en.png`, `public/og/zh-CN.png` (create) | Share images. |
| `deploy/Dockerfile`, `deploy/compose.yml` (create) | Runtime container. |
| `scripts/site_release.py` (create) | `release`, `promote`, `rollback`, `status`. |
| `scripts/tests/site-output.test.mjs` (create) | Assertions on the built HTML, sitemap, robots, llms.txt. |
| `scripts/tests/test_site_release_unit.py` (create) | Unit tests for the release script's pure functions. |
| `docs/development/deployment.md` (create) | Runbook, including the Cloudflare steps. |

---

### Task 1: Language path logic

**Files:**
- Modify: `src/lib/i18n.ts`
- Test: `scripts/tests/test_i18n_unit.mjs`

**Interfaces:**
- Produces:
  - `localizedPath(language: Language, path: string): string`
  - `splitLanguagePath(pathname: string): { language: Language | null; path: string; exact: boolean }`
  - `languageRoute(request: { pathname: string; search: string; savedLanguage?: string | null; navigation: boolean }): LanguageRoute`
  - `type LanguageRoute = { kind: "redirect"; status: 307 | 308; location: string; save: Language | null } | { kind: "rewrite"; pathname: string } | { kind: "pass" }`

- [ ] **Step 1: Write the failing tests**

Add `localizedPath, splitLanguagePath, languageRoute` to the destructured import near the top of `scripts/tests/test_i18n_unit.mjs`, then append:

```js
test("English paths have no prefix; Chinese paths are prefixed", () => {
  assert.equal(localizedPath("en", "/"), "/");
  assert.equal(localizedPath("en", "/markets"), "/markets");
  assert.equal(localizedPath("zh-CN", "/"), "/zh-CN");
  assert.equal(localizedPath("zh-CN", "/markets/x#a"), "/zh-CN/markets/x#a");
});

test("a path is split into its language and the rest", () => {
  assert.deepEqual(splitLanguagePath("/markets"), { language: null, path: "/markets", exact: true });
  assert.deepEqual(splitLanguagePath("/zh-CN"), { language: "zh-CN", path: "/", exact: true });
  assert.deepEqual(splitLanguagePath("/zh-CN/occupations/11-1011.00"), { language: "zh-CN", path: "/occupations/11-1011.00", exact: true });
  assert.deepEqual(splitLanguagePath("/ZH-cn/markets"), { language: "zh-CN", path: "/markets", exact: false });
});

const route = (pathname, extra = {}) => languageRoute({ pathname, search: "", navigation: true, ...extra });

test("an unprefixed address is served in English", () => {
  assert.deepEqual(route("/"), { kind: "rewrite", pathname: "/en" });
  assert.deepEqual(route("/occupations/11-1011.00"), { kind: "rewrite", pathname: "/en/occupations/11-1011.00" });
});

test("a Chinese address passes through; wrong casing is corrected once", () => {
  assert.deepEqual(route("/zh-CN/markets"), { kind: "pass" });
  assert.deepEqual(route("/ZH-cn/markets", { search: "?a=1" }), { kind: "redirect", status: 308, location: "/zh-CN/markets?a=1", save: null });
});

test("the internal English prefix is never a public address", () => {
  assert.deepEqual(route("/en/markets"), { kind: "redirect", status: 308, location: "/markets", save: null });
  assert.deepEqual(route("/en"), { kind: "redirect", status: 308, location: "/", save: null });
});

test("?lang= moves to the path address, saves the choice, and keeps other parameters", () => {
  assert.deepEqual(route("/markets", { search: "?lang=zh-CN&q=1" }), { kind: "redirect", status: 307, location: "/zh-CN/markets?q=1", save: "zh-CN" });
  assert.deepEqual(route("/zh-CN/markets", { search: "?lang=en" }), { kind: "redirect", status: 307, location: "/markets", save: "en" });
  assert.deepEqual(route("/markets", { search: "?lang=en" }), { kind: "redirect", status: 307, location: "/markets", save: "en" });
});

test("an unknown ?lang= is dropped without changing language or saving", () => {
  assert.deepEqual(route("/zh-CN/markets", { search: "?lang=fr" }), { kind: "redirect", status: 307, location: "/zh-CN/markets", save: null });
  assert.deepEqual(route("/markets", { search: "?lang=" }), { kind: "redirect", status: 307, location: "/markets", save: null });
});

test("a prefetch never saves a language", () => {
  assert.equal(route("/markets", { search: "?lang=zh-CN", navigation: false }).save, null);
});

test("a saved Chinese choice redirects a navigation, and only a navigation", () => {
  assert.deepEqual(route("/markets", { savedLanguage: "zh-CN" }), { kind: "redirect", status: 307, location: "/zh-CN/markets", save: null });
  assert.deepEqual(route("/markets", { savedLanguage: "zh-CN", navigation: false }), { kind: "rewrite", pathname: "/en/markets" });
  assert.deepEqual(route("/markets", { savedLanguage: "en" }), { kind: "rewrite", pathname: "/en/markets" });
  assert.deepEqual(route("/markets", { savedLanguage: "garbage" }), { kind: "rewrite", pathname: "/en/markets" });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm i18n:test`
Expected: FAIL — `localizedPath is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/i18n.ts`, above `bilingual`:

```ts
/** The public address of `path` in `language`. English has no prefix. */
export function localizedPath(language: Language, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (language === DEFAULT_LANGUAGE) return clean;
  return clean === "/" ? `/${language}` : `/${language}${clean}`;
}

/**
 * `/zh-CN/markets` -> zh-CN + `/markets`. `exact` is false when the tag is a
 * published language written in another casing, which is one redirect away
 * from its address rather than a second copy of the page.
 */
export function splitLanguagePath(pathname: string): { language: Language | null; path: string; exact: boolean } {
  const [, first = "", ...rest] = pathname.split("/");
  const language = normalizeLanguage(first);
  if (!language) return { language: null, path: pathname || "/", exact: true };
  return { language, path: `/${rest.join("/")}`.replace(/\/+$/, "") || "/", exact: first === language };
}

export type LanguageRoute =
  | { kind: "redirect"; status: 307 | 308; location: string; save: Language | null }
  | { kind: "rewrite"; pathname: string }
  | { kind: "pass" };

/**
 * What the proxy does with one request. Pure, so every rule is unit tested.
 *
 * Redirect locations are relative on purpose: the origin sits behind a tunnel
 * and sees plain HTTP on an internal host, and a relative Location cannot
 * leak either.
 *
 * `?lang=` redirects are temporary. A browser caches a permanent redirect and
 * stops asking the server, so the second click on a language link would no
 * longer save the choice.
 */
export function languageRoute(request: {
  pathname: string;
  search: string;
  savedLanguage?: string | null;
  navigation: boolean;
}): LanguageRoute {
  const { language: prefix, path, exact } = splitLanguagePath(request.pathname);
  const params = new URLSearchParams(request.search);

  if (params.has(LANGUAGE_PARAM)) {
    const requested = urlLanguage(request.search);
    params.delete(LANGUAGE_PARAM);
    const query = params.toString();
    const target = requested ?? prefix ?? DEFAULT_LANGUAGE;
    return {
      kind: "redirect",
      status: 307,
      location: `${localizedPath(target, path)}${query ? `?${query}` : ""}`,
      save: request.navigation ? requested : null,
    };
  }

  if (prefix === DEFAULT_LANGUAGE) {
    return { kind: "redirect", status: 308, location: `${path}${request.search}`, save: null };
  }
  if (prefix) {
    return exact
      ? { kind: "pass" }
      : { kind: "redirect", status: 308, location: `${localizedPath(prefix, path)}${request.search}`, save: null };
  }

  const saved = normalizeLanguage(request.savedLanguage);
  if (saved && saved !== DEFAULT_LANGUAGE && request.navigation) {
    return { kind: "redirect", status: 307, location: `${localizedPath(saved, path)}${request.search}`, save: null };
  }
  return { kind: "rewrite", pathname: `/${DEFAULT_LANGUAGE}${path === "/" ? "" : path}` };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm i18n:test`
Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Commit** — `Add path-based language routing rules`

---

### Task 2: Move pages under `[lang]` and prerender them

**Files:**
- Create: `src/lib/locale.ts`, `src/app/global-not-found.tsx`
- Move into `src/app/[lang]/`: `layout.tsx`, `page.tsx`, `home.module.css`, `error.tsx`, `error.module.css`, `not-found.tsx`, `markets/`, `occupations/`, `updates/`, `voices/`, `whitepaper/`, `work/`
- Stay in `src/app/`: `globals.css`, `design-tokens.css`, `icon.svg`
- Modify: `src/proxy.ts`, `src/lib/i18n.ts`, `src/components/language-switch.tsx`, `next.config.ts`

**Interfaces:**
- Consumes: `languageRoute`, `LANGUAGES`, `normalizeLanguage` from Task 1.
- Produces: `getLocale(): Promise<{ language: Language }>` exported from `@/lib/locale` (no longer from `@/lib/i18n`).

- [ ] **Step 1: Read the guides**

Read `02-guides/internationalization.md`, `03-api-reference/04-functions/next-root-params.md`, `03-api-reference/03-file-conventions/proxy.md` and the `global-not-found` section of `03-file-conventions/not-found.md`.

- [ ] **Step 2: Move the files**

```bash
mkdir -p "src/app/[lang]"
for f in layout.tsx page.tsx home.module.css error.tsx error.module.css not-found.tsx markets occupations updates voices whitepaper work; do
  mv "src/app/$f" "src/app/[lang]/$f"
done
grep -rn '@/app/' src --include='*.ts' --include='*.tsx'
```

For every hit of the `grep`, insert `[lang]/` after `@/app/` unless the import targets `globals.css` or `design-tokens.css`.

- [ ] **Step 3: Create `src/lib/locale.ts`**

```ts
import { lang } from "next/root-params";
import { DEFAULT_LANGUAGE, normalizeLanguage, type Language } from "./i18n";

/**
 * The language of the page being rendered, from the `[lang]` segment.
 *
 * It lives apart from `i18n.ts` because `next/root-params` can only be
 * imported by Server Components, while `i18n.ts` is also loaded by the proxy,
 * by Client Components and by plain-node tests.
 */
export async function getLocale(): Promise<{ language: Language }> {
  return { language: normalizeLanguage(await lang()) ?? DEFAULT_LANGUAGE };
}
```

- [ ] **Step 4: Remove the request-based reader**

In `src/lib/i18n.ts` delete `getLocale`, `getRequestUrl`, `LANGUAGE_HEADER`, `REQUEST_URL_HEADER` and `languageHref`, and update the file's header comment: precedence is now "the language in the path, then for an unprefixed address the saved choice, then English". Delete the `languageHref` tests from `scripts/tests/test_i18n_unit.mjs` and its name from the import there.

In every file that imports `getLocale` from `@/lib/i18n`, import it from `@/lib/locale` instead and keep the other names on the `@/lib/i18n` import. Find them with `grep -rln "getLocale" src`.

- [ ] **Step 5: Root layout**

In `src/app/[lang]/layout.tsx`:

- change `import "./globals.css"` to `import "../globals.css"`;
- change the three font `src` values from `"../../design/…"` to `"../../../design/…"`;
- add below the font declarations:

```ts
/** Both languages are built ahead of time; no other value of the segment is a page. */
export function generateStaticParams() {
  return LANGUAGES.map((lang) => ({ lang }));
}
export const dynamicParams = false;
```

and add `LANGUAGES` to the `@/lib/i18n` import. Leave `generateMetadata` as it is; Task 5 replaces it.

- [ ] **Step 6: Language switch without request headers**

Replace the body of `LanguageSwitch` in `src/components/language-switch.tsx` so it no longer needs the current URL. A query-only `href` resolves against the address the reader is on, so the path is kept without JavaScript:

```tsx
import { LANGUAGES, LANGUAGE_PARAM, bilingual, languageName, type Language } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
```

```tsx
export async function LanguageSwitch() {
  const { language } = await getLocale();
  const c = copy[language];
  return (
    <nav className="oaw-lang" aria-label={c.switchLabel}>
      {LANGUAGES.map((option) => {
        const current = option === language;
        return (
          <a
            key={option}
            className={current ? "oaw-lang-option oaw-lang-option-current" : "oaw-lang-option"}
            href={`?${LANGUAGE_PARAM}=${option}`}
            hrefLang={option}
            lang={option}
            aria-current={current ? "true" : undefined}
          >
            {languageName(option)}
            <span className="oaw-sr-only" lang={language}>
              {" "}
              {current ? c.currentLanguage : c[SWITCH_KEY[option]]}
            </span>
          </a>
        );
      })}
    </nav>
  );
}
```

Update the component's doc comment: the proxy turns `?lang=` into the path address and saves the choice.

- [ ] **Step 7: Rewrite `src/proxy.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { LANGUAGE_COOKIE, LANGUAGE_COOKIE_MAX_AGE, languageRoute } from "./lib/i18n";

/**
 * Only a top-level navigation is a reader choosing a language. Speculative
 * prefetches and client-side data requests must not rewrite the saved choice
 * or be bounced to another language.
 */
function isNavigation(request: NextRequest) {
  const destination = request.headers.get("sec-fetch-dest");
  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  return (destination === null || destination === "document") && !purpose.includes("prefetch");
}

/**
 * English is served at unprefixed addresses and Chinese under `/zh-CN`; the
 * pages themselves live under `/[lang]`. The rules are in `languageRoute`.
 */
export function proxy(request: NextRequest) {
  const route = languageRoute({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    savedLanguage: request.cookies.get(LANGUAGE_COOKIE)?.value,
    navigation: isNavigation(request),
  });

  let response: NextResponse;
  if (route.kind === "redirect") {
    // A relative Location: see `languageRoute`.
    response = new NextResponse(null, { status: route.status, headers: { Location: route.location } });
    if (route.save) {
      response.cookies.set({
        name: LANGUAGE_COOKIE,
        value: route.save,
        path: "/",
        maxAge: LANGUAGE_COOKIE_MAX_AGE,
        sameSite: "lax",
      });
    }
  } else if (route.kind === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = route.pathname;
    response = NextResponse.rewrite(url);
  } else {
    response = NextResponse.next();
  }

  // Only the production service may be indexed; a candidate build must not be.
  if (process.env.SITE_ENV !== "production") response.headers.set("X-Robots-Tag", "noindex");
  return response;
}

/**
 * Files that are not pages are named one by one. "Anything with an extension"
 * would be wrong: occupation addresses such as /occupations/11-1011.00 contain
 * a dot. The 32-hex `.txt` is the IndexNow key file in `public/`.
 */
export const config = {
  matcher: [
    "/((?!_next/|og/|healthz$|robots\\.txt$|sitemap\\.xml$|llms\\.txt$|icon\\.svg$|[0-9a-f]{32}\\.txt$).*)",
  ],
};
```

- [ ] **Step 8: The 404 for unmatched addresses**

In `next.config.ts` add to the config object: `experimental: { globalNotFound: true },`.

Create `src/app/global-not-found.tsx`. It renders outside every layout, so it cannot read the `[lang]` segment; like `error.tsx` it reads the language off the address in the browser and renders English on the server:

```tsx
"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_LANGUAGE, bilingual, localizedPath, splitLanguagePath, type Language } from "@/lib/i18n";
import "./globals.css";

const copy = bilingual({
  en: { eyebrow: "404 · NO SUCH PAGE", title: "Page not found.", home: "Home →" },
  "zh-CN": { eyebrow: "404 · 没有这个页面", title: "页面不存在。", home: "回到首页 →" },
});

const subscribe = () => () => {};
const addressLanguage = (): Language => splitLanguagePath(window.location.pathname).language ?? DEFAULT_LANGUAGE;
const serverLanguage = (): Language => DEFAULT_LANGUAGE;

export default function GlobalNotFound() {
  const language = useSyncExternalStore(subscribe, addressLanguage, serverLanguage);
  const c = copy[language];
  return (
    <html lang={language}>
      <body>
        <main className="wrap">
          <section className="inner-page">
            <p className="eyebrow"><span className="dot" />{c.eyebrow}</p>
            <h1>{c.title}</h1>
            <div className="actions">
              <a className="text-link" href={localizedPath(language, "/")}>{c.home}</a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
```

If the build rejects `"use client"` on this file, move everything inside `<body>` into `src/components/not-found-body.tsx` as the Client Component and keep `global-not-found.tsx` a Server Component rendering `<html lang="en"><body><NotFoundBody /></body></html>`.

In `src/app/[lang]/not-found.tsx` update the doc comment (the language now comes from the path); the code keeps working through `getLocale()`.

- [ ] **Step 9: Build and confirm the pages are static**

Run: `pnpm typecheck && pnpm lint && time pnpm build`
Expected: the build's route table marks `/[lang]`, `/[lang]/markets`, `/[lang]/markets/[id]` and the other page routes as prerendered (● or ○), none as dynamic (ƒ) except `Proxy`. Links still point at unprefixed paths at this point; Task 3 fixes Chinese links.

Record in the task report: the number of prerendered pages printed by the build and the wall-clock build time. **If the build takes longer than 10 minutes, stop and report**; the spec says to return to the design rather than serve the snapshot online.

- [ ] **Step 10: Check the routing by hand**

Run `pnpm dev`, then in a second terminal:

```bash
curl -sI localhost:3456/markets | head -1                      # 200
curl -sI localhost:3456/zh-CN/markets | head -1                # 200
curl -sI 'localhost:3456/markets?lang=zh-CN' | grep -i -E '^(HTTP|location|set-cookie)'   # 307, /zh-CN/markets, openaiwill_language=zh-CN
curl -sI localhost:3456/en/markets | grep -i -E '^(HTTP|location)'                        # 308, /markets
curl -sI localhost:3456/ZH-cn/markets | grep -i -E '^(HTTP|location)'                     # 308, /zh-CN/markets
curl -sI -H 'Cookie: openaiwill_language=zh-CN' localhost:3456/markets | grep -i -E '^(HTTP|location)'  # 307, /zh-CN/markets
curl -s localhost:3456/zh-CN | grep -o '<html[^>]*>'           # lang="zh-CN"
curl -sI localhost:3456/no-such-page | head -1                 # 404
```

Every `location` must start with `/`, not `http`.

- [ ] **Step 11: Commit** — `Serve each language at its own address and prerender every page`

---

### Task 3: Links that carry the language

**Files:**
- Modify: `src/lib/routes.ts`, `src/lib/site-nav.ts` consumers, and every file with an internal link (list below)
- Test: `scripts/tests/site-links.test.mjs` (create); add it to the `i18n:test` script in `package.json`

**Interfaces:**
- Consumes: `localizedPath` from Task 1.
- Produces, all from `@/lib/routes`:
  - `href<T extends string>(language: Language, path: T & SitePath<T>): Route`
  - `workHref(language: Language, activityId: string): Route`
  - `updateHref(language: Language, eventId: string): Route`
  - `marketHref(language: Language, marketId: string): Route`
  - `workSlug(activityId: string): string` (unchanged)

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/site-links.test.mjs`:

```js
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}

// An internal link written as a bare string skips the language prefix, so a
// Chinese page would send its reader to the English one. Every internal link
// goes through `href()` or one of the entity helpers in src/lib/routes.ts.
test("no internal link is written as a bare path", () => {
  const offenders = [];
  for (const path of sources(SRC)) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/href=\{?\s*["'`]\//.test(line)) offenders.push(`${path.slice(SRC.length + 1)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
```

In `package.json` change `i18n:test` to:

```json
"i18n:test": "node --test scripts/tests/test_i18n_unit.mjs scripts/tests/test_site_labels_unit.mjs scripts/tests/site-links.test.mjs",
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm i18n:test`
Expected: FAIL listing about 25 `file:line` offenders.

- [ ] **Step 3: The helpers**

Replace `src/lib/routes.ts`:

```ts
import type { Route } from "next";
import { localizedPath, type Language } from "./i18n";

/**
 * `path` is written without a language prefix and checked against the route
 * tree as it would be under `/en`. A path no page serves is a type error, the
 * same guarantee `typedRoutes` gave before the pages moved under `/[lang]`.
 */
type SitePath<T extends string> = T extends "/" ? T : `/en${T}` extends Route<`/en${T}`> ? T : never;

/** A link to `path` in `language`. One place, so a link and the page it points at cannot disagree. */
export function href<T extends string>(language: Language, path: T & SitePath<T>): Route {
  return localizedPath(language, path) as Route;
}

export const workSlug = (activityId: string) => activityId.replace(/^oaw:market:/, "");
export const workHref = (language: Language, activityId: string) =>
  localizedPath(language, `/work/${workSlug(activityId)}`) as Route;
export const updateHref = (language: Language, eventId: string) =>
  localizedPath(language, `/updates/${eventId}`) as Route;
export const marketHref = (language: Language, marketId: string) =>
  localizedPath(language, `/markets/${marketId.replace(/^oaw:market:/, "")}`) as Route;
```

- [ ] **Step 4: Prove the type check bites**

Temporarily add `href("en", "/no-such-page");` to the bottom of `src/lib/routes.ts` and run `pnpm typecheck`.
Expected: an error on that line (`not assignable to parameter of type 'never'`). Remove the line. **If there is no error, stop and report**: the link guarantee would be lost and the helper needs a different type.

- [ ] **Step 5: Convert every link**

Rules, applied to each site below. Every one of these components already has `language` in scope (as a prop or from `getLocale()`); where a Client Component does not, add a `language: Language` prop and pass it from its parent.

| Before | After |
| --- | --- |
| `href="/markets"` | `href={href(language, "/markets")}` |
| ``href={`/markets/${slug}`}`` | ``href={href(language, `/markets/${slug}`)}`` |
| `href={workHref(id)}` | `href={workHref(language, id)}` (same for `updateHref`, `marketHref`) |
| `href={item.href}` where `item` comes from `SITE_NAV` or `DataPageLinks` | `href={href(language, item.href)}` |

Sites (line numbers are from before Task 2's move; the paths gain `[lang]/`):

- `src/app/[lang]/layout.tsx`: brand link `/`; the `SITE_NAV` map.
- `src/app/[lang]/not-found.tsx`: `/`, `/occupations`.
- `src/app/[lang]/page.tsx`: the `links` passed to `Rail` — build each with `href(language, item.href)`.
- `src/app/[lang]/updates/[id]/page.tsx`: `/updates` (twice), `/`, `workHref`, `marketHref`.
- `src/app/[lang]/updates/updates-browser.tsx`: `updateHref`.
- `src/app/[lang]/markets/markets-explorer.tsx`: `/markets/${row.slug}`.
- `src/app/[lang]/markets/[id]/activities.tsx`: `workHref`.
- `src/app/[lang]/markets/[id]/page.tsx`: `/markets` (twice), `/occupations/${…}`.
- `src/app/[lang]/work/[id]/page.tsx`: `marketHref` (three), `updateHref`, `workHref`, `/updates`.
- `src/app/[lang]/occupations/directory.tsx`: `/occupations/g/${g.slug}`, `/occupations/${member.slug}`.
- `src/app/[lang]/occupations/g/[id]/page.tsx`: `/`, `/markets/${…}`.
- `src/app/[lang]/occupations/[code]/explorer.tsx`: `/markets/${row.marketSlug}`.
- `src/app/[lang]/occupations/[code]/page.tsx`: `/occupations` (twice), `/markets/${row.slug}`.
- `src/components/data-page.tsx`: the three entries of `DataPageLinks`.
- `src/components/home/chain-screens.tsx`: `/updates`, `/markets`, `/occupations`, and the `/markets/…#anchor` link.
- `src/components/home/sections/updates-section.tsx`, `attention-section.tsx` (both the `Link` and the `<a>`), `graph-section.tsx`: `updateHref`, `workHref`, `marketHref`.
- `src/components/home/sections/domains-section.tsx`: `workHref`, `marketHref`.
- `src/components/home/sections/text-sections.tsx`: `/updates`, `/whitepaper`.
- `src/components/home/overview/overview.tsx`: `workHref`, `updateHref`.
- `src/components/home/sections/rail.tsx`: receives finished hrefs from the home page; no change beyond its prop type staying `Route`.

`src/components/progress-compare.tsx` and `chain-screens.tsx` carry comments about `as Route`; keep their meaning accurate after the edit.

- [ ] **Step 6: Run the checks**

Run: `pnpm i18n:test && pnpm typecheck && pnpm lint`
Expected: PASS; the link test lists no offenders.

- [ ] **Step 7: Commit** — `Carry the language through every internal link`

---

### Task 4: One list of prerendered pages, and nothing else is a page

**Files:**
- Create: `src/lib/site-pages.ts`
- Modify: the five detail pages under `src/app/[lang]/`
- Test: `scripts/tests/site-output.test.mjs` (create); `package.json` scripts

**Interfaces:**
- Produces from `@/lib/site-pages`:
  - `detailPages: { markets(): string[]; occupations(): string[]; occupationGroups(): string[]; work(): string[]; updates(): { id: string; occurredAt: string | null }[] }` — each returns URL slugs
  - `FIXED_PATHS: readonly ["/", "/markets", "/occupations", "/updates", "/voices", "/whitepaper"]`

- [ ] **Step 1: Create `src/lib/site-pages.ts`**

```ts
import {
  activities,
  chainEvents,
  groupSlug,
  markets,
  marketSlug,
  occupationSlug,
  occupations,
  progress,
} from "./snapshot";
import { workSlug } from "./routes";

/** Pages that exist whatever the snapshot holds. */
export const FIXED_PATHS = ["/", "/markets", "/occupations", "/updates", "/voices", "/whitepaper"] as const;

/**
 * The detail pages this build contains. Each detail route prerenders exactly
 * this list and serves nothing else, and the sitemap lists exactly this list,
 * so the sitemap cannot name a page that does not exist.
 */
export const detailPages = {
  markets: () => markets().map((market) => marketSlug(market.id)),
  occupations: () => occupations().map((row) => occupationSlug(row.occupation_id)),
  occupationGroups: () => Object.keys(progress?.groups ?? {}).map(groupSlug),
  /** Only work an update has reached has a page of its own. */
  work: () => activities.filter((a) => a.evidence_rows && a.level).map((a) => workSlug(a.activity_id)),
  updates: () => chainEvents.map((e) => ({ id: e.event_id, occurredAt: e.occurred_at ?? null })),
};
```

Before saving, open `src/lib/snapshot.ts` and confirm `chainEvents` rows have `occurred_at`; if the field has another name on that type, use it and keep the returned key `occurredAt`.

- [ ] **Step 2: Use it in the five detail pages**

In each file replace the body of `generateStaticParams` and add `dynamicParams` directly below it:

| File | `generateStaticParams` body |
| --- | --- |
| `markets/[id]/page.tsx` | `return detailPages.markets().map((id) => ({ id }));` |
| `occupations/[code]/page.tsx` | `return detailPages.occupations().map((code) => ({ code }));` |
| `occupations/g/[id]/page.tsx` | `return detailPages.occupationGroups().map((id) => ({ id }));` |
| `work/[id]/page.tsx` | `return detailPages.work().map((id) => ({ id }));` |
| `updates/[id]/page.tsx` | `return detailPages.updates().map(({ id }) => ({ id }));` |

```ts
/** The server holds no snapshot, so an address outside this build is a 404, not a page to render. */
export const dynamicParams = false;
```

- [ ] **Step 3: Write the output test**

Create `scripts/tests/site-output.test.mjs`. It reads what `next build` wrote, so it runs after a build:

```js
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const APP = join(ROOT, ".next", "server", "app");
const HAS_SNAPSHOT = existsSync(join(ROOT, "datasets", "published", "latest", "manifest.json"));
const FIXED = ["", "/markets", "/occupations", "/updates", "/voices", "/whitepaper"];

const html = (language, path) => readFileSync(join(APP, `${language}${path}.html`), "utf8");
const anchors = (page) => [...page.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => m[1]);
const internal = (hrefs) => hrefs.filter((h) => h.startsWith("/") && !h.startsWith("//"));

test("the build exists", () => {
  assert.ok(existsSync(APP), "run `pnpm build` first");
});

test("every fixed page is prerendered in both languages", () => {
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      assert.match(html(language, path), new RegExp(`<html[^>]*lang="${language}"`), `${language}${path}`);
    }
  }
});

test("a Chinese page links only to Chinese pages, an English page only to unprefixed ones", () => {
  for (const path of FIXED) {
    for (const link of internal(anchors(html("zh-CN", path)))) {
      assert.ok(link === "/zh-CN" || link.startsWith("/zh-CN/"), `zh-CN${path} links to ${link}`);
    }
    for (const link of internal(anchors(html("en", path)))) {
      assert.ok(!/^\/(en|zh-CN)(\/|$)/.test(link), `en${path} links to ${link}`);
    }
  }
});

test("detail pages are prerendered when there is a snapshot", { skip: !HAS_SNAPSHOT }, () => {
  for (const section of ["markets", "occupations", "updates", "work"]) {
    for (const language of ["en", "zh-CN"]) {
      const pages = readdirSync(join(APP, language, section)).filter((name) => name.endsWith(".html"));
      assert.ok(pages.length > 0, `${language}/${section} has no prerendered pages`);
    }
  }
});
```

Add to `package.json` scripts: `"site:test": "node --test scripts/tests/site-output.test.mjs"`, and in the `check` script append ` && pnpm site:test` after `pnpm build`.

- [ ] **Step 4: Build and test**

Run: `pnpm build && pnpm site:test`
Expected: PASS.

- [ ] **Step 5: The build still works with no snapshot**

CI has no snapshot. Run:

```bash
mv datasets/published/latest datasets/published/latest.aside
pnpm build && pnpm site:test; status=$?
mv datasets/published/latest.aside datasets/published/latest
exit $status
```

Expected: build succeeds, the detail-page test is skipped, the rest pass. **If the build fails because a detail route has no static parameters, stop and report.**

- [ ] **Step 6: Unknown addresses are 404**

Run `pnpm build && pnpm start`, then:

```bash
for p in /markets/nope /zh-CN/updates/nope /occupations/00-0000.00 /work/nope; do curl -s -o /dev/null -w "%{http_code} $p\n" localhost:3456$p; done
```

Expected: `404` on every line.

- [ ] **Step 7: Run `pnpm check`, then commit** — `Prerender one shared list of detail pages`

---

### Task 5: Page metadata

**Files:**
- Create: `src/lib/seo.ts`, `public/og/en.png`, `public/og/zh-CN.png`, `design/system-v1/og/card.html`
- Modify: `src/app/[lang]/layout.tsx` and the `generateMetadata` of every page
- Test: `scripts/tests/site-output.test.mjs`

**Interfaces:**
- Produces from `@/lib/seo`:
  - `SITE_URL = "https://openaiwill.com"`, `SITE_NAME = "openaiwill"`, `X_HANDLE = "@openaiwill"`, `X_URL = "https://x.com/openaiwill"`, `DISCORD_URL = "https://discord.gg/ArVHw2K9X"`, `GITHUB_URL = "https://github.com/feyn-machines/openaiwill"`, `SOCIAL_LINKS: readonly { label: string; href: string }[]` (X, Discord, GitHub)
  - `siteCopy: Record<Language, { title: string; description: string }>`
  - `absoluteUrl(language: Language, path: string): string`
  - `pageMetadata(page: { language: Language; path: string; title?: string; description?: string }): Metadata`

- [ ] **Step 1: Read** `03-api-reference/04-functions/generate-metadata.md` (fields `metadataBase`, `alternates`, `openGraph`, `twitter`).

- [ ] **Step 2: Add the failing tests** to `scripts/tests/site-output.test.mjs`:

```js
const SITE = "https://openaiwill.com";
const publicUrl = (language, path) => `${SITE}${language === "en" ? path || "/" : `/zh-CN${path}`}`;
const tag = (page, pattern) => page.match(pattern)?.[1] ?? null;

test("each page names its own address and its counterpart in the other language", () => {
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      const page = html(language, path);
      const where = `${language}${path}`;
      assert.equal(tag(page, /<link rel="canonical" href="([^"]+)"/), publicUrl(language, path), where);
      assert.equal(tag(page, /<link rel="alternate" hrefLang="en" href="([^"]+)"/), publicUrl("en", path), where);
      assert.equal(tag(page, /<link rel="alternate" hrefLang="zh-CN" href="([^"]+)"/), publicUrl("zh-CN", path), where);
      assert.equal(tag(page, /<link rel="alternate" hrefLang="x-default" href="([^"]+)"/), publicUrl("en", path), where);
      assert.equal(tag(page, /<meta property="og:url" content="([^"]+)"/), publicUrl(language, path), where);
      assert.equal(tag(page, /<meta property="og:image" content="([^"]+)"/), `${SITE}/og/${language}.png`, where);
      assert.ok(tag(page, /<meta name="description" content="([^"]+)"/), where);
      assert.equal(tag(page, /<meta name="twitter:site" content="([^"]+)"/), "@openaiwill", where);
    }
  }
});

test("every page links to the project's accounts in the header and in the footer", () => {
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      const links = anchors(html(language, path));
      for (const url of ["https://x.com/openaiwill", "https://discord.gg/ArVHw2K9X", "https://github.com/feyn-machines/openaiwill"]) {
        assert.equal(links.filter((link) => link === url).length, 2, `${language}${path}: ${url} should appear in header and footer`);
      }
    }
  }
});

test("the default title is the confirmed headline, not the retired one", () => {
  assert.match(html("en", ""), /<title>How far AI has taken over the world<\/title>/);
  assert.match(html("zh-CN", ""), /<title>AI 接管世界的进度<\/title>/);
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) assert.doesNotMatch(html(language, path), /<title>[^<]*Kill Your Idea/);
  }
});

test("no page claims a replacement share, a probability or a reviewed score", () => {
  const banned = /replacement rate|% of jobs|probability of failure|verified score|替代率|失败概率|已审核/i;
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      const page = html(language, path);
      assert.doesNotMatch(tag(page, /<title>([^<]*)<\/title>/) ?? "", banned);
      assert.doesNotMatch(tag(page, /<meta name="description" content="([^"]+)"/) ?? "", banned);
    }
  }
});
```

Run: `pnpm build && pnpm site:test` — expected: FAIL on the canonical assertion.

- [ ] **Step 3: Create `src/lib/seo.ts`**

```ts
import type { Metadata } from "next";
import { LANGUAGES, bilingual, localizedPath, type Language } from "./i18n";

/** The public address. Not a secret and not per-environment: a candidate build names the same canonical pages. */
export const SITE_URL = "https://openaiwill.com";
export const SITE_NAME = "openaiwill";
/** The project's own account on X (user-confirmed 2026-10-03). */
export const X_HANDLE = "@openaiwill";
export const X_URL = "https://x.com/openaiwill";
/** The project's community invite on Discord (user-confirmed 2026-10-03). */
export const DISCORD_URL = "https://discord.gg/ArVHw2K9X";
/** The public source repository (user-confirmed 2026-10-03). */
export const GITHUB_URL = "https://github.com/feyn-machines/openaiwill";

/** The project's own places elsewhere, in the order the footer shows them. */
export const SOCIAL_LINKS = [
  { label: "X", href: X_URL },
  { label: "Discord", href: DISCORD_URL },
  { label: "GitHub", href: GITHUB_URL },
] as const;

/**
 * The words confirmed for the first screen on 2026-09-22 (DESIGN.md): the
 * headline as the default title, the question and its supporting line as the
 * default description.
 */
export const siteCopy = bilingual({
  en: {
    title: "How far AI has taken over the world",
    description: "Will AI kill your idea? Replace what you do? Every AI update could change your answer.",
  },
  "zh-CN": {
    title: "AI 接管世界的进度",
    description: "AI 会杀死你的想法？取代你的工作能力？每一次 AI 更新，都可能会挑战你的答案。",
  },
});

const OG_LOCALE: Record<Language, string> = { en: "en_US", "zh-CN": "zh_CN" };

/** The full public address of `path` (written without a language prefix) in `language`. */
export function absoluteUrl(language: Language, path: string): string {
  return `${SITE_URL}${localizedPath(language, path)}`;
}

/**
 * Everything a page tells a search engine about itself: its own address, the
 * same page in the other language, and the share card. `path` is written
 * without a language prefix.
 */
export function pageMetadata(page: { language: Language; path: string; title?: string; description?: string }): Metadata {
  const { language, path } = page;
  const site = siteCopy[language];
  const description = page.description ?? site.description;
  const shareTitle = page.title ?? site.title;
  const url = absoluteUrl(language, path);
  const image = `/og/${language}.png`;
  return {
    ...(page.title ? { title: page.title } : {}),
    description,
    alternates: {
      canonical: url,
      languages: {
        ...Object.fromEntries(LANGUAGES.map((l) => [l, absoluteUrl(l, path)])),
        "x-default": absoluteUrl("en", path),
      },
    },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      url,
      title: shareTitle,
      description,
      locale: OG_LOCALE[language],
      images: [{ url: image, width: 1200, height: 630, alt: site.title }],
    },
    twitter: { card: "summary_large_image", site: X_HANDLE, title: shareTitle, description, images: [image] },
  };
}
```

- [ ] **Step 4: Layout defaults**

In `src/app/[lang]/layout.tsx` delete `metaDescription` from both languages of `copy` and replace `generateMetadata`:

```ts
export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: siteCopy[language].title, template: `%s | ${SITE_NAME}` },
    description: siteCopy[language].description,
  };
}
```

Import `SITE_NAME, SITE_URL, SOCIAL_LINKS, siteCopy` from `@/lib/seo`. Rewrite the comment above it: titles and descriptions follow the language of the address.

In the same file, show the project's accounts in **both the header and the footer** (user request, 2026-10-03: all three, in both places). Add a `footerLinks` key to both languages of `copy` (en `"openaiwill elsewhere"`, zh-CN `"openaiwill 的其他地址"`) and add inside `<footer>`, after the two existing `<span>`s:

```tsx
<nav className="footer-links" aria-label={c.footerLinks}>
  {SOCIAL_LINKS.map((link) => (
    <a key={link.href} href={link.href} rel="noopener">{link.label}</a>
  ))}
</nav>
```

Add one rule next to the existing `.footer` rule in `src/app/globals.css`, using only existing tokens: `.footer-links{display:flex;gap:var(--ah-space-4)}.footer-links a{text-decoration:underline;text-underline-offset:4px}`. The labels are names and are the same in both languages.

For the header, render the same three links as a second `<nav className="header-social" aria-label={c.footerLinks}>` inside `.header-end`, between the main navigation and `<LanguageSwitch />`, with the same `<a>` markup. Style it next to the existing header rules with existing tokens only (muted colour, the same font size as the main navigation, `gap:var(--ah-space-3)`). The header must not overflow: check `/` and `/markets` in both languages at 1440px and 390px wide with headless Chrome screenshots (`--window-size=1440,900` and `--window-size=390,844`) and read the images. If the links do not fit at 390px, let `.header-end` wrap onto a second row; do not hide them. The homepage also has a fixed `Rail` (`src/components/home/sections/rail.tsx`) that takes over navigation once the header scrolls away; leave it as it is.

- [ ] **Step 5: Every page**

Each `generateMetadata` returns `pageMetadata({ language, path, title, description })` with the same `title` it returns today. Home has no `generateMetadata` yet; add one.

| File under `src/app/[lang]/` | `path` | `description` |
| --- | --- | --- |
| `page.tsx` | `"/"` | omit (site default); omit `title` too |
| `markets/page.tsx` | `"/markets"` | `c.lead` (as today) |
| `markets/[id]/page.tsx` | `` `/markets/${id}` `` | see below |
| `occupations/page.tsx` | `"/occupations"` | as today |
| `occupations/[code]/page.tsx` | `` `/occupations/${code}` `` | see below |
| `occupations/g/[id]/page.tsx` | `` `/occupations/g/${id}` `` | see below |
| `updates/page.tsx` | `"/updates"` | `c.lead` (as today) |
| `updates/[id]/page.tsx` | `` `/updates/${id}` `` | `update.summary` (as today) |
| `voices/page.tsx` | `"/voices"` | as today |
| `whitepaper/page.tsx` | `"/whitepaper"` | `c.metaDescription` (as today) |
| `work/[id]/page.tsx` | `` `/work/${id}` `` | as today |

`id` and `code` are the raw route parameters (`(await params).id`).

Three detail routes share one description across hundreds of pages today. Give each its own, built from numbers the page already shows. Add these keys to the page's existing bilingual copy object and fill the placeholders with `.replace`:

- `markets/[id]`: `metaDescription` — en `"{name}: {count} kinds of work, each with the AI updates that reached it."`, zh-CN `"{name}：{count} 类工作，以及触及每类工作的 AI 更新。"`. `{count}` is `market.activities`.
- `occupations/[code]`: en `"{name}: {tasks} tasks, {reached} reached by an AI update."`, zh-CN `"{name}：{tasks} 项任务，其中 {reached} 项已被 AI 更新触及。"`. `{tasks}` is `progress.occupations[id].tasks`; `{reached}` is `assessedCount(progress.occupations[id].by_stage)`.
- `occupations/g/[id]`: same two sentences, with the group's `tasks` and `by_stage`.

- [ ] **Step 6: Share images**

Create `design/system-v1/og/card.html`: a 1200×630 page that links `../../../src/app/design-tokens.css`, uses the same colour tokens as `.brand`, `.brand-ai` and `.brand-will` in `src/app/globals.css` for the wordmark, the page background and ink tokens for the rest, and shows the wordmark plus the headline for the language in its `?lang=` parameter (`siteCopy` titles above). Fonts: `@font-face` the OFL `Outfit-Variable.ttf` and `InterTight-Variable.ttf` from `../fonts/`; Chinese text falls back to the system face.

Render both and commit the PNGs (CI has no browser):

```bash
mkdir -p public/og
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for l in en zh-CN; do
  "$CHROME" --headless --hide-scrollbars --window-size=1200,630 \
    --screenshot="$PWD/public/og/$l.png" "file://$PWD/design/system-v1/og/card.html?lang=$l"
done
```

Open both PNGs with the Read tool and confirm the wordmark and headline are legible and nothing is clipped. Run `pnpm design:check`; if it rejects the new directory, register `og/card.html` where that check lists design sources.

- [ ] **Step 7: Build and test**

Run: `pnpm build && pnpm site:test`
Expected: PASS.

- [ ] **Step 8: Titles for the user to review**

Print the title and description of one page per route in both languages and include the output in the task report:

```bash
for f in en en/markets en/occupations en/updates en/voices en/whitepaper zh-CN zh-CN/markets zh-CN/occupations zh-CN/updates zh-CN/voices zh-CN/whitepaper \
  "$(ls .next/server/app/en/markets/*.html | head -1 | sed 's|.next/server/app/||;s|.html||')" \
  "$(ls .next/server/app/zh-CN/occupations/*.html | head -1 | sed 's|.next/server/app/||;s|.html||')"; do
  echo "== /$f"; grep -o '<title>[^<]*</title>\|<meta name="description" content="[^"]*"' ".next/server/app/$f.html" | head -2
done
```

- [ ] **Step 9: Commit** — `Give every page its address, counterpart and share card`

---

### Task 6: Sitemap and robots

**Files:**
- Create: `src/app/sitemap.ts`, `src/app/robots.ts`
- Test: `scripts/tests/site-output.test.mjs`

**Interfaces:**
- Consumes: `detailPages`, `FIXED_PATHS` (Task 4); `absoluteUrl`, `SITE_URL` (Task 5); `manifest` from `@/lib/snapshot`.

- [ ] **Step 1: Read** `03-file-conventions/01-metadata/sitemap.md` and `robots.md`.

- [ ] **Step 2: Add the failing tests**

```js
const body = (name) => readFileSync(join(APP, `${name}.body`), "utf8");

test("robots.txt allows everything, names the AI crawlers, and points at the sitemap", () => {
  const robots = body("robots.txt");
  assert.match(robots, /Sitemap: https:\/\/openaiwill\.com\/sitemap\.xml/);
  assert.doesNotMatch(robots, /Disallow: \/\S/);
  for (const bot of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User",
    "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot", "Bytespider"]) {
    assert.match(robots, new RegExp(`User-Agent: ${bot}\\b`, "i"), bot);
  }
});

test("every sitemap address is a prerendered page, with its counterpart", () => {
  const xml = body("sitemap.xml");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length >= FIXED.length * 2);
  assert.equal(new Set(locs).size, locs.length, "duplicate addresses");
  for (const loc of locs) {
    assert.ok(loc.startsWith(`${SITE}/`) || loc === SITE, loc);
    const path = decodeURI(loc.slice(SITE.length)).replace(/\/$/, "");
    const file = path.startsWith("/zh-CN") ? path.slice(1) : `en${path}`;
    assert.ok(existsSync(join(APP, `${file}.html`)), `${loc} is not a prerendered page`);
  }
  assert.match(xml, /hreflang="zh-CN"/);
  assert.match(xml, /hreflang="x-default"/);
});
```

If the build names these outputs differently, list `.next/server/app` and adjust `body()` only; the assertions stay.

- [ ] **Step 3: Create `src/app/robots.ts`**

```ts
import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

/**
 * Named so the decision is on the page: search, retrieval and training
 * crawlers are all welcome (user decision, 2026-10-03). The names repeat the
 * wildcard rule on purpose - several operators only honour a group that
 * addresses their crawler by name.
 */
const AI_CRAWLERS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User",
  "ClaudeBot", "Claude-SearchBot", "Claude-User",
  "PerplexityBot", "Perplexity-User",
  "Google-Extended", "Applebot-Extended", "CCBot", "Bytespider",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: "/" })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
```

- [ ] **Step 4: Create `src/app/sitemap.ts`**

```ts
import type { MetadataRoute } from "next";
import { LANGUAGES } from "@/lib/i18n";
import { absoluteUrl } from "@/lib/seo";
import { FIXED_PATHS, detailPages } from "@/lib/site-pages";
import { manifest } from "@/lib/snapshot";

type Page = { path: string; lastModified?: string };

/**
 * One entry per page per language, each naming its counterpart. The list is
 * the one the routes prerender from, so nothing here can be a 404.
 *
 * `lastModified` is when the data behind a page was produced: the snapshot's
 * generation time, or for an update the time it happened. It is left out
 * rather than invented when there is no snapshot.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const built = manifest?.generated_at;
  const pages: Page[] = [
    ...FIXED_PATHS.map((path) => ({ path, lastModified: built })),
    ...detailPages.markets().map((id) => ({ path: `/markets/${id}`, lastModified: built })),
    ...detailPages.occupationGroups().map((id) => ({ path: `/occupations/g/${id}`, lastModified: built })),
    ...detailPages.occupations().map((code) => ({ path: `/occupations/${code}`, lastModified: built })),
    ...detailPages.work().map((id) => ({ path: `/work/${id}`, lastModified: built })),
    ...detailPages.updates().map(({ id, occurredAt }) => ({ path: `/updates/${id}`, lastModified: occurredAt ?? built })),
  ];
  return pages.flatMap(({ path, lastModified }) =>
    LANGUAGES.map((language) => ({
      url: absoluteUrl(language, path),
      ...(lastModified ? { lastModified } : {}),
      alternates: {
        languages: {
          ...Object.fromEntries(LANGUAGES.map((l) => [l, absoluteUrl(l, path)])),
          "x-default": absoluteUrl("en", path),
        },
      },
    })),
  );
}
```

- [ ] **Step 5: Build and test**

Run: `pnpm build && pnpm site:test`
Expected: PASS. Then `pnpm start` and confirm `curl -s localhost:3456/robots.txt` and `curl -s localhost:3456/sitemap.xml | head -20` are served (the proxy must not rewrite them).

- [ ] **Step 6: Commit** — `Publish a sitemap and crawler rules`

---

### Task 7: Structured data

**Files:**
- Create: `src/components/json-ld.tsx`
- Modify: `src/lib/seo.ts`; `src/app/[lang]/page.tsx`, `whitepaper/page.tsx`, `markets/page.tsx`, `occupations/page.tsx`, `markets/[id]/page.tsx`, `occupations/[code]/page.tsx`, `occupations/g/[id]/page.tsx`, `work/[id]/page.tsx`, `updates/[id]/page.tsx`
- Test: `scripts/tests/site-output.test.mjs`

**Interfaces:**
- Produces from `@/lib/seo`:
  - `siteLd(language): object[]` — `Organization` and `WebSite`
  - `breadcrumbLd(language, trail: { name: string; path: string }[]): object`
  - `datasetLd(language, page: { name: string; description: string; path: string }): object | null`
  - `articleLd(language, page: { headline: string; description?: string; path: string; datePublished?: string | null; basedOn?: string[] }): object`
- Produces from `@/components/json-ld`: `<JsonLd data={object | object[] | null} />`

- [ ] **Step 1: Read** `02-guides/json-ld.md`.

- [ ] **Step 2: Add the failing tests**

```js
const ld = (page) =>
  [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => {
    const value = JSON.parse(m[1]);
    return Array.isArray(value) ? value : [value];
  });
const types = (page) => ld(page).map((item) => item["@type"]);

test("structured data names the organisation, the datasets and their status", () => {
  for (const language of ["en", "zh-CN"]) {
    assert.deepEqual(types(html(language, "")).sort(), ["Organization", "WebSite"]);
    assert.ok(types(html(language, "/whitepaper")).includes("Article"));
    const org = ld(html(language, "")).find((item) => item["@type"] === "Organization");
    assert.deepEqual(org.sameAs, ["https://x.com/openaiwill", "https://discord.gg/ArVHw2K9X", "https://github.com/feyn-machines/openaiwill"]);
  }
});

test("a dataset states that it is machine-proposed and when it was produced", { skip: !HAS_SNAPSHOT }, () => {
  for (const path of ["/markets", "/occupations"]) {
    const dataset = ld(html("en", path)).find((item) => item["@type"] === "Dataset");
    assert.ok(dataset, path);
    assert.match(dataset.creativeWorkStatus, /machine-proposed/i);
    assert.ok(dataset.dateModified && dataset.version);
  }
});

test("structured data never claims a review or a rating", () => {
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      for (const type of types(html(language, path))) {
        assert.ok(!["ClaimReview", "Rating", "AggregateRating", "Review"].includes(type), `${language}${path}: ${type}`);
      }
    }
  }
});
```

Run: `pnpm build && pnpm site:test` — expected: FAIL.

- [ ] **Step 3: Create `src/components/json-ld.tsx`**

```tsx
/** One JSON-LD block. `<` is escaped so a string in the data cannot close the script element. */
export function JsonLd({ data }: { data: object | object[] | null }) {
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
```

- [ ] **Step 4: Builders**

Append to `src/lib/seo.ts` (add `import { manifest } from "./snapshot";` at the top):

```ts
const CONTEXT = "https://schema.org";

const organization = {
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/icon.svg`,
  sameAs: [X_URL, DISCORD_URL, GITHUB_URL],
} as const;

export function siteLd(language: Language): object[] {
  return [
    { "@context": CONTEXT, ...organization },
    {
      "@context": CONTEXT,
      "@type": "WebSite",
      name: SITE_NAME,
      url: absoluteUrl(language, "/"),
      inLanguage: language,
      description: siteCopy[language].description,
      publisher: organization,
    },
  ];
}

export function breadcrumbLd(language: Language, trail: { name: string; path: string }[]): object {
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: trail.map((step, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: step.name,
      item: absoluteUrl(language, step.path),
    })),
  };
}

/**
 * Written for machines, so the interface does not have to carry the sentence:
 * every reading in a snapshot is proposed by a model and no person has reviewed
 * it. An engine that quotes a number takes the status with it.
 */
const DATA_STATUS: Record<Language, string> = {
  en: "Machine-proposed, not reviewed by a person",
  "zh-CN": "由机器提出，尚未经人审核",
};

export function datasetLd(language: Language, page: { name: string; description: string; path: string }): object | null {
  if (!manifest) return null;
  return {
    "@context": CONTEXT,
    "@type": "Dataset",
    name: page.name,
    description: page.description,
    url: absoluteUrl(language, page.path),
    inLanguage: language,
    creator: organization,
    version: `${manifest.method_version} / ontology ${manifest.schema_version}`,
    dateModified: manifest.generated_at,
    creativeWorkStatus: DATA_STATUS[language],
  };
}

export function articleLd(
  language: Language,
  page: { headline: string; description?: string; path: string; datePublished?: string | null; basedOn?: string[] },
): object {
  return {
    "@context": CONTEXT,
    "@type": "Article",
    headline: page.headline,
    ...(page.description ? { description: page.description } : {}),
    url: absoluteUrl(language, page.path),
    inLanguage: language,
    publisher: organization,
    ...(page.datePublished ? { datePublished: page.datePublished } : {}),
    ...(page.basedOn?.length ? { isBasedOn: page.basedOn } : {}),
  };
}
```

- [ ] **Step 5: Place them**

Render `<JsonLd … />` as the first child of each page's returned element. Names are the same strings the page already uses for its title; index names come from `siteNavCopy[language]`.

| Page | Data |
| --- | --- |
| `page.tsx` (home) | `siteLd(language)` |
| `whitepaper/page.tsx` | `articleLd(language, { headline: c.metaTitle, description: c.metaDescription, path: "/whitepaper" })` |
| `markets/page.tsx` | `datasetLd(language, { name: c.title, description: c.lead, path: "/markets" })` |
| `occupations/page.tsx` | `datasetLd(language, { name: <title>, description: <lead>, path: "/occupations" })` |
| `markets/[id]` | `breadcrumbLd(language, [{ name: nav.markets, path: "/markets" }, { name, path: `/markets/${id}` }])` |
| `occupations/g/[id]` | breadcrumb: Occupations → group |
| `occupations/[code]` | breadcrumb: Occupations → group (when `group_id` is set) → occupation |
| `work/[id]` | breadcrumb: Markets → market → work |
| `updates/[id]` | `[breadcrumbLd(language, [{ name: nav.updates, path: "/updates" }, { name: update.title, path }]), articleLd(language, { headline: update.title, description: update.summary, path, datePublished: update.occurred_at, basedOn: update.source_urls })]` |

For `updates/[id]`, read the fields from the row the page already loads; if that row has no `source_urls`, take them from the matching entry of `events` as `markets/[id]/page.tsx` already does. Titles and summaries of updates stay in the language they were written in; do not label them as translated.

- [ ] **Step 6: Build and test, run `pnpm check`**

Run: `pnpm build && pnpm site:test && pnpm check`
Expected: PASS.

- [ ] **Step 7: Commit** — `Describe the site, its datasets and their status to machines`

---

### Task 8: `llms.txt` and text a crawler can read

**Files:**
- Create: `src/app/llms.txt/route.ts`
- Test: `scripts/tests/site-output.test.mjs`

**Interfaces:**
- Consumes: `SITE_NAV`, `siteNavCopy`, `LEVEL_NAMES`, `manifest`, `absoluteUrl`, `SITE_URL`.

- [ ] **Step 1: Add the failing tests**

```js
test("llms.txt is generated from the site, names real pages, and overstates nothing", () => {
  const text = body("llms.txt");
  assert.match(text, /^# openaiwill\n/);
  assert.doesNotMatch(text, /\bplatform\b|verified|reviewed score|replacement rate/i);
  assert.match(text, /machine-proposed/i);
  assert.match(text, /https:\/\/x\.com\/openaiwill/);
  assert.match(text, /https:\/\/discord\.gg\/ArVHw2K9X/);
  assert.match(text, /https:\/\/github\.com\/feyn-machines\/openaiwill/);
  for (const [, url] of text.matchAll(/\]\((https:\/\/openaiwill\.com[^)]*)\)/g)) {
    const path = url.slice(SITE.length).replace(/\/$/, "");
    if (/\.(txt|xml)$/.test(path)) continue;
    const file = path.startsWith("/zh-CN") ? path.slice(1) : `en${path}`;
    assert.ok(existsSync(join(APP, `${file}.html`)), `${url} is not a page`);
  }
});

test("the figures on the home page are in its HTML, not only drawn by script", { skip: !HAS_SNAPSHOT }, () => {
  for (const language of ["en", "zh-CN"]) {
    const text = html(language, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    assert.match(text, /\bL[0-5]\b/, `${language}: no level appears as text`);
    assert.ok((text.match(/\d{2,}/g) ?? []).length >= 5, `${language}: fewer than five numbers appear as text`);
  }
});
```

- [ ] **Step 2: Create `src/app/llms.txt/route.ts`**

```ts
import { LEVEL_NAMES } from "@/lib/level-names";
import { DISCORD_URL, GITHUB_URL, SITE_NAME, SITE_URL, X_URL, absoluteUrl } from "@/lib/seo";
import { SITE_NAV, siteNavCopy } from "@/lib/site-nav";
import { manifest } from "@/lib/snapshot";

export const dynamic = "force-static";

/**
 * A short map of the site for language models, built from the same navigation,
 * level names and snapshot manifest the pages use, so it cannot drift from
 * them. English, with the Chinese entry point named.
 */
export function GET() {
  const nav = siteNavCopy.en;
  const lines = [
    `# ${SITE_NAME}`,
    "",
    "> An initiative to make progress toward AI independently completing major production and service work more transparent and credible. Each reading links to the official update it rests on.",
    "",
    "## Pages",
    "",
    ...SITE_NAV.map((item) => `- [${nav[item.key]}](${absoluteUrl("en", item.href)})`),
    `- [Sitemap](${SITE_URL}/sitemap.xml)`,
    `- [简体中文](${absoluteUrl("zh-CN", "/")})`,
    `- [openaiwill on X](${X_URL})`,
    `- [openaiwill on Discord](${DISCORD_URL})`,
    `- [Source on GitHub](${GITHUB_URL})`,
    "",
    "## Levels",
    "",
    "Each kind of work carries the highest level its evidence supports.",
    "",
    ...LEVEL_NAMES.en.map((name, level) => `- L${level}: ${name}`),
    "",
    "## Data",
    "",
    ...(manifest
      ? [
          `- Generated: ${manifest.generated_at}`,
          `- Method: ${manifest.method_version}; ontology ${manifest.schema_version}`,
          "- Status: machine-proposed. No person has reviewed these readings and the method is not calibrated.",
        ]
      : ["- No data snapshot is published in this build."]),
    "",
    "## Citing",
    "",
    "Cite the page address together with the generation time above. Page addresses and their anchors are stable.",
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
```

- [ ] **Step 3: Build and test**

Run: `pnpm build && pnpm site:test`
Expected: the `llms.txt` test passes. If the home-page figures test fails, the numbers a reader sees are drawn only by script: in the failing section's component render the same figures as text in the server output (visually present or `.oaw-sr-only`), without adding explanatory prose, and rerun.

- [ ] **Step 4: Read what a crawler reads**

```bash
pnpm start &
sleep 3
for p in / /markets /occupations /updates /zh-CN; do
  echo "== $p"; curl -s -A GPTBot "localhost:3456$p" | sed 's/<script[^>]*>.*<\/script>//g;s/<[^>]*>/ /g' | tr -s ' \n' | cut -c1-400
done
kill %1
```

Expected: each page's opening text states what the page is and shows real numbers. Put the five outputs in the task report.

- [ ] **Step 5: Commit** — `Publish llms.txt and keep the figures readable without scripts`

---

### Task 9: A build that can be shipped

**Files:**
- Create: `src/app/healthz/route.ts`, `deploy/Dockerfile`, `deploy/compose.yml`, `scripts/site_release.py`, `.env.deploy.example`, `scripts/tests/test_site_release_unit.py`
- Modify: `next.config.ts`, `package.json`, `.gitignore`

**Interfaces:**
- Produces: `python3 scripts/site_release.py {build|release|promote|rollback|status}`; `pnpm site:build`, `site:release`, `site:promote`, `site:rollback`, `site:status`, `site:test:unit`.
- `scripts/site_release.py` pure functions: `release_id(generated_at: str, commit: str, dirty: bool) -> str`, `verify_snapshot(directory: Path) -> dict`, `forbidden_entries(release_dir: Path) -> list[str]`, `to_prune(ids: list[str], keep: int, protected: set[str]) -> list[str]`, `smoke(base: str, release: str | None) -> list[str]`.

- [ ] **Step 1: Read** `03-api-reference/05-config/01-next-config-js/output.md` and `02-guides/self-hosting.md`.

- [ ] **Step 2: Write the failing unit tests**

Create `scripts/tests/test_site_release_unit.py`:

```python
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import site_release as release  # noqa: E402
from data_pipeline.pipeline import digest  # noqa: E402

PAYLOAD = {
    "chain": {"events": [{"event_id": "e1"}], "evidence": [], "activities": [], "gates": [], "gate_edges": []},
    "markets": [], "tasks": [], "events": [{"event_id": "e1"}], "models": [], "sources": [],
    "coverage": {"a": 1}, "progress": {"b": 2},
}


def write_snapshot(directory, payload=PAYLOAD, **manifest):
    counts = {
        **{f"chain.{k}": len(v) for k, v in payload["chain"].items()},
        **{k: len(v) for k, v in payload.items() if isinstance(v, list)},
        **{k: 1 for k, v in payload.items() if isinstance(v, dict) and k != "chain"},
    }
    body = {"generated_at": "2026-10-03T10:29:12.430661+00:00", "counts": counts,
            "content_sha256": digest(payload), **manifest}
    for name, value in payload.items():
        (directory / f"{name}.json").write_text(json.dumps(value))
    (directory / "manifest.json").write_text(json.dumps(body))


class ReleaseIdTest(unittest.TestCase):
    def test_id_is_generation_time_and_commit(self):
        self.assertEqual(release.release_id("2026-10-03T10:29:12.430661+00:00", "e2d4005", False),
                         "20261003T102912Z-e2d4005")

    def test_time_is_converted_to_utc(self):
        self.assertEqual(release.release_id("2026-10-03T18:29:12+08:00", "e2d4005", False),
                         "20261003T102912Z-e2d4005")

    def test_uncommitted_work_is_marked(self):
        self.assertTrue(release.release_id("2026-10-03T10:29:12+00:00", "e2d4005", True).endswith("-dirty"))


class VerifySnapshotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_a_consistent_snapshot_passes(self):
        write_snapshot(self.dir)
        self.assertEqual(release.verify_snapshot(self.dir)["content_sha256"], digest(PAYLOAD))

    def test_a_missing_manifest_fails(self):
        with self.assertRaisesRegex(release.ReleaseError, "manifest"):
            release.verify_snapshot(self.dir)

    def test_an_edited_file_fails(self):
        write_snapshot(self.dir)
        (self.dir / "events.json").write_text(json.dumps([{"event_id": "e1"}, {"event_id": "e2"}]))
        with self.assertRaisesRegex(release.ReleaseError, "content_sha256|counts"):
            release.verify_snapshot(self.dir)

    def test_a_missing_file_fails(self):
        write_snapshot(self.dir)
        (self.dir / "tasks.json").unlink()
        with self.assertRaisesRegex(release.ReleaseError, "tasks.json"):
            release.verify_snapshot(self.dir)


class ForbiddenEntriesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def put(self, relative, text="x"):
        path = self.dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_a_clean_release_has_none(self):
        self.put("app/server.js")
        self.put("app/.next/static/chunk.js")
        self.put("app/public/og/en.png")
        self.put("release.json", "{}")
        self.assertEqual(release.forbidden_entries(self.dir), [])

    def test_snapshot_secrets_and_local_data_are_caught(self):
        for relative in ["app/datasets/published/latest/events.json", "app/.env.local", "app/.env.deploy",
                         "app/data/runtime/x.db", "app/local/x-crawler/crawler/a.py", "app/key.pem",
                         "app/docs/whitepaper.md", "app/cookies.json"]:
            self.put(relative)
        found = release.forbidden_entries(self.dir)
        self.assertEqual(len(found), 8, found)


class PruneTest(unittest.TestCase):
    def test_keeps_the_newest_and_whatever_is_live(self):
        ids = [f"2026100{n}T000000Z-aaaaaaa" for n in range(1, 8)]
        self.assertEqual(release.to_prune(ids, keep=5, protected={ids[0]}), [ids[1]])

    def test_nothing_to_prune_below_the_limit(self):
        self.assertEqual(release.to_prune(["a", "b"], keep=5, protected=set()), [])


if __name__ == "__main__":
    unittest.main()
```

Add to `package.json`: `"site:test:unit": "python3 -m unittest discover -s scripts/tests -p 'test_site_release_unit.py'"`, and add `pnpm site:test:unit` to `check` after `pnpm data:test:unit`.

Run: `pnpm site:test:unit` — expected: FAIL, `No module named 'site_release'`.

- [ ] **Step 3: `next.config.ts`**

Add to the config object:

```ts
  /**
   * A self-contained server for the release directory. The snapshot, local
   * data and documents are read while building and must not be copied next to
   * the server: the release carries rendered pages, never the files they came
   * from. `scripts/site_release.py` checks the assembled directory as well.
   */
  output: "standalone",
  outputFileTracingExcludes: {
    "/**": ["./datasets/**", "./data/**", "./local/**", "./docs/**", "./design/**", "./output/**", "./db/**", "./scripts/**"],
  },
```

- [ ] **Step 4: `src/app/healthz/route.ts`**

```ts
export const dynamic = "force-static";

/** Which build is answering. The release id is fixed when the build runs. */
export function GET() {
  return Response.json({ ok: true, release: process.env.RELEASE_ID ?? "dev" });
}
```

- [ ] **Step 5: Container files**

`deploy/Dockerfile`:

```dockerfile
# The application is built on the release machine; this image only runs it.
FROM node:22-alpine
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --chown=node:node app/ ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

`deploy/compose.yml`:

```yaml
# One release. The project name (-p) decides whether it is the candidate or production.
services:
  web:
    build: .
    image: openaiwill-web:${RELEASE_ID}
    restart: unless-stopped
    environment:
      SITE_ENV: ${SITE_ENV:-preview}
    ports:
      - "127.0.0.1:${HOST_PORT}:3000"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/healthz"]
      interval: 5s
      timeout: 3s
      retries: 12
```

`.env.deploy.example`:

```
# Copy to .env.deploy (ignored by Git). No secret belongs here; the SSH key stays in ~/.ssh.
DEPLOY_HOST=
DEPLOY_USER=
DEPLOY_SSH_KEY=~/.ssh/your-key.pem
DEPLOY_ROOT=/opt/openaiwill
```

Confirm `.env.deploy` is ignored (`git check-ignore .env.deploy`) and `.env.deploy.example` is not; if the example is ignored by `.env*`, add `!.env.deploy.example` below that rule in `.gitignore`. Add `/.release/` to `.gitignore`.

- [ ] **Step 6: `scripts/site_release.py`**

```python
#!/usr/bin/env python3
"""Build openaiwill locally and ship the build to the server over SSH.

  build     verify the snapshot, build, assemble .release/<id>/ and smoke-test it locally
  release   build, upload, and start the release as the candidate on the server
  promote   make the candidate the production service
  rollback  make the previous production release the production service again
  status    show what the server is running

The snapshot never leaves this machine: pages are rendered here and only the
rendered build is uploaded.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from data_pipeline.pipeline import digest  # noqa: E402

SNAPSHOT = ROOT / "datasets" / "published" / "latest"
STAGING = ROOT / ".release"
SITE_URL = "https://openaiwill.com"
SNAPSHOT_FILES = ["chain", "markets", "tasks", "events", "models", "sources", "coverage", "progress"]
PRODUCTION = {"project": "openaiwill", "port": 8320, "env": "production"}
CANDIDATE = {"project": "openaiwill-next", "port": 8321, "env": "preview"}
LOCAL_PORT = 8399
KEEP = 5


class ReleaseError(Exception):
    pass


def release_id(generated_at: str, commit: str, dirty: bool) -> str:
    moment = datetime.fromisoformat(generated_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    return f"{moment:%Y%m%dT%H%M%SZ}-{commit}{'-dirty' if dirty else ''}"


def verify_snapshot(directory: Path) -> dict:
    """The manifest must describe the files beside it; a half-written snapshot is not built."""
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        raise ReleaseError(f"no manifest at {manifest_path}; run `pnpm data:publish:snapshot`")
    manifest = json.loads(manifest_path.read_text())
    payload = {}
    for name in SNAPSHOT_FILES:
        path = directory / f"{name}.json"
        if not path.is_file():
            raise ReleaseError(f"snapshot file missing: {name}.json")
        payload[name] = json.loads(path.read_text())
    counts = {
        **{f"chain.{key}": len(value) for key, value in payload["chain"].items()},
        **{key: len(value) for key, value in payload.items() if isinstance(value, list)},
        **{key: 1 for key, value in payload.items() if isinstance(value, dict) and key != "chain"},
    }
    if counts != manifest.get("counts"):
        raise ReleaseError("snapshot counts do not match its manifest")
    if digest(payload) != manifest.get("content_sha256"):
        raise ReleaseError("snapshot content_sha256 does not match its files")
    return manifest


FORBIDDEN_DIRS = {"datasets", "data", "local", "docs", "design", "db", "scripts", ".git", ".claude", ".agents", ".codex"}
FORBIDDEN_NAME = re.compile(r"^\.env|\.pem$|\.key$|\.sqlite3?$|\.db$|cookies|storage[-_]state|^credentials", re.I)


def forbidden_entries(release_dir: Path) -> list[str]:
    """Paths that must never be uploaded. The release is assembled from an allow-list; this is the second check."""
    found = []
    for path in sorted(release_dir.rglob("*")):
        relative = path.relative_to(release_dir)
        parts = relative.parts
        if "node_modules" in parts:
            continue
        # `app/<dir>/...`: a private directory copied next to the server.
        private_dir = len(parts) > 1 and parts[0] == "app" and parts[1] in FORBIDDEN_DIRS
        if path.is_file() and (private_dir or FORBIDDEN_NAME.search(path.name)):
            found.append(str(relative))
    return found


def to_prune(ids: list[str], keep: int, protected: set[str]) -> list[str]:
    old = sorted(ids)[:-keep] if len(ids) > keep else []
    return [name for name in old if name not in protected]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url: str, cookie: str | None = None):
    opener = urllib.request.build_opener(NoRedirect)
    request = urllib.request.Request(url, headers={"Cookie": cookie} if cookie else {})
    try:
        with opener.open(request, timeout=15) as response:
            return response.status, response.headers, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read().decode("utf-8", "replace")


def smoke(base: str, release: str | None) -> list[str]:
    """Requests a reader or a crawler would make. Returns the failures."""
    failures = []

    def expect(path, status, location=None, contains=None, cookie=None):
        code, headers, body = fetch(base + path, cookie)
        where = headers.get("Location")
        if code != status:
            failures.append(f"{path}: status {code}, expected {status}")
        if location is not None and where != location:
            failures.append(f"{path}: Location {where!r}, expected {location!r}")
        if contains is not None and contains not in body:
            failures.append(f"{path}: body lacks {contains!r}")
        return body

    health = expect("/healthz", 200)
    if release and release not in health:
        failures.append(f"/healthz does not report {release}")
    expect("/", 200, contains='lang="en"')
    expect("/zh-CN", 200, contains='lang="zh-CN"')
    expect("/markets", 200)
    expect("/zh-CN/occupations", 200)
    expect("/robots.txt", 200, contains="Sitemap:")
    expect("/llms.txt", 200, contains="# openaiwill")
    expect("/og/en.png", 200)
    sitemap = expect("/sitemap.xml", 200, contains="<urlset")
    # Redirects are relative: the origin is behind a tunnel and must not name a scheme or host.
    expect("/markets?lang=zh-CN", 307, location="/zh-CN/markets")
    expect("/zh-CN/markets?lang=en", 307, location="/markets")
    expect("/en/markets", 308, location="/markets")
    expect("/ZH-cn/markets", 308, location="/zh-CN/markets")
    expect("/markets", 307, location="/zh-CN/markets", cookie="openaiwill_language=zh-CN")
    expect("/markets/no-such-market", 404)
    expect("/zh-CN/updates/no-such-update", 404)
    expect("/no-such-page", 404)
    # One real detail page of each kind, taken from the sitemap; occupation addresses contain a dot.
    for section in ("markets", "occupations", "updates", "work"):
        match = re.search(rf"<loc>{re.escape(SITE_URL)}(/{section}/[^<]+)</loc>", sitemap)
        if match:
            expect(match.group(1), 200)
        else:
            failures.append(f"sitemap lists no /{section}/ page")
    return failures


def run(command, **kwargs):
    print("$", command if isinstance(command, str) else " ".join(map(str, command)), flush=True)
    return subprocess.run(command, check=True, cwd=ROOT, **kwargs)


def git(*args) -> str:
    return subprocess.check_output(["git", "-C", str(ROOT), *args], text=True).strip()


def load_target() -> dict:
    path = ROOT / ".env.deploy"
    if not path.is_file():
        raise ReleaseError("no .env.deploy; copy .env.deploy.example and fill it in")
    values = dict(line.split("=", 1) for line in path.read_text().splitlines()
                  if "=" in line and not line.lstrip().startswith("#"))
    for key in ("DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_SSH_KEY", "DEPLOY_ROOT"):
        if not values.get(key, "").strip():
            raise ReleaseError(f".env.deploy lacks {key}")
    return {key: value.strip() for key, value in values.items()}


def ssh_base(target: dict) -> list[str]:
    return ["ssh", "-i", os.path.expanduser(target["DEPLOY_SSH_KEY"]), "-o", "IdentitiesOnly=yes",
            "-o", "BatchMode=yes", f"{target['DEPLOY_USER']}@{target['DEPLOY_HOST']}"]


def remote(target: dict, script: str, capture: bool = False) -> str:
    result = subprocess.run([*ssh_base(target), "bash", "-euo", "pipefail", "-c", shlex.quote(script)],
                            check=True, text=True, capture_output=capture)
    return result.stdout.strip() if capture else ""


def compose(slot: dict, release: str, action: str) -> str:
    return (f"sudo RELEASE_ID={release} HOST_PORT={slot['port']} SITE_ENV={slot['env']} "
            f"docker compose -p {slot['project']} {action}")


def build() -> str:
    manifest = verify_snapshot(SNAPSHOT)
    release = release_id(manifest["generated_at"], git("rev-parse", "--short", "HEAD"),
                         bool(git("status", "--porcelain")))
    if release.endswith("-dirty"):
        print("warning: uncommitted changes; this release cannot be reproduced from a commit", file=sys.stderr)
    run(["pnpm", "check"], env={**os.environ, "RELEASE_ID": release})

    staged = STAGING / release
    shutil.rmtree(STAGING, ignore_errors=True)
    app = staged / "app"
    shutil.copytree(ROOT / ".next" / "standalone", app, symlinks=True)
    shutil.copytree(ROOT / ".next" / "static", app / ".next" / "static")
    shutil.copytree(ROOT / "public", app / "public")
    shutil.copy(ROOT / "deploy" / "Dockerfile", staged / "Dockerfile")
    shutil.copy(ROOT / "deploy" / "compose.yml", staged / "compose.yml")
    (staged / "release.json").write_text(json.dumps({
        "release": release,
        "commit": git("rev-parse", "HEAD"),
        "snapshot_generated_at": manifest["generated_at"],
        "snapshot_sha256": manifest["content_sha256"],
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }, indent=2) + "\n")

    found = forbidden_entries(staged)
    if found:
        raise ReleaseError("release contains files that must not be uploaded:\n  " + "\n  ".join(found[:20]))

    server = subprocess.Popen(["node", "server.js"], cwd=app,
                              env={**os.environ, "PORT": str(LOCAL_PORT), "HOSTNAME": "127.0.0.1", "SITE_ENV": "preview"})
    try:
        base = f"http://127.0.0.1:{LOCAL_PORT}"
        for _ in range(30):
            try:
                fetch(base + "/healthz")
                break
            except OSError:
                time.sleep(0.5)
        failures = smoke(base, release)
        if fetch(base + "/markets")[1].get("X-Robots-Tag") != "noindex":
            failures.append("a non-production server did not send X-Robots-Tag: noindex")
    finally:
        server.terminate()
        server.wait()
    if failures:
        raise ReleaseError("smoke test failed:\n  " + "\n  ".join(failures))
    print(f"built {release} at {staged.relative_to(ROOT)}")
    return release


def release_command() -> None:
    target = load_target()
    release = build()
    root = target["DEPLOY_ROOT"]
    remote(target, f"sudo install -d -o {target['DEPLOY_USER']} -g {target['DEPLOY_USER']} {root} {root}/releases")
    run(["rsync", "-az", "--delete", "-e",
         f"ssh -i {os.path.expanduser(target['DEPLOY_SSH_KEY'])} -o IdentitiesOnly=yes",
         f"{STAGING / release}/", f"{target['DEPLOY_USER']}@{target['DEPLOY_HOST']}:{root}/releases/{release}/"])
    remote(target, f"cd {root}/releases/{release} && {compose(CANDIDATE, release, 'up -d --build --wait')} "
                   f"&& curl -fsS http://127.0.0.1:{CANDIDATE['port']}/healthz | grep -q {release} "
                   f"&& echo {release} > {root}/candidate")
    print(f"\ncandidate {release} is running on the server.\n"
          f"preview:  ssh -i {target['DEPLOY_SSH_KEY']} -N -L 8321:127.0.0.1:{CANDIDATE['port']} "
          f"{target['DEPLOY_USER']}@{target['DEPLOY_HOST']}   then open http://localhost:8321\n"
          f"go live:  pnpm site:promote")


def switch(target: dict, release: str) -> None:
    root = target["DEPLOY_ROOT"]
    remote(target, f"""
test -d {root}/releases/{release}
cd {root}/releases/{release}
{compose(PRODUCTION, release, 'up -d --build --wait')}
curl -fsS http://127.0.0.1:{PRODUCTION['port']}/healthz | grep -q {release}
if [ -f {root}/current ] && [ "$(cat {root}/current)" != "{release}" ]; then cp {root}/current {root}/previous; fi
echo {release} > {root}/current
""")


def promote_command() -> None:
    target = load_target()
    root = target["DEPLOY_ROOT"]
    release = remote(target, f"cat {root}/candidate", capture=True)
    switch(target, release)
    remote(target, f"cd {root}/releases/{release} && {compose(CANDIDATE, release, 'down')} && rm -f {root}/candidate")
    listing = remote(target, f"ls {root}/releases", capture=True).split()
    protected = set(remote(target, f"cat {root}/current {root}/previous 2>/dev/null || true", capture=True).split())
    for old in to_prune(listing, KEEP, protected):
        remote(target, f"rm -rf {root}/releases/{old}; sudo docker image rm -f openaiwill-web:{old} >/dev/null 2>&1 || true")
    print(f"production is now {release}")
    failures = smoke(SITE_URL, release)
    if fetch(SITE_URL + "/markets")[1].get("X-Robots-Tag"):
        failures.append("production sends X-Robots-Tag; it must be indexable")
    if failures:
        raise ReleaseError("production is switched but the public check failed (pnpm site:rollback to revert):\n  "
                           + "\n  ".join(failures))
    notify_indexnow()


def rollback_command() -> None:
    target = load_target()
    release = remote(target, f"cat {target['DEPLOY_ROOT']}/previous", capture=True)
    switch(target, release)
    print(f"production is back on {release}")


def status_command() -> None:
    target = load_target()
    root = target["DEPLOY_ROOT"]
    print(remote(target, f"""
echo "current:   $(cat {root}/current 2>/dev/null || echo none)"
echo "previous:  $(cat {root}/previous 2>/dev/null || echo none)"
echo "candidate: $(cat {root}/candidate 2>/dev/null || echo none)"
echo "releases:  $(ls {root}/releases 2>/dev/null | tr '\\n' ' ')"
sudo docker ps --filter name=openaiwill --format '{{{{.Names}}}}  {{{{.Image}}}}  {{{{.Status}}}}  {{{{.Ports}}}}'
""", capture=True))


def notify_indexnow() -> None:
    """Tell IndexNow-fed engines (Bing, and through it ChatGPT search) which addresses exist now."""
    keys = [path for path in (ROOT / "public").glob("*.txt")
            if re.fullmatch(r"[0-9a-f]{32}", path.stem) and path.read_text().strip() == path.stem]
    if not keys:
        print("no IndexNow key in public/; skipped")
        return
    _, _, sitemap = fetch(SITE_URL + "/sitemap.xml")
    urls = re.findall(r"<loc>([^<]+)</loc>", sitemap)
    body = json.dumps({"host": "openaiwill.com", "key": keys[0].stem,
                       "keyLocation": f"{SITE_URL}/{keys[0].name}", "urlList": urls}).encode()
    request = urllib.request.Request("https://api.indexnow.org/indexnow", data=body,
                                     headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            print(f"IndexNow: {response.status} for {len(urls)} addresses")
    except urllib.error.URLError as error:
        print(f"IndexNow not notified ({error}); the release itself is unaffected", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["build", "release", "promote", "rollback", "status"])
    command = parser.parse_args().command
    try:
        {"build": build, "release": release_command, "promote": promote_command,
         "rollback": rollback_command, "status": status_command}[command]()
    except ReleaseError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        print(f"error: command failed with status {error.returncode}", file=sys.stderr)
        return error.returncode or 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Add to `package.json` scripts:

```json
"site:build": "python3 scripts/site_release.py build",
"site:release": "python3 scripts/site_release.py release",
"site:promote": "python3 scripts/site_release.py promote",
"site:rollback": "python3 scripts/site_release.py rollback",
"site:status": "python3 scripts/site_release.py status",
```

- [ ] **Step 7: IndexNow key**

```bash
key=$(python3 -c "import secrets; print(secrets.token_hex(16))"); printf '%s' "$key" > "public/$key.txt"
```

The key is public by design (it is served from the site). Run `pnpm security:check`; if the scanner flags the file, add that exact filename pattern (`public/<32 hex>.txt`) to its allow-list rather than weakening a rule.

- [ ] **Step 8: Unit tests**

Run: `pnpm site:test:unit`
Expected: PASS.

- [ ] **Step 9: Build a release locally**

Run: `pnpm site:build`
Expected: `pnpm check` passes, then `built <id> at .release/<id>`. This runs the whole smoke list against the standalone server on port 8399, which is the end-to-end test of the proxy rules, the 404s, the dotted occupation address and the relative redirects.

Then confirm by hand that the snapshot is not in the release:

```bash
find .release -path '*datasets*' -o -name 'events.json' -o -name '.env*' | grep -v node_modules
du -sh .release
```

Expected: no output from `find`. **If `find` lists files, stop**: change the key of `outputFileTracingExcludes` (try `"**/*"`), rebuild, and do not weaken `forbidden_entries`.

- [ ] **Step 10: The container runs it** (needs local Docker; skip with a note in the report if unavailable)

```bash
id=$(ls .release); cd .release/$id
RELEASE_ID=$id HOST_PORT=8398 SITE_ENV=preview docker compose -p openaiwill-local up -d --build --wait
curl -s localhost:8398/healthz; curl -sI localhost:8398/markets | head -1
RELEASE_ID=$id HOST_PORT=8398 docker compose -p openaiwill-local down; cd -
```

Expected: the health response names the release id; `200`.

- [ ] **Step 11: Commit** — `Build a self-contained release and the script that ships it`

---

### Task 10: Runbook, first release, registration

**This task changes the server and the public site. Do not start Step 3 until the user says to.**

**Files:**
- Create: `docs/development/deployment.md`, `.env.deploy` (local, ignored)
- Modify: `docs/development/local-collection-and-publishing.md` (one line pointing at the new runbook), project `CLAUDE.md` (current-state paragraph: deployment exists)

- [ ] **Step 1: Write `docs/development/deployment.md`**

In Chinese, matching the other files in `docs/development/`. Sections, each a short list of commands and what to expect:

1. 概览 — local build, rendered pages only, `/opt/openaiwill/releases/<id>/`, Compose projects and ports, Cloudflare Tunnel.
2. 首次准备 — `.env.deploy` from the example; the five Cloudflare steps from the spec, including: an A record pointing at the server IP does not work because the server's ports 80 and 443 are closed; the address must be a Tunnel public hostname → `http://localhost:8320`; turn off "Block AI bots" and the managed `robots.txt`.
3. 发布 — `pnpm data:publish:snapshot` → `pnpm site:release` → preview through the SSH tunnel → `pnpm site:promote`.
4. 回滚 — `pnpm site:rollback`; `pnpm site:status`.
5. 上线后 — Google Search Console and Bing Webmaster Tools (verify by DNS TXT, submit `https://openaiwill.com/sitemap.xml`); `curl -A GPTBot -I https://openaiwill.com/` must be 200; Google Rich Results Test on the home page and one update page.
6. 每月检查 — the ten fixed questions (below) asked of ChatGPT, Claude, Perplexity and Gemini; record whether openaiwill is cited and whether the citation is accurate.

Ten questions, five per language, for the user to adjust:

```
How far has AI come in doing accounting work on its own?
Which kinds of work can AI already complete without a person?
What can AI do today in a software developer's job, task by task?
Is there a site that tracks AI progress by occupation with sources?
What does "L3 conditional automation" mean for a kind of work?
AI 现在能独立完成哪些工作？
AI 对会计这个职业的各项任务做到了什么程度？
有没有按职业和任务追踪 AI 进展并给出来源的网站？
最近哪些 AI 更新改变了某类工作的自动化程度？
openaiwill 是什么？
```

- [ ] **Step 2: Local target file**

Create `.env.deploy` with `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` and `DEPLOY_ROOT=/opt/openaiwill`; the operator enters the host, user and key path from their own records (never written to a tracked file). Confirm `git status` does not list it. Run `pnpm site:status`.
Expected: `current: none`, and no `openaiwill` containers.

- [ ] **Step 3: Candidate** (after the user's go-ahead)

Run: `pnpm site:release`
Expected: ends with the preview and go-live instructions. Open the SSH tunnel it prints and check both languages on desktop and phone widths. Report to the user and wait.

- [ ] **Step 4: Production** (after the user confirms the candidate and has added the Tunnel hostname)

Run: `pnpm site:promote`
Expected: `production is now <id>`, the public smoke check passes against `https://openaiwill.com`, IndexNow reports a status. If the public check fails because the Tunnel hostname is not in place yet, production is running on the server and nothing needs reverting: fix the hostname and run `python3 -c "import sys; sys.path.insert(0,'scripts'); import site_release as r; print(r.smoke(r.SITE_URL, None))"` until it prints `[]`.

- [ ] **Step 5: Public checks**

```bash
curl -sI https://openaiwill.com/ | grep -i -E '^(HTTP|x-robots-tag)'          # 200, no x-robots-tag
curl -sI 'https://openaiwill.com/markets?lang=zh-CN' | grep -i '^location'     # /zh-CN/markets
curl -s -o /dev/null -w '%{http_code}\n' -A GPTBot https://openaiwill.com/     # 200
curl -s -o /dev/null -w '%{http_code}\n' -A ClaudeBot https://openaiwill.com/llms.txt   # 200
curl -s https://openaiwill.com/robots.txt | head -5                            # ours, not Cloudflare's managed file
```

A 403 for a crawler user agent, or a `robots.txt` that is not the one this build produces, means the Cloudflare AI-bot settings are still on.

- [ ] **Step 6: Registration**

Walk the user through section 5 of the runbook; these need their accounts.

- [ ] **Step 7: Update `CLAUDE.md`** — in "Current state", replace "no … production deployment" with one sentence naming the runbook and that data updates are published by `pnpm site:release` then `pnpm site:promote`; note the language rule is now path-based; record the official accounts (X `https://x.com/openaiwill`, Discord `https://discord.gg/ArVHw2K9X`, GitHub `https://github.com/feyn-machines/openaiwill`) in the product paragraph. Commit — `Document deployment and record the first release`
