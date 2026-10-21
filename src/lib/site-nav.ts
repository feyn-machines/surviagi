import { bilingual } from "@/lib/i18n";

/** The site's main destinations, shared by the header and the homepage rail so the two cannot drift. */
export const SITE_NAV = [
  { href: "/markets", key: "markets" },
  { href: "/occupations", key: "occupations" },
  { href: "/topics", key: "topics" },
  { href: "/updates", key: "updates" },
  { href: "/voices", key: "voices" },
  { href: "/articles", key: "articles" },
  { href: "/whitepaper", key: "whitepaper" },
] as const;

export const siteNavCopy = bilingual({
  en: {
    navLabel: "Main navigation",
    markets: "Markets",
    occupations: "Occupations",
    topics: "Topics",
    updates: "AI Updates",
    voices: "Voices",
    articles: "Articles",
    whitepaper: "Whitepaper",
  },
  "zh-CN": {
    navLabel: "主导航",
    markets: "赛道",
    occupations: "职业",
    topics: "话题",
    updates: "AI 更新",
    voices: "声音",
    articles: "文章",
    whitepaper: "白皮书",
  },
});
