/**
 * Language selection for the bilingual site.
 *
 * Precedence, per CLAUDE.md / DESIGN.md: the language in the path wins, then
 * for an unprefixed address the saved user choice, then English. The browser
 * `Accept-Language` header is deliberately never consulted, so a Chinese
 * browser still opens the English default until the reader chooses otherwise.
 *
 * This module has no static `next/*` imports on purpose: `src/proxy.ts` (edge),
 * Client Components and `scripts/tests/test_i18n_unit.mjs` (plain node) all
 * import it. The render-time reader of the path language is `./locale`.
 */

export const LANGUAGES = ["en", "zh-CN"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Shown first when nobody has chosen a language. */
export const DEFAULT_LANGUAGE: Language = "en";

/** Query parameter that carries an explicit language in a shared link. */
export const LANGUAGE_PARAM = "lang";

/** Cookie holding the saved choice. Readable by the browser; no login needed. */
export const LANGUAGE_COOKIE = "openaiwill_language";

/** One year, refreshed on every explicit choice. */
export const LANGUAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const LANGUAGE_NAMES: Record<Language, string> = { en: "EN", "zh-CN": "中文" };

/** The label for a language, written in that language. */
export function languageName(language: Language): string {
  return LANGUAGE_NAMES[language];
}

/**
 * Accepts only the two published tags, case-insensitively. Anything else —
 * an unknown tag, an empty string, a repeated parameter, `null` — returns
 * `null` so the caller falls back instead of throwing.
 */
export function normalizeLanguage(value: unknown): Language | null {
  if (typeof value !== "string") return null;
  const tag = value.trim().toLowerCase();
  return LANGUAGES.find((language) => language.toLowerCase() === tag) ?? null;
}

export type LanguageRequest = {
  /** Raw `?lang=` value from the request URL, if the reader supplied one. */
  urlLanguage?: string | null;
  /** Raw saved choice, normally the language cookie. */
  savedLanguage?: string | null;
};

/** URL language, then saved choice, then English. Never the browser preference. */
export function resolveLanguage(request: LanguageRequest = {}): Language {
  return normalizeLanguage(request.urlLanguage)
    ?? normalizeLanguage(request.savedLanguage)
    ?? DEFAULT_LANGUAGE;
}

/**
 * Reads `?lang=` out of a full URL, a path with a query, or a bare query
 * string. Unparseable or unknown values return `null` rather than throwing.
 */
export function urlLanguage(url: string | null | undefined): Language | null {
  if (!url) return null;
  const withoutHash = url.split("#")[0];
  const mark = withoutHash.indexOf("?");
  const query = mark === -1 ? withoutHash : withoutHash.slice(mark + 1);
  return normalizeLanguage(new URLSearchParams(query).get(LANGUAGE_PARAM));
}

/** The public address of `path` in `language`. English has no prefix. */
export function localizedPath(language: Language, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (language === DEFAULT_LANGUAGE) return clean;
  return clean === "/" ? `/${language}` : `/${language}${clean}`;
}

/**
 * `/zh-CN/markets` -> zh-CN + `/markets`. Normalizes slashes (backslash to `/`,
 * collapses `//+` to `/`, removes trailing `/` unless path is `/`).
 *
 * `exact` is true only when the pathname is already in canonical form:
 * - For no-language paths: `pathname === path` (already normalized).
 * - For language paths: the language tag is in published casing AND pathname matches
 *   `/{language}{path}` (where path is the normalized trailing-slash-stripped form).
 *
 * `exact: false` means a redirect is needed to canonicalise slashes or casing.
 */
export function splitLanguagePath(pathname: string): { language: Language | null; path: string; exact: boolean } {
  // Normalize: backslash → slash, collapse /+ to /, remove trailing / unless root
  const clean = pathname.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "") || "/";

  const [, first = "", ...rest] = clean.split("/");
  const language = normalizeLanguage(first);
  if (!language) {
    return { language: null, path: clean, exact: pathname === clean };
  }

  const path = `/${rest.join("/")}`.replace(/\/$/, "") || "/";
  // exact: true only if language tag is in published casing AND pathname is already normalized
  const exact = first === language && pathname === clean;
  return { language, path, exact };
}

export type LanguageRoute =
  | { kind: "redirect"; status: 307 | 308; location: string; save: Language | null }
  | { kind: "rewrite"; pathname: string }
  | { kind: "pass" };

/**
 * What the proxy does with one request. Pure, so every rule is unit tested.
 *
 * Rules, in order:
 * 1. `?lang=` parameter: redirect to the target language with other params preserved (307, temporary).
 * 2. Canonicalization: redirect if not exact (slashes, casing, trailing slashes need fixing) (308, permanent).
 * 3. Saved language preference: redirect navigation (not prefetch) from English to saved language (307).
 * 4. Default: rewrite to `/en` prefix internally (no public redirect).
 *
 * Redirect locations are relative on purpose: the origin sits behind a tunnel
 * and sees plain HTTP on an internal host, and a relative Location cannot
 * leak either (never `://`, `//`, or backslash escapes).
 *
 * `?lang=` redirects are temporary (307). A browser caches a permanent redirect (308)
 * and stops asking the server, so the second click on a language link would no longer save.
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

  // No language prefix. Canonicalise if needed (slashes, trailing /).
  if (!exact) {
    return { kind: "redirect", status: 308, location: `${path}${request.search}`, save: null };
  }

  const saved = normalizeLanguage(request.savedLanguage);
  if (saved && saved !== DEFAULT_LANGUAGE && request.navigation) {
    return { kind: "redirect", status: 307, location: `${localizedPath(saved, path)}${request.search}`, save: null };
  }
  return { kind: "rewrite", pathname: `/${DEFAULT_LANGUAGE}${path === "/" ? "" : path}` };
}

/**
 * Both languages, enforced by the type: a block of copy cannot be written in
 * one language only, because the Chinese record must carry every English key.
 *
 * It lives here rather than beside the data-page components so that any page
 * can declare its copy without importing from one.
 */
export function bilingual<T extends Record<string, string>>(copy: {
  en: T;
  "zh-CN": Record<keyof T, string>;
}): Record<Language, Record<keyof T, string>> {
  return copy;
}
