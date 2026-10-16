import { DEFAULT_LANGUAGE, normalizeLanguage } from "@/lib/i18n";
import { colon, link, markdownResponse } from "@/lib/markdown-copy";
import { chainEvents, manifest, topicBySlug } from "@/lib/snapshot";
import { answerSentence, copy } from "../copy";

/** Rendered per request from the loaded data release, like the page. */
export const dynamic = "force-dynamic";

/** The topic page as Markdown: its sentence, then under each answer the updates that weigh on it and who argues it. */
export async function GET(_: Request, { params }: { params: Promise<{ lang: string; slug: string }> }) {
  const { lang, slug } = await params;
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const topic = topicBySlug(slug);
  if (!topic) return new Response("Not found", { status: 404 });

  const c = copy[language];
  const sep = colon(language);
  const source = c.source.replace(/\s*↗$/, "");
  const withPage = new Set(chainEvents().map((e) => e.event_id));
  const about = topic.about ? topic.about[language] ?? topic.about.en : null;

  const body = [
    `> ${answerSentence(topic, language, manifest()?.generated_at.slice(0, 10) ?? "")}`,
    "",
    [c[topic.question_type], about, `${c.since} ${topic.opened_at.slice(0, 10)}`].filter(Boolean).join(" · "),
  ];
  for (const option of topic.options) {
    body.push("", `## ${option.text[language]}`, "",
      `${c.argued} ${option.accounts} · ${c.for} ${option.supports} · ${c.against} ${option.contradicts}`);
    const evidence = topic.evidence.filter((row) => row.option === option.key);
    if (evidence.length > 0) {
      body.push("", `### ${c.evidenceLabel}`, "");
      for (const row of evidence) {
        const title = withPage.has(row.event_id) ? link(language, row.title, `/updates/${row.event_id}`) : row.title;
        const when = [row.by, row.occurred_at?.slice(0, 10)].filter(Boolean).join(" · ");
        body.push(`- ${c[row.sign]}${sep}${title}${when ? ` · ${when}` : ""}${row.source_url ? ` · [${source}](${row.source_url})` : ""}`);
      }
    }
    const claims = topic.claims.filter((claim) => claim.option === option.key);
    body.push("", `### ${c.claimsLabel}`, "");
    if (claims.length === 0) body.push(c.nobody);
    for (const claim of claims) {
      const said = (claim.quote ?? claim.says).replace(/\s+/g, " ");
      body.push(`- @${claim.handle} · ${claim.published_at.slice(0, 10)}${sep}${said}${claim.url ? ` · [${source}](${claim.url})` : ""}`);
    }
  }
  return markdownResponse(language, `/topics/${topic.slug}`, topic.question[language], body);
}
