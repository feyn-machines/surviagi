import { plural } from "@/lib/plural";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { type Language } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import { siteNavCopy } from "@/lib/site-nav";
import { href } from "@/lib/routes";
import { WorkGrid } from "@/components/work-grid";
import { Bar, Block, Head, Stat, blueprint as bp } from "@/components/blueprint";
import {
  activitiesOfMarket,
  assessedCount,
  atOrAboveL2,
  evidenceForActivity,
  gates as allGates,
  groupSlug,
  manifest,
  marketSlug,
  marketsOfOccupation,
  occupationMedianShare,
  occupationSlug,
  occupations,
  progress,
  progressFor,
} from "@/lib/snapshot";
import {
  DataPageLinks,
  formatNumber,
  Provenance,
} from "@/components/data-page";
import { copy } from "./copy";
import { detailCopy, fill } from "@/app/[lang]/markets/copy";
import { termNameOrRaw } from "@/components/ontology-labels";
import { ActivityExplorer, type ExplorerActivity } from "./explorer";
import s from "./detail.module.css";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * One occupation, read along the path the evidence actually travels:
 * occupation → market → activity → task.
 *
 * The question this page answers is which pieces of this job an update has
 * touched at all, and which ones nobody has looked at. Both numbers are at the
 * top at display size, the hundred squares show the split, and the activity
 * list below opens onto the updates themselves.
 */

type Props = { params: Promise<{ code: string }> };

function idForCode(code: string): string | undefined {
  return occupations().find((row) => occupationSlug(row.occupation_id) === code)?.occupation_id;
}

function label(id: string, language: Language) {
  const entry = progress()?.occupations?.[id];
  const zh = entry?.label_zh_cn ?? null;
  const en = entry?.label_en ?? id;
  return language === "zh-CN" ? (zh ?? en) : en;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { language } = await getLocale();
  const c = copy[language];
  const code = (await params).code;
  const id = idForCode(code);
  if (!id) notFound();
  const name = label(id, language);
  const entry = progress()?.occupations?.[id];
  const reached = entry ? assessedCount(entry.by_stage) : 0;
  return pageMetadata({
    language,
    path: `/occupations/${code}`,
    title: `${name} · ${c.metaSuffix}`,
    description: c.metaDescription
      .replace("{name}", name)
      .replace("{tasks}", String(entry?.tasks ?? 0))
      .replace("{reached}", String(reached)),
    // An occupation no update has reached has nothing of its own to show yet.
    index: reached > 0,
    markdown: true,
  });
}

export default async function OccupationPage({ params }: Props) {
  const { language } = await getLocale();
  const c = copy[language];
  const code = (await params).code;
  const id = idForCode(code);

  if (!id) notFound();

  const name = label(id, language);
  const counts = progressFor(id) ?? {};
  const entry = progress()?.occupations?.[id];
  const totalTasks = entry?.tasks ?? 0;
  const assessed = assessedCount(counts);
  const atL2 = atOrAboveL2(counts);
  const median = occupationMedianShare();

  const served = marketsOfOccupation(id);
  const caps: Record<string, number> = progress()?.tier_caps ?? {};

  // One row per activity, with the readings that produced its level already
  // joined: the client list only narrows and opens what the server resolved.
  const seen = new Set<string>();
  const explorer: ExplorerActivity[] = [];
  const marketRows: { id: string; label: string; slug: string; activities: number }[] = [];
  for (const edge of served) {
    const rows = activitiesOfMarket(edge.market_id);
    const marketLabel =
      (language === "zh-CN" ? rows[0]?.market_zh_cn : rows[0]?.market_en) ??
      rows[0]?.market_en ??
      edge.market_id;
    marketRows.push({
      id: edge.market_id,
      label: marketLabel,
      slug: marketSlug(edge.market_id),
      activities: rows.length,
    });
    for (const activity of rows) {
      if (seen.has(activity.activity_id)) continue;
      seen.add(activity.activity_id);
      const activityLabel =
        (language === "zh-CN" ? activity.label_zh_cn : activity.label_en) ?? activity.label_en;
      explorer.push({
        id: activity.activity_id,
        label: activityLabel,
        search: `${activity.label_en} ${activity.label_zh_cn ?? ""} ${marketLabel}`.toLowerCase(),
        marketLabel,
        marketSlug: marketSlug(activity.market_id),
        level: activity.level,
        tier: activity.best_tier,
        tasks: activity.tasks,
        gated: activity.gated,
        readings: evidenceForActivity(activity.activity_id).flatMap((reading) => [
          {
            eventId: reading.event_id,
            title: reading.title,
            date: reading.occurred_at,
            org: reading.org_name,
            tier: reading.evidence_tier,
            observed: reading.observed_level,
            level: reading.level,
            url: reading.source_urls?.[0] ?? null,
          },
          // A post by someone else that confirmed the reading counts toward the level in its own right.
          ...(reading.confirmations ?? []).map((v) => ({
            eventId: `${reading.event_id}:${v.source_id}`,
            title: fill(detailCopy[language].confirms, {
              handle: v.handle ?? v.account_key,
              nature: termNameOrRaw("post_nature", v.post_nature, language),
              title: reading.title,
            }),
            date: v.posted_at,
            org: `@${v.handle ?? v.account_key}`,
            tier: v.evidence_tier,
            // The list explains a cut by the tier; a cut made by the kind of post is not the tier's, so it is not shown as one.
            observed: v.level !== null && caps[v.evidence_tier] !== v.level ? v.level : v.observed_level,
            level: v.level,
            url: v.url,
          })),
        ]),
      });
    }
  }
  marketRows.sort((a, b) => b.activities - a.activities || a.label.localeCompare(b.label));
  const widest = Math.max(1, ...marketRows.map((row) => row.activities));

  const gatesHere = explorer.some((row) => row.gated)
    ? allGates().filter((gate) => gate.candidate_activities + gate.reviewed_activities > 0)
    : [];

  const levelWords: Record<string, string> = {};
  for (const [key, text] of Object.entries(progress()?.levels ?? {})) levelWords[key] = text[language];

  const groupId = entry?.group_id ?? null;
  const group = groupId ? progress()?.groups?.[groupId] : undefined;
  const trail = [
    { name: siteNavCopy[language].occupations, path: "/occupations" },
    ...(groupId && group
      ? [{ name: ((language === "zh-CN" ? group.label_zh_cn : group.label_en) ?? group.label_en) ?? groupId, path: `/occupations/g/${groupSlug(groupId)}` }]
      : []),
    { name, path: `/occupations/${code}` },
  ];

  return (
    <div className={`${s.page} ${bp.canvas}`}>
      <JsonLd data={breadcrumbLd(language, trail)} />
      <Link className="oaw-back" href={href(language, "/occupations")}>
        {c.back}
      </Link>
      <h1 className={s.title}>{name}</h1>
      <p className={s.pageLead}>{c.lead}</p>
      {/* The page's answer in one dated sentence with its numbers, the line an engine can quote. */}
      <p className={s.answer}>
        {plural(assessed > 0 ? c.answer : c.answerNone, { total: totalTasks, assessed, rest: Math.max(0, totalTasks - assessed) })
          .replace("{date}", manifest()?.generated_at.slice(0, 10) ?? "")
          .replace("{name}", name)
          .replace("{total}", formatNumber(totalTasks))
          .replace("{atL2}", formatNumber(atL2))
          .replace("{assessed}", formatNumber(assessed))
          .replace("{rest}", formatNumber(Math.max(0, totalTasks - assessed)))}
      </p>

      <div className={s.stats}>
        <Stat
          label={c.statReachLabel}
          tag={levelWords["2"] ? `L2 · ${levelWords["2"]}` : "L2+"}
          value={atL2}
          unit={c.ofTotal.replace("{total}", formatNumber(totalTasks))}
          tone={atL2 === 0 ? "correction" : "signal"}
          note={<p>{c.statReachNote.replace("{median}", String(median.median))}</p>}
        />
        <Stat
          label={c.statLookedLabel}
          tag={c.tasksTag.replace("{n}", formatNumber(totalTasks))}
          value={assessed}
          unit={c.ofTotal.replace("{total}", formatNumber(totalTasks))}
          tone={assessed === 0 ? "correction" : "plain"}
          note={
            <p>
              {plural(c.statLookedNote, { assessed, rest: totalTasks - assessed }).replace(
                "{rest}",
                formatNumber(totalTasks - assessed),
              )}
            </p>
          }
        />
      </div>

      <Block title={c.gridTitle} lead={c.gridLead}>
        {assessed === 0 ? (
          <div className={s.empty}>
            <p className={s.emptyTitle}>{c.gridNone}</p>
            <p className={s.emptyWhy}>{c.gridNoneWhy}</p>
          </div>
        ) : (
          <WorkGrid counts={counts} language={language} title={c.gridTitle} />
        )}
      </Block>

      <Block title={c.activitiesTitle}>
        <ActivityExplorer
          activities={explorer}
          language={language}
          levels={levelWords}
          tierCaps={progress()?.tier_caps ?? {}}
        />
      </Block>

      <Block title={c.marketsTitle} lead={c.marketsLead}>
        {marketRows.length === 0 ? (
          <div className={s.empty}>
            <p className={s.emptyTitle}>{c.marketsNone}</p>
            <p className={s.emptyWhy}>{c.gridNoneWhy}</p>
          </div>
        ) : (
          <ul className={s.markets}>
            {marketRows.map((row) => (
              <li key={row.id}>
                <Link className={s.marketRow} href={href(language, `/markets/${row.slug}`)}>
                  <span className={s.marketName}>{row.label}</span>
                  <span className={s.marketMeter}>
                    <Bar share={row.activities / widest} label={row.label} />
                  </span>
                  <span className={s.marketCount}>
                    {row.activities}
                    <span className={s.unit}> {c.marketActivities}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title={c.gatesTitle} lead={c.gatesLead}>
        {gatesHere.length === 0 ? (
          <div className={s.empty}>
            <p className={s.emptyTitle}>{c.gatesNone}</p>
            <p className={s.emptyWhy}>{c.gatesLead}</p>
          </div>
        ) : (
          <ul className={s.gates}>
            {gatesHere.map((gate) => (
              <li key={gate.gate_id}>
                <Head
                  label={
                    (language === "zh-CN" ? gate.label_zh_cn : gate.label_en) ?? gate.label_en
                  }
                  tag={gate.gate_type}
                  tone="warning"
                />
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Provenance language={language} />
      <DataPageLinks language={language} current="occupations" />
    </div>
  );
}
