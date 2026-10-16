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
  bilingual,
  formatNumber,
  Provenance,
} from "@/components/data-page";
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

const copy = bilingual({
  en: {
    metaSuffix: "Occupation",
    metaDescription: "{name}: {tasks} tasks, {reached} reached by an AI update.",
    back: "All occupations",
    lead: "Which pieces of this job an update has reached, and which nobody has looked at.",
    answer: "As of {date}, AI does {atL2} of the {total} tasks of {name} at L2 or above; {assessed} tasks carry a level, and the other {rest} have no evidence either way.",
    answerNone: "As of {date}, no AI update has reached any of the {total} tasks of {name}.",
    statReachLabel: "AI finishes",
    statReachNote: "tasks at L2 or above. The median occupation is at {median}%.",
    statLookedLabel: "Looked at",
    statLookedNote: "tasks carry a level at all; the other {rest} have no evidence either way.",
    ofTotal: "/ {total}",
    gridTitle: "This occupation's tasks",
    gridLead: "One square, one task, filled to the lowest level of the kinds of work covering it.",
    gridNone: "No work with evidence behind it covers any task in this occupation.",
    gridNoneWhy: "The updates read so far are vendor and lab announcements, which rarely speak to this kind of work.",
    marketsTitle: "Markets this occupation serves",
    marketsLead: "A market is a kind of work a business sells; a job usually serves several.",
    marketsNone: "No market has been linked to this occupation yet.",
    marketActivities: "kinds of work",
    activitiesTitle: "What AI has been shown to do here",
    gatesTitle: "Non-technical conditions on these kinds of work",
    gatesLead: "A condition that does not lift because a model improved.",
    gatesNone: "No non-technical condition has been recorded against the kinds of work reaching this occupation.",
    tasksTag: "{n} tasks",
  },
  "zh-CN": {
    metaSuffix: "职业",
    metaDescription: "{name}：{tasks} 项任务，其中 {reached} 项已被 AI 更新触及。",
    back: "全部职业",
    lead: "这份工作里，哪几件已经被更新触及，哪几件还没人看过。",
    answer: "截至 {date}，{name}的 {total} 项任务中，AI 能做到 L2 及以上的有 {atL2} 项；有层级的共 {assessed} 项，其余 {rest} 项没有任何证据。",
    answerNone: "截至 {date}，{name}的 {total} 项任务还没有被任何 AI 更新触及。",
    statReachLabel: "AI 能做完",
    statReachNote: "项任务到 L2 及以上。中位职业是 {median}%。",
    statLookedLabel: "被看过",
    statLookedNote: "项任务有层级；其余 {rest} 项没有任何证据。",
    ofTotal: "/ {total}",
    gridTitle: "这个职业的任务",
    gridLead: "一格一条任务，填到覆盖它的工作里最低的那一级。",
    gridNone: "这个职业里没有任何一条任务被有证据支撑的工作覆盖。",
    gridNoneWhy: "目前读到的更新是厂商与实验室公告，很少谈到这类工作。",
    marketsTitle: "这个职业服务的赛道",
    marketsLead: "赛道是企业对外出售的一类工作，一份工作通常服务好几个。",
    marketsNone: "还没有赛道与这个职业建立关联。",
    marketActivities: "项工作",
    activitiesTitle: "AI 在这里被证明能做什么",
    gatesTitle: "这些工作的非技术门槛",
    gatesLead: "不随模型变强而松动的条件。",
    gatesNone: "触及这个职业的工作上没有记录到非技术门槛。",
    tasksTag: "{n} 项任务",
  },
});

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
        readings: evidenceForActivity(activity.activity_id).map((reading) => ({
          eventId: reading.event_id,
          title: reading.title,
          date: reading.occurred_at,
          org: reading.org_name,
          tier: reading.evidence_tier,
          observed: reading.observed_level,
          level: reading.level,
          url: reading.source_urls?.[0] ?? null,
        })),
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
        {(assessed > 0 ? c.answer : c.answerNone)
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
            <p>{c.statLookedNote.replace("{rest}", formatNumber(totalTasks - assessed))}</p>
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
