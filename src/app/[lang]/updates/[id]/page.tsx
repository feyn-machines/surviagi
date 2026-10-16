import { plural } from "@/lib/plural";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LEVEL_NAMES, TIER_NAMES, levelClass } from "@/components/home/sections/levels";
import { vocabularyTerm } from "@/components/ontology-labels";
import s from "@/components/detail.module.css";
import { getLocale } from "@/lib/locale";
import { articleLd, breadcrumbLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import { siteNavCopy } from "@/lib/site-nav";
import { UPDATE_LANGUAGES } from "@/lib/site-pages";
import { copy } from "./copy";
import { href, marketHref, workHref } from "@/lib/routes";
import { activityById, chainEvents, events as allEvents, evidenceForEvent } from "@/lib/snapshot";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * One update: what it said, where it was published, and every kind of work it
 * bears on with the level claimed and the level accepted. Only an update that
 * bears on some work has a page.
 */

type Props = { params: Promise<{ id: string }> };
const find = (id: string) => chainEvents().find((e) => e.event_id === id);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { language } = await getLocale();
  const id = (await params).id;
  const update = find(id);
  if (!update) notFound();
  return pageMetadata({ language, path: `/updates/${id}`, title: update.title, description: update.summary, languages: UPDATE_LANGUAGES, markdown: true });
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
  const rows = evidenceForEvent(update.event_id).filter((r) => r.level !== null);
  const markets = new Set(rows.map((r) => r.market_id));
  const top = Math.max(0, ...rows.map((r) => r.level ?? 0));
  const views = more?.attention?.views ?? null;
  const levelText = `L${top} ${LEVEL_NAMES[language][top]}`;
  const say = plural(c.say, { n: rows.length, m: markets.size }).replace("{n}", String(rows.length)).replace("{m}", String(markets.size)).split("{level}");

  const path = `/updates/${update.event_id}`;
  const ld = [
    breadcrumbLd(language, [{ name: siteNavCopy[language].updates, path: "/updates" }, { name: update.title, path }]),
    articleLd(language, {
      headline: update.title,
      description: update.summary,
      path,
      datePublished: update.occurred_at,
      basedOn: update.source_urls ?? more?.source_urls ?? [],
    }),
  ];

  return (
    <div className={s.page}>
      <JsonLd data={ld} />
      <Link className={s.back} href={href(language, "/updates")}>{c.back}</Link>
      <div className={s.eyebrow}>{update.org_name} · {update.occurred_at ? update.occurred_at.slice(0, 10) : c.undated}{kind ? ` · ${zh ? kind["zh-CN"] ?? kind.en : kind.en}` : ""}</div>
      <h1 className={s.title}>{update.title}{zh && <em>{c.original}</em>}</h1>
      <p className={s.say}>{update.summary}</p>
      <p className={s.say}>{say[0]}<b>{levelText}</b>{say[1]}</p>

      <dl className={s.facts}>
        <div className={s.fact}><dt>{c.top}</dt><dd className={top >= 3 ? s.sig : ""}>L{top}<small>{LEVEL_NAMES[language][top]}</small></dd></div>
        <div className={s.fact}><dt>{c.work}</dt><dd>{rows.length}</dd></div>
        <div className={s.fact}><dt>{c.markets}</dt><dd>{markets.size}</dd></div>
        <div className={s.fact}><dt>{c.views}</dt><dd>{views ? compact(views, zh) : "—"}</dd></div>
      </dl>

      <h2 className={s.h2}>{c.listTitle}</h2>
      <p className={s.sub}>{c.listSub}</p>
      <ul className={s.list}>
        {rows.map((r) => {
          const work = activityById(r.activity_id);
          const market = work ? (zh ? work.market_zh_cn : work.market_en) ?? work.market_en : "";
          const linked = Boolean(work?.evidence_rows && work.level);
          const name = (zh ? r.activity_zh_cn : r.activity_en) ?? r.activity_en;
          return (
            <li key={r.activity_id} className={s.row}>
              <div className={s.when}><b>L{r.level}</b>{LEVEL_NAMES[language][r.level ?? 0]}</div>
              <div className={s.what}>
                {linked ? <Link className={s.name} href={workHref(language, r.activity_id)}>{name}</Link> : <span className={s.name}>{name}</span>}
                {work && <small><Link href={marketHref(language, work.market_id)}>{market}</Link></small>}
              </div>
              <div className={s.how}>
                <span className={`${s.tag} ${s[levelClass(r.level ?? 0)]}`}>L{r.level} {LEVEL_NAMES[language][r.level ?? 0]}</span>
                {(r.observed_level ?? 0) > (r.level ?? 0) && <span className={s.warn}>{c.claimed.replace("{c}", String(r.observed_level)).replace("{a}", String(r.level))}</span>}
                <span>{TIER_NAMES[language][r.evidence_tier] ?? r.evidence_tier}</span>
              </div>
            </li>
          );
        })}
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
