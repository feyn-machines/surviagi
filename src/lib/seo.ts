import type { Metadata } from "next";
import { LANGUAGES, bilingual, localizedPath, type Language } from "./i18n";
import { SITE_URL } from "./site-origin";
import { manifest as dataManifest } from "./snapshot";

export { SITE_URL };
export const SITE_NAME = "SurviAGI";
/** What the name stands for, and the names the same project is also known by (the last is its earlier name). */
export const SITE_ALTERNATE_NAMES = ["The AGI Survival Guide", "新人类 AI 生存指南", "openaiwill"] as const;
/** The project's current public X account (verified 2026-10-10). */
export const X_HANDLE = "@surviagi";
export const X_URL = "https://x.com/surviagi";
/** The project's community invite on Discord (user-confirmed 2026-10-03). */
export const DISCORD_URL = "https://discord.gg/ArVHw2K9X";
/** The public source repository (user-confirmed 2026-10-03). */
export const GITHUB_URL = "https://github.com/feyn-machines/surviagi";

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

/**
 * The full public address of `path` (written without a language prefix) in
 * `language`. The English home is the bare site address, the spelling Next
 * writes into each page's canonical link, so the sitemap and the page agree.
 */
export function absoluteUrl(language: Language, path: string): string {
  const local = localizedPath(language, path);
  return local === "/" ? SITE_URL : `${SITE_URL}${local}`;
}

/**
 * Everything a page tells a search engine about itself: its own address, the
 * same page in the other language, and the share card. `path` is written
 * without a language prefix.
 *
 * `languages` names the languages the page's own content exists in. A page
 * whose content is the same words in every language (an update keeps its
 * original title and summary) is one page to a search engine: the other
 * address points at it instead of standing as a second copy.
 *
 * `index: false` asks engines to leave the page out while still following its
 * links; it is for a page that has nothing of its own to say yet.
 */
export function pageMetadata(page: {
  language: Language;
  path: string;
  title?: string;
  description?: string;
  languages?: readonly Language[];
  index?: boolean;
}): Metadata {
  const { language, path } = page;
  const site = siteCopy[language];
  const description = page.description ?? site.description;
  const shareTitle = page.title ?? site.title;
  const versions = page.languages ?? LANGUAGES;
  const url = absoluteUrl(versions.includes(language) ? language : versions[0], path);
  const image = `/og/${language}.png`;
  return {
    ...(page.title ? { title: page.title } : {}),
    description,
    ...(page.index === false ? { robots: { index: false, follow: true } } : {}),
    alternates: {
      canonical: url,
      languages: {
        ...Object.fromEntries(versions.map((l) => [l, absoluteUrl(l, path)])),
        "x-default": absoluteUrl(versions.includes("en") ? "en" : versions[0], path),
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

const CONTEXT = "https://schema.org";

const organization = {
  "@type": "Organization",
  name: SITE_NAME,
  alternateName: SITE_ALTERNATE_NAMES,
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
  const manifest = dataManifest();
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
