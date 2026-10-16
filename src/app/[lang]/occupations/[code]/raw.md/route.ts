import { LEVEL_NAMES } from "@/components/home/sections/levels";
import { count, fill } from "@/app/[lang]/markets/copy";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "@/lib/i18n";
import { colon, link, markdownResponse } from "@/lib/markdown-copy";
import { workSlug } from "@/lib/routes";
import {
  activitiesOfMarket,
  assessedCount,
  atOrAboveL2,
  manifest,
  marketSlug,
  marketsOfOccupation,
  occupationSlug,
  occupations,
  progress,
} from "@/lib/snapshot";
import { copy } from "../copy";

/** Rendered per request from the loaded data release, like the page. */
export const dynamic = "force-dynamic";

/**
 * The occupation page as Markdown: its sentence, the kinds of work reaching it
 * that carry a level, and the markets it serves. An occupation no update has
 * reached stays out of the index here as its page does.
 */
export async function GET(_: Request, { params }: { params: Promise<{ lang: string; code: string }> }) {
  const { lang, code } = await params;
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const id = occupations().find((row) => occupationSlug(row.occupation_id) === code)?.occupation_id;
  if (!id) return new Response("Not found", { status: 404 });

  const sep = colon(language);
  const c = copy[language];
  const zh = language === "zh-CN";
  const entry = progress()?.occupations?.[id];
  const name = (zh ? (entry?.label_zh_cn ?? entry?.label_en) : entry?.label_en) ?? id;
  const counts = entry?.by_stage ?? {};
  const total = entry?.tasks ?? 0;
  const assessed = assessedCount(counts);
  const levels = LEVEL_NAMES[language];

  const seen = new Set<string>();
  const marketRows: { label: string; slug: string; activities: number }[] = [];
  const reached: { label: string; market: string; slug: string; level: number }[] = [];
  let unread = 0;
  for (const edge of marketsOfOccupation(id)) {
    const rows = activitiesOfMarket(edge.market_id);
    const market = (zh ? rows[0]?.market_zh_cn : rows[0]?.market_en) ?? rows[0]?.market_en ?? edge.market_id;
    marketRows.push({ label: market, slug: marketSlug(edge.market_id), activities: rows.length });
    for (const activity of rows) {
      if (seen.has(activity.activity_id)) continue;
      seen.add(activity.activity_id);
      if (activity.evidence_rows && activity.level) {
        reached.push({
          label: (zh ? activity.label_zh_cn : activity.label_en) ?? activity.label_en,
          market,
          slug: workSlug(activity.activity_id),
          level: Math.round(activity.level),
        });
      } else unread += 1;
    }
  }
  marketRows.sort((a, b) => b.activities - a.activities || a.label.localeCompare(b.label));
  reached.sort((a, b) => b.level - a.level || a.label.localeCompare(b.label));

  const body = [
    `> ${fill(assessed > 0 ? c.answer : c.answerNone, {
      date: manifest()?.generated_at.slice(0, 10) ?? "",
      name,
      total: count(total),
      atL2: count(atOrAboveL2(counts)),
      assessed: count(assessed),
      rest: count(Math.max(0, total - assessed)),
    })}`,
    "",
    c.lead,
    "",
    `## ${c.activitiesTitle}`,
    "",
  ];
  if (reached.length === 0) body.push(c.gridNone);
  for (const row of reached) {
    body.push(`- ${link(language, row.label, `/work/${row.slug}`)}${zh ? `（${row.market}）` : ` (${row.market})`}${sep}L${row.level} ${levels[row.level]}`);
  }
  if (unread > 0) body.push("", fill(c.unread, { n: count(unread) }));

  body.push("", `## ${c.marketsTitle}`, "", c.marketsLead, "");
  if (marketRows.length === 0) body.push(c.marketsNone);
  for (const row of marketRows) {
    body.push(`- ${link(language, row.label, `/markets/${row.slug}`)}${sep}${count(row.activities)} ${c.marketActivities}`);
  }
  // An occupation no update has reached has nothing of its own to say yet; its page is left out of the index too.
  return markdownResponse(language, `/occupations/${code}`, name, body, { index: assessed > 0 });
}
