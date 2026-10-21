import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// `src/lib/i18n.ts` keeps no static `next/*` imports, so the real source can be
// type-stripped and loaded here. Node 22.17 cannot import `.ts` directly.
const SOURCE_PATH = fileURLToPath(new URL("../../src/lib/i18n.ts", import.meta.url));
const source = readFileSync(SOURCE_PATH, "utf8");
// Comments are dropped so the guard below reads the code, not the prose about it.
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true },
}).outputText;
const {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_PARAM,
  languageRoute,
  localizedPath,
  normalizeLanguage,
  resolveLanguage,
  splitLanguagePath,
  urlLanguage,
} = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(javascript)}`);

const CHINESE_BROWSER = "zh-CN,zh;q=0.9,en;q=0.8";

test("the default language is English", () => {
  assert.equal(DEFAULT_LANGUAGE, "en");
  assert.deepEqual([...LANGUAGES], ["en", "zh-CN"]);
  assert.equal(resolveLanguage(), "en");
  assert.equal(resolveLanguage({}), "en");
  assert.equal(resolveLanguage({ urlLanguage: null, savedLanguage: null }), "en");
});

test("an explicit URL language beats a saved choice", () => {
  assert.equal(resolveLanguage({ urlLanguage: "zh-CN", savedLanguage: "en" }), "zh-CN");
  assert.equal(resolveLanguage({ urlLanguage: "en", savedLanguage: "zh-CN" }), "en");
});

test("a saved choice beats the default", () => {
  assert.equal(resolveLanguage({ savedLanguage: "zh-CN" }), "zh-CN");
  assert.equal(resolveLanguage({ urlLanguage: null, savedLanguage: "zh-CN" }), "zh-CN");
});

test("the browser language never decides", () => {
  // Accept-Language is not an input at all: a Chinese browser still gets English.
  assert.equal(resolveLanguage({ acceptLanguage: CHINESE_BROWSER }), "en");
  assert.equal(resolveLanguage({ savedLanguage: "en", acceptLanguage: CHINESE_BROWSER }), "en");
  assert.doesNotMatch(javascript.toLowerCase(), /accept-language|acceptlanguage/, "i18n.ts must not read Accept-Language");
  assert.doesNotMatch(javascript, /\bq=/, "i18n.ts must not parse Accept-Language quality values");
});

test("an unusable ?lang= value falls back instead of throwing", () => {
  for (const value of ["", " ", "de", "zh-TW", "en-US", "klingon", "zh-CN,en", "../../etc", "%%%", null, undefined, 7, {}, []]) {
    assert.equal(normalizeLanguage(value), null, `${JSON.stringify(value)} must not normalize`);
    assert.equal(resolveLanguage({ urlLanguage: value }), "en");
    assert.equal(resolveLanguage({ urlLanguage: value, savedLanguage: "zh-CN" }), "zh-CN");
  }
  assert.equal(resolveLanguage({ urlLanguage: "en", savedLanguage: "nonsense" }), "en");
  assert.equal(resolveLanguage({ savedLanguage: "nonsense" }), "en");
});

test("known tags are accepted whatever their case or padding", () => {
  for (const value of ["en", "EN", " en ", "\ten\n"]) assert.equal(normalizeLanguage(value), "en");
  for (const value of ["zh-CN", "zh-cn", "ZH-CN", " zh-CN "]) assert.equal(normalizeLanguage(value), "zh-CN");
});

test("the URL language is read from a full URL, a path or a bare query", () => {
  assert.equal(urlLanguage("https://openaiwill.com/domains?lang=zh-CN"), "zh-CN");
  assert.equal(urlLanguage("/domains?lang=en&group=health"), "en");
  assert.equal(urlLanguage("?lang=zh-CN"), "zh-CN");
  assert.equal(urlLanguage("lang=zh-CN"), "zh-CN");
  assert.equal(urlLanguage("/domains?lang=zh-CN#sources"), "zh-CN");
  assert.equal(urlLanguage("/domains"), null);
  assert.equal(urlLanguage("/domains?lang="), null);
  assert.equal(urlLanguage("/domains?lang=de"), null);
  assert.equal(urlLanguage("/domains?language=zh-CN"), null);
  assert.equal(urlLanguage(""), null);
  assert.equal(urlLanguage(null), null);
  assert.equal(urlLanguage(undefined), null);
  assert.equal(LANGUAGE_PARAM, "lang");
});

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

test("open redirects are blocked: double slashes and other escapes are canonicalised", () => {
  assert.deepEqual(route("/en//evil.com/x"), { kind: "redirect", status: 308, location: "/evil.com/x", save: null });
  assert.deepEqual(route("//evil.com"), { kind: "redirect", status: 308, location: "/evil.com", save: null });
  assert.deepEqual(route("//evil.com", { search: "?lang=en" }), { kind: "redirect", status: 307, location: "/evil.com", save: "en" });
  assert.deepEqual(route("/zh-CN//markets"), { kind: "redirect", status: 308, location: "/zh-CN/markets", save: null });
  assert.deepEqual(route("/zh-CN/markets/"), { kind: "redirect", status: 308, location: "/zh-CN/markets", save: null });
  assert.deepEqual(route("/markets/"), { kind: "redirect", status: 308, location: "/markets", save: null });
  assert.deepEqual(route("/EN/markets"), { kind: "redirect", status: 308, location: "/markets", save: null });
  assert.deepEqual(route("/zh-CN/"), { kind: "redirect", status: 308, location: "/zh-CN", save: null });
});

test("every redirect location is a relative path with no protocol or host", () => {
  const testPaths = ["//evil.com", "/en//evil.com", "/zh-CN//evil.com", "/\\evil.com", "/en/\\evil.com", "///evil.com/", "/EN//evil.com"];
  const searchParams = ["", "?lang=en", "?lang=zh-CN", "?lang=fr"];
  const savedChoices = [undefined, "zh-CN"];

  for (const pathname of testPaths) {
    for (const search of searchParams) {
      for (const savedLanguage of savedChoices) {
        const result = languageRoute({ pathname, search, savedLanguage, navigation: true });
        if (result.kind === "redirect") {
          assert.match(result.location, /^\//, `redirect location must start with /: ${pathname} ${search} → ${result.location}`);
          assert.doesNotMatch(result.location, /^\/\//, `redirect location must not start with //: ${pathname} ${search} → ${result.location}`);
          assert.doesNotMatch(result.location, /:\\/, `redirect location must not contain :\\ (escaped protocol): ${pathname} ${search} → ${result.location}`);
          assert.doesNotMatch(result.location, /^[^/].*:\/\//, `redirect location must not contain :// (protocol): ${pathname} ${search} → ${result.location}`);
        }
      }
    }
  }
});

test("canonical forms stay exact, non-canonical forms redirect", () => {
  assert.deepEqual(splitLanguagePath("/markets"), { language: null, path: "/markets", exact: true });
  assert.deepEqual(splitLanguagePath("/markets/"), { language: null, path: "/markets", exact: false });
  assert.deepEqual(splitLanguagePath("/zh-CN"), { language: "zh-CN", path: "/", exact: true });
  assert.deepEqual(splitLanguagePath("/zh-CN/"), { language: "zh-CN", path: "/", exact: false });
  assert.deepEqual(splitLanguagePath("/ZH-cn/markets"), { language: "zh-CN", path: "/markets", exact: false });
  assert.deepEqual(splitLanguagePath("/EN/markets"), { language: "en", path: "/markets", exact: false });
});
