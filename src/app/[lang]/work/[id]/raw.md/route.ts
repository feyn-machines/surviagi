import { LEVEL_NAMES, TIER_NAMES } from "@/components/home/sections/levels";
import { detailCopy, fill } from "@/app/[lang]/markets/copy";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "@/lib/i18n";
import { colon, link, markdownResponse } from "@/lib/markdown-copy";
import { workSlug } from "@/lib/routes";
import { activities, activitiesOfMarket, evidenceForActivity, gatesOfActivity, gates as allGates, manifest, marketSlug } from "@/lib/snapshot";
import { copy } from "../copy";

/** Rendered per request from the loaded data release, like the page. */
export const dynamic = "force-dynamic";

const TIER_RANK: Record<string, number> = { T1: 0, T2: 1, T3: 2, T4: 3 };

/** The work page as Markdown: its sentence, every update behind its level, and the work beside it. */
export async function GET(_: Request, { params }: { params: Promise<{ lang: string; id: string }> }) {
  const { lang, id } = await params;
  const language = normalizeLanguage(lang) ?? DEFAULT_LANGUAGE;
  const work = activities().find((a) => a.evidence_rows && a.level && workSlug(a.activity_id) === id);
  if (!work) return new Response("Not found", { status: 404 });

  const sep = colon(language);
  const c = copy[language];
  const zh = language === "zh-CN";
  const name = (zh ? work.label_zh_cn : work.label_en) ?? work.label_en;
  const market = (zh ? work.market_zh_cn : work.market_en) ?? work.market_en;
  const level = Math.round(work.level ?? 0);
  const levels = LEVEL_NAMES[language];
  const tiers = TIER_NAMES[language];
  const rows = evidenceForActivity(work.activity_id).filter((r) => r.level !== null);
  const tier = rows.map((r) => r.evidence_tier).sort((a, b) => (TIER_RANK[a] ?? 9) - (TIER_RANK[b] ?? 9))[0] ?? "T3";
  const gateById = new Map(allGates().map((g) => [g.gate_id, g]));
  const held = work.gated ? gatesOfActivity(work.activity_id).map((g) => gateById.get(g)).filter((g) => g !== undefined) : [];
  const siblings = activitiesOfMarket(work.market_id).filter((a) => a.activity_id !== work.activity_id && a.evidence_rows && a.level);
  const marketPath = `/markets/${marketSlug(work.market_id)}`;

  const body = [
    `> ${fill(c.say, {
      date: manifest()?.generated_at.slice(0, 10) ?? "",
      level: `L${level} ${levels[level]}`,
      n: rows.length,
      tier: tiers[tier] ?? tier,
    })}`,
    "",
    `${detailCopy[language].eyebrow}${sep}${link(language, market, marketPath)}`,
  ];
  if (held.length > 0) {
    body.push("", `${c.held} ${held.map((g) => (zh ? g.label_zh_cn : g.label_en) ?? g.label_en).join(" · ")}. ${c.heldNote}`);
  }
  body.push("", `## ${c.listTitle}`, "", c.listSub, "");
  for (const r of rows) {
    const accepted = r.level ?? 0;
    const claimed = (r.observed_level ?? 0) > accepted
      ? fill(c.claimed, { c: r.observed_level ?? 0, a: accepted })
      : `L${accepted} ${levels[accepted]}`;
    const source = r.source_urls[0] ? ` · [${c.source.replace(/\s*↗$/, "")}](${r.source_urls[0]})` : "";
    body.push(
      `- ${r.occurred_at ? r.occurred_at.slice(0, 10) : c.undated} · ${r.org_name ?? ""} · ` +
        `${link(language, r.title, `/updates/${r.event_id}`)}${sep}${claimed} · ${tiers[r.evidence_tier] ?? r.evidence_tier}${source}`,
    );
    if (r.summary) body.push(`  ${r.summary.replace(/\s+/g, " ")}`);
  }
  if (siblings.length > 0) {
    body.push("", `## ${fill(c.more, { market })}`, "");
    for (const a of siblings) {
      body.push(`- ${link(language, (zh ? a.label_zh_cn : a.label_en) ?? a.label_en, `/work/${workSlug(a.activity_id)}`)}${sep}L${Math.round(a.level ?? 0)}`);
    }
  }
  return markdownResponse(language, `/work/${id}`, name, body);
}
