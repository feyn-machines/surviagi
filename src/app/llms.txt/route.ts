import { LEVEL_NAMES } from "@/lib/level-names";
import { DISCORD_URL, GITHUB_URL, SITE_NAME, SITE_URL, X_URL, absoluteUrl } from "@/lib/seo";
import { SITE_NAV, siteNavCopy } from "@/lib/site-nav";
import { manifest as dataManifest, markets, marketSlug } from "@/lib/snapshot";
import publishedArticles from "@/content/articles.json";

export const dynamic = "force-dynamic";

/**
 * A short map of the site for language models, built from the same navigation,
 * level names and the loaded release's manifest the pages use, so it cannot drift from
 * them. English, with the Chinese entry point named.
 */
export function GET() {
  const manifest = dataManifest();
  const example = markets()[0];
  const nav = siteNavCopy.en;
  const lines = [
    `# ${SITE_NAME}`,
    "",
    "> SurviAGI (The AGI Survival Guide; 新人类 AI 生存指南; formerly openaiwill) is an independent initiative, not affiliated with any AI company, to make progress toward AI independently completing major production and service work more transparent and credible. Each reading links to the official update it rests on.",
    "",
    "## Pages",
    "",
    ...SITE_NAV.map((item) => `- [${nav[item.key]}](${absoluteUrl("en", item.href)})`),
    `- [Sitemap](${SITE_URL}/sitemap.xml)`,
    `- [简体中文](${absoluteUrl("zh-CN", "/")})`,
    `- [${SITE_NAME} on X](${X_URL})`,
    `- [${SITE_NAME} on Discord](${DISCORD_URL})`,
    `- [Source on GitHub](${GITHUB_URL})`,
    "",
    ...(publishedArticles.length
      ? [
          "## Articles",
          "",
          ...publishedArticles.map((item) =>
            `- [${item.title.en}](${absoluteUrl("en", `/articles/${item.slug}`)}) (${item.date}): ${item.description.en} ` +
            `[Markdown](${absoluteUrl("en", `/articles/${item.slug}/raw.md`)})`),
          `- [Feed](${absoluteUrl("en", "/articles/feed.xml")})`,
          "",
        ]
      : []),
    "## Markdown copies",
    "",
    "Every work, market and occupation page has the same content as Markdown at its address plus `/raw.md`, " +
      "with absolute links and the data generation time" +
      (example ? `, for example ${absoluteUrl("en", `/markets/${marketSlug(example.id)}/raw.md`)}` : "") +
      ". Chinese pages have theirs under /zh-CN.",
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
