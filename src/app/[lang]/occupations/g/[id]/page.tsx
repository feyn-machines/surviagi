import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { bilingual } from "@/lib/i18n";
import { plural } from "@/lib/plural";
import { getLocale } from "@/lib/locale";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import { siteNavCopy } from "@/lib/site-nav";
import { indexable } from "@/lib/site-pages";
import { activityHref, href } from "@/lib/routes";
import {
  activitiesOfMarket,
  marketsOfOccupation,
  occupationGroups,
  occupationSlug,
  occupations,
  groupFromSlug,
  links,
  events,
  manifest,
  touchedShare,
} from "@/lib/snapshot";
import { WorkGrid, gridCounts } from "@/components/work-grid";
import { EvidenceTimeline, type TimelineMark } from "@/components/evidence-timeline";
import { Bar, Block, Stat, blueprint as bp } from "@/components/blueprint";
import { MemberRanking, type MemberRow } from "./ranking";
import s from "./group.module.css";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * One sector, and the question it exists to answer: how far apart are the jobs
 * inside it?
 *
 * A sector average is the least useful number on this page. The two at the top
 * are the sector's own share of tasks an update has touched and the spread
 * between its most and least touched occupation, because an average of 7% made
 * of one 59% and twenty zeroes is a different world from twenty sevens.
 */
const copy = bilingual({
  en: {
    back: "All sectors",
    metaDescription: "{name}: {tasks} tasks, {reached} reached by an AI update.",
    lead: "How far apart the occupations inside this sector are.",
    answer: "As of {date}, collected AI updates bear on {assessed} of the {total} {total|task|tasks} in {name}; the other {rest} {rest|is|are} not mentioned by any update.",
    answerNone: "As of {date}, no AI update has reached any of the {total} tasks in {name}.",
    statShareLabel: "Touched by an update",
    statShareNote: "of this sector's tasks. The middle sector is at {median}%.",
    statSpreadLabel: "Spread inside",
    statSpreadNote: "points between its most and its least touched occupation, among the {n} anything was read about.",
    tasksTag: "{n} tasks",
    gridTitle: "The work in this sector, as 100 squares",
    gridLead: "One square, one task, filled when at least one collected update bears on it.",
    timelineTitle: "What moved it",
    timelineLead: "Updates that left evidence on work reaching this sector.",
    timelineNone: "No update in the collected window left evidence on this sector's work.",
    drivesTitle: "Work the updates bear on",
    drivesLead: "The kinds of work reaching this sector, most updates first. Each row opens the updates on its market page.",
    drivesNone: "No update bears on any work reaching this sector.",
    drivesWhy: "That is a statement about what has been collected, not about the work.",
    insideTitle: "Inside this sector",
    updatesUnit: "{n|update|updates}",
  },
  "zh-CN": {
    back: "全部领域",
    metaDescription: "{name}：{tasks} 项任务，其中 {reached} 项已被 AI 更新触及。",
    lead: "这个领域内部的职业，彼此差多远。",
    answer: "截至 {date}，{name}领域的 {total} 项任务中，已有采集到的 AI 更新谈到 {assessed} 项，其余 {rest} 项没有任何更新谈到。",
    answerNone: "截至 {date}，{name}领域的 {total} 项任务还没有被任何 AI 更新触及。",
    statShareLabel: "被更新触及",
    statShareNote: "的任务。中位的那个领域是 {median}%。",
    statSpreadLabel: "内部落差",
    statSpreadNote: "个百分点，被触及最多的职业与最少的职业之差；只算有更新谈到的那 {n} 个。",
    tasksTag: "{n} 项任务",
    gridTitle: "这个领域的工作，画成 100 格",
    gridLead: "一格一条任务，至少有一条采集到的更新谈到它就填上。",
    timelineTitle: "是什么推动了它",
    timelineLead: "在这个领域的工作上留下证据的更新。",
    timelineNone: "采集窗口里没有一次更新在这个领域的工作上留下证据。",
    drivesTitle: "有更新谈到的工作",
    drivesLead: "触及这个领域的各项工作，更新多的在前。每一行指向赛道页上的那些更新。",
    drivesNone: "触及这个领域的工作，没有任何一条被更新谈到。",
    drivesWhy: "这说的是采集到了什么，不是这份工作本身。",
    insideTitle: "领域内部",
    updatesUnit: "条更新",
  },
});

/** Share of this group's tasks an update has touched. */
const share = touchedShare;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { language } = await getLocale();
  const group = groupFromSlug(id);
  if (!group) notFound();
  const label = ((language === "zh-CN" ? group.label_zh_cn : group.label_en) ?? group.label_en) ?? id;
  return pageMetadata({
    language,
    path: `/occupations/g/${id}`,
    title: label,
    description: copy[language].metaDescription
      .replace("{name}", label)
      .replace("{tasks}", String(group.tasks))
      .replace("{reached}", String(group.touched_tasks)),
    index: indexable.group(group),
  });
}

export default async function OccupationGroup({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { language } = await getLocale();
  const c = copy[language];

  const group = groupFromSlug(id);
  if (!group) notFound();

  const label =
    (language === "zh-CN" ? group.label_zh_cn : group.label_en) ?? group.label_en ?? id;
  const here = share(group.touched_tasks, group.tasks);

  const allShares = occupationGroups()
    .map((g) => share(g.touched_tasks, g.tasks))
    .sort((a, b) => a - b);
  const median = allShares.length ? allShares[Math.floor(allShares.length / 2)] : 0;

  // The occupations that make up this sector, drawn the same way one level down.
  const members: MemberRow[] = occupations()
    .filter((entry) => entry.group_id === group.id)
    .map((entry) => ({
      id: entry.occupation_id,
      label:
        (language === "zh-CN" ? entry.label_zh_cn : entry.label_en) ??
        entry.label_en ??
        entry.occupation_id,
      tasks: entry.tasks,
      counts: gridCounts(entry.touched, entry.tasks),
      assessed: entry.touched,
      href: href(language, `/occupations/${occupationSlug(entry.occupation_id)}`),
    }));

  // Both ends of the spread are occupations something was read about. An
  // occupation no update mentions also sits at 0, but that 0 is a fact about
  // the collection, and stretching the spread down to it would dress a gap in
  // the reading as a finding about the work.
  const memberShares = members
    .filter((row) => row.assessed > 0)
    .map((row) => Math.round((row.assessed / row.tasks) * 100));
  const spread = memberShares.length
    ? Math.max(...memberShares) - Math.min(...memberShares)
    : 0;

  // The activities that reach this sector, through the markets its occupations
  // serve. Furthest first, and only the ones an update actually said something
  // about - an activity with no reading has nothing to show here.
  const memberIds = new Set(members.map((m) => m.id));
  const marketIds = new Set(
    [...memberIds].flatMap((member) => marketsOfOccupation(member).map((e) => e.market_id)),
  );
  const drives = [...marketIds]
    .flatMap((marketId) => activitiesOfMarket(marketId))
    .filter((activity) => (activity.updates ?? 0) > 0)
    .sort((a, b) => (b.updates ?? 0) - (a.updates ?? 0) || b.tasks - a.tasks)
    .slice(0, 12);
  const mostUpdates = Math.max(1, ...drives.map((activity) => activity.updates ?? 0));
  const activityIds = new Set(
    [...marketIds].flatMap((marketId) =>
      activitiesOfMarket(marketId).map((a) => a.activity_id),
    ),
  );

  const eventUrl = new Map<string, string | null>(
    events().map((row) => [row.event_id, row.source_urls?.[0] ?? null]),
  );
  const byEvent = new Map<string, TimelineMark>();
  for (const row of links()) {
    if (!activityIds.has(row.activity_id)) continue;
    if (!row.occurred_at) continue;
    const name =
      (language === "zh-CN" ? row.activity_zh_cn : row.activity_en) ?? row.activity_en;
    const found = byEvent.get(row.event_id);
    if (found) {
      if (!found.capabilities.includes(name)) found.capabilities.push(name);
    } else {
      byEvent.set(row.event_id, {
        eventId: row.event_id,
        date: row.occurred_at,
        title: row.title,
        capabilities: [name],
        url: eventUrl.get(row.event_id) ?? null,
      });
    }
  }
  const marks = [...byEvent.values()];

  const counts = gridCounts(group.touched_tasks, group.tasks);
  const number = new Intl.NumberFormat("en-US");
  const assessed = group.touched_tasks;

  return (
    <div className={`${s.page} ${bp.canvas}`}>
      <JsonLd data={breadcrumbLd(language, [{ name: siteNavCopy[language].occupations, path: "/occupations" }, { name: label, path: `/occupations/g/${id}` }])} />
      <Link className="oaw-back" href={href(language, "/")}>
        {c.back}
      </Link>

      <h1 className={s.title}>{label}</h1>
      <p className={s.pageLead}>{c.lead}</p>
      {/* The page's answer in one dated sentence with its numbers, the line an engine can quote. */}
      <p className={s.answer}>
        {plural(assessed > 0 ? c.answer : c.answerNone, { total: group.tasks, assessed, rest: Math.max(0, group.tasks - assessed) })
          .replace("{date}", manifest()?.generated_at.slice(0, 10) ?? "")
          .replace("{name}", label)
          .replace("{total}", number.format(group.tasks))
          .replace("{assessed}", number.format(assessed))
          .replace("{rest}", number.format(Math.max(0, group.tasks - assessed)))}
      </p>

      <div className={s.stats}>
        <Stat
          label={c.statShareLabel}
          tag={c.tasksTag.replace("{n}", number.format(group.tasks))}
          value={here}
          unit="%"
          tone={here === 0 ? "correction" : "signal"}
          note={<p>{c.statShareNote.replace("{median}", String(median))}</p>}
        />
        <Stat
          label={c.statSpreadLabel}
          tag={`${members.length}`}
          value={spread}
          unit="pt"
          tone={spread === 0 ? "correction" : "signal"}
          note={<p>{c.statSpreadNote.replace("{n}", String(memberShares.length))}</p>}
        />
      </div>

      <Block title={c.gridTitle} lead={c.gridLead}>
        <WorkGrid counts={counts} language={language} title={c.gridTitle} />
      </Block>

      <Block title={c.timelineTitle} lead={c.timelineLead}>
        {marks.length === 0 ? (
          <div className={s.empty}>
            <p className={s.emptyTitle}>{c.timelineNone}</p>
            <p className={s.emptyWhy}>{c.drivesWhy}</p>
          </div>
        ) : (
          <EvidenceTimeline marks={marks} language={language} />
        )}
      </Block>

      <Block title={c.drivesTitle} lead={c.drivesLead}>
        {drives.length === 0 ? (
          <div className={s.empty}>
            <p className={s.emptyTitle}>{c.drivesNone}</p>
            <p className={s.emptyWhy}>{c.drivesWhy}</p>
          </div>
        ) : (
          <ul className={s.drives}>
            {drives.map((activity) => (
              <li key={activity.activity_id}>
                <Link
                  className={s.driveRow}
                  href={activityHref(language, activity)}
                >
                  <span className={s.driveName}>
                    {(language === "zh-CN" ? activity.label_zh_cn : activity.label_en) ??
                      activity.label_en}
                  </span>
                  <span className={s.driveMeter}>
                    <Bar share={(activity.updates ?? 0) / mostUpdates} />
                  </span>
                  <span className={s.driveStage}>
                    {activity.updates} {plural(c.updatesUnit, { n: activity.updates ?? 0 })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Block>

      {members.length ? (
        <Block title={c.insideTitle}>
          <MemberRanking rows={members} language={language} />
        </Block>
      ) : null}
    </div>
  );
}
