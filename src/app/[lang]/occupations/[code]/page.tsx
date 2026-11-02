import { plural } from "@/lib/plural";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { type Language } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import { siteNavCopy } from "@/lib/site-nav";
import { indexable } from "@/lib/site-pages";
import { activityHref, href } from "@/lib/routes";
import { WorkGrid, gridCounts } from "@/components/work-grid";
import { Bar, Block, Stat, blueprint as bp } from "@/components/blueprint";
import {
  activitiesOfMarket,
  linksOfWork,
  groupSlug,
  manifest,
  marketSlug,
  marketsOfOccupation,
  occupationById,
  occupationGroups,
  occupationMedianShare,
  occupationSlug,
  occupations,
} from "@/lib/snapshot";
import {
  DataPageLinks,
  formatNumber,
  Provenance,
} from "@/components/data-page";
import { copy } from "./copy";
import { detailCopy, fill } from "@/app/[lang]/markets/copy";
import { updateTimestamp } from "@/lib/update-date";
import { termNameOrRaw } from "@/components/ontology-labels";
import { ActivityExplorer, type ExplorerActivity } from "./explorer";
import s from "./detail.module.css";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * One occupation, read along the path the evidence actually travels:
 * occupation → market → activity → task.
 *
 * The question this page answers is which pieces of this job a collected update
 * bears on at all, and which ones nobody has looked at. Both numbers are at the
 * top at display size, the hundred squares show the split, and the activity
 * list below opens onto the updates themselves. Nothing here is graded.
 */

type Props = { params: Promise<{ code: string }> };

function idForCode(code: string): string | undefined {
  return occupations().find((row) => occupationSlug(row.occupation_id) === code)?.occupation_id;
}

function label(id: string, language: Language) {
  const entry = occupationById(id);
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
  const entry = occupationById(id);
  const reached = entry?.touched_tasks ?? 0;
  return pageMetadata({
    language,
    path: `/occupations/${code}`,
    title: `${name} · ${c.metaSuffix}`,
    description: c.metaDescription
      .replace("{name}", name)
      .replace("{tasks}", String(entry?.tasks ?? 0))
      .replace("{reached}", String(reached)),
    // An occupation no update has reached has nothing of its own to show yet.
    index: indexable.occupation(reached),
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
  const entry = occupationById(id);
  const totalTasks = entry?.tasks ?? 0;
  const assessed = entry?.touched_tasks ?? 0;
  const median = occupationMedianShare();

  const served = marketsOfOccupation(id);

  // One row per activity, with the updates that bear on it already joined: the
  // client list only narrows and opens what the server resolved.
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
        href: activityHref(language, activity),
        tasks: activity.tasks,
        updates: linksOfWork(activity.activity_id).flatMap((row) => [
          {
            key: row.event_id,
            eventId: row.event_id as string | null,
            title: row.title,
            when: updateTimestamp(row)?.slice(0, 10) ?? null,
            org: row.org_name,
            url: row.source_urls?.[0] ?? null,
          },
          // A post by someone else that says the same: recorded, not verified.
          ...(row.confirmations ?? []).map((v) => ({
            key: `${row.event_id}:${v.source_id}`,
            eventId: null,
            title: fill(detailCopy[language].alsoSays, {
              handle: v.handle ?? v.account_key,
              nature: termNameOrRaw("post_nature", v.post_nature, language),
              title: row.title,
            }),
            when: v.posted_at ? v.posted_at.slice(0, 10) : null,
            org: `@${v.handle ?? v.account_key}`,
            url: v.url,
          })),
        ]),
      });
    }
  }
  marketRows.sort((a, b) => b.activities - a.activities || a.label.localeCompare(b.label));
  const widest = Math.max(1, ...marketRows.map((row) => row.activities));

  const groupId = entry?.group_id ?? null;
  const group = groupId ? occupationGroups().find((g) => g.id === groupId) : undefined;
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
          .replace("{assessed}", formatNumber(assessed))
          .replace("{rest}", formatNumber(Math.max(0, totalTasks - assessed)))}
      </p>

      <div className={s.stats}>
        <Stat
          label={c.statReachLabel}
          tag={c.tasksTag.replace("{n}", formatNumber(totalTasks))}
          value={assessed}
          unit={c.ofTotal.replace("{total}", formatNumber(totalTasks))}
          tone={assessed === 0 ? "correction" : "signal"}
          note={<p>{c.statReachNote.replace("{median}", String(median.median))}</p>}
        />
        <Stat
          label={c.statLookedLabel}
          tag={c.tasksTag.replace("{n}", formatNumber(totalTasks))}
          value={Math.max(0, totalTasks - assessed)}
          unit={c.ofTotal.replace("{total}", formatNumber(totalTasks))}
          tone="plain"
          note={<p>{plural(c.statLookedNote, { rest: Math.max(0, totalTasks - assessed) })}</p>}
        />
      </div>

      <Block title={c.gridTitle} lead={c.gridLead}>
        {assessed === 0 ? (
          <div className={s.empty}>
            <p className={s.emptyTitle}>{c.gridNone}</p>
            <p className={s.emptyWhy}>{c.gridNoneWhy}</p>
          </div>
        ) : (
          <WorkGrid counts={gridCounts(assessed, totalTasks)} language={language} title={c.gridTitle} />
        )}
      </Block>

      <Block title={c.activitiesTitle}>
        <ActivityExplorer activities={explorer} language={language} />
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
                    <span className={s.unit}> {fill(c.marketActivities, { n: row.activities })}</span>
                  </span>
                </Link>
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
