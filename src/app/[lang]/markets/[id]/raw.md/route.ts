import { LEVEL_NAMES } from "@/components/home/sections/levels";
import { termNameOrRaw } from "@/components/ontology-labels";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "@/lib/i18n";
import { colon, link, markdownResponse } from "@/lib/markdown-copy";
import { workSlug } from "@/lib/routes";
import {
  activitiesOfMarket,
  evidenceForActivity,
  gates as allGates,
  gatesOfActivity,
  manifest,
  markets,
  marketSlug,
  occupationsOfMarket,
  occupationSlug,
} from "@/lib/snapshot";
import { count, detailCopy, fill } from "../../copy";

/** Rendered per request from the loaded data release, like the page. */
export const dynamic = "force-dynamic";

/**
 * The market page as Markdown: its sentence, each kind of work with its level and
 * the evidence behind it, the occupations that serve the market and the
 * non-technical conditions holding work in it.
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
  const levels = LEVEL_NAMES[language];
  const gateById = new Map(allGates().map((g) => [g.gate_id, g]));
  const rows = activitiesOfMarket(market.id).map((activity) => ({
    activity,
    rung: activity.level === null ? null : Math.floor(activity.level),
    // As on the page: only a gate the gate state applies is named under a row.
    gates: (activity.gated ? gatesOfActivity(activity.activity_id) : []).flatMap((g) => gateById.get(g) ?? []),
    readings: evidenceForActivity(activity.activity_id),
  }));
  const scored = rows.filter((row) => row.rung !== null);
  // Counted as the page counts them: each reading, and each post that confirmed one.
  const readings = rows.reduce((sum, row) => sum + row.readings.reduce((n, r) => n + 1 + (r.confirmations?.length ?? 0), 0), 0);
  const topRung = scored.reduce<number | null>((best, row) => Math.max(best ?? 0, row.rung ?? 0), null);

  const body = [
    `> ${fill(topRung === null ? c.answerNone : c.answer, {
      date: manifest()?.generated_at.slice(0, 10) ?? "",
      name,
      n: count(rows.length),
      scored: count(scored.length),
      top: topRung ?? 0,
      readings: count(readings),
    })}`,
    "",
    c.lead,
    "",
    `## ${c.activitiesTitle}`,
    "",
  ];
  if (rows.length === 0) body.push(c.activitiesNone);
  for (const { activity, rung, gates, readings: evidence } of rows) {
    const label = (zh ? activity.label_zh_cn : activity.label_en) ?? activity.label_en;
    const title = activity.evidence_rows && activity.level ? link(language, label, `/work/${workSlug(activity.activity_id)}`) : label;
    const level = rung === null ? c.noReading : `L${rung} ${levels[rung]}`;
    const held = gates.length > 0
      ? ` · ${c.gated}${sep}${gates.map((g) => (zh ? g.label_zh_cn : g.label_en) ?? g.label_en).join(" · ")}`
      : "";
    body.push(`- ${title}${sep}${level} · ${count(activity.tasks)} ${c.tasks}${held}`);
    for (const r of evidence) {
      const published = r.level === null ? c.noReading : `L${r.level}`;
      const claimed = r.observed_level !== null && r.level !== null && r.observed_level > r.level
        ? ` (${c.colJudged} L${r.observed_level})`
        : "";
      const source = r.source_urls[0] ? `[${r.title.replace(/([[\]])/g, "\\$1")}](${r.source_urls[0]})` : r.title;
      body.push(`  - ${r.occurred_at?.slice(0, 10) ?? ""} · ${source}${sep}${published}${claimed} · ` +
        termNameOrRaw("evidence_tier", r.evidence_tier, language));
      for (const v of r.confirmations ?? []) {
        const said = fill(c.confirms, {
          handle: v.handle ?? v.account_key,
          nature: termNameOrRaw("post_nature", v.post_nature, language),
          title: r.title,
        }).replace(/([[\]])/g, "\\$1");
        body.push(`  - ${v.posted_at?.slice(0, 10) ?? ""} · ${v.url ? `[${said}](${v.url})` : said}${sep}` +
          `${v.level === null ? c.noReading : `L${v.level}`} · ${termNameOrRaw("evidence_tier", v.evidence_tier, language)}`);
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

  const heldHere = new Map<string, number>();
  for (const row of rows) for (const gate of row.gates) heldHere.set(gate.gate_id, (heldHere.get(gate.gate_id) ?? 0) + 1);
  const gatesHere = allGates().filter((gate) => heldHere.has(gate.gate_id));
  if (gatesHere.length > 0) {
    body.push("", `## ${c.gatesTitle}`, "", c.gatesLead, "");
    for (const gate of gatesHere) {
      body.push(`- **${(zh ? gate.label_zh_cn : gate.label_en) ?? gate.label_en}** ` +
        `(${termNameOrRaw("gate_type", gate.gate_type, language)}; ${c.colHolds} ${count(heldHere.get(gate.gate_id) ?? 0)})${sep}` +
        `${(zh ? gate.definition_zh_cn : gate.definition_en) ?? gate.definition_en}`);
    }
  }
  return markdownResponse(language, `/markets/${id}`, name, body);
}
