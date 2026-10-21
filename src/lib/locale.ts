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
