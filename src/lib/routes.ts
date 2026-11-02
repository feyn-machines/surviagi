import type { Route } from "next";
import { activityAnchor } from "./anchors";
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
/** A kind of work lives on its market's page, at the row that opens onto its updates. */
export const activityHref = (language: Language, work: { activity_id: string; market_id: string }) =>
  `${localizedPath(language, `/markets/${work.market_id.replace(/^oaw:market:/, "")}`)}#${activityAnchor(work.activity_id, work.market_id)}` as Route;
export const updateHref = (language: Language, eventId: string) =>
  localizedPath(language, `/updates/${eventId}`) as Route;
export const topicHref = (language: Language, slug: string) =>
  localizedPath(language, `/topics/${slug}`) as Route;
export const marketHref = (language: Language, marketId: string) =>
  localizedPath(language, `/markets/${marketId.replace(/^oaw:market:/, "")}`) as Route;
