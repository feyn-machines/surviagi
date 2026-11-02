import { LEVEL_NAMES, TIER_NAMES } from "@/components/home/sections/levels";
import { vocabularyTerm } from "@/components/ontology-labels";
import { plural } from "@/lib/plural";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "@/lib/i18n";
import { colon, link, markdownResponse } from "@/lib/markdown-copy";
import { activityAnchor } from "@/lib/anchors";
import { activityById, chainEvents, events as allEvents, evidenceForEvent, marketSlug } from "@/lib/snapshot";
import { copy, updateDate } from "../copy";

/** Rendered per request from the loaded data release, like the page. */
export const dynamic = "force-dynamic";

/** The update page as Markdown: what it said, where, and every kind of work it bears on. */
export async function GET(_: Request, { params }: { params: Promise<{ lang: string; id: string }> }) {
  const { lang, id } = await params;
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const update = chainEvents().find((e) => e.event_id === id);
  if (!update) return new Response("Not found", { status: 404 });

  const c = copy[language];
  const zh = language === "zh-CN";
  const sep = colon(language);
  const levels = LEVEL_NAMES[language];
  const tiers = TIER_NAMES[language];
  const more = allEvents().find((e) => e.event_id === update.event_id);
  const kind = vocabularyTerm("event_kind", more?.kind);
  const rows = evidenceForEvent(update.event_id).filter((r) => r.level !== null);
  const markets = new Set(rows.map((r) => r.market_id));
  const top = Math.max(0, ...rows.map((r) => r.level ?? 0));
  const say = plural(c.say, { n: rows.length, m: markets.size })
    .replace("{n}", String(rows.length))
    .replace("{m}", String(markets.size))
    .replace("{level}", `L${top} ${levels[top]}`);

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
    const accepted = r.level ?? 0;
    const level = (r.observed_level ?? 0) > accepted
      ? c.claimed.replace("{c}", String(r.observed_level)).replace("{a}", String(accepted))
      : `L${accepted} ${levels[accepted]}`;
    body.push(`- ${named}${market ? (zh ? `（${market}）` : ` (${market})`) : ""}${sep}${level} · ${tiers[r.evidence_tier] ?? r.evidence_tier}`);
  }
  if (update.source_urls.length > 0) {
    body.push("", `## ${c.sources}`, "");
    update.source_urls.forEach((url, i) => body.push(`- [${c.source.replace("{i}", String(i + 1)).replace(/\s*↗$/, "")}](${url})`));
  }
  // An update keeps its original words in every language, so its English page is the one to keep.
  return markdownResponse(language, `/updates/${update.event_id}`, update.title, body, { canonical: "en" });
}
