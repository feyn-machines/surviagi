import { LEVEL_LINE, LEVEL_MEANINGS, LEVEL_NAMES } from "@/lib/level-names";
import { DISCORD_URL, GITHUB_URL, SITE_NAME, SITE_URL, X_URL, absoluteUrl } from "@/lib/seo";
import { SITE_NAV, siteNavCopy } from "@/lib/site-nav";
import { buildHomeData } from "@/lib/home-data";
import { workSlug } from "@/lib/routes";
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
  const home = buildHomeData();
  const lines = [
    `# ${SITE_NAME}`,
    "",
    "> SurviAGI (The AGI Survival Guide; 新人类 AI 生存指南; formerly openaiwill) is an independent initiative, not affiliated with any AI company, to make progress toward AI independently completing major production and service work more transparent and credible. Each reading links to the official update it rests on.",
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
    "Every work, market, occupation, topic and update page, and the whitepaper, has the same content as Markdown at its address plus `/raw.md`, " +
      "with absolute links and the data generation time" +
      (example ? `, for example ${absoluteUrl("en", `/markets/${marketSlug(example.id)}/raw.md`)}` : "") +
      ". Chinese pages have theirs under /zh-CN.",
    "",
    "## For AI agents",
    "",
    `Search and read the published records over MCP (Streamable HTTP) at ${SITE_URL}/api/mcp, no key needed: tools \`search\` and \`get_record\`. ` +
      `The same as HTTP: ${SITE_URL}/api/agent/search?query=... and ${SITE_URL}/api/agent/record?id=... ` +
      `Submitting research questions or accounts to monitor needs a reader's API key and ${SITE_URL}/api/mcp/submit. ` +
      `Details: [For AI agents](${absoluteUrl("en", "/agents")}).`,
    "",
    "## Levels",
    "",
    "Each kind of work carries the highest level its evidence supports. " +
      `${LEVEL_LINE.en} A level is accepted only with the evidence it requires; a claim above it is kept as a claim.`,
    "",
    ...LEVEL_NAMES.en.map((name, level) => {
      const { roles, evidence } = LEVEL_MEANINGS.en[level];
      return `- L${level} ${name}: ${roles}${evidence === "—" ? "" : ` Evidence required: ${evidence}.`}`;
    }),
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

/**
 * Where things stand, in one dated sentence an engine can quote, with the same
 * numbers the home page shows (both come from `buildHomeData`), followed by the
 * work that has gone furthest: the pages with the most to say.
 */
function standing(home: NonNullable<ReturnType<typeof buildHomeData>>): string[] {
  const top = Math.max(...home.works.map((w) => w.level));
  const furthest = home.works.filter((w) => w.level === top).sort((a, b) => a.name.en.localeCompare(b.name.en));
  const works = (n: number) => `${n} ${n === 1 ? "kind" : "kinds"} of work`;
  return [
    "## Where things stand",
    "",
    `As of ${home.generatedAt}, AI updates have given a level to ${home.works.length} of the ${home.catalogueWorks} kinds of work ` +
      `in the catalogue; the furthest any has reached is L${top} ${LEVEL_NAMES.en[top]}, held by ${works(furthest.length)}. ` +
      `${home.updates.length} updates from ${home.orgsTracked} AI companies bear on them, collected since ${home.start}.`,
    "",
    `### At L${top}`,
    "",
    ...furthest.map((w) => `- [${w.name.en}](${absoluteUrl("en", `/work/${workSlug(w.id)}`)}) (${w.market.en})`),
    "",
  ];
}
