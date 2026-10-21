import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { bilingual } from "@/lib/i18n";
import { plural } from "@/lib/plural";
import { getLocale } from "@/lib/locale";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import { siteNavCopy } from "@/lib/site-nav";
import { href } from "@/lib/routes";
import {
  activitiesOfMarket,
  assessedCount,
  atOrAboveL2,
  marketSlug,
  marketsOfOccupation,
  occupationSlug,
  progress,
  groupFromSlug,
  readings,
  events,
  manifest,
  type StageCounts,
} from "@/lib/snapshot";
import { WorkGrid, type StageKey } from "@/components/work-grid";
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
 * are the sector's own share and the spread between its widest and narrowest
 * occupation, because an average of 7% made of one 59% and twenty zeroes is a
 * different world from twenty sevens.
 */
const copy = bilingual({
  en: {
    back: "All sectors",
    metaDescription: "{name}: {tasks} tasks, {reached} reached by an AI update.",
    lead: "How far apart the occupations inside this sector are.",
    answer: "As of {date}, AI does {atL2} of the {total} {total|task|tasks} in {name} at L2 or above; {assessed} {assessed|task carries|tasks carry} a level, and the other {rest} {rest|has|have} no evidence either way.",
    answerNone: "As of {date}, no AI update has reached any of the {total} tasks in {name}.",
    statShareLabel: "AI finishes",
    statShareNote: "of this sector's tasks, at L2 or above. The middle sector is at {median}%.",
    statSpreadLabel: "Spread inside",
    statSpreadNote: "points between its widest and its narrowest occupation, among the {n} anything was read about.",
    tasksTag: "{n} tasks",
    gridTitle: "The work in this sector, as 100 squares",
    gridLead: "One square, one task, filled to the lowest level covering it.",
    timelineTitle: "What moved it",
    timelineLead: "Updates that left evidence on work reaching this sector.",
    timelineNone: "No update in the collected window left evidence on this sector's work.",
    drivesTitle: "What AI does here",
    drivesLead: "The work reaching this sector, furthest first.",
    drivesNone: "No work reaching this sector has evidence behind it.",
    drivesWhy: "That is a statement about what has been collected, not about the work.",
    insideTitle: "Inside this sector",
    noStage: "no evidence",
  },
  "zh-CN": {
    back: "全部领域",
    metaDescription: "{name}：{tasks} 项任务，其中 {reached} 项已被 AI 更新触及。",
    lead: "这个领域内部的职业，彼此差多远。",
    answer: "截至 {date}，{name}领域的 {total} 项任务中，AI 能做到 L2 及以上的有 {atL2} 项；有层级的共 {assessed} 项，其余 {rest} 项没有任何证据。",
    answerNone: "截至 {date}，{name}领域的 {total} 项任务还没有被任何 AI 更新触及。",
    statShareLabel: "AI 能做完",
    statShareNote: "的任务到 L2 及以上。中位的那个领域是 {median}%。",
    statSpreadLabel: "内部落差",
    statSpreadNote: "个百分点，最高的职业与最低的职业之差；只算有证据的那 {n} 个。",
    tasksTag: "{n} 项任务",
    gridTitle: "这个领域的工作，画成 100 格",
    gridLead: "一格一条任务，填到覆盖它的最低一级。",
    timelineTitle: "是什么推动了它",
    timelineLead: "在这个领域的工作上留下证据的更新。",
    timelineNone: "采集窗口里没有一次更新在这个领域的工作上留下证据。",
    drivesTitle: "AI 在这里做什么",
    drivesLead: "触及这些工作的工作，走得最远的在前。",
    drivesNone: "触及这个领域的工作里，没有一条有证据。",
    drivesWhy: "这说的是采集到了什么，不是这份工作本身。",
    insideTitle: "领域内部",
    noStage: "无证据",
  },
});

const KEYS: StageKey[] = ["0", "1", "2", "3", "4", "5", "unknown", "untouched"];

/** Share of this group's tasks AI produces the bulk of or better: L2 and up. */
function share(counts: StageCounts, tasks: number) {
  if (!tasks) return 0;
  return Math.round((atOrAboveL2(counts) / tasks) * 100);
}

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
      .replace("{reached}", String(assessedCount(group.by_stage))),
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
  const here = share(group.by_stage, group.tasks);

  const allShares = Object.values(progress()?.groups ?? {})
    .map((g) => share(g.by_stage, g.tasks))
    .sort((a, b) => a - b);
  const median = allShares.length ? allShares[Math.floor(allShares.length / 2)] : 0;

  // The occupations that make up this sector, drawn the same way one level down.
  const members: MemberRow[] = Object.entries(progress()?.occupations ?? {})
    .filter(([, entry]) => entry.group_id === group.id)
    .map(([occupationId, entry]) => ({
      id: occupationId,
      label:
        (language === "zh-CN" ? entry.label_zh_cn : entry.label_en) ??
        entry.label_en ??
        occupationId,
      tasks: entry.tasks,
      counts: entry.by_stage,
      assessed: assessedCount(entry.by_stage),
      href: href(language, `/occupations/${occupationSlug(occupationId)}`),
    }));

  // Both ends of the spread are occupations something was read about. An
  // occupation no update mentions also sits at 0, but that 0 is a fact about
  // the collection, and stretching the spread down to it would dress a gap in
  // the reading as a finding about the work.
  const memberShares = members
    .filter((row) => row.assessed > 0)
    .map((row) => share(row.counts, row.tasks));
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
    .filter((activity) => activity.level !== null)
    .sort((a, b) => (b.level ?? -1) - (a.level ?? -1) || b.tasks - a.tasks)
    .slice(0, 12);
  const activityIds = new Set(
    [...marketIds].flatMap((marketId) =>
      activitiesOfMarket(marketId).map((a) => a.activity_id),
    ),
  );

  const eventUrl = new Map<string, string | null>(
    events().map((row) => [row.event_id, row.source_urls?.[0] ?? null]),
  );
  const byEvent = new Map<string, TimelineMark>();
  // The chain stores positive readings only, so there is no sign to filter on.
  for (const row of readings()) {
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

  const counts: StageCounts = {};
  for (const key of KEYS) counts[key] = group.by_stage[key] ?? 0;
  const number = new Intl.NumberFormat("en-US");
  const assessed = assessedCount(group.by_stage);

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
          .replace("{atL2}", number.format(atOrAboveL2(group.by_stage)))
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
            {drives.map((activity) => {
              const level = activity.level;
              const key = level === null ? null : String(Math.floor(level));
              const word = key ? progress()?.levels?.[key]?.[language] : null;
              return (
                <li key={activity.activity_id}>
                  <Link
                    className={s.driveRow}
                    href={href(language, `/markets/${marketSlug(activity.market_id)}`)}
                  >
                    <span className={s.driveName}>
                      {(language === "zh-CN" ? activity.label_zh_cn : activity.label_en) ??
                        activity.label_en}
                    </span>
                    <span className={s.driveMeter}>
                      <Bar share={(level ?? 0) / 5} />
                    </span>
                    <span className={s.driveStage}>
                      {key === null ? c.noStage : `L${key}${word ? ` · ${word}` : ""}`}
                    </span>
                  </Link>
                </li>
              );
            })}
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
