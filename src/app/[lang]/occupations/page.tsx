import type { Metadata } from "next";
import { bilingual } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { datasetLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import {
  groupSlug,
  occupationGroups,
  occupationSlug,
  occupations,
  snapshotExists,
  touchedShare,
} from "@/lib/snapshot";
import { NoSnapshot } from "@/components/data-page";
import { Stat, blueprint as bp } from "@/components/blueprint";
import { OccupationDirectory, type DirectoryGroup, type DirectoryRow } from "./directory";
import s from "./occupations.module.css";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * Finding yourself, not comparing sectors.
 *
 * The homepage already ranks the twenty-three groups; repeating that here would
 * be the same page twice. A reader knows what their job is called and usually
 * not which SOC group it sits in, so the search box is the page. The two
 * numbers above it are what makes a row mean anything once it is found: the
 * catalogue's size, and where the middle occupation sits in how much of its
 * work any collected update has touched.
 */
const copy = bilingual({
  en: {
    metaTitle: "Find your occupation",
    metaDescription: "Every occupation in the snapshot and its tasks, with the share of those tasks that collected AI updates bear on.",
    title: "Find your occupation",
    lead: "Search for your job title; the number beside it is the share of its tasks a collected update bears on.",
    statTotalLabel: "Occupations",
    statTotalNote: "every occupation the source publishes, including the ones no update has reached.",
    statMedianLabel: "Median occupation",
    statMedianNote: "{zero} of {total} read zero, which is a statement about what has been collected.",
    tasksTag: "{n} tasks",
    touchedTag: "touched",
  },
  "zh-CN": {
    metaTitle: "找到你的职业",
    metaDescription: "快照中的全部职业及其任务，以及被采集到的 AI 更新谈到的任务比例。",
    title: "找到你的职业",
    lead: "搜你的职业名；后面那个数字，是它的任务里有更新谈到的比例。",
    statTotalLabel: "职业",
    statTotalNote: "来源发布的全部职业，包括没有任何更新触及的那些。",
    statMedianLabel: "中位职业",
    statMedianNote: "{total} 个里有 {zero} 个是 0，这说的是采集到了什么，不是这些工作安全。",
    tasksTag: "{n} 项任务",
    touchedTag: "已触及",
  },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return pageMetadata({ language, path: "/occupations", title: copy[language].metaTitle, description: copy[language].metaDescription });
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Occupations({ searchParams }: Props) {
  const { q } = await searchParams;
  const initialQuery = typeof q === "string" ? q.slice(0, 100) : "";
  const { language } = await getLocale();
  const c = copy[language];
  if (!snapshotExists()) return <NoSnapshot language={language} />;

  const rows: DirectoryRow[] = occupations().map((entry) => {
    const id = entry.occupation_id;
    const en = entry.label_en ?? id;
    const zh = entry.label_zh_cn ?? "";
    return {
      id,
      slug: occupationSlug(id),
      label: (language === "zh-CN" ? entry.label_zh_cn : entry.label_en) ?? en,
      // Both labels, so a reader who knows the English name finds the Chinese
      // row and the other way round.
      search: `${en} ${zh}`.toLowerCase(),
      groupId: entry.group_id ?? "",
      tasks: entry.tasks,
      share: touchedShare(entry.touched, entry.tasks),
      touched: entry.touched,
    };
  });

  const groups: DirectoryGroup[] = occupationGroups().map((group) => ({
    id: group.id,
    slug: groupSlug(group.id),
    label: (language === "zh-CN" ? group.label_zh_cn : group.label_en) ?? group.label_en ?? group.id,
    tasks: group.tasks,
    share: touchedShare(group.touched_tasks, group.tasks),
  }));
  groups.sort((a, b) => a.label.localeCompare(b.label));

  const shares = rows.map((row) => row.share).sort((x, y) => x - y);
  const median = shares.length ? shares[Math.floor(shares.length / 2)] : 0;
  const zeroes = rows.filter((row) => row.share === 0).length;
  const tasksTotal = rows.reduce((sum, row) => sum + row.tasks, 0);
  const number = new Intl.NumberFormat("en-US");

  return (
    <div className={`${s.page} ${bp.canvas}`}>
      <JsonLd data={datasetLd(language, { name: c.title, description: c.metaDescription, path: "/occupations" })} />
      <h1 className={s.title}>{c.title}</h1>
      <p className={s.pageLead}>{c.lead}</p>

      <div className={s.stats}>
        <Stat
          label={c.statTotalLabel}
          tag={c.tasksTag.replace("{n}", number.format(tasksTotal))}
          value={number.format(rows.length)}
          note={<p>{c.statTotalNote}</p>}
        />
        <Stat
          label={c.statMedianLabel}
          tag={c.touchedTag}
          value={median}
          unit="%"
          tone={median === 0 ? "correction" : "signal"}
          note={
            <p>
              {c.statMedianNote
                .replace("{zero}", number.format(zeroes))
                .replace("{total}", number.format(rows.length))}
            </p>
          }
        />
      </div>

      <OccupationDirectory
        rows={rows}
        groups={groups}
        language={language}
        initialQuery={initialQuery}
      />
    </div>
  );
}
