import { DISCORD_URL, GITHUB_URL, SITE_NAME, SITE_URL, X_URL, absoluteUrl } from "@/lib/seo";
import { SITE_NAV, siteNavCopy } from "@/lib/site-nav";
import { buildHomeData } from "@/lib/home-data";
import { manifest as dataManifest, markets, marketSlug } from "@/lib/snapshot";
import publishedArticles from "@/content/articles.json";
import { approvedEditorialArticles } from "@/lib/editorial-store";

export const dynamic = "force-dynamic";

/**
 * A short map of the site for language models, built from the same navigation
 * and the loaded release's manifest the pages use, so it cannot drift from
 * them. English, with the Chinese entry point named.
 */
export async function GET() {
  const manifest = dataManifest();
  const approvedArticles = await approvedEditorialArticles("en");
  const approvedSlugs = new Set(approvedArticles.map((item) => item.articleId));
  const articleEntries = [
    ...publishedArticles.filter((item) => !approvedSlugs.has(item.slug)).map((item) => ({
      slug: item.slug,
      path: `/articles/${item.slug}`,
      title: item.title.en,
      description: item.description.en,
      date: item.date,
    })),
    ...approvedArticles.map((item) => ({
      slug: item.articleId,
      path: `/articles/approved/${item.articleId}`,
      title: item.title,
      description: item.summary,
      date: item.createdAt.slice(0, 10),
    })),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  const example = markets()[0];
  const nav = siteNavCopy.en;
  const home = buildHomeData();
  const lines = [
    `# ${SITE_NAME}`,
    "",
    "> SurviAGI (The AGI Survival Guide; 新人类 AI 生存指南; formerly openaiwill) is an independent initiative, not affiliated with any AI company, to make progress toward AI independently completing major production and service work more transparent and credible. Each update links to the original posts it rests on.",
    "",
    ...(home ? standing(home) : []),
    "## Pages",
    "",
    ...SITE_NAV.map((item) => `- [${nav[item.key]}](${absoluteUrl("en", item.href)})`),
    `- [Sitemap](${SITE_URL}/sitemap.xml)`,
    `- [简体中文](${absoluteUrl("zh-CN", "/")})`,
    `- [${SITE_NAME} on X](${X_URL})`,
    `- [${SITE_NAME} on Discord](${DISCORD_URL})`,
    `- [Source on GitHub](${GITHUB_URL})`,
    "",
    ...(articleEntries.length
      ? [
          "## Articles",
          "",
          ...articleEntries.map((item) =>
            `- [${item.title}](${absoluteUrl("en", item.path)}) (${item.date}): ${item.description} ` +
            `[Markdown](${absoluteUrl("en", `${item.path}/raw.md`)})`),
          `- [Feed](${absoluteUrl("en", "/articles/feed.xml")})`,
          "",
        ]
      : []),
    "## Markdown copies",
    "",
    "Every work, market, occupation, topic and update page, and the whitepaper, has the same content as Markdown at its address plus `/raw.md`, " +
      "with absolute links and the data generation time" +
      (example ? `, for example ${absoluteUrl("en", `/markets/${marketSlug(example.id)}/raw.md`)}` : "") +
      ". Chinese pages have theirs under /zh-CN.",
    "",
    "## For AI agents",
    "",
    "Use SurviAGI to find AI updates and evidence related to specific work, such as accounting, customer support and software development. Search by short task or product keywords, read the matching record, and check its original sources. Machine summaries are unreviewed; public articles identify their approval or preview status. Records do not establish that an entire occupation is automated, and coverage can be incomplete.",
    "",
    `Install the SurviAGI HTTP Skill: ${SITE_URL}/api/agent/packages/surviagi-http.zip (SKILL.md and a Python 3 script; no dependencies or key for reading). Installation guide: ${absoluteUrl("en", "/agents")}#install.`,
    "",
    `Search and read the published records over MCP (Streamable HTTP) at ${SITE_URL}/api/mcp, no key needed: tools \`search\`, \`get_record\`, \`query_observations\` (observations filtered by occupation, market, organization, evidence type, direction and date, with counts) and \`occupation_summary\` (one occupation's or market's evidence statistics, the numbers its page shows). ` +
      `The same as HTTP: ${SITE_URL}/api/agent/search?query=..., ${SITE_URL}/api/agent/record?id=..., ${SITE_URL}/api/agent/observations?occupation=... and ${SITE_URL}/api/agent/summary?occupation=... ` +
      `Submitting research questions or accounts to monitor needs a reader's API key and ${SITE_URL}/api/mcp/submit. ` +
      `Details: [For AI agents](${absoluteUrl("en", "/agents")}).`,
    "",
    `Data contract: a JSON Schema per record type and an OpenAPI description, with every field graded (quote, excerpt, machine, human, record) and four separate versions on every response (contract, ontology, method, data). Index: ${SITE_URL}/contract/v1/index.json; OpenAPI: ${SITE_URL}/contract/v1/openapi.json.`,
    "",
    "## Data",
    "",
    ...(manifest
      ? [
          `- Generated: ${manifest.generated_at}`,
          `- Method: ${manifest.method_version}; ontology ${manifest.schema_version}`,
          "- Status: machine-proposed. No person has reviewed these records and the method is not calibrated.",
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

/**
 * Where things stand, in one dated sentence an engine can quote, with the same
 * numbers the home page shows (both come from `buildHomeData`). It states counts
 * of collected updates only: the L0–L5 level scale is retired (Issue #35).
 */
function standing(home: NonNullable<ReturnType<typeof buildHomeData>>): string[] {
  return [
    "## Where things stand",
    "",
    `As of ${home.generatedAt}, ${home.updatesTotal} updates from ${home.orgsTracked} AI companies have been collected since ${home.start}, ` +
      `and ${home.topicsTotal} open questions about jobs and businesses are tracked. An update is a record of what a company or person said it did; it is not a measure of what AI can do.`,
    "",
  ];
}
