import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import { listedArticles } from "@/lib/article-list";
import { buildHomeData, RECENT_DAYS } from "@/lib/home-data";
import { bilingual, localizedPath } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { href, topicHref, updateHref } from "@/lib/routes";
import { pageMetadata, siteLd } from "@/lib/seo";
import { dateLabel } from "@/lib/update-date";
import s from "./home.module.css";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

const ARTICLES = 3;

/**
 * The home page is the entry to one question - will AI take over this job or
 * this business, and what is the evidence - and to the four places that answer
 * it. It reads the same data as `llms.txt` and shows counts of collected
 * updates, not a progress score. It is plain server HTML: every link and both
 * search forms work without JavaScript.
 */
const copy = bilingual({
  en: {
    eyebrow: "THE AGI SURVIVAL GUIDE",
    headline: "Will AI take over your work? What the evidence says",
    lead: "For each job and each kind of business: who uses AI for it, how far they got, the numbers they report, and the evidence against. Every update links to the original posts it rests on.",
    standing: "As of {date}: {updates} updates from {orgs} AI companies collected since {start}; {recent} in the last {days} days.",
    jobsLabel: "Will AI take over my job?",
    jobsPlaceholder: "accountant, 客服, software developer…",
    jobsButton: "Find a job",
    marketsLabel: "Is my line of business still worth building?",
    marketsPlaceholder: "SaaS, travel booking, pest control…",
    marketsButton: "Find a business",
    sections: "Four ways in",
    markets: "Markets",
    marketsText: "Kinds of business, and what AI is doing in each.",
    occupations: "Occupations",
    occupationsText: "Jobs, and the tasks AI has been reported doing.",
    topics: "Topics",
    topicsText: "Open questions, with who argued each answer.",
    articles: "Articles",
    articlesText: "What changed, read from the updates.",
    recent: "New evidence",
    recentLead: "The latest updates from AI companies.",
    allUpdates: "All updates",
    featured: "Questions argued both ways",
    featuredLead: "More than one answer has someone arguing it.",
    allTopics: "All topics",
    accounts: "accounts",
    evidence: "evidence",
    job: "JOB",
    business: "BUSINESS",
    writing: "Latest articles",
    allArticles: "All articles",
    note: "An update is a record of what a company or person said it did. It is not a measure of what AI can do, and none of it has been reviewed as a score.",
    source: "source",
    sources: "sources",
    noData: "No published data yet. The site reads a local snapshot that has not been generated on this build.",
  },
  "zh-CN": {
    eyebrow: "新人类 AI 生存指南",
    headline: "AI 会接手你的工作吗？证据怎么说",
    lead: "针对每个职业、每类生意：谁在用 AI 做这件事、做到了哪一步、他们报告了什么数字，以及反面的证据。每条更新都链接到它所依据的原帖。",
    standing: "截至 {date}：自 {start} 起收集了 {orgs} 家 AI 公司的 {updates} 条更新，近 {days} 天有 {recent} 条。",
    jobsLabel: "AI 会接手我的职业吗？",
    jobsPlaceholder: "会计、客服、software developer…",
    jobsButton: "查职业",
    marketsLabel: "我这门生意还值得做吗？",
    marketsPlaceholder: "卖软件、在线订票、虫害防治…",
    marketsButton: "查生意",
    sections: "四个入口",
    markets: "赛道",
    marketsText: "各类生意，以及 AI 在其中做了什么。",
    occupations: "职业",
    occupationsText: "各个职业，以及 AI 被报告做过的任务。",
    topics: "话题",
    topicsText: "开放的问题，以及每种答案由谁主张。",
    articles: "文章",
    articlesText: "从更新里读出的变化。",
    recent: "最近的新证据",
    recentLead: "AI 公司最新的更新。",
    allUpdates: "全部更新",
    featured: "两边都有人说的问题",
    featuredLead: "不止一个答案有人主张。",
    allTopics: "全部话题",
    accounts: "个账号",
    evidence: "条证据",
    job: "职业",
    business: "生意",
    writing: "最新文章",
    allArticles: "全部文章",
    note: "更新是对一家公司或一个人声称做了什么的记录，不是对 AI 能力的度量，也没有经过复核而折算成分数。",
    source: "个来源",
    sources: "个来源",
    noData: "暂无已发布的数据。网站读取本地快照，而这次构建没有生成快照。",
  },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return pageMetadata({ language, path: "/" });
}

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));

export default async function Home() {
  const { language } = await getLocale();
  const c = copy[language];
  const data = buildHomeData();
  const articles = (await listedArticles(language)).slice(0, ARTICLES);
  const pick = (both: { en: string; zh: string }) => (language === "zh-CN" ? both.zh : both.en);

  return (
    <div className={s.home}>
      <JsonLd data={siteLd(language)} />
      <header className={s.hero}>
        <p className={s.eyebrow}>{c.eyebrow}</p>
        <h1 className={s.headline}>{c.headline}</h1>
        <p className={s.lead}>{c.lead}</p>
        {data ? (
          <p className={s.standing}>
            {fill(c.standing, { date: data.generatedAt, updates: data.updatesTotal, orgs: data.orgsTracked, start: data.start, recent: data.recentUpdates, days: RECENT_DAYS })}
          </p>
        ) : (
          <p className={s.standing}>{c.noData}</p>
        )}
        <div className={s.ask}>
          <form className={s.form} method="get" action={localizedPath(language, "/occupations")} role="search">
            <label className={s.formLabel} htmlFor="home-jobs">{c.jobsLabel}</label>
            <div className={s.formRow}>
              <input id="home-jobs" className={s.input} type="search" name="q" placeholder={c.jobsPlaceholder} autoComplete="off" />
              <button className={s.button} type="submit">{c.jobsButton}</button>
            </div>
          </form>
          <form className={s.form} method="get" action={localizedPath(language, "/markets")} role="search">
            <label className={s.formLabel} htmlFor="home-markets">{c.marketsLabel}</label>
            <div className={s.formRow}>
              <input id="home-markets" className={s.input} type="search" name="q" placeholder={c.marketsPlaceholder} autoComplete="off" />
              <button className={s.button} type="submit">{c.marketsButton}</button>
            </div>
          </form>
        </div>
      </header>

      <section className={s.block} aria-labelledby="home-sections">
        <h2 id="home-sections" className={s.blockTitle}>{c.sections}</h2>
        <ul className={s.cards}>
          {([
            ["/markets", c.markets, c.marketsText],
            ["/occupations", c.occupations, c.occupationsText],
            ["/topics", c.topics, c.topicsText],
            ["/articles", c.articles, c.articlesText],
          ] as const).map(([path, title, text]) => (
            <li key={path}>
              <Link className={s.card} href={href(language, path)}>
                <span className={s.cardTitle}>{title}</span>
                <span className={s.cardText}>{text}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {data && data.latest.length > 0 ? (
        <section id="updates" className={s.block} aria-labelledby="home-recent">
          <div className={s.blockHead}>
            <div>
              <h2 id="home-recent" className={s.blockTitle}>{c.recent}</h2>
              <p className={s.blockLead}>{c.recentLead}</p>
            </div>
            <Link className={s.more} href={href(language, "/updates")}>{c.allUpdates} →</Link>
          </div>
          <ul className={s.rows}>
            {data.latest.map((u) => (
              <li key={u.id} className={s.row}>
                <time className={s.rowDate} dateTime={u.date ?? undefined}>{dateLabel(u.date, u.announced, language)}</time>
                <div>
                  <Link className={s.rowTitle} href={updateHref(language, u.id)}>{u.title}</Link>
                  <p className={s.rowMeta}>
                    {[u.org, u.kind ? pick(u.kind) : null, `${u.sources} ${u.sources === 1 ? c.source : c.sources}`].filter(Boolean).join(" · ")}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data && data.topics.length > 0 ? (
        <section className={s.block} aria-labelledby="home-topics">
          <div className={s.blockHead}>
            <div>
              <h2 id="home-topics" className={s.blockTitle}>{c.featured}</h2>
              <p className={s.blockLead}>{c.featuredLead}</p>
            </div>
            <Link className={s.more} href={href(language, "/topics")}>{c.allTopics} ({data.topicsTotal}) →</Link>
          </div>
          <ul className={s.rows}>
            {data.topics.map((t) => (
              <li key={t.slug} className={s.row}>
                <span className={s.rowDate}>{t.type === "replacement" ? c.job : c.business}</span>
                <div>
                  <Link className={s.rowTitle} href={topicHref(language, t.slug)}>{pick(t.question)}</Link>
                  <p className={s.rowMeta}>{t.accounts} {c.accounts} · {t.evidence} {c.evidence}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {articles.length > 0 ? (
        <section className={s.block} aria-labelledby="home-articles">
          <div className={s.blockHead}>
            <h2 id="home-articles" className={s.blockTitle}>{c.writing}</h2>
            <Link className={s.more} href={href(language, "/articles")}>{c.allArticles} →</Link>
          </div>
          <ul className={s.rows}>
            {articles.map((a) => (
              <li key={a.slug} className={s.row}>
                <time className={s.rowDate} dateTime={a.date}>{a.date}</time>
                <div>
                  <Link className={s.rowTitle} href={localizedPath(language, a.path) as never}>{a.title}</Link>
                  <p className={s.rowMeta}>{a.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className={s.note}>{c.note}</p>
    </div>
  );
}
