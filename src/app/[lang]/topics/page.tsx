import type { Metadata } from "next";
import type { Route } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/data-page";
import d from "@/components/data-page.module.css";
import f from "@/components/detail.module.css";
import { bilingual, localizedPath, type Language } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { topicHref } from "@/lib/routes";
import { pageMetadata } from "@/lib/seo";
import { topics, type Topic } from "@/lib/snapshot";
import s from "./topics.module.css";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * The open questions, in four steps: how many there are, the ones argued both
 * ways, the fields they fall in, then all of them - narrowed by kind, field and
 * order, a page at a time. Every filter is a link, so the page reads the same
 * with JavaScript off and each view has an address.
 */
const PAGE_SIZE = 12;
const FEATURED = 4;
const TYPES = ["replacement", "viability"] as const;
const SORTS = ["argued", "latest", "evidence"] as const;
/** The field of a topic the catalog has no entry for. */
const OUTSIDE = "outside";

const copy = bilingual({
  en: {
    metaTitle: "Topics: will AI replace this job, is this business still worth building",
    metaDescription: "Open questions about specific jobs and businesses, each with its answers, who argued them and the evidence for and against.",
    eyebrow: "TOPICS",
    title: "Open questions",
    topics: "Topics",
    both: "Argued both ways",
    accounts: "Accounts",
    evidence: "Evidence",
    featured: "Argued both ways",
    featuredSub: "More than one answer has someone arguing it.",
    fields: "By field",
    fieldsSub: "The occupation group or market a question is about.",
    all: "All questions",
    kind: "Kind",
    order: "Order",
    any: "All",
    replacement: "Jobs",
    viability: "Businesses",
    replacementTag: "JOB",
    viabilityTag: "BUSINESS",
    argued: "Most argued",
    latest: "Newest",
    evidenceSort: "Most evidence",
    bothOnly: "Both ways only",
    outside: "Not in the catalog",
    nAccounts: "accounts",
    nEvidence: "evidence",
    bothTag: "both ways",
    shown: "{n} questions",
    clear: "Clear",
    prev: "← Previous",
    next: "Next →",
    page: "Page {p} of {n}",
    empty: "No topics yet.",
    none: "Nothing matches.",
  },
  "zh-CN": {
    metaTitle: "话题：AI 会不会替代这个职业，这门生意还值不值得做",
    metaDescription: "关于具体职业和生意的开放问题：每个问题的几种答案、谁主张过、正反两面的证据。",
    eyebrow: "话题",
    title: "开放的问题",
    topics: "话题",
    both: "两边都有人说",
    accounts: "账号",
    evidence: "证据",
    featured: "两边都有人说",
    featuredSub: "不止一个选项有人主张。",
    fields: "按领域",
    fieldsSub: "问题所关于的职业大类或赛道。",
    all: "全部问题",
    kind: "类型",
    order: "排序",
    any: "全部",
    replacement: "职业",
    viability: "生意",
    replacementTag: "职业",
    viabilityTag: "生意",
    argued: "主张最多",
    latest: "最新",
    evidenceSort: "证据最多",
    bothOnly: "只看两边都有人说",
    outside: "目录外",
    nAccounts: "个账号",
    nEvidence: "条证据",
    bothTag: "两边都有人说",
    shown: "{n} 个问题",
    clear: "清除",
    prev: "← 上一页",
    next: "下一页 →",
    page: "第 {p} / {n} 页",
    empty: "暂无话题。",
    none: "没有符合的话题。",
  },
});

type Query = { type?: string; field?: string; sides?: string; sort?: string; page?: string };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  const c = copy[language];
  return pageMetadata({ language, path: "/topics", title: c.metaTitle, description: c.metaDescription });
}

const fieldKey = (topic: Topic): string => (topic.group ? topic.group.id.replace(/^oaw:/, "").replace(/:/g, "-") : OUTSIDE);

const ORDER: Record<(typeof SORTS)[number], (a: Topic, b: Topic) => number> = {
  argued: (a, b) => b.accounts - a.accounts || b.evidence.length - a.evidence.length,
  latest: (a, b) => (b.latest_claim_at ?? "").localeCompare(a.latest_claim_at ?? ""),
  evidence: (a, b) => b.evidence.length - a.evidence.length || b.accounts - a.accounts,
};

/** The address of the list with these filters; a default is left out so each view has one address. */
function listHref(language: Language, query: Query): Route {
  const params = new URLSearchParams();
  for (const key of ["type", "field", "sides", "sort", "page"] as const) {
    const value = query[key];
    if (value && !(key === "sort" && value === "argued") && !(key === "page" && value === "1")) params.set(key, value);
  }
  const text = params.toString();
  return `${localizedPath(language, "/topics")}${text ? `?${text}` : ""}#all` as Route;
}

function Bars({ topic, language }: { topic: Topic; language: Language }) {
  const most = Math.max(1, ...topic.options.map((o) => o.accounts));
  return (
    <ul className={s.bars}>
      {topic.options.map((o) => (
        <li key={o.key} className={`${s.bar} ${o.accounts ? "" : s.unargued}`}>
          <span className={s.barText}>
            {o.text[language]}
            {o.supports + o.contradicts > 0 ? (
              <span className={s.marks}>
                {o.supports > 0 ? <span className={s.supports}>+{o.supports}</span> : null}
                {o.contradicts > 0 ? <span className={s.contradicts}> −{o.contradicts}</span> : null}
              </span>
            ) : null}
          </span>
          <span className={s.barCount}>{o.accounts}</span>
          <span className={s.barTrack}><i className={s.barFill} style={{ width: `${(o.accounts / most) * 100}%` }} /></span>
        </li>
      ))}
    </ul>
  );
}

export default async function Topics({ searchParams }: Props) {
  const { language } = await getLocale();
  const c = copy[language];
  const raw = await searchParams;
  const one = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
  const all = topics();

  const type = TYPES.find((t) => t === one("type"));
  const sort = SORTS.find((t) => t === one("sort")) ?? "argued";
  const bothOnly = one("sides") === "both";
  const fieldNames = new Map<string, string>();
  for (const topic of all) fieldNames.set(fieldKey(topic), topic.group ? topic.group[language] ?? topic.group.en : c.outside);
  const field = one("field") && fieldNames.has(one("field") as string) ? one("field") : undefined;
  const query: Query = { type, field, sides: bothOnly ? "both" : undefined, sort };

  const ofType = all.filter((t) => !type || t.question_type === type);
  const fields = [...fieldNames].map(([key, name]) => ({ key, name, count: ofType.filter((t) => fieldKey(t) === key).length }))
    .filter((row) => row.count > 0)
    .sort((a, b) => Number(a.key === OUTSIDE) - Number(b.key === OUTSIDE) || b.count - a.count || a.name.localeCompare(b.name));
  const matched = ofType.filter((t) => (!field || fieldKey(t) === field) && (!bothOnly || t.sides === "open"))
    .sort((a, b) => ORDER[sort](a, b) || a.slug.localeCompare(b.slug));
  const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(one("page") ?? "1", 10) || 1));
  const shown = matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const narrowed = Boolean(type || field || bothOnly);
  const featured = all.filter((t) => t.sides === "open").sort(ORDER.argued).slice(0, FEATURED);

  const totals = {
    accounts: new Set(all.flatMap((t) => t.claims.map((claim) => claim.handle.toLowerCase()))).size,
    evidence: new Set(all.flatMap((t) => t.evidence.map((row) => row.event_id))).size,
  };

  if (all.length === 0) {
    return (
      <div className={d.page}>
        <PageHeader eyebrow={c.eyebrow} title={c.title} />
        <p className={d.note}>{c.empty}</p>
      </div>
    );
  }

  return (
    <div className={d.page}>
      <PageHeader eyebrow={c.eyebrow} title={c.title} />

      <dl className={f.facts}>
        <div className={f.fact}><dt>{c.topics}</dt><dd>{all.length}</dd></div>
        <div className={f.fact}><dt>{c.both}</dt><dd className={f.sig}>{all.filter((t) => t.sides === "open").length}</dd></div>
        <div className={f.fact}><dt>{c.accounts}</dt><dd>{totals.accounts}</dd></div>
        <div className={f.fact}><dt>{c.evidence}</dt><dd>{totals.evidence}</dd></div>
      </dl>

      {featured.length > 0 && !narrowed && page === 1 ? (
        <section>
          <h2 className={s.h2}>{c.featured}</h2>
          <p className={s.sub}>{c.featuredSub}</p>
          <div className={s.cards}>
            {featured.map((topic) => (
              <Link key={topic.slug} className={s.card} href={topicHref(language, topic.slug)}>
                <span className={s.cardKind}>
                  {c[`${topic.question_type}Tag`]}{topic.about ? ` · ${topic.about[language] ?? topic.about.en}` : ""}
                </span>
                <h3 className={s.cardQuestion}>{topic.question[language]}</h3>
                <Bars topic={topic} language={language} />
                <span className={s.cardFoot}>
                  <b>{topic.accounts}</b> {c.nAccounts}
                  {topic.evidence.length > 0 ? <> · <b>{topic.evidence.length}</b> {c.nEvidence}</> : null}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h2 className={s.h2}>{c.fields}</h2>
        <p className={s.sub}>{c.fieldsSub}</p>
        <div className={s.fields}>
          {fields.map((row) => (
            <Link key={row.key} className={`${s.field} ${field === row.key ? s.on : ""}`}
              href={listHref(language, { ...query, field: field === row.key ? undefined : row.key })}>
              {row.name}<small>{row.count}</small>
            </Link>
          ))}
        </div>
      </section>

      <section id="all">
        <h2 className={s.h2}>{c.all}</h2>
        <div className={s.toolbar}>
          <nav className={s.tabs} aria-label={c.kind}>
            <span className={s.tabsLabel}>{c.kind}</span>
            <Link className={type ? "" : s.on} href={listHref(language, { ...query, type: undefined, field: undefined })}>
              {c.any}<small>{all.length}</small>
            </Link>
            {TYPES.map((t) => (
              <Link key={t} className={type === t ? s.on : ""} href={listHref(language, { ...query, type: t, field: undefined })}>
                {c[t]}<small>{all.filter((topic) => topic.question_type === t).length}</small>
              </Link>
            ))}
            <Link className={bothOnly ? s.on : ""} href={listHref(language, { ...query, sides: bothOnly ? undefined : "both" })}>
              {c.bothOnly}
            </Link>
          </nav>
          <nav className={s.tabs} aria-label={c.order}>
            <span className={s.tabsLabel}>{c.order}</span>
            {SORTS.map((key) => (
              <Link key={key} className={sort === key ? s.on : ""} href={listHref(language, { ...query, sort: key })}>
                {c[key === "evidence" ? "evidenceSort" : key]}
              </Link>
            ))}
          </nav>
        </div>
        <p className={s.shown}>
          {c.shown.replace("{n}", String(matched.length))}
          {field ? ` · ${fieldNames.get(field)}` : ""}
          {narrowed ? <Link href={listHref(language, { sort })}>{c.clear}</Link> : null}
        </p>

        {shown.length === 0 ? <p className={d.note}>{c.none}</p> : (
          <ul className={s.rowsList}>
            {shown.map((topic) => (
              <li key={topic.slug} className={s.topicRow}>
                <div>
                  <Link className={s.question} href={topicHref(language, topic.slug)}>{topic.question[language]}</Link>
                  <div className={s.topicMeta}>
                    <span>{c[`${topic.question_type}Tag`]}</span>
                    {topic.about ? <span>{topic.about[language] ?? topic.about.en}</span> : <span>{c.outside}</span>}
                    <span><b>{topic.accounts}</b> {c.nAccounts}</span>
                    {topic.evidence.length > 0 ? <span><b>{topic.evidence.length}</b> {c.nEvidence}</span> : null}
                    {topic.sides === "open" ? <span className={s.both}>{c.bothTag}</span> : null}
                    {topic.latest_claim_at ? <span>{topic.latest_claim_at.slice(0, 10)}</span> : null}
                  </div>
                </div>
                <Bars topic={topic} language={language} />
              </li>
            ))}
          </ul>
        )}

        {pages > 1 ? (
          <nav className={s.pager} aria-label={c.page.replace("{p}", String(page)).replace("{n}", String(pages))}>
            {page > 1 ? <Link href={listHref(language, { ...query, page: String(page - 1) })}>{c.prev}</Link> : <span className={s.off}>{c.prev}</span>}
            <span>{c.page.replace("{p}", String(page)).replace("{n}", String(pages))}</span>
            {page < pages ? <Link href={listHref(language, { ...query, page: String(page + 1) })}>{c.next}</Link> : <span className={s.off}>{c.next}</span>}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
