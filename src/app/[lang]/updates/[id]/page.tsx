import { plural } from "@/lib/plural";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { vocabularyTerm } from "@/components/ontology-labels";
import s from "@/components/detail.module.css";
import { getLocale } from "@/lib/locale";
import { articleLd, breadcrumbLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import { siteNavCopy } from "@/lib/site-nav";
import { UPDATE_LANGUAGES, indexable } from "@/lib/site-pages";
import { copy, reports, updateDate } from "./copy";
import { activityHref, href, marketHref } from "@/lib/routes";
import { activityById, linkedEvents, events as allEvents, linksOfEvent } from "@/lib/snapshot";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * One update: what it said, where it was published, and every kind of work it
 * bears on, by market. Nothing is graded. Only an update that bears on some
 * work has a page.
 */

type Props = { params: Promise<{ id: string }> };
const find = (id: string) => linkedEvents().find((e) => e.event_id === id);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { language } = await getLocale();
  const id = (await params).id;
  const update = find(id);
  if (!update) notFound();
  return pageMetadata({ language, path: `/updates/${id}`, title: update.title, description: update.summary, languages: UPDATE_LANGUAGES, index: indexable.update(update), markdown: true });
}

function compact(n: number, zh: boolean): string {
  const f = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$|(\.\d*?)0+$/, "$1");
  if (zh) return n >= 1e8 ? `${f(n / 1e8)} 亿` : n >= 1e4 ? `${f(n / 1e4)} 万` : String(n);
  return n >= 1e6 ? `${f(n / 1e6)}M` : n >= 1e3 ? `${f(n / 1e3)}K` : String(n);
}

export default async function UpdatePage({ params }: Props) {
  const { language } = await getLocale();
  const c = copy[language];
  const update = find((await params).id);
  if (!update) notFound();

  const zh = language === "zh-CN";
  const more = allEvents().find((e) => e.event_id === update.event_id);
  const kind = vocabularyTerm("event_kind", more?.kind);
  const rows = linksOfEvent(update.event_id)
    .map((r) => {
      const work = activityById(r.activity_id);
      return {
        id: r.activity_id,
        work,
        marketId: r.market_id,
        market: work ? ((zh ? work.market_zh_cn : work.market_en) ?? work.market_en) : "",
        name: (zh ? r.activity_zh_cn : r.activity_en) ?? r.activity_en,
      };
    })
    .sort((a, b) => a.market.localeCompare(b.market, language) || a.name.localeCompare(b.name, language));
  const markets = new Set(rows.map((r) => r.marketId));
  const views = more?.attention?.views ?? null;
  const told = reports(update, language);
  const say = plural(c.say, { n: rows.length, m: markets.size }).replace("{n}", String(rows.length)).replace("{m}", String(markets.size));

  const path = `/updates/${update.event_id}`;
  const ld = [
    breadcrumbLd(language, [{ name: siteNavCopy[language].updates, path: "/updates" }, { name: update.title, path }]),
    articleLd(language, {
      headline: update.title,
      description: update.summary,
      path,
      datePublished: update.occurred_at ?? update.announced_at,
      basedOn: update.source_urls ?? more?.source_urls ?? [],
    }),
  ];

  return (
    <div className={s.page}>
      <JsonLd data={ld} />
      <Link className={s.back} href={href(language, "/updates")}>{c.back}</Link>
      <div className={s.eyebrow}>{update.org_name} · {updateDate(c, update)}{kind ? ` · ${zh ? kind["zh-CN"] ?? kind.en : kind.en}` : ""}</div>
      <h1 className={s.title}>{update.title}{zh && <em>{c.original}</em>}</h1>
      <p className={s.say}>{update.summary}</p>
      <p className={s.say}>{say}</p>

      <dl className={s.facts}>
        <div className={s.fact}><dt>{c.work}</dt><dd>{rows.length}</dd></div>
        <div className={s.fact}><dt>{c.markets}</dt><dd>{markets.size}</dd></div>
        <div className={s.fact}><dt>{c.sourcesFact}</dt><dd>{update.source_urls.length}</dd></div>
        <div className={s.fact}><dt>{c.views}</dt><dd>{views ? compact(views, zh) : "—"}</dd></div>
      </dl>

      {(told.basis || told.task || told.facts.length > 0) && (
        <>
          <h2 className={s.h2}>{c.reportsTitle}</h2>
          <p className={s.sub}>{c.reportsSub}</p>
          <ul className={s.list}>
            {told.basis && (
              <li className={s.row}>
                <div className={s.when}>{c.basis}</div>
                <div className={s.what}><span className={s.name}>{told.basis}</span>{told.basisMeans && <p>{told.basisMeans}</p>}</div>
                <div className={s.how} />
              </li>
            )}
            {told.task && (
              <li className={s.row}>
                <div className={s.when}>{c.task}</div>
                <div className={s.what}><span className={s.name}>{told.task}</span></div>
                <div className={s.how}>{told.result && <span className={s.tag}>{told.result}</span>}</div>
              </li>
            )}
            {told.facts.map((f, i) => (
              <li key={i} className={s.row}>
                <div className={s.when}>{c.figure}</div>
                <div className={s.what}><span className={s.name}>{f.value}</span><p>{f.what}</p><small>“{f.quote}”</small></div>
                <div className={s.how} />
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className={s.h2}>{c.listTitle}</h2>
      <p className={s.sub}>{c.listSub}</p>
      <ul className={s.list}>
        {rows.map((r) => (
          <li key={r.id} className={s.row}>
            <div className={s.when}>{r.work ? <Link href={marketHref(language, r.work.market_id)}>{r.market}</Link> : r.market}</div>
            <div className={s.what}>
              {r.work ? <Link className={s.name} href={activityHref(language, r.work)}>{r.name}</Link> : <span className={s.name}>{r.name}</span>}
            </div>
            <div className={s.how}>
              {r.work && <Link className={s.out} href={activityHref(language, r.work)}>{c.onMarket} →</Link>}
            </div>
          </li>
        ))}
      </ul>

      {update.source_urls.length > 0 && (
        <>
          <h2 className={s.h2}>{c.sources}</h2>
          <div className={s.links} style={{ marginTop: 18 }}>
            {update.source_urls.map((url, i) => (
              <a key={url} className={s.chip} href={url} target="_blank" rel="nofollow noopener noreferrer">{c.source.replace("{i}", String(i + 1))}<small>{new URL(url).hostname.replace(/^www\./, "")}</small></a>
            ))}
          </div>
        </>
      )}

      <div className={s.cta}>
        <Link href={href(language, "/updates")}>{c.all}</Link>
        <Link href={href(language, "/")}>{c.home}</Link>
      </div>
    </div>
  );
}
