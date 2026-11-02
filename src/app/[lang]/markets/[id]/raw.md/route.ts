import { termNameOrRaw } from "@/components/ontology-labels";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "@/lib/i18n";
import { colon, link, markdownResponse } from "@/lib/markdown-copy";
import { indexable } from "@/lib/site-pages";
import {
  activitiesOfMarket,
  activityAnchor,
  linksOfWork,
  manifest,
  markets,
  marketSlug,
  occupationsOfMarket,
  occupationSlug,
} from "@/lib/snapshot";
import { updateDateLabel } from "@/lib/update-date";
import { count, detailCopy, fill } from "../../copy";

/** Rendered per request from the loaded data release, like the page. */
export const dynamic = "force-dynamic";

/**
 * The market page as Markdown: its sentence, each kind of work with the updates
 * that bear on it, and the occupations that serve the market.
 */
export async function GET(_: Request, { params }: { params: Promise<{ lang: string; id: string }> }) {
  const { lang, id } = await params;
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const market = markets().find((m) => marketSlug(m.id) === id);
  if (!market) return new Response("Not found", { status: 404 });

  const sep = colon(language);
  const c = detailCopy[language];
  const zh = language === "zh-CN";
  const name = (zh ? market.zh_cn : market.en) ?? market.en;
  const rows = activitiesOfMarket(market.id).map((activity) => ({
    activity,
    updates: linksOfWork(activity.activity_id),
  }));
  const updateIds = new Set(rows.flatMap((row) => row.updates.map((r) => r.event_id)));
  const withUpdates = rows.filter((row) => row.updates.length > 0);

  const body = [
    `> ${fill(updateIds.size === 0 ? c.answerNone : c.answer, {
      date: manifest()?.generated_at.slice(0, 10) ?? "",
      name,
      n: count(rows.length),
      scored: count(withUpdates.length),
      updates: count(updateIds.size),
    })}`,
    "",
    c.lead,
    "",
    `## ${c.activitiesTitle}`,
    "",
  ];
  if (rows.length === 0) body.push(c.activitiesNone);
  for (const { activity, updates } of rows) {
    const label = (zh ? activity.label_zh_cn : activity.label_en) ?? activity.label_en;
    const anchor = activityAnchor(activity.activity_id, market.id);
    body.push(`- ${label}${sep}${count(updates.length)} ${c.updates} · ${fill(c.tasks, { n: count(activity.tasks) })} (#${anchor})`);
    for (const r of updates) {
      const source = r.source_urls[0] ? `[${r.title.replace(/([[\]])/g, "\\$1")}](${r.source_urls[0]})` : r.title;
      body.push(`  - ${updateDateLabel(r, language) ?? ""} · ${r.org_name ?? ""} · ${source}`);
      for (const v of r.confirmations ?? []) {
        const said = fill(c.alsoSays, {
          handle: v.handle ?? v.account_key,
          nature: termNameOrRaw("post_nature", v.post_nature, language),
          title: r.title,
        }).replace(/([[\]])/g, "\\$1");
        body.push(`  - ${v.posted_at?.slice(0, 10) ?? ""} · ${v.url ? `[${said}](${v.url})` : said}`);
      }
    }
  }

  const served = occupationsOfMarket(market.id);
  body.push("", `## ${c.occupationsTitle}`, "", c.occupationsLead, "");
  if (served.length === 0) body.push(c.occupationsNone);
  for (const edge of served) {
    const occupation = (zh ? edge.occupation_zh_cn : edge.occupation_en) ?? edge.occupation_en;
    const confidence = edge.confidence === null ? c.noReading : edge.confidence.toFixed(2);
    body.push(`- ${link(language, occupation, `/occupations/${occupationSlug(edge.occupation_id)}`)}${sep}${c.colConfidence} ${confidence}`);
  }

  return markdownResponse(language, `/markets/${id}`, name, body, { index: indexable.market(market.id) });
}
