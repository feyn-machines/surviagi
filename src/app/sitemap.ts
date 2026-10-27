import type { MetadataRoute } from "next";
import { LANGUAGES, type Language } from "@/lib/i18n";
import { absoluteUrl } from "@/lib/seo";
import { FIXED_PATHS, UPDATE_LANGUAGES, detailPages, evidenceDates } from "@/lib/site-pages";
import { manifest } from "@/lib/snapshot";
import { approvedEditorialArticles, publicPreviews } from "@/lib/editorial-store";
import publishedArticles from "@/content/articles.json";

export const dynamic = "force-dynamic";

type Page = { path: string; lastModified?: string; languages?: readonly Language[] };

/**
 * One entry per page per language, each naming its counterpart. The detail
 * addresses come from the release the routes answer from, so nothing here can
 * be a 404.
 *
 * `lastModified` is when a page last had something new: for an update the
 * time it happened, for a topic its latest claim, for market, occupation and
 * work pages the newest dated update among their readings (`evidenceDates`),
 * and for the fixed pages, which summarise the whole release, the snapshot's
 * generation time. It is left out rather than invented when there is no such
 * time: a detail page with no date of its own would otherwise claim a change
 * at every data release.
 *
 * Only pages with something of their own are listed: an occupation no update
 * has reached is left out (its page asks not to be indexed), and an update is
 * listed once because its words are the same in every language.
 */
let kept: { key: string; entries: MetadataRoute.Sitemap } | null = null;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const built = manifest()?.generated_at;
  const approvedByLanguage = await Promise.all(LANGUAGES.map((language) => approvedEditorialArticles(language)));
  const approvedSlugs = new Set(approvedByLanguage.flatMap((items) => items.map((item) => item.articleId)));
  // Static article data follows the build; the editorial list changes with its database pointer.
  const approvedState = approvedByLanguage.flatMap((items) => items.map((item) => `${item.articleId}:v${item.version}:${item.createdAt}`)).sort().join(",");
  const key = `${built ?? ""}|${approvedState}`;
  if (kept?.key !== key) kept = { key, entries: entries(built, approvedSlugs) };
  const approvedEntries = approvedByLanguage.flatMap((items, index) => items.map((item) => ({
    url: absoluteUrl(LANGUAGES[index], `/articles/approved/${item.articleId}`),
    lastModified: toTheSecond(item.createdAt),
    alternates: {
      languages: {
        ...Object.fromEntries(LANGUAGES.map((other) => [other, absoluteUrl(other, `/articles/approved/${item.articleId}`)])),
        "x-default": absoluteUrl("en", `/articles/approved/${item.articleId}`),
      },
    },
  })));
  const previewEntries = await Promise.all(LANGUAGES.map(async (language) =>
    (await publicPreviews(language)).map((item) => ({
      url: absoluteUrl(language, `/articles/previews/${item.articleId}/v${item.version}`),
      lastModified: toTheSecond(item.createdAt),
      alternates: {
        languages: {
          ...Object.fromEntries(LANGUAGES.map((other) => [other, absoluteUrl(other, `/articles/previews/${item.articleId}/v${item.version}`)])),
          "x-default": absoluteUrl("en", `/articles/previews/${item.articleId}/v${item.version}`),
        },
      },
    })),
  ));
  const hasPreviews = previewEntries.some((items) => items.length > 0);
  const directory = hasPreviews ? LANGUAGES.map((language) => ({
    url: absoluteUrl(language, "/articles/previews"),
    alternates: { languages: { ...Object.fromEntries(LANGUAGES.map((other) => [other, absoluteUrl(other, "/articles/previews")])) , "x-default": absoluteUrl("en", "/articles/previews") } },
  })) : [];
  return [...kept.entries, ...approvedEntries, ...directory, ...previewEntries.flat()];
}

function entries(built: string | undefined, approvedSlugs: Set<string>): MetadataRoute.Sitemap {
  const dated = evidenceDates();
  const pages: Page[] = [
    ...FIXED_PATHS.map((path) => ({ path, lastModified: built })),
    ...detailPages.markets().map((id) => ({ path: `/markets/${id}`, lastModified: dated.market(`oaw:market:${id}`) })),
    ...detailPages.occupationGroups().map((id) => ({
      path: `/occupations/g/${id}`,
      lastModified: dated.group(`oaw:occupation-group:${id}`),
    })),
    ...detailPages.reachedOccupations().map((code) => ({
      path: `/occupations/${code}`,
      lastModified: dated.occupation(`oaw:occupation:${code}`),
    })),
    ...detailPages.work().map((id) => ({ path: `/work/${id}`, lastModified: dated.work(`oaw:market:${id}`) })),
    ...detailPages.topics().map(({ slug, latest }) => ({ path: `/topics/${slug}`, lastModified: latest ?? undefined })),
    ...detailPages.updates().map(({ id, occurredAt }) => ({ path: `/updates/${id}`, lastModified: occurredAt ?? undefined, languages: UPDATE_LANGUAGES })),
    // The article pages are built ahead from documents the server does not carry,
    // so the list comes from the index written beside the build.
    ...publishedArticles.filter((item) => !approvedSlugs.has(item.slug)).map((item) => ({ path: `/articles/${item.slug}`, lastModified: item.date })),
  ];
  return pages.flatMap(({ path, lastModified, languages = LANGUAGES }) =>
    languages.map((language) => ({
      url: absoluteUrl(language, path),
      ...(lastModified ? { lastModified: toTheSecond(lastModified) } : {}),
      alternates: {
        languages: {
          ...Object.fromEntries(languages.map((l) => [l, absoluteUrl(l, path)])),
          "x-default": absoluteUrl("en", path),
        },
      },
    })),
  );
}

// The data carries times to the microsecond; a sitemap reader expects a date or a time to the second.
function toTheSecond(time: string): string {
  return time.replace(/(T\d{2}:\d{2}:\d{2})\.\d+/, "$1");
}
