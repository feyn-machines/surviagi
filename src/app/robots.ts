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
  // These crawlers are covered by the wildcard rule already; naming them
  // explicitly keeps the allow decision visible in operators' bot reports.
  "Amazonbot", "meta-externalagent", "DuckAssistBot",
];

/** Pages and endpoints that are for signed-in people only; no crawler has a reason to fetch them. */
const PRIVATE = ["/admin", "/zh-CN/admin", "/api/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: "/", disallow: PRIVATE })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
