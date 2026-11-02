import { vocabularyTerm } from "@/components/ontology-labels";
import { plural } from "@/lib/plural";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "@/lib/i18n";
import { link, markdownResponse } from "@/lib/markdown-copy";
import { activityAnchor } from "@/lib/anchors";
import { activityById, linkedEvents, events as allEvents, linksOfEvent, marketSlug } from "@/lib/snapshot";
import { copy, updateDate } from "../copy";

/** Rendered per request from the loaded data release, like the page. */
export const dynamic = "force-dynamic";

/** The update page as Markdown: what it said, where, and every kind of work it bears on. */
export async function GET(_: Request, { params }: { params: Promise<{ lang: string; id: string }> }) {
  const { lang, id } = await params;
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const update = linkedEvents().find((e) => e.event_id === id);
  if (!update) return new Response("Not found", { status: 404 });

  const c = copy[language];
  const zh = language === "zh-CN";
  const more = allEvents().find((e) => e.event_id === update.event_id);
  const kind = vocabularyTerm("event_kind", more?.kind);
  const label = (r: ReturnType<typeof linksOfEvent>[number]) => {
    const work = activityById(r.activity_id);
    return {
      market: work ? (zh ? work.market_zh_cn : work.market_en) ?? work.market_en : "",
      name: (zh ? r.activity_zh_cn : r.activity_en) ?? r.activity_en,
    };
  };
  // By market, so the order says nothing about how much any update achieved.
  const rows = linksOfEvent(update.event_id).sort(
    (a, b) => label(a).market.localeCompare(label(b).market, language) || label(a).name.localeCompare(label(b).name, language),
  );
  const markets = new Set(rows.map((r) => r.market_id));
  const say = plural(c.say, { n: rows.length, m: markets.size })
    .replace("{n}", String(rows.length))
    .replace("{m}", String(markets.size));

  const body = [
    `${update.org_name ?? ""} · ${updateDate(c, update)}` +
      (kind ? ` · ${zh ? kind["zh-CN"] ?? kind.en : kind.en}` : ""),
    "",
    ...(update.summary ? [`> ${update.summary.replace(/\s+/g, " ")}`, ""] : []),
    say,
    "",
    `## ${c.listTitle}`,
    "",
  ];
  for (const r of rows) {
    const work = activityById(r.activity_id);
    const name = (zh ? r.activity_zh_cn : r.activity_en) ?? r.activity_en;
    const market = work ? (zh ? work.market_zh_cn : work.market_en) ?? work.market_en : "";
    const named = work
      ? link(language, name, `/markets/${marketSlug(work.market_id)}#${activityAnchor(work.activity_id, work.market_id)}`)
      : name;
    body.push(`- ${named}${market ? (zh ? `（${market}）` : ` (${market})`) : ""}`);
  }
  if (update.source_urls.length > 0) {
    body.push("", `## ${c.sources}`, "");
    update.source_urls.forEach((url, i) => body.push(`- [${c.source.replace("{i}", String(i + 1)).replace(/\s*↗$/, "")}](${url})`));
  }
  // An update keeps its original words in every language, so its English page is the one to keep.
  return markdownResponse(language, `/updates/${update.event_id}`, update.title, body, { canonical: "en" });
}
