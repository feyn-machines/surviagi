import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/json-ld";
import { topicEditorial } from "@/content/topic-editorials";
import d from "@/components/detail.module.css";
import { appEnabled } from "@/lib/app-config";
import { bilingual } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { href, marketHref, updateHref } from "@/lib/routes";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { siteNavCopy } from "@/lib/site-nav";
import { chainEvents, markets, occupationSlug, occupations, topicBySlug, type Topic } from "@/lib/snapshot";
import { localizedPath } from "@/lib/i18n";
import type { Route } from "next";
import s from "../topics.module.css";
import { TopicVote } from "./vote";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * One topic: the question, and under each answer who argued it and which
 * updates weigh for or against it. The page declares no answer.
 */
const copy = bilingual({
  en: {
    back: "← All topics",
    replacement: "JOB",
    viability: "BUSINESS",
    since: "Open since",
    accounts: "Accounts",
    posts: "Posts",
    evidence: "Evidence",
    answers: "Answers",
    argued: "argued by",
    for: "for",
    against: "against",
    evidenceLabel: "Evidence",
    claimsLabel: "Who argues it",
    supports: "SUPPORTS",
    contradicts: "CONTRADICTS",
    nobody: "Nobody argues this yet.",
    outside: "not in the panel",
    source: "Source ↗",
    quarters: "By quarter",
    quarter: "Quarter",
    describe: "{q} {n} answers, argued by {a} accounts in the posts collected.",
  },
  "zh-CN": {
    back: "← 全部话题",
    replacement: "职业",
    viability: "生意",
    since: "提出于",
    accounts: "账号",
    posts: "帖子",
    evidence: "证据",
    answers: "选项",
    argued: "主张的账号",
    for: "支持",
    against: "反驳",
    evidenceLabel: "证据",
    claimsLabel: "谁这么主张",
    supports: "支持",
    contradicts: "反驳",
    nobody: "还没有人主张这个答案。",
    outside: "名单外",
    source: "来源 ↗",
    quarters: "按季度",
    quarter: "季度",
    describe: "{q} {n} 个选项，采集到的帖子里有 {a} 个账号主张过。",
  },
});

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { language } = await getLocale();
  const slug = (await params).slug;
  const topic = topicBySlug(slug);
  if (!topic) notFound();
  const c = copy[language];
  const editorial = topicEditorial(slug, language);
  return pageMetadata({
    language,
    path: `/topics/${slug}`,
    title: topic.question[language],
    description: editorial?.description ?? c.describe.replace("{q}", topic.question[language]).replace("{n}", String(topic.options.length))
      .replace("{a}", String(topic.accounts)),
  });
}

/** A link to the page of what the topic is about, when that page exists in this release. */
function aboutHref(topic: Topic, language: "en" | "zh-CN"): Route | null {
  const about = topic.about;
  if (!about) return null;
  if (about.kind === "occupation" && occupations().some((o) => o.occupation_id === about.id)) {
    return localizedPath(language, `/occupations/${occupationSlug(about.id)}`) as Route;
  }
  if (about.kind === "market" && markets().some((m) => m.id === about.id)) return marketHref(language, about.id);
  return null;
}

export default async function TopicPage({ params }: Props) {
  const { language } = await getLocale();
  const c = copy[language];
  const topic = topicBySlug((await params).slug);
  if (!topic) notFound();
  const editorial = topicEditorial(topic.slug, language);

  const withPage = new Set(chainEvents().map((e) => e.event_id));
  const about = topic.about;
  const aboutLink = aboutHref(topic, language);
  const aboutName = about ? about[language] ?? about.en : null;
  const quarters = Object.keys(topic.by_quarter).sort();
  const path = `/topics/${topic.slug}`;
  const ld = [breadcrumbLd(language, [{ name: siteNavCopy[language].topics, path: "/topics" }, { name: topic.question[language], path }])];

  return (
    <div className={d.page}>
      <JsonLd data={ld} />
      <Link className={d.back} href={href(language, "/topics")}>{c.back}</Link>
      <div className={d.eyebrow}>
        {c[topic.question_type]}
        {aboutName ? <> · {aboutLink ? <Link href={aboutLink}>{aboutName}</Link> : aboutName}</> : null}
        {" · "}{c.since} {topic.opened_at.slice(0, 10)}
      </div>
      <h1 className={d.title}>{topic.question[language]}</h1>

      <dl className={d.facts}>
        <div className={d.fact}><dt>{c.answers}</dt><dd>{topic.options.length}</dd></div>
        <div className={d.fact}><dt>{c.accounts}</dt><dd>{topic.accounts}</dd></div>
        <div className={d.fact}><dt>{c.posts}</dt><dd>{topic.posts}</dd></div>
        <div className={d.fact}><dt>{c.evidence}</dt><dd className={topic.evidence.length ? d.sig : ""}>{topic.evidence.length}</dd></div>
      </dl>

      {editorial ? (
        <section className={s.editorial} aria-labelledby="topic-analysis-heading">
          <div className={s.editorialMeta}>
            <span>{editorial.label}</span>
            <span>{editorial.updated} <time dateTime={editorial.date}>{editorial.date}</time></span>
          </div>
          <h2 id="topic-analysis-heading" className={s.editorialTitle}>{editorial.title}</h2>
          <p className={s.editorialSummary}>{editorial.summary}</p>
          <ul className={s.editorialPoints}>
            {editorial.points.map((point) => (
              <li key={point.url}>
                <h3>{point.title}</h3>
                <p>{point.text}</p>
                <a href={point.url} target="_blank" rel="noopener noreferrer">{point.source} ↗</a>
              </li>
            ))}
          </ul>
          <p className={s.editorialNext}>{editorial.next}</p>
          <Link className={s.editorialLink} href={href(language, editorial.articlePath)}>{editorial.article}</Link>
        </section>
      ) : null}

      <TopicVote language={language} enabled={appEnabled()} topicId={topic.topic_id}
        options={topic.options.map((option) => ({ option_id: option.option_id, text: option.text[language] }))} />

      {topic.options.map((option) => {
        const claims = topic.claims.filter((claim) => claim.option === option.key);
        const evidence = topic.evidence.filter((row) => row.option === option.key);
        return (
          <section key={option.key} className={s.option}>
            <div className={s.optionHead}>
              <h2 className={s.optionText}>{option.text[language]}</h2>
              <div className={s.optionCounts}>
                {c.argued} <b>{option.accounts}</b> · {c.for} <b>{option.supports}</b> · {c.against} <b>{option.contradicts}</b>
              </div>
            </div>
            <div className={s.optionBody}>
              {evidence.length > 0 ? (
                <>
                  <div className={s.label}>{c.evidenceLabel}</div>
                  <ul className={s.rows}>
                    {evidence.map((row) => (
                      <li key={`${row.event_id}-${row.sign}`}>
                        <span className={`${s.sign} ${s[row.sign]}`}>{c[row.sign]}</span>
                        <div>
                          {withPage.has(row.event_id)
                            ? <Link href={updateHref(language, row.event_id)}>{row.title}</Link>
                            : row.title}
                          <small>
                            {[row.by, row.occurred_at?.slice(0, 10)].filter(Boolean).join(" · ")}
                            {row.source_url ? <> · <a href={row.source_url} rel="noopener noreferrer" target="_blank">{c.source}</a></> : null}
                          </small>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <div className={s.label}>{c.claimsLabel}</div>
              {claims.length === 0 ? <p className={s.none}>{c.nobody}</p> : (
                <ul className={s.rows}>
                  {claims.map((claim) => (
                    <li key={claim.source_id}>
                      <span className={s.who}>@{claim.handle}</span>
                      <div>
                        {claim.quote ?? claim.says}
                        <small>
                          {claim.published_at.slice(0, 10)}
                          {claim.url ? <> · <a href={claim.url} rel="noopener noreferrer" target="_blank">{c.source}</a></> : null}
                          {claim.account_key ? null : <span className={s.outside}>{c.outside}</span>}
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      })}

      {quarters.length > 1 ? (
        <>
          <h2 className={d.h2}>{c.quarters}</h2>
          <table className={s.quarters}>
            <thead>
              <tr><th>{c.quarter}</th>{topic.options.map((o) => <th key={o.key}>{o.text[language]}</th>)}</tr>
            </thead>
            <tbody>
              {quarters.map((quarter) => (
                <tr key={quarter}>
                  <td className={s.n}>{quarter}</td>
                  {topic.options.map((o) => <td key={o.key} className={s.n}>{topic.by_quarter[quarter][o.key] ?? 0}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}
